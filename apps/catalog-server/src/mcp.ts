#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CheckoutService } from "./checkout-service.js";

/**
 * Standards-based "agent-readable catalog": any MCP client (Claude Code,
 * Claude Desktop, another agent framework) can `list_products` and
 * `create_checkout` against this merchant without knowing its REST API.
 * This is the same CheckoutService the HTTP server uses, so every bound,
 * gate, and audit-log entry applies identically over either transport.
 */
const service = new CheckoutService();
const server = new McpServer({ name: "scalerai-bazaar-catalog", version: "0.1.0" });

server.tool(
  "list_products",
  "List every product in the merchant's catalog: id, name, price (minor units), currency, category, and live stock.",
  {},
  async () => ({
    content: [
      { type: "text", text: JSON.stringify({ merchant: service.catalog.merchant, products: service.listProducts() }) },
    ],
  })
);

server.tool(
  "get_product",
  "Fetch a single product by id.",
  { productId: z.string() },
  async ({ productId }) => {
    const product = service.getProduct(productId);
    if (!product) return { content: [{ type: "text", text: JSON.stringify({ error: "not_found" }) }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(product) }] };
  }
);

server.tool(
  "recommend_products",
  "Rank real, in-stock candidates by rating and budget fit (optionally filtered by category and " +
    "required features). Returns each candidate with the concrete score breakdown behind it. Always " +
    "call this before telling anyone what 'the best' product is — never guess or rank from memory. " +
    "Call list_products first if you haven't already, so you know the real category strings and prices.",
  {
    category: z
      .string()
      .optional()
      .describe(
        "Must exactly match a category string already seen from list_products. If unsure, omit — " +
          "maxPrice and mustHave alone still filter correctly."
      ),
    maxPrice: z
      .number()
      .positive()
      .optional()
      .describe("In the catalog's minor currency unit (paise for INR) — multiply a rupee amount by 100."),
    mustHave: z.array(z.string()).optional(),
    excludeIds: z.array(z.string()).optional(),
  },
  async (criteria) => ({ content: [{ type: "text", text: JSON.stringify(service.recommend(criteria)) }] })
);

server.tool(
  "create_checkout",
  "Attempt to buy one or more products as a named agent/buyer. Subject to the merchant's bounds " +
    "(max order amount, daily spend cap, allowed categories) and may require human approval " +
    "(status: pending_approval) before any payment is captured. Always inspect `reasons` in the " +
    "response — every allow/deny/gate decision is explained there. On status 'captured', check the " +
    "`upsell` array: each entry is a real, in-stock, frequently-paired product with its own reason " +
    "and pre-formatted price — offer the first one to the buyer as a follow-up, never invent one.",
  {
    actor: z.string().describe("Stable identifier for the buying agent, e.g. 'buyer-agent-claude'"),
    items: z
      .array(z.object({ productId: z.string(), quantity: z.number().int().positive() }))
      .min(1),
  },
  async ({ actor, items }) => {
    const result = await service.requestCheckout({ actor, items });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "check_order_status",
  "Read the full, tamper-evident audit trail for a given actor, most recent first.",
  { actor: z.string() },
  async ({ actor }) => {
    const entries = (await service.auditLog.readAll()).filter((e) => e.actor === actor).reverse();
    return { content: [{ type: "text", text: JSON.stringify(entries) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
