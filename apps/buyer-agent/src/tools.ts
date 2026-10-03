import { checkPaymentStatus, listProducts, recommendProducts, requestCheckout } from "./catalog-client.js";
import { reviewGate } from "./operator.js";

export const ACTOR_ID = "buyer-agent-local-llm";

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "list_products",
      description:
        "List every product in the merchant's agent-readable catalog: id, name, price (in minor units, e.g. paise), currency, category, and live stock.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "recommend_products",
      description:
        "Rank real, in-stock candidates by rating and budget fit (optionally filtered by category and " +
        "required features). Returns each candidate with the concrete score breakdown behind it — rating, " +
        "price-vs-budget fit, matched features. Always call this before telling the user what 'the best' " +
        "product is; never guess or rank from memory. Call list_products first if you haven't already, so " +
        "you know the real category strings and prices this catalog actually uses.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Must exactly match a category string you already saw from list_products (e.g. 'electronics'). " +
              "If you haven't called list_products yet or aren't sure of the exact spelling, omit this field " +
              "entirely — maxPrice and mustHave alone will still filter correctly across all categories.",
          },
          maxPrice: {
            type: "number",
            description:
              "Must be in the catalog's minor currency unit, same as product prices (paise for INR) — " +
              "multiply a rupee amount by 100. E.g. a ₹3000 budget is maxPrice: 300000.",
          },
          mustHave: { type: "array", items: { type: "string" } },
          excludeIds: { type: "array", items: { type: "string" }, description: "product ids to skip, e.g. ones the user already rejected" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_checkout",
      description:
        "Attempt to buy one or more products. This call is bounded (max order amount, daily spend cap, " +
        "allowed categories) and may pause for human approval if it crosses the merchant's gate threshold — " +
        "you will only ever see the outcome (captured, pending_payment, declined, or payment_failed) with " +
        "`reasons` explaining the decision. You cannot approve your own gated checkout. 'pending_payment' " +
        "means a real payment link was issued and NOTHING is paid yet: give the user its paymentUrl and use " +
        "check_payment_status when they say they've paid. On status 'captured', the " +
        "response includes an `upsell` array of real, in-stock, frequently-paired products (each with its " +
        "own priceDisplay and reason) — never invent an upsell yourself, only offer what's actually there.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                productId: { type: "string" },
                quantity: { type: "integer", minimum: 1 },
              },
              required: ["productId", "quantity"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_payment_status",
      description:
        "Check whether the payment link from a 'pending_payment' checkout has been paid. Returns 'captured' " +
        "once paid, 'payment_failed' if the link expired or was cancelled, or 'pending_payment' if not paid yet.",
      parameters: {
        type: "object",
        properties: {
          paymentLinkId: { type: "string", description: "the paymentLinkId from the pending_payment result" },
        },
        required: ["paymentLinkId"],
      },
    },
  },
];

export async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  if (name === "list_products") {
    return listProducts();
  }

  if (name === "recommend_products") {
    return recommendProducts(
      input as { category?: string; maxPrice?: number; mustHave?: string[]; excludeIds?: string[] }
    );
  }

  if (name === "create_checkout") {
    const items = input.items as { productId: string; quantity: number }[];
    const result = await requestCheckout(ACTOR_ID, items);

    if (result.status === "pending_approval") {
      const resolved = await reviewGate(result.approvalId, result.amount, result.currency, result.reasons);
      return resolved;
    }

    return result;
  }

  if (name === "check_payment_status") {
    return checkPaymentStatus(String(input.paymentLinkId));
  }

  throw new Error(`Unknown tool: ${name}`);
}
