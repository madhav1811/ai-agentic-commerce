import { randomUUID } from "node:crypto";
import { AuditLog } from "@aac/audit-log";
import { PolicyEngine } from "@aac/policy-engine";
import { RazorpayClient, describeRazorpayError } from "@aac/razorpay-client";
import { config, loadCatalog } from "./config.js";
import { formatInr, rankProducts, type RecommendCriteria, type RankedProduct } from "./recommend.js";
import type { Catalog, CheckoutRequestBody, CheckoutResult, Product, UpsellSuggestion } from "./types.js";

interface PendingApproval {
  id: string;
  actor: string;
  items: { product: Product; quantity: number }[];
  amount: number;
  currency: string;
  createdAt: string;
}

export class CheckoutService {
  readonly catalog: Catalog;
  readonly auditLog: AuditLog;
  private policy: PolicyEngine;
  private razorpay: RazorpayClient;
  private pendingApprovals = new Map<string, PendingApproval>();

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

  private suggestSubstitute(outOfStock: Product): Product | undefined {
    return this.catalog.products.find(
      (p) => p.category === outOfStock.category && p.stock > 0 && p.id !== outOfStock.id
    );
  }

  /**
   * Deterministic cross-sell: each product's own `upsellWith` pairing, filtered
   * to in-stock items not already in the cart. Never delegated to the LLM, same
   * as recommend.ts — the reason quotes the real product that earned the pairing.
   */
  private suggestUpsells(purchased: { product: Product; quantity: number }[]): UpsellSuggestion[] {
    const purchasedIds = new Set(purchased.map((p) => p.product.id));
    const suggestions = new Map<string, UpsellSuggestion>();
    for (const { product } of purchased) {
      for (const upsellId of product.upsellWith) {
        if (purchasedIds.has(upsellId) || suggestions.has(upsellId)) continue;
        const upsellProduct = this.getProduct(upsellId);
        if (!upsellProduct || upsellProduct.stock <= 0) continue;
        suggestions.set(upsellId, {
          product: upsellProduct,
          reason: `frequently bought with "${product.name}"`,
          priceDisplay: formatInr(upsellProduct.price),
        });
      }
    }
    return [...suggestions.values()];
  }

  async requestCheckout(request: CheckoutRequestBody): Promise<CheckoutResult> {
    await this.auditLog.record({
      actor: request.actor,
      action: "checkout_requested",
      status: "info",
      reasons: [`requested ${request.items.length} line item(s)`],
      details: { items: request.items },
    });

    const resolved: { product: Product; quantity: number }[] = [];
    for (const item of request.items) {
      const product = this.getProduct(item.productId);
      if (!product) {
        await this.auditLog.record({
          actor: request.actor,
          action: "checkout_declined",
          status: "denied",
          reasons: [`unknown product id "${item.productId}"`],
        });
        return { status: "declined", reasons: [`unknown product id "${item.productId}"`] };
      }
      if (product.stock < item.quantity) {
        const suggestion = this.suggestSubstitute(product);
        const reasons = [
          `"${product.name}" is out of stock (requested ${item.quantity}, available ${product.stock})`,
        ];
        if (suggestion) reasons.push(`suggested substitute: "${suggestion.name}" (${suggestion.id})`);
        await this.auditLog.record({
          actor: request.actor,
          action: "checkout_declined",
          status: "denied",
          reasons,
          details: { outOfStockProductId: product.id, suggestionId: suggestion?.id },
        });
        return { status: "declined", reasons, suggestion };
      }
      resolved.push({ product, quantity: item.quantity });
    }

    const amount = resolved.reduce((sum, r) => sum + r.product.price * r.quantity, 0);
    const currency = this.catalog.merchant.currency;
    const items = resolved.map((r) => ({ name: r.product.name, category: r.product.category }));

    const decision = await this.policy.evaluate({ actor: request.actor, amount, currency, items });
    await this.auditLog.record({
      actor: request.actor,
      action: "policy_evaluated",
      amount,
      currency,
      status: decision.allowed ? "allowed" : "denied",
      reasons: decision.reasons,
    });

    if (!decision.allowed) {
      return { status: "declined", reasons: decision.reasons };
    }

    if (decision.requiresGate) {
      const approvalId = `appr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      this.pendingApprovals.set(approvalId, {
        id: approvalId,
        actor: request.actor,
        items: resolved,
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

    return this.captureOrder(request.actor, resolved, amount, currency);
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
    return this.captureOrder(pending.actor, pending.items, pending.amount, pending.currency);
  }

  async deny(approvalId: string, deniedBy: string, reason: string): Promise<CheckoutResult> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return { status: "declined", reasons: [`no pending approval with id "${approvalId}"`] };
    }
    this.pendingApprovals.delete(approvalId);
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

  private async captureOrder(
    actor: string,
    items: { product: Product; quantity: number }[],
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
      const link = await this.razorpay.createPaymentLink({
        amount,
        currency,
        description: items.map((i) => `${i.quantity}x ${i.product.name}`).join(", "),
        referenceId: order.id,
      });
      await this.auditLog.record({
        actor,
        action: "payment_captured",
        amount,
        currency,
        orderId: order.id,
        status: "pending",
        reasons: ["real Razorpay payment link issued; awaiting human payment"],
        details: { paymentLinkUrl: link.short_url, paymentLinkId: link.id },
      });
      return {
        status: "captured",
        orderId: order.id,
        paymentId: link.id,
        amount,
        amountDisplay: formatInr(amount),
        currency,
        simulated: false,
        upsell: this.suggestUpsells(items),
      };
    }

    const payment = this.razorpay.simulateCapture(order.id, amount, currency);
    for (const { product, quantity } of items) {
      product.stock -= quantity;
    }
    await this.policy.commitSpend(actor, amount);
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
