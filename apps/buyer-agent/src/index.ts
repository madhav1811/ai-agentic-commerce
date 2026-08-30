import { chat, type OllamaMessage } from "./ollama-client.js";
import { ACTOR_ID, runTool, tools } from "./tools.js";
import { fetchAuditLog, verifyAuditChain } from "./catalog-client.js";

const DEFAULT_GOAL =
  "Buy the Pulse 2 Smartwatch for a fitness enthusiast. If it's unavailable, use the merchant's " +
  "own suggested substitute instead of giving up. Then, spend up to your remaining budget on one " +
  "more item you think pairs well with your first pick. Explain every decision you make.";

const SYSTEM_PROMPT = `You are an autonomous AI buyer agent transacting against a real merchant's \
agent-readable catalog over Razorpay test-mode APIs. You have tools to browse the catalog and \
attempt checkouts. Every checkout is bounded and may require human approval (a "gate") that you \
cannot bypass or approve yourself — if a checkout comes back pending or declined, treat that as \
real information and adapt, don't retry the exact same call. Narrate your reasoning briefly before \
each tool call: what you're buying and why. If an item is out of stock, use any suggested substitute \
the merchant offers rather than stopping. Always call list_products before create_checkout so you \
know real product ids, prices and stock — never guess an id. When you're done, summarize what was \
purchased, what was declined, and why, in plain language a merchant operator could audit. Do not \
call any tool more than once with the exact same arguments.`;

async function main() {
  const goal = process.argv.slice(2).join(" ").trim() || DEFAULT_GOAL;
  console.log(`\n🛒 Buyer agent goal: ${goal}`);
  console.log(`   (running locally via Ollama — no API key, no cost)\n`);

  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: goal },
  ];

  for (let turn = 0; turn < 8; turn++) {
    const message = await chat(messages, tools);

    if (message.content.trim()) {
      console.log(`🤖 ${message.content.trim()}\n`);
    }

    if (!message.tool_calls || message.tool_calls.length === 0) {
      messages.push(message);
      break;
    }

    messages.push(message);

    for (const call of message.tool_calls) {
      console.log(`   → calling ${call.function.name}(${JSON.stringify(call.function.arguments)})`);
      const result = await runTool(call.function.name, call.function.arguments);
      console.log(`   ← ${JSON.stringify(result)}\n`);
      messages.push({ role: "tool", content: JSON.stringify(result) });
    }
  }

  console.log("──────────────────────────────────────────");
  console.log("Audit trail for this agent:");
  const entries = (await fetchAuditLog()).filter((e: { actor: string }) => e.actor === ACTOR_ID);
  for (const e of entries) {
    console.log(`  [${e.seq}] ${e.timestamp}  ${e.action.padEnd(20)} ${e.status.padEnd(9)} ${e.reasons.join("; ")}`);
  }
  const chainResult = await verifyAuditChain();
  console.log(
    chainResult.valid
      ? "\n✅ audit log hash chain verified — untampered"
      : `\n❌ audit log broken at seq ${chainResult.brokenAtSeq}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
