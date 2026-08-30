import express from "express";
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
    const product = service.getProduct(req.params.id);
    if (!product) return res.status(404).json({ error: "not_found" });
    res.json(product);
  });

  app.post("/checkout", async (req, res) => {
    const parsed = checkoutRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const result = await service.requestCheckout(parsed.data);
    res.json(result);
  });

  app.post("/checkout/:approvalId/approve", async (req, res) => {
    if (req.header("x-approval-token") !== config.approvalToken) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const approvedBy = (req.body?.approvedBy as string | undefined) ?? "human-operator";
    const result = await service.approve(req.params.approvalId, approvedBy);
    res.json(result);
  });

  app.post("/checkout/:approvalId/deny", async (req, res) => {
    if (req.header("x-approval-token") !== config.approvalToken) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const deniedBy = (req.body?.deniedBy as string | undefined) ?? "human-operator";
    const reason = (req.body?.reason as string | undefined) ?? "not specified";
    const result = await service.deny(req.params.approvalId, deniedBy, reason);
    res.json(result);
  });

  app.get("/audit-log", async (_req, res) => {
    const entries = await service.auditLog.readAll();
    res.json(entries);
  });

  app.get("/audit-log/verify", async (_req, res) => {
    const result = await service.auditLog.verifyChain();
    res.json(result);
  });

  app.get("/dashboard", (_req, res) => {
    res.type("html").send(dashboardHtml);
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
      <td>\${e.seq}</td>
      <td>\${e.timestamp}</td>
      <td>\${e.actor}</td>
      <td><code>\${e.action}</code></td>
      <td>\${e.amount ? (e.amount / 100).toFixed(2) + ' ' + (e.currency || '') : ''}</td>
      <td class="status-\${e.status}">\${e.status}</td>
      <td>\${(e.reasons || []).join('; ')}</td>
    </tr>\`).join('');
}
load();
setInterval(load, 4000);
</script>
</body>
</html>`;
