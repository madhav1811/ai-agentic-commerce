import { listProducts, requestCheckout } from "./catalog-client.js";
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
      name: "create_checkout",
      description:
        "Attempt to buy one or more products. This call is bounded (max order amount, daily spend cap, " +
        "allowed categories) and may pause for human approval if it crosses the merchant's gate threshold — " +
        "you will only ever see the final outcome (captured, declined, or payment_failed) with `reasons` " +
        "explaining the decision. You cannot approve your own gated checkout.",
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
];

export async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  if (name === "list_products") {
    return listProducts();
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

  throw new Error(`Unknown tool: ${name}`);
}
