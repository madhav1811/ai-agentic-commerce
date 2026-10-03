import { ACTOR_ID } from "./tools.js";
import { prompt, closePrompt } from "./human.js";
import { fetchAuditLog, verifyAuditChain } from "./catalog-client.js";
import { createSession, runTurn } from "./chat-engine.js";

async function main() {
  let goal = process.argv.slice(2).join(" ").trim();
  if (!goal) {
    goal = await prompt("🙋 Hi! What are you shopping for, and what's your budget?\n> ");
  }

  console.log(`\n🛒 Shopping for: ${goal}`);
  console.log(`   (running locally via Ollama — no API key, no cost. Type 'exit' any time to stop.)\n`);

  const session = createSession();
  let humanReply: string | undefined = goal;

  for (;;) {
    const result = await runTurn(session, humanReply);

    for (const step of result.steps) {
      if (step.thinking) console.log(`\n🤖 ${step.thinking}`);
      for (const call of step.calls) {
        console.log(`   → calling ${call.name}(${JSON.stringify(call.arguments)})`);
        console.log(`   ← ${JSON.stringify(call.result)}`);
      }
    }

    console.log(`\n🤖 ${result.reply}`);
    if (result.ended) break;

    humanReply = await prompt("\n🙋 > ");
  }

  closePrompt();
  console.log("\n──────────────────────────────────────────");
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
