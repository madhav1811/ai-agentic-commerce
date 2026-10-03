import Razorpay from "razorpay";
import { createHmac, randomUUID } from "node:crypto";

export interface RazorpayClientConfig {
  keyId: string;
  keySecret: string;
}

export interface CreateOrderInput {
  amount: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}

export interface CreatePaymentLinkInput {
  amount: number;
  currency: string;
  description: string;
  referenceId: string;
  notes?: Record<string, string>;
  /** Optional — the AI buyer flow has no real human contact details to prefill. */
  customer?: { name?: string; email?: string; contact?: string };
  /** Unix seconds; Razorpay requires at least 15 minutes in the future. */
  expireBy?: number;
}

/**
 * The id of the payment made against a paid link. The SDK types `payments` as
 * a single object, but the API returns an array of payments.
 */
export function paymentIdFromLink(link: unknown): string | undefined {
  const payments = (link as { payments?: { payment_id?: string }[] | null }).payments;
  return Array.isArray(payments) ? payments[0]?.payment_id : undefined;
}

/**
 * Thin wrapper around the Razorpay Node SDK, scoped to test mode.
 *
 * Order creation and payment links are real calls against Razorpay's
 * test-mode API. Actual card/UPI capture is intentionally NOT done
 * server-to-server here: Razorpay requires client-side tokenization
 * (Checkout.js or a hosted Payment Link page) for PCI-DSS compliance,
 * so there is no legitimate "just POST a card number" endpoint to call.
 *
 * Two capture paths are exposed, both explicit about what they are:
 *  - `createPaymentLink` returns a real, payable Razorpay test-mode URL.
 *    Pay it with a published Razorpay test card to see a genuine capture.
 *  - `simulateCapture` fabricates a captured-payment record shaped like
 *    Razorpay's real payload, for fully unattended agent-to-agent demos
 *    where no human is available to click the link. It is clearly logged
 *    as simulated everywhere it is used.
 */

interface RazorpaySdkError {
  statusCode: string | number;
  error: { code: string; description: string };
}

function isRazorpaySdkError(err: unknown): err is RazorpaySdkError {
  return (
    typeof err === "object" &&
    err !== null &&
    "error" in err &&
    typeof (err as { error?: unknown }).error === "object"
  );
}

/** The Node SDK rejects with a plain `{statusCode, error: {code, description}}` object, not an Error. */
/**
 * True if retrying the same call later could succeed: network failures (no
 * HTTP status), rate limits (429) and Razorpay server errors (5xx). Other
 * 4xx responses, such as 401 bad keys or 404 unknown id, won't fix themselves.
 */
export function isRetryableRazorpayError(err: unknown): boolean {
  if (!isRazorpaySdkError(err)) return true;
  const status = Number(err.statusCode);
  return !Number.isFinite(status) || status === 429 || status >= 500;
}

export function describeRazorpayError(err: unknown): string {
  if (isRazorpaySdkError(err)) {
    return `${err.error.code}: ${err.error.description} (HTTP ${err.statusCode})`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export class RazorpayClient {
  private client: Razorpay;

  constructor(config: RazorpayClientConfig) {
    this.client = new Razorpay({ key_id: config.keyId, key_secret: config.keySecret });
  }

  async createOrder(input: CreateOrderInput) {
    return this.client.orders.create({
      amount: input.amount,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes,
    });
  }

  async fetchOrder(orderId: string) {
    return this.client.orders.fetch(orderId);
  }

  async createPaymentLink(input: CreatePaymentLinkInput) {
    return this.client.paymentLink.create({
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      reference_id: input.referenceId,
      notes: input.notes,
      customer: input.customer ?? {},
      expire_by: input.expireBy,
      notify: { sms: false, email: false },
    });
  }

  async fetchPaymentLink(paymentLinkId: string) {
    return this.client.paymentLink.fetch(paymentLinkId);
  }

  async fetchPayment(paymentId: string) {
    return this.client.payments.fetch(paymentId);
  }

  /** Verifies an `x-razorpay-signature` webhook header against the raw request body. */
  static verifyWebhookSignature(rawBody: string, signature: string, webhookSecret: string): boolean {
    const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
    return expected === signature;
  }

  /**
   * Fabricates a captured-payment record for automated demo/test runs.
   * Never call this in a real merchant integration — it does not move money.
   */
  simulateCapture(orderId: string, amount: number, currency: string) {
    return {
      id: `pay_sim_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      order_id: orderId,
      amount,
      currency,
      status: "captured" as const,
      method: "simulated",
      simulated: true,
      captured_at: new Date().toISOString(),
    };
  }
}
