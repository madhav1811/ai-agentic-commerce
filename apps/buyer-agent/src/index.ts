import { chat, type OllamaMessage } from "./ollama-client.js";
import { ACTOR_ID, runTool, tools } from "./tools.js";
import { prompt, isExitPhrase, closePrompt } from "./human.js";
import { fetchAuditLog, verifyAuditChain } from "./catalog-client.js";

const MAX_TURNS = 40;

const SYSTEM_PROMPT = `You are a conversational AI shopping assistant chatting live with one real \
human in this terminal, against a real merchant's catalog over Razorpay test-mode APIs. This is an \
ordinary back-and-forth conversation: when you want to ask them something or check whether they want \
a recommendation, just say so in your reply — you do not need any special tool to talk to them, they \
will read what you write and reply directly in the next message.

Your process for every shopping request:
1. If their message already states a budget and what they want, don't ask again — go to step 2. Only \
ask first if something essential (budget or category) is genuinely missing.
2. Call list_products first if you haven't already this conversation, so you know the exact category \
strings and real prices (in paise: ₹1 = 100). Then call recommend_products with the category/budget/ \
must-have features implied by their request — convert any rupee budget to paise (×100), and only pass \
a category you actually saw from list_products (omit it otherwise).
3. NEVER decide what's "best" yourself — recommend_products returns a real ranked list with numeric \
reasons (rating, price fit, feature match). Tell the user its #1 result and quote its actual reasons. \
Then ask plainly: "Want me to buy the <name> for ₹<price>? (yes/no)" — and stop your turn there so they \
can answer.
4. When their next message is affirmative, call create_checkout for exactly that product. This may \
pause for a separate human-approval gate on large amounts — that's normal, just report the outcome.
5. When their next message declines it, call recommend_products again with that product's id added to \
excludeIds, and repeat from step 3 with the new top result. If there are no more candidates, say so \
honestly and ask if they want to raise the budget or change what they're looking for.
6. Once create_checkout returns "captured" or "pending_approval", give a final plain-language summary \
and stop shopping unless they ask for something new.

Never call create_checkout without an explicit yes from the human in this conversation first. Never \
claim a purchase happened unless create_checkout actually returned status "captured". Never guess a \
product id — only use ids you got from list_products or recommend_products. Never do paise-to-rupee \
math yourself — always quote the exact rupee amounts already given to you in "reasons" or \
"amountDisplay" fields; you are unreliable at that conversion so don't attempt it.`;

async function main() {
  let goal = process.argv.slice(2).join(" ").trim();
  if (!goal) {
    goal = await prompt("🙋 Hi! What are you shopping for, and what's your budget?\n> ");
  }

  console.log(`\n🛒 Shopping for: ${goal}`);
  console.log(`   (running locally via Ollama — no API key, no cost. Type 'exit' any time to stop.)\n`);

  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: goal },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const message = await chat(messages, tools);
    messages.push(message);

    if (message.tool_calls && message.tool_calls.length > 0) {
      if (message.content.trim()) console.log(`\n🤖 ${message.content.trim()}`);
      for (const call of message.tool_calls) {
        console.log(`   → calling ${call.function.name}(${JSON.stringify(call.function.arguments)})`);
        const result = await runTool(call.function.name, call.function.arguments);
        console.log(`   ← ${JSON.stringify(result)}`);
        messages.push({ role: "tool", content: JSON.stringify(result) });
      }
      continue;
    }

    // No tool call: this message is directed at the human. Show it, then wait
    // for their real typed reply and feed it back in as the next turn.
    console.log(`\n🤖 ${message.content.trim()}`);
    const reply = await prompt("\n🙋 > ");
    if (isExitPhrase(reply)) {
      console.log("\n👋 Ending the session.");
      break;
    }
    messages.push({ role: "user", content: reply });
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
