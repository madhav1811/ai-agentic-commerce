import { randomUUID } from "node:crypto";
import { AuditLog } from "@aac/audit-log";
import { PolicyEngine, type PolicyDecision } from "@aac/policy-engine";
import { RazorpayClient, describeRazorpayError, paymentIdFromLink } from "@aac/razorpay-client";
import { config, loadCatalog } from "./config.js";
import { formatInr, rankProducts, type RecommendCriteria, type RankedProduct } from "./recommend.js";
import type {
  Catalog,
  CheckoutItem,
  CheckoutRequestBody,
  CheckoutResult,
  Product,
  UpsellSuggestion,
} from "./types.js";

type CartLine = { product: Product; quantity: number };

/** Payment links expire after this long. */
const PAYMENT_LINK_TTL_SECONDS = 30 * 60;
/**
 * How long after expiry the server checks an unpaid link itself (and again
 * at this interval until Razorpay reports it settled), so an abandoned link
 * releases its hold even if nobody ever polls it.
 */
const EXPIRY_CHECK_INTERVAL_MS = 60 * 1000;

interface PendingApproval {
  id: string;
  actor: string;
  items: CartLine[];
  amount: number;
  currency: string;
  createdAt: string;
}

interface PendingPayment {
  paymentLinkId: string;
  paymentUrl: string;
  orderId: string;
  actor: string;
  items: CartLine[];
  amount: number;
  currency: string;
}

type HoldResult =
  | { ok: true; lines: CartLine[]; amount: number; currency: string; decision: PolicyDecision }
  | { ok: false; result: CheckoutResult };

export class CheckoutService {
  readonly catalog: Catalog;
  readonly auditLog: AuditLog;
  private policy: PolicyEngine;
  private razorpay: RazorpayClient;
  private pendingApprovals = new Map<string, PendingApproval>();
  private pendingPayments = new Map<string, PendingPayment>();
  /**
   * Final outcome of every settled payment link, so repeat checks (e.g. a user
   * saying "I paid" twice) get the same answer instead of "unknown". Stored as
   * a promise so a check arriving mid-settlement waits for the same result.
   */
  private settledPayments = new Map<string, Promise<CheckoutResult>>();
  /** Units held by in-flight orders (awaiting approval or payment), per product id. */
  private reservedStock = new Map<string, number>();
  /**
   * Tail of the decision queue. Stock and policy checks plus the hold they
   * place run one checkout at a time, so two concurrent checkouts can't both
   * claim the last unit or the last of an agent's daily cap.
   */
  private decisionQueue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.catalog = loadCatalog();
    this.auditLog = new AuditLog(config.paths.auditLog);
    this.policy = new PolicyEngine(config.policy, config.paths.policyState);
    this.razorpay = new RazorpayClient(config.razorpay);
  }

  listProducts(): Product[] {
    return this.catalog.products;
  }

  getProduct(productId: string): Product | undefined {
    return this.catalog.products.find((p) => p.id === productId);
  }

  recommend(criteria: RecommendCriteria): RankedProduct[] {
    return rankProducts(this.catalog.products, criteria);
  }

  /** Stock not already held by an in-flight order. */
  private available(product: Product): number {
    return product.stock - (this.reservedStock.get(product.id) ?? 0);
  }

  private suggestSubstitute(outOfStock: Product): Product | undefined {
    return this.catalog.products.find(
      (p) => p.category === outOfStock.category && this.available(p) > 0 && p.id !== outOfStock.id
    );
  }

  /**
   * Deterministic cross-sell: each product's own `upsellWith` pairing, filtered
   * to in-stock items not already in the cart. Never delegated to the LLM, same
   * as recommend.ts — the reason quotes the real product that earned the pairing.
   */
  private suggestUpsells(purchased: CartLine[]): UpsellSuggestion[] {
    const purchasedIds = new Set(purchased.map((p) => p.product.id));
    const suggestions = new Map<string, UpsellSuggestion>();
    for (const { product } of purchased) {
      for (const upsellId of product.upsellWith) {
        if (purchasedIds.has(upsellId) || suggestions.has(upsellId)) continue;
        const upsellProduct = this.getProduct(upsellId);
        if (!upsellProduct || this.available(upsellProduct) <= 0) continue;
        suggestions.set(upsellId, {
          product: upsellProduct,
          reason: `frequently bought with "${product.name}"`,
          priceDisplay: formatInr(upsellProduct.price),
        });
      }
    }
    return [...suggestions.values()];
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.decisionQueue.then(fn);
    this.decisionQueue = run.catch(() => undefined);
    return run;
  }

  private hold(actor: string, lines: CartLine[], amount: number): void {
    for (const { product, quantity } of lines) {
      this.reservedStock.set(product.id, (this.reservedStock.get(product.id) ?? 0) + quantity);
    }
    this.policy.reserve(actor, amount);
  }

  private releaseHold(actor: string, lines: CartLine[], amount: number): void {
    for (const { product, quantity } of lines) {
      const remaining = (this.reservedStock.get(product.id) ?? 0) - quantity;
      if (remaining > 0) this.reservedStock.set(product.id, remaining);
      else this.reservedStock.delete(product.id);
    }
    this.policy.release(actor, amount);
  }

  /** Turns a held order into a sale: stock leaves the shelf and spend counts against the daily bound. */
  private async settleHold(actor: string, lines: CartLine[], amount: number): Promise<void> {
    this.releaseHold(actor, lines, amount);
    for (const { product, quantity } of lines) {
      product.stock -= quantity;
    }
    await this.policy.commitSpend(actor, amount);
  }

  /**
   * Validates stock and policy for a cart and, if allowed, holds the stock and
   * spend so nothing else can claim them. Must run inside `serialize`.
   */
  private async checkAndHold(actor: string, items: CheckoutItem[], context?: string): Promise<HoldResult> {
    const lines: CartLine[] = [];
    // Totals per product, so two lines for the same product can't each pass on their own.
    const requested = new Map<string, number>();
    for (const item of items) {
      const product = this.getProduct(item.productId);
      if (!product) {
        await this.auditLog.record({
          actor,
          action: "checkout_declined",
          status: "denied",
          reasons: [`unknown product id "${item.productId}"`],
        });
        return { ok: false, result: { status: "declined", reasons: [`unknown product id "${item.productId}"`] } };
      }
      const total = (requested.get(product.id) ?? 0) + item.quantity;
      requested.set(product.id, total);
      const available = this.available(product);
      if (available < total) {
        const suggestion = this.suggestSubstitute(product);
        const reasons = [`"${product.name}" is out of stock (requested ${total}, available ${available})`];
        if (context) reasons.unshift(context);
        if (suggestion) reasons.push(`suggested substitute: "${suggestion.name}" (${suggestion.id})`);
        await this.auditLog.record({
          actor,
          action: "checkout_declined",
          status: "denied",
          reasons,
          details: { outOfStockProductId: product.id, suggestionId: suggestion?.id },
        });
        return { ok: false, result: { status: "declined", reasons, suggestion } };
      }
      lines.push({ product, quantity: item.quantity });
    }

    const amount = lines.reduce((sum, r) => sum + r.product.price * r.quantity, 0);
    const currency = this.catalog.merchant.currency;
    const policyItems = lines.map((r) => ({ name: r.product.name, category: r.product.category }));

    const decision = await this.policy.evaluate({ actor, amount, currency, items: policyItems });
    await this.auditLog.record({
      actor,
      action: "policy_evaluated",
      amount,
      currency,
      status: decision.allowed ? "allowed" : "denied",
      reasons: context ? [context, ...decision.reasons] : decision.reasons,
    });

    if (!decision.allowed) {
      return { ok: false, result: { status: "declined", reasons: decision.reasons } };
    }

    this.hold(actor, lines, amount);
    return { ok: true, lines, amount, currency, decision };
  }

  async requestCheckout(request: CheckoutRequestBody): Promise<CheckoutResult> {
    await this.auditLog.record({
      actor: request.actor,
      action: "checkout_requested",
      status: "info",
      reasons: [`requested ${request.items.length} line item(s)`],
      details: { items: request.items },
    });

    const check = await this.serialize(() => this.checkAndHold(request.actor, request.items));
    if (!check.ok) return check.result;
    const { lines, amount, currency, decision } = check;

    if (decision.requiresGate) {
      // The hold stays in place while the order waits, so approval can't oversell or overspend.
      const approvalId = `appr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      this.pendingApprovals.set(approvalId, {
        id: approvalId,
        actor: request.actor,
        items: lines,
        amount,
        currency,
        createdAt: new Date().toISOString(),
      });
      await this.auditLog.record({
        actor: request.actor,
        action: "gate_required",
        amount,
        currency,
        status: "pending",
        reasons: decision.reasons,
        details: { approvalId },
      });
      return {
        status: "pending_approval",
        approvalId,
        reasons: decision.reasons,
        amount,
        amountDisplay: formatInr(amount),
        currency,
      };
    }

    return this.captureOrder(request.actor, lines, amount, currency);
  }

  async approve(approvalId: string, approvedBy: string): Promise<CheckoutResult> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return { status: "declined", reasons: [`no pending approval with id "${approvalId}"`] };
    }
    this.pendingApprovals.delete(approvalId);
    await this.auditLog.record({
      actor: pending.actor,
      action: "gate_approved",
      amount: pending.amount,
      currency: pending.currency,
      status: "allowed",
      reasons: [`approved by ${approvedBy}`],
      details: { approvalId },
    });

    // Approval is a human's yes to *this* order, not a bypass: re-run stock and
    // policy against current state (bounds or the day may have changed) before
    // any money moves. Release-then-recheck runs as one step so nothing slips in between.
    const check = await this.serialize(async () => {
      this.releaseHold(pending.actor, pending.items, pending.amount);
      const items = pending.items.map((l) => ({ productId: l.product.id, quantity: l.quantity }));
      return this.checkAndHold(pending.actor, items, `re-checked at approval time (${approvalId})`);
    });
    if (!check.ok) return check.result;

    if (check.amount !== pending.amount) {
      this.releaseHold(pending.actor, check.lines, check.amount);
      const reasons = [
        `order total changed from ${formatInr(pending.amount)} to ${formatInr(check.amount)} since it was approved; resubmit for a fresh approval`,
      ];
      await this.auditLog.record({ actor: pending.actor, action: "checkout_declined", status: "denied", reasons });
      return { status: "declined", reasons };
    }

    return this.captureOrder(pending.actor, check.lines, check.amount, check.currency);
  }

  async deny(approvalId: string, deniedBy: string, reason: string): Promise<CheckoutResult> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return { status: "declined", reasons: [`no pending approval with id "${approvalId}"`] };
    }
    this.pendingApprovals.delete(approvalId);
    this.releaseHold(pending.actor, pending.items, pending.amount);
    await this.auditLog.record({
      actor: pending.actor,
      action: "gate_denied",
      amount: pending.amount,
      currency: pending.currency,
      status: "denied",
      reasons: [`denied by ${deniedBy}: ${reason}`],
      details: { approvalId },
    });
    return { status: "declined", reasons: [`denied by ${deniedBy}: ${reason}`] };
  }

  /**
   * Polls Razorpay for a payment link issued in `real_payment_link` mode and
   * settles it: "paid" captures (stock and spend committed), "expired" or
   * "cancelled" fails and releases the hold, anything else is still pending.
   * Once settled, every later check returns that same outcome.
   */
  async checkPayment(paymentLinkId: string): Promise<CheckoutResult> {
    const settled = this.settledPayments.get(paymentLinkId);
    if (settled) return settled;

    const pending = this.pendingPayments.get(paymentLinkId);
    if (!pending) {
      return { status: "declined", reasons: [`no payment awaiting confirmation with id "${paymentLinkId}"`] };
    }

    let link;
    try {
      link = await this.razorpay.fetchPaymentLink(paymentLinkId);
    } catch (err) {
      return this.pendingPaymentResult(pending, [
        `could not reach Razorpay to check this payment: ${describeRazorpayError(err)}`,
      ]);
    }

    // Another check may have settled it while we were waiting on Razorpay.
    const settledMeanwhile = this.settledPayments.get(paymentLinkId);
    if (settledMeanwhile) return settledMeanwhile;

    if (link.status === "paid" || link.status === "expired" || link.status === "cancelled") {
      // Recorded synchronously, before any await, so exactly one check settles the link.
      this.pendingPayments.delete(paymentLinkId);
      const settlement =
        link.status === "paid"
          ? this.settlePaid(pending, paymentIdFromLink(link) ?? paymentLinkId)
          : this.settleUnpaid(pending, link.status);
      this.settledPayments.set(paymentLinkId, settlement);
      return settlement;
    }

    return this.pendingPaymentResult(pending, [`payment link is "${link.status}"; not paid yet`]);
  }

  /**
   * Checks an unpaid link once it has expired, and keeps checking every
   * interval until Razorpay reports it settled, so its hold is released even
   * if nobody polls. `unref` keeps the timer from holding the process open.
   */
  private scheduleExpiryCheck(paymentLinkId: string, delayMs: number): void {
    setTimeout(async () => {
      const result = await this.checkPayment(paymentLinkId).catch(() => undefined);
      if (!result || result.status === "pending_payment") {
        this.scheduleExpiryCheck(paymentLinkId, EXPIRY_CHECK_INTERVAL_MS);
      }
    }, delayMs).unref();
  }

  private async settlePaid(pending: PendingPayment, paymentId: string): Promise<CheckoutResult> {
    const { paymentLinkId, actor, items, amount, currency, orderId } = pending;
    await this.settleHold(actor, items, amount);
    await this.auditLog.record({
      actor,
      action: "payment_captured",
      amount,
      currency,
      orderId,
      status: "success",
      reasons: ["real Razorpay test-mode payment captured via payment link"],
      details: { paymentLinkId, paymentId, simulated: false },
    });
    return {
      status: "captured",
      orderId,
      paymentId,
      amount,
      amountDisplay: formatInr(amount),
      currency,
      simulated: false,
      upsell: this.suggestUpsells(items),
    };
  }

  private async settleUnpaid(pending: PendingPayment, linkStatus: "expired" | "cancelled"): Promise<CheckoutResult> {
    const { paymentLinkId, actor, items, amount, currency, orderId } = pending;
    this.releaseHold(actor, items, amount);
    const reasons = [`payment link ${linkStatus} before it was paid; nothing was charged`];
    await this.auditLog.record({
      actor,
      action: "payment_failed",
      amount,
      currency,
      orderId,
      status: "failure",
      reasons,
      details: { paymentLinkId },
    });
    return { status: "payment_failed", orderId, reasons };
  }

  private pendingPaymentResult(pending: PendingPayment, reasons: string[]): CheckoutResult {
    return {
      status: "pending_payment",
      orderId: pending.orderId,
      paymentLinkId: pending.paymentLinkId,
      paymentUrl: pending.paymentUrl,
      amount: pending.amount,
      amountDisplay: formatInr(pending.amount),
      currency: pending.currency,
      reasons,
    };
  }

  /** Expects the caller to already hold `items`/`amount`; every exit path settles or releases that hold. */
  private async captureOrder(
    actor: string,
    items: CartLine[],
    amount: number,
    currency: string
  ): Promise<CheckoutResult> {
    let order;
    try {
      order = await this.razorpay.createOrder({
        amount,
        currency,
        receipt: `receipt_${randomUUID().slice(0, 12)}`,
        notes: { actor, itemIds: items.map((i) => i.product.id).join(",") },
      });
    } catch (err) {
      this.releaseHold(actor, items, amount);
      const message = describeRazorpayError(err);
      await this.auditLog.record({
        actor,
        action: "payment_failed",
        amount,
        currency,
        status: "failure",
        reasons: [`Razorpay order creation failed: ${message}`],
      });
      return { status: "payment_failed", orderId: "unknown", reasons: [`order creation failed: ${message}`] };
    }

    await this.auditLog.record({
      actor,
      action: "order_created",
      amount,
      currency,
      orderId: order.id,
      status: "success",
      reasons: ["Razorpay test-mode order created"],
    });

    if (config.paymentMode === "real_payment_link") {
      let link;
      try {
        link = await this.razorpay.createPaymentLink({
          amount,
          currency,
          description: items.map((i) => `${i.quantity}x ${i.product.name}`).join(", "),
          referenceId: order.id,
          expireBy: Math.floor(Date.now() / 1000) + PAYMENT_LINK_TTL_SECONDS,
        });
      } catch (err) {
        this.releaseHold(actor, items, amount);
        const message = describeRazorpayError(err);
        await this.auditLog.record({
          actor,
          action: "payment_failed",
          amount,
          currency,
          orderId: order.id,
          status: "failure",
          reasons: [`Razorpay payment link creation failed: ${message}`],
        });
        return { status: "payment_failed", orderId: order.id, reasons: [`payment link creation failed: ${message}`] };
      }

      // Nothing is captured yet: the hold stays until checkPayment sees the link paid, expired or cancelled.
      const pending: PendingPayment = {
        paymentLinkId: link.id,
        paymentUrl: link.short_url,
        orderId: order.id,
        actor,
        items,
        amount,
        currency,
      };
      this.pendingPayments.set(link.id, pending);
      this.scheduleExpiryCheck(link.id, PAYMENT_LINK_TTL_SECONDS * 1000 + EXPIRY_CHECK_INTERVAL_MS);
      const reasons = [
        "real Razorpay payment link issued; nothing is captured until a human pays it",
        `link expires in ${PAYMENT_LINK_TTL_SECONDS / 60} minutes`,
      ];
      await this.auditLog.record({
        actor,
        action: "payment_pending",
        amount,
        currency,
        orderId: order.id,
        status: "pending",
        reasons,
        details: { paymentLinkUrl: link.short_url, paymentLinkId: link.id },
      });
      return this.pendingPaymentResult(pending, reasons);
    }

    const payment = this.razorpay.simulateCapture(order.id, amount, currency);
    await this.settleHold(actor, items, amount);
    await this.auditLog.record({
      actor,
      action: "payment_captured",
      amount,
      currency,
      orderId: order.id,
      status: "success",
      reasons: ["payment simulated for unattended agent-to-agent demo (see razorpay-client docs)"],
      details: { paymentId: payment.id, simulated: true },
    });

    return {
      status: "captured",
      orderId: order.id,
      paymentId: payment.id,
      amount,
      amountDisplay: formatInr(amount),
      currency,
      simulated: true,
      upsell: this.suggestUpsells(items),
    };
  }
}
