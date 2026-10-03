import { randomUUID } from "node:crypto";
import express from "express";
import { ACTOR_ID } from "./tools.js";
import { fetchAuditLog, verifyAuditChain } from "./catalog-client.js";
import { createSession, runTurn, type Session } from "./chat-engine.js";

const PORT = Number(process.env.UI_PORT ?? 4100);
const CATALOG_SERVER_URL = process.env.CATALOG_SERVER_URL ?? "http://localhost:4000";

if (process.env.AUTO_APPROVE === "false") {
  console.warn(
    "⚠️  AUTO_APPROVE=false has no browser approval flow yet — forcing AUTO_APPROVE=true for this " +
      "process so a gated checkout auto-approves instead of the request hanging. For interactive " +
      "approve/deny, use the CLI buyer-agent instead (`npm run dev:agent`)."
  );
  process.env.AUTO_APPROVE = "true";
}

// In-memory only, same as the CLI's single in-process conversation — no
// persistence needed for a $0 local demo, and nothing here should survive a restart.
const sessions = new Map<string, Session>();

const app = express();
app.use(express.json());

app.get("/api/config", (_req, res) => {
  res.json({ catalogDashboardUrl: `${CATALOG_SERVER_URL}/dashboard` });
});

app.post("/api/session", (_req, res) => {
  const sessionId = randomUUID();
  sessions.set(sessionId, createSession());
  res.json({ sessionId });
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "invalid_request" });
  }
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "unknown_session" });

  try {
    const result = await runTurn(session, message.trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "agent_error", message: (err as Error).message });
  }
});

app.get("/api/audit", async (_req, res) => {
  const entries = (await fetchAuditLog()).filter((e: { actor: string }) => e.actor === ACTOR_ID);
  const chain = await verifyAuditChain();
  res.json({ entries, chain });
});

app.get("/", (_req, res) => {
  res.type("html").send(chatHtml);
});

app.listen(PORT, () => {
  console.log(`🛒 Buyer-agent chat UI → http://localhost:${PORT}`);
  console.log(`   (talking to the catalog server at ${CATALOG_SERVER_URL}, and Ollama locally — $0 either way)`);
});

const chatHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>AI Buyer Agent — ScaleraiBazaar</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    background: #0b0d10; color: #e6e6e6; margin: 0;
    display: flex; flex-direction: column; height: 100vh;
  }
  header {
    padding: 12px 20px; border-bottom: 1px solid #262a30;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header .sub { color: #9aa4af; font-size: 11px; }
  header button, header a.btn {
    background: #171b20; color: #9aa4af; border: 1px solid #262a30; border-radius: 6px;
    padding: 6px 10px; font-size: 11px; cursor: pointer; text-decoration: none;
  }
  header button:hover, header a.btn:hover { color: #e6e6e6; border-color: #3a3f47; }
  #log { flex: 1; overflow-y: auto; padding: 16px 20px; }
  .row { margin-bottom: 14px; display: flex; }
  .row.human { justify-content: flex-end; }
  .bubble {
    max-width: 70%; padding: 8px 12px; border-radius: 10px; font-size: 13px; line-height: 1.5;
    white-space: pre-wrap; word-wrap: break-word;
  }
  .row.agent .bubble { background: #14202b; border: 1px solid #1f3040; color: #cfe3f5; }
  .row.human .bubble { background: #16241a; border: 1px solid #24402c; color: #d6f5df; }
  .row.system .bubble { background: #241616; border: 1px solid #402424; color: #f5d6d6; font-style: italic; }
  .trace {
    margin: 6px 0 14px; padding: 8px 12px; border-radius: 8px; background: #101214;
    border: 1px solid #20242a; font-size: 11px; color: #8ab4ff; max-width: 85%;
  }
  .trace .thinking { color: #9aa4af; font-style: italic; margin-bottom: 6px; }
  .trace .call { margin-bottom: 4px; }
  .trace .call .name { color: #8ab4ff; }
  .trace .call .io { color: #6f7883; word-break: break-all; }
  #composer {
    display: flex; gap: 8px; padding: 12px 20px; border-top: 1px solid #262a30;
  }
  #composer input {
    flex: 1; background: #14171b; color: #e6e6e6; border: 1px solid #262a30; border-radius: 8px;
    padding: 10px 12px; font-size: 13px; font-family: inherit;
  }
  #composer input:disabled { opacity: 0.5; }
  #composer button {
    background: #2455a4; color: white; border: none; border-radius: 8px; padding: 10px 18px;
    font-size: 13px; cursor: pointer; font-family: inherit;
  }
  #composer button:disabled { opacity: 0.5; cursor: default; }
  .pending { color: #9aa4af; font-size: 12px; padding: 0 20px 8px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>🛒 AI Buyer Agent</h1>
    <div class="sub">local LLM via Ollama · $0 cost · talks to a real Razorpay test-mode merchant</div>
  </div>
  <div style="display:flex; gap:8px;">
    <a class="btn" id="dashboardLink" href="#" target="_blank">Audit dashboard ↗</a>
    <button id="newSession">New session</button>
  </div>
</header>
<div id="log"></div>
<div class="pending" id="pending" style="display:none;">🤖 thinking…</div>
<div id="composer">
  <input id="input" type="text" placeholder="What are you shopping for, and what's your budget?" autocomplete="off" />
  <button id="send">Send</button>
</div>
<script>
let sessionId = null;

const logEl = document.getElementById("log");
const pendingEl = document.getElementById("pending");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function addRow(role, text) {
  const row = document.createElement("div");
  row.className = "row " + role;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  row.appendChild(bubble);
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}

function addTrace(steps) {
  for (const step of steps) {
    const trace = document.createElement("div");
    trace.className = "trace";
    let html = "";
    if (step.thinking) html += '<div class="thinking">' + escapeHtml(step.thinking) + "</div>";
    for (const call of step.calls) {
      html +=
        '<div class="call"><span class="name">→ ' + escapeHtml(call.name) + "</span>" +
        '<div class="io">' + escapeHtml(JSON.stringify(call.arguments)) + "</div>" +
        '<div class="io">← ' + escapeHtml(JSON.stringify(call.result)) + "</div></div>";
    }
    trace.innerHTML = html;
    logEl.appendChild(trace);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function setBusy(busy) {
  inputEl.disabled = busy;
  sendEl.disabled = busy;
  pendingEl.style.display = busy ? "block" : "none";
}

async function startSession() {
  const res = await fetch("/api/session", { method: "POST" });
  const data = await res.json();
  sessionId = data.sessionId;
  logEl.innerHTML = "";
  addRow("agent", "Hi! What are you shopping for, and what's your budget?");
}

async function send() {
  const text = inputEl.value.trim();
  if (!text || !sessionId) return;
  addRow("human", text);
  inputEl.value = "";
  setBusy(true);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      addRow("system", "Error: " + (err.message || err.error || res.status));
      return;
    }
    const result = await res.json();
    addTrace(result.steps || []);
    addRow("agent", result.reply);
  } catch (err) {
    addRow("system", "Network error talking to the buyer-agent server: " + err.message);
  } finally {
    setBusy(false);
    inputEl.focus();
  }
}

sendEl.addEventListener("click", send);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") send();
});
document.getElementById("newSession").addEventListener("click", startSession);

fetch("/api/config").then((r) => r.json()).then((c) => {
  document.getElementById("dashboardLink").href = c.catalogDashboardUrl;
});

startSession();
</script>
</body>
</html>`;
