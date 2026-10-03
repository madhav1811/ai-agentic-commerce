#!/usr/bin/env node
import "./load-env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * Standards-based "agent-readable catalog": any MCP client (Claude Code,
 * Claude Desktop, another agent framework) can `list_products` and
 * `create_checkout` against this merchant without knowing its REST API.
 *
 * MCP clients spawn this as its own process, so it deliberately holds no
 * merchant state. Every tool forwards to the running catalog-server, which
 * owns the single CheckoutService: one stock count, one set of pending
 * approvals and holds, one audit-log writer. A gated MCP checkout can then be
 * approved through the same `/checkout/:id/approve` endpoint as any other.
 */
const BASE_URL = process.env.CATALOG_SERVER_URL ?? "http://localhost:4000";

const server = new McpServer({ name: "scalerai-bazaar-catalog", version: "0.1.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function callCatalog(path: string, init?: { method: "POST"; body: unknown }): Promise<ToolResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: init?.method ?? "GET",
      headers: init ? { "content-type": "application/json" } : undefined,
      body: init ? JSON.stringify(init.body) : undefined,
    });
  } catch (err) {
    const message =
      `could not reach the catalog-server at ${BASE_URL} (${(err as Error).message}). ` +
      "Start it with `npm run dev:catalog` before using this MCP server.";
    return { content: [{ type: "text", text: JSON.stringify({ error: "catalog_unreachable", message }) }], isError: true };
  }
  const text = await res.text();
  return { content: [{ type: "text", text }], isError: !res.ok || undefined };
}

server.tool(
  "list_products",
  "List every product in the merchant's catalog: id, name, price (minor units), currency, category, and live stock.",
  {},
  async () => callCatalog("/catalog")
);

server.tool(
  "get_product",
  "Fetch a single product by id.",
  { productId: z.string() },
  async ({ productId }) => callCatalog(`/catalog/${encodeURIComponent(productId)}`)
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
  async (criteria) => callCatalog("/recommend", { method: "POST", body: criteria })
);

server.tool(
  "create_checkout",
  "Attempt to buy one or more products as a named agent/buyer. Subject to the merchant's bounds " +
    "(max order amount, daily spend cap, allowed categories) and may require human approval " +
    "(status: pending_approval) before any payment is captured. Always inspect `reasons` in the " +
    "response — every allow/deny/gate decision is explained there. Status 'pending_payment' means a " +
    "real payment link was issued and nothing is paid yet — share its paymentUrl and use " +
    "check_payment_status; never call that a completed purchase. On status 'captured', check the " +
    "`upsell` array: each entry is a real, in-stock, frequently-paired product with its own reason " +
    "and pre-formatted price — offer the first one to the buyer as a follow-up, never invent one.",
  {
    actor: z.string().describe("Stable identifier for the buying agent, e.g. 'buyer-agent-claude'"),
    items: z
      .array(z.object({ productId: z.string(), quantity: z.number().int().positive() }))
      .min(1),
  },
  async ({ actor, items }) => callCatalog("/checkout", { method: "POST", body: { actor, items } })
);

server.tool(
  "check_payment_status",
  "Check whether a payment link from a 'pending_payment' checkout has been paid. Returns 'captured' " +
    "once paid, 'payment_failed' if the link expired or was cancelled, or 'pending_payment' if not yet paid.",
  { paymentLinkId: z.string() },
  async ({ paymentLinkId }) => callCatalog(`/payments/${encodeURIComponent(paymentLinkId)}`)
);

server.tool(
  "check_order_status",
  "Read the full, tamper-evident audit trail for a given actor, most recent first.",
  { actor: z.string() },
  async ({ actor }) => {
    const result = await callCatalog("/audit-log");
    if (result.isError) return result;
    const entries = (JSON.parse(result.content[0].text) as { actor: string }[])
      .filter((e) => e.actor === actor)
      .reverse();
    return { content: [{ type: "text", text: JSON.stringify(entries) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
