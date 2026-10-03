import { randomUUID } from "node:crypto";
import { AuditLog, type AuditEntryInput } from "@aac/audit-log";
import { PolicyEngine, SpendNotPersistedError, todayKey, type PolicyDecision } from "@aac/policy-engine";
import {
  RazorpayClient,
  describeRazorpayError,
  isRetryableRazorpayError,
  paymentIdFromLink,
} from "@aac/razorpay-client";
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
/** After this many checks (about an hour), keep checking but only every SLOW_EXPIRY_CHECK_INTERVAL_MS. */
const MAX_EXPIRY_CHECKS = 60;
const SLOW_EXPIRY_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/**
 * How long expiry checks keep going (at the slow interval) while Razorpay
 * rejects the lookup itself, e.g. 401 after a key rotation, before stopping.
 */
const REJECTED_CHECKS_GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** How long a settled link's outcome is kept for repeat checks before it is dropped from memory. */
const SETTLED_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
/** A gated order nobody approves or denies within this long is expired and its hold released. */
const APPROVAL_TTL_MS = 30 * 60 * 1000;
/** An approval restored after a failed audit write gets at least this long for the operator to retry. */
const MIN_RESTORED_APPROVAL_MS = 60 * 1000;
/** How long an expired approval id is remembered, so a late approve/deny can say "expired". */
const EXPIRED_APPROVAL_MEMORY_MS = 24 * 60 * 60 * 1000;
/** Retry interval for a spend commit that failed before the spend was counted. */
const COMMIT_RETRY_INTERVAL_MS = 60 * 1000;

/**
 * Once an outcome is decided (Razorpay created an order, a link was paid or
 * expired, an operator denied), failing to write the spend or audit entry
 * must not turn that outcome into an error or strand a hold. The failure is
 * logged loudly instead. Audit writes *before* a decision stay fatal: no
 * money moves without a record of why.
 */
function logWriteFailure(subject: string, what: string, err: unknown): void {
  console.error(`⚠️  ${subject}: the outcome stands, but recording the ${what} failed: ${(err as Error)?.message ?? err}`);
}

interface PendingApproval {
  id: string;
  actor: string;
  items: CartLine[];
  amount: number;
  currency: string;
  createdAt: string;
  /** The approval's expiry timer, cleared on approve/deny so it doesn't linger for the full TTL. */
  expiryTimer?: ReturnType<typeof setTimeout>;
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
  /** Recently expired approval ids, so a late approve/deny gets a clear reason. */
  private expiredApprovals = new Set<string>();
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

  /** Products as buyers see them: `stock` excludes units held by in-flight orders. */
  /** Swaps in new Razorpay keys (see reloadEnv); in-flight state is untouched. */
  reloadRazorpayKeys(keys: { keyId: string; keySecret: string }): void {
    this.razorpay = new RazorpayClient(keys);
  }

  listProducts(): Product[] {
    return this.catalog.products.map((p) => this.buyerView(p));
  }

  getProductView(productId: string): Product | undefined {
    const product = this.getProduct(productId);
    return product && this.buyerView(product);
  }

  getProduct(productId: string): Product | undefined {
    return this.catalog.products.find((p) => p.id === productId);
  }

  recommend(criteria: RecommendCriteria): RankedProduct[] {
    return rankProducts(this.listProducts(), criteria);
  }

  private buyerView(product: Product): Product {
    return { ...product, stock: this.available(product) };
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
          product: this.buyerView(upsellProduct),
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
    this.releaseStock(lines);
    this.policy.release(actor, amount);
  }

  private releaseStock(lines: CartLine[]): void {
    for (const { product, quantity } of lines) {
      const remaining = (this.reservedStock.get(product.id) ?? 0) - quantity;
      if (remaining > 0) this.reservedStock.set(product.id, remaining);
      else this.reservedStock.delete(product.id);
    }
  }

  /**
   * Turns a held order into a sale: stock leaves the shelf (synchronously) and
   * the spend moves from held to committed against the daily bound. The spend
   * is never left counted nowhere: if committing fails before it is counted,
   * the hold keeps counting it while the commit is retried in the background
   * (so it doesn't reduce the cap forever). Rejects so the caller can log.
   */
  private async settleHold(actor: string, lines: CartLine[], amount: number): Promise<void> {
    this.releaseStock(lines);
    for (const { product, quantity } of lines) {
      product.stock -= quantity;
    }
    // Fixed now, so a retry after midnight still counts against the day of the sale.
    const saleDay = todayKey();
    try {
      await this.policy.commitSpend(actor, amount, saleDay);
    } catch (err) {
      // Counted in memory, only the file write failed: the hold is no longer needed.
      if (err instanceof SpendNotPersistedError) this.policy.release(actor, amount);
      else this.retryCommitLater(actor, amount, saleDay);
      throw err;
    }
    this.policy.release(actor, amount);
  }

  /**
   * Retries a spend commit that failed before counting (e.g. the state file was
   * unreadable). Once it counts, the hold that stood in for it is released.
   * Once the sale's day is over, its spend no longer belongs to any current
   * cap, so the hold is simply released. Logs on the first retry and then
   * hourly, not every minute.
   */
  private retryCommitLater(actor: string, amount: number, saleDay: string, attempt = 1): void {
    setTimeout(async () => {
      if (todayKey() !== saleDay) {
        console.error(`⚠️  daily-spend commit for "${actor}" (${saleDay}) never succeeded; that day is over, releasing its hold`);
        this.policy.release(actor, amount);
        return;
      }
      try {
        await this.policy.commitSpend(actor, amount, saleDay);
      } catch (err) {
        if (!(err instanceof SpendNotPersistedError)) {
          if (attempt === 1 || attempt % 60 === 0) {
            console.error(`⚠️  daily-spend commit for "${actor}" still failing (retry ${attempt}): ${(err as Error).message}`);
          }
          this.retryCommitLater(actor, amount, saleDay, attempt + 1);
          return;
        }
      }
      // Counted (true), or the day rolled over during the commit (false): either way the hold is done.
      this.policy.release(actor, amount);
    }, COMMIT_RETRY_INTERVAL_MS).unref();
  }

  /** An audit write after the outcome is decided: failures are logged, never thrown (see logWriteFailure). */
  private async recordOutcome(subject: string, entry: AuditEntryInput): Promise<void> {
    await this.auditLog.record(entry).catch((err) => logWriteFailure(subject, "audit entry", err));
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
        return {
          ok: false,
          result: { status: "declined", reasons, suggestion: suggestion && this.buyerView(suggestion) },
        };
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
      this.trackApproval(
        { id: approvalId, actor: request.actor, items: lines, amount, currency, createdAt: new Date().toISOString() },
        APPROVAL_TTL_MS
      );
      const reasons = [
        ...decision.reasons,
        `expires in ${APPROVAL_TTL_MS / 60000} minutes if no operator approves or denies it`,
      ];
      await this.recordOutcome(`approval ${approvalId}`, {
        actor: request.actor,
        action: "gate_required",
        amount,
        currency,
        status: "pending",
        reasons,
        details: { approvalId },
      });
      return {
        status: "pending_approval",
        approvalId,
        reasons,
        amount,
        amountDisplay: formatInr(amount),
        currency,
      };
    }

    return this.captureOrder(request.actor, lines, amount, currency);
  }

  private trackApproval(pending: PendingApproval, ttlMs: number): void {
    pending.expiryTimer = setTimeout(() => void this.expireApproval(pending.id), ttlMs);
    pending.expiryTimer.unref();
    this.pendingApprovals.set(pending.id, pending);
  }

  /**
   * Puts an approval back after its approve() failed partway, with its hold
   * intact and a fresh expiry for whatever time it had left (at least
   * MIN_RESTORED_APPROVAL_MS), so the operator can simply retry.
   */
  private restoreApproval(pending: PendingApproval): void {
    const remainingMs = Date.parse(pending.createdAt) + APPROVAL_TTL_MS - Date.now();
    this.trackApproval(pending, Math.max(remainingMs, MIN_RESTORED_APPROVAL_MS));
  }

  private untrackApproval(pending: PendingApproval): void {
    clearTimeout(pending.expiryTimer);
    this.pendingApprovals.delete(pending.id);
  }

  private noPendingApproval(approvalId: string): CheckoutResult {
    const reason = this.expiredApprovals.has(approvalId)
      ? `approval "${approvalId}" expired after ${APPROVAL_TTL_MS / 60000} minutes without a decision and its hold was released; resubmit the checkout`
      : `no pending approval with id "${approvalId}"`;
    return { status: "declined", reasons: [reason] };
  }

  async approve(approvalId: string, approvedBy: string): Promise<CheckoutResult> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return this.noPendingApproval(approvalId);
    this.untrackApproval(pending);
    try {
      await this.auditLog.record({
        actor: pending.actor,
        action: "gate_approved",
        amount: pending.amount,
        currency: pending.currency,
        status: "allowed",
        reasons: [`approved by ${approvedBy}`],
        details: { approvalId },
      });
    } catch (err) {
      // No money moves without a record of the approval.
      this.restoreApproval(pending);
      throw err;
    }

    // Approval is a human's yes to *this* order, not a bypass: re-run stock and
    // policy against current state (bounds or the day may have changed) before
    // any money moves. Release-then-recheck runs as one step so nothing slips in between.
    let check: HoldResult;
    try {
      check = await this.serialize(async () => {
        this.releaseHold(pending.actor, pending.items, pending.amount);
        const items = pending.items.map((l) => ({ productId: l.product.id, quantity: l.quantity }));
        try {
          return await this.checkAndHold(pending.actor, items, `re-checked at approval time (${approvalId})`);
        } catch (err) {
          // The re-check broke (e.g. an audit or state write) before deciding
          // anything, and it never places a hold when it throws. Still inside
          // the queue, so putting the original hold back can't oversell.
          this.hold(pending.actor, pending.items, pending.amount);
          throw err;
        }
      });
    } catch (err) {
      this.restoreApproval(pending);
      throw err;
    }
    // A decline is a real outcome (recorded, hold released), not a failure to restore from.
    if (!check.ok) return check.result;

    if (check.amount !== pending.amount) {
      this.releaseHold(pending.actor, check.lines, check.amount);
      const reasons = [
        `order total changed from ${formatInr(pending.amount)} to ${formatInr(check.amount)} since it was approved; resubmit for a fresh approval`,
      ];
      await this.recordOutcome(`approval ${approvalId}`, {
        actor: pending.actor,
        action: "checkout_declined",
        status: "denied",
        reasons,
      });
      return { status: "declined", reasons };
    }

    try {
      return await this.captureOrder(pending.actor, check.lines, check.amount, check.currency, {
        keepHoldOnError: true,
      });
    } catch (err) {
      // A record that must exist before money moves couldn't be written; the hold is intact.
      this.restoreApproval(pending);
      throw err;
    }
  }

  async deny(approvalId: string, deniedBy: string, reason: string): Promise<CheckoutResult> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return this.noPendingApproval(approvalId);
    this.untrackApproval(pending);
    this.releaseHold(pending.actor, pending.items, pending.amount);
    await this.recordOutcome(`approval ${approvalId}`, {
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

  /** Releases the hold of a gated order nobody approved or denied in time. */
  private async expireApproval(approvalId: string): Promise<void> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;
    this.untrackApproval(pending);
    this.releaseHold(pending.actor, pending.items, pending.amount);
    this.expiredApprovals.add(approvalId);
    setTimeout(() => this.expiredApprovals.delete(approvalId), EXPIRED_APPROVAL_MEMORY_MS).unref();
    await this.recordOutcome(`approval ${approvalId}`, {
      actor: pending.actor,
      action: "gate_expired",
      amount: pending.amount,
      currency: pending.currency,
      status: "denied",
      reasons: [`no operator decision within ${APPROVAL_TTL_MS / 60000} minutes; hold released`],
      details: { approvalId },
    });
  }

  /**
   * Polls Razorpay for a payment link issued in `real_payment_link` mode and
   * settles it: "paid" captures (stock and spend committed), "expired" or
   * "cancelled" fails and releases the hold, anything else is still pending.
   * Once settled, every later check returns that same outcome.
   */
  async checkPayment(paymentLinkId: string): Promise<CheckoutResult> {
    return (await this.checkPaymentDetailed(paymentLinkId)).result;
  }

  /**
   * `retryable` is false once checking again can't help: the link is settled
   * or unknown, or Razorpay rejected the lookup itself (e.g. 401 bad keys,
   * 404 unknown link) rather than being unreachable.
   */
  private async checkPaymentDetailed(paymentLinkId: string): Promise<{ result: CheckoutResult; retryable: boolean }> {
    const settled = this.settledPayments.get(paymentLinkId);
    if (settled) return { result: await settled, retryable: false };

    const pending = this.pendingPayments.get(paymentLinkId);
    if (!pending) {
      return {
        result: { status: "declined", reasons: [`no payment awaiting confirmation with id "${paymentLinkId}"`] },
        retryable: false,
      };
    }

    let link;
    try {
      link = await this.razorpay.fetchPaymentLink(paymentLinkId);
    } catch (err) {
      return {
        result: this.pendingPaymentResult(pending, [
          `could not check this payment with Razorpay: ${describeRazorpayError(err)}`,
        ]),
        retryable: isRetryableRazorpayError(err),
      };
    }

    // Another check may have settled it while we were waiting on Razorpay.
    const settledMeanwhile = this.settledPayments.get(paymentLinkId);
    if (settledMeanwhile) return { result: await settledMeanwhile, retryable: false };

    if (link.status === "paid" || link.status === "expired" || link.status === "cancelled") {
      // Recorded synchronously, before any await, so exactly one check settles the link.
      this.pendingPayments.delete(paymentLinkId);
      const settlement =
        link.status === "paid"
          ? this.settlePaid(pending, paymentIdFromLink(link) ?? paymentLinkId)
          : this.settleUnpaid(pending, link.status);
      this.settledPayments.set(paymentLinkId, settlement);
      setTimeout(() => this.settledPayments.delete(paymentLinkId), SETTLED_RESULT_TTL_MS).unref();
      return { result: await settlement, retryable: false };
    }

    return {
      result: this.pendingPaymentResult(pending, [`payment link is "${link.status}"; not paid yet`]),
      retryable: true,
    };
  }

  /**
   * Checks an unpaid link once it has expired, and keeps checking every
   * interval until Razorpay reports it settled, so its hold is released even
   * if nobody polls. After MAX_EXPIRY_CHECKS it slows down rather than stops:
   * the hold is never released without Razorpay's word (that could oversell a
   * paid order), so a long Razorpay outage still settles once it recovers.
   * When Razorpay rejects the lookup itself (bad keys, unknown link), it tells
   * the operator how to fix it without a restart and keeps checking at the
   * slow interval, giving up after REJECTED_CHECKS_GIVE_UP_MS of rejections.
   * `unref` keeps the timer from holding the process open.
   */
  private scheduleExpiryCheck(paymentLinkId: string, delayMs: number, attempt = 1, rejectedSince?: number): void {
    setTimeout(async () => {
      let check: { result: CheckoutResult; retryable: boolean } | undefined;
      try {
        check = await this.checkPaymentDetailed(paymentLinkId);
      } catch (err) {
        console.error(`⚠️  expiry check ${attempt} for payment link ${paymentLinkId} failed: ${(err as Error).message}`);
      }
      if (check && check.result.status !== "pending_payment") return;
      if (check && !check.retryable) {
        const reason = check.result.status === "pending_payment" ? check.result.reasons.join("; ") : "";
        const since = rejectedSince ?? Date.now();
        if (Date.now() - since >= REJECTED_CHECKS_GIVE_UP_MS) {
          console.error(
            `⚠️  payment link ${paymentLinkId}: Razorpay has rejected every check for 24 hours (${reason}); ` +
              `stopped automatic checks. Its hold stays until GET /payments/${paymentLinkId} succeeds.`
          );
          return;
        }
        if (rejectedSince === undefined) {
          console.error(
            `⚠️  payment link ${paymentLinkId}: Razorpay rejected the check (${reason}). If the keys changed, ` +
              `update .env and run \`kill -HUP ${process.pid}\` to reload them without a restart (a restart ` +
              `loses this payment's hold). Checking every ${SLOW_EXPIRY_CHECK_INTERVAL_MS / 60000} minutes meanwhile.`
          );
        }
        this.scheduleExpiryCheck(paymentLinkId, SLOW_EXPIRY_CHECK_INTERVAL_MS, attempt + 1, since);
        return;
      }
      if (attempt === MAX_EXPIRY_CHECKS) {
        console.error(
          `⚠️  payment link ${paymentLinkId} still unsettled after ${attempt} expiry checks; ` +
            `checking every ${SLOW_EXPIRY_CHECK_INTERVAL_MS / 60000} minutes from now on`
        );
      }
      const nextDelay = attempt >= MAX_EXPIRY_CHECKS ? SLOW_EXPIRY_CHECK_INTERVAL_MS : EXPIRY_CHECK_INTERVAL_MS;
      this.scheduleExpiryCheck(paymentLinkId, nextDelay, attempt + 1);
    }, delayMs).unref();
  }

  private async settlePaid(pending: PendingPayment, paymentId: string): Promise<CheckoutResult> {
    const { paymentLinkId, actor, items, amount, currency, orderId } = pending;
    const subject = `payment link ${paymentLinkId}`;
    await this.settleHold(actor, items, amount).catch((err) => logWriteFailure(subject, "daily spend", err));
    await this.recordOutcome(subject, {
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
    await this.recordOutcome(`payment link ${paymentLinkId}`, {
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

  /**
   * Expects the caller to already hold `items`/`amount`; every returned result
   * settles or releases that hold. It throws only when a record that must
   * exist before money can move (order_created, payment_pending) can't be
   * written. The hold is then released, unless `keepHoldOnError` is set (the
   * caller restores the order it came from, as approve() does).
   */
  private async captureOrder(
    actor: string,
    items: CartLine[],
    amount: number,
    currency: string,
    { keepHoldOnError = false } = {}
  ): Promise<CheckoutResult> {
    const failBeforeMoneyMoves = (err: unknown): never => {
      if (!keepHoldOnError) this.releaseHold(actor, items, amount);
      throw err;
    };

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
      await this.recordOutcome(`order for ${actor}`, {
        actor,
        action: "payment_failed",
        amount,
        currency,
        status: "failure",
        reasons: [`Razorpay order creation failed: ${message}`],
      });
      return { status: "payment_failed", orderId: "unknown", reasons: [`order creation failed: ${message}`] };
    }

    const subject = `order ${order.id}`;
    const orderCreated: AuditEntryInput = {
      actor,
      action: "order_created",
      amount,
      currency,
      orderId: order.id,
      status: "success",
      reasons: ["Razorpay test-mode order created"],
    };
    // The last record before money can move (a simulated capture, or a payable
    // link): if it can't be written, stop here. An unpaid Razorpay order is inert.
    await this.auditLog.record(orderCreated).catch(failBeforeMoneyMoves);

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
        await this.recordOutcome(subject, {
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

      const reasons = [
        "real Razorpay payment link issued; nothing is captured until a human pays it",
        `link expires in ${PAYMENT_LINK_TTL_SECONDS / 60} minutes`,
      ];
      // A payable link is never handed out without a record of it. If the
      // record can't be written, cancel the link (best effort; the buyer never
      // sees its URL either way) and stop.
      try {
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
      } catch (err) {
        await this.razorpay.cancelPaymentLink(link.id).catch((cancelErr) =>
          console.error(
            `⚠️  payment link ${link.id} could not be recorded or cancelled (${describeRazorpayError(cancelErr)}); ` +
              "its URL was never given to the buyer"
          )
        );
        failBeforeMoneyMoves(err);
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
      return this.pendingPaymentResult(pending, reasons);
    }

    const payment = this.razorpay.simulateCapture(order.id, amount, currency);
    await this.settleHold(actor, items, amount).catch((err) => logWriteFailure(subject, "daily spend", err));
    await this.recordOutcome(subject, {
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
