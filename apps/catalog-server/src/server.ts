import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { CheckoutService } from "./checkout-service.js";

const checkoutItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive(),
});

const checkoutRequestSchema = z.object({
  actor: z.string().min(1),
  items: z.array(checkoutItemSchema).min(1),
});

const recommendRequestSchema = z.object({
  category: z.string().optional(),
  maxPrice: z.number().positive().optional(),
  mustHave: z.array(z.string()).optional(),
  excludeIds: z.array(z.string()).optional(),
});

/**
 * Express 4 doesn't catch rejected promises from async handlers: the request
 * hangs and the unhandled rejection kills the process, taking every in-memory
 * hold, approval and payment link with it. This forwards them to the error handler.
 */
function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    // `?? new Error(...)`: next() with no argument would fall through to a 404.
    handler(req, res).catch((err) => next(err ?? new Error("route handler rejected without an error")));
  };
}

export function createServer(service: CheckoutService) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, merchant: service.catalog.merchant.name, paymentMode: config.paymentMode });
  });

  // Agent-readable catalog: schema is stable and small enough for any LLM buyer
  // agent to reason over directly, mirroring the shape MCP's list_products tool returns.
  app.get("/catalog", (_req, res) => {
    res.json({
      schema_version: "1.0",
      merchant: service.catalog.merchant,
      products: service.listProducts(),
    });
  });

  app.get("/catalog/:id", (req, res) => {
    const product = service.getProductView(req.params.id);
    if (!product) return res.status(404).json({ error: "not_found" });
    res.json(product);
  });

  // Deterministic, explainable ranking — every candidate comes back with the
  // actual numbers behind its score, so a buyer agent (or a human) can be
  // told *why* something is "the best" instead of taking an LLM's word for it.
  app.post("/recommend", (req, res) => {
    const parsed = recommendRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }
    res.json({ candidates: service.recommend(parsed.data) });
  });

  app.post("/checkout", asyncRoute(async (req, res) => {
    const parsed = checkoutRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const result = await service.requestCheckout(parsed.data);
    res.json(result);
  }));

  app.post("/checkout/:approvalId/approve", asyncRoute(async (req, res) => {
    if (req.header("x-approval-token") !== config.approvalToken) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const approvedBy = (req.body?.approvedBy as string | undefined) ?? "human-operator";
    const result = await service.approve(req.params.approvalId, approvedBy);
    res.json(result);
  }));

  app.post("/checkout/:approvalId/deny", asyncRoute(async (req, res) => {
    if (req.header("x-approval-token") !== config.approvalToken) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const deniedBy = (req.body?.deniedBy as string | undefined) ?? "human-operator";
    const reason = (req.body?.reason as string | undefined) ?? "not specified";
    const result = await service.deny(req.params.approvalId, deniedBy, reason);
    res.json(result);
  }));

  // Confirms a payment link issued in real_payment_link mode. Only "paid" ever
  // turns into "captured"; until then the order stays pending_payment.
  app.get("/payments/:paymentLinkId", asyncRoute(async (req, res) => {
    const result = await service.checkPayment(req.params.paymentLinkId);
    res.json(result);
  }));

  app.get("/audit-log", asyncRoute(async (_req, res) => {
    const entries = await service.auditLog.readAll();
    res.json(entries);
  }));

  app.get("/audit-log/verify", asyncRoute(async (_req, res) => {
    const result = await service.auditLog.verifyChain();
    res.json(result);
  }));

  app.get("/dashboard", (_req, res) => {
    res.type("html").send(dashboardHtml);
  });

  // Last: turns any error (a rejected async route, a malformed JSON body) into
  // a JSON response instead of a hung request or a crashed server.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    // Too late to send an error body; let Express close the connection.
    if (res.headersSent) return next(err);
    const e = (err ?? {}) as { status?: unknown; expose?: unknown; message?: unknown };
    const status = typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status >= 500) {
      // Details (file paths, internal state) go to the server log, never to the caller.
      console.error("⚠️  request failed:", err);
      return res.status(500).json({ error: "internal_error", message: "internal error; see the server logs" });
    }
    // Client errors such as malformed JSON: body-parser marks its messages safe to show with `expose`.
    res.status(status).json({
      error: "bad_request",
      message: e.expose === true && typeof e.message === "string" ? e.message : "bad request",
    });
  });

  return app;
}

const dashboardHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Audit Trail — ScaleraiBazaar</title>
<style>
  body { font-family: ui-monospace, monospace; background: #0b0d10; color: #e6e6e6; margin: 0; padding: 24px; }
  h1 { font-size: 18px; }
  .chain { margin-bottom: 16px; padding: 8px 12px; border-radius: 6px; }
  .chain.valid { background: #113322; color: #6fd68f; }
  .chain.invalid { background: #3a1515; color: #ff7a7a; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #262a30; vertical-align: top; }
  th { color: #9aa4af; font-weight: 600; }
  .status-success, .status-allowed { color: #6fd68f; }
  .status-denied, .status-failure { color: #ff7a7a; }
  .status-pending { color: #ffcf6f; }
  .status-info { color: #9aa4af; }
  code { color: #8ab4ff; }
</style>
</head>
<body>
<h1>Audit Trail</h1>
<div id="chain" class="chain">checking hash chain…</div>
<table id="log">
  <thead><tr><th>#</th><th>time</th><th>actor</th><th>action</th><th>amount</th><th>status</th><th>reasons</th></tr></thead>
  <tbody></tbody>
</table>
<script>
// actor, reasons and the rest come from request bodies (anyone can POST
// /checkout), so every value is escaped before it touches innerHTML.
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function load() {
  const [entries, chain] = await Promise.all([
    fetch('/audit-log').then(r => r.json()),
    fetch('/audit-log/verify').then(r => r.json()),
  ]);
  const chainEl = document.getElementById('chain');
  chainEl.textContent = chain.valid ? '✅ hash chain verified — no tampering detected' : ('❌ chain broken at seq ' + chain.brokenAtSeq);
  chainEl.className = 'chain ' + (chain.valid ? 'valid' : 'invalid');
  const tbody = document.querySelector('#log tbody');
  tbody.innerHTML = entries.slice().reverse().map(e => \`
    <tr>
      <td>\${esc(e.seq)}</td>
      <td>\${esc(e.timestamp)}</td>
      <td>\${esc(e.actor)}</td>
      <td><code>\${esc(e.action)}</code></td>
      <td>\${e.amount ? esc((e.amount / 100).toFixed(2) + ' ' + (e.currency || '')) : ''}</td>
      <td class="status-\${esc(e.status)}">\${esc(e.status)}</td>
      <td>\${esc((e.reasons || []).join('; '))}</td>
    </tr>\`).join('');
}
load();
setInterval(load, 4000);
</script>
</body>
</html>`;
