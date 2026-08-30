import Anthropic from "@anthropic-ai/sdk";
import { ACTOR_ID, runTool, tools } from "./tools.js";
import { fetchAuditLog, verifyAuditChain } from "./catalog-client.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

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
the merchant offers rather than stopping. When you're done, summarize what was purchased, what was \
declined, and why, in plain language a merchant operator could audit.`;

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  const client = new Anthropic({ apiKey });

  const goal = process.argv.slice(2).join(" ").trim() || DEFAULT_GOAL;
  console.log(`\n🛒 Buyer agent goal: ${goal}\n`);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: goal }];

  for (let turn = 0; turn < 8; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
    for (const block of textBlocks) {
      if (block.text.trim()) console.log(`🤖 ${block.text.trim()}\n`);
    }

    if (response.stop_reason !== "tool_use") {
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`   → calling ${block.name}(${JSON.stringify(block.input)})`);
      const result = await runTool(block.name, block.input as Record<string, unknown>);
      console.log(`   ← ${JSON.stringify(result)}\n`);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  console.log("──────────────────────────────────────────");
  console.log("Audit trail for this agent:");
  const entries = (await fetchAuditLog()).filter((e: { actor: string }) => e.actor === ACTOR_ID);
  for (const e of entries) {
    console.log(`  [${e.seq}] ${e.timestamp}  ${e.action.padEnd(20)} ${e.status.padEnd(9)} ${e.reasons.join("; ")}`);
  }
  const chain = await verifyAuditChain();
  console.log(chain.valid ? "\n✅ audit log hash chain verified — untampered" : `\n❌ audit log broken at seq ${chain.brokenAtSeq}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
