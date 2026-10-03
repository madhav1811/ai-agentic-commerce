import { chat, type OllamaMessage } from "./ollama-client.js";
import { runTool, tools } from "./tools.js";
import { isExitPhrase } from "./human.js";

export const MAX_TURNS = 40;

export const SYSTEM_PROMPT = `You are a conversational AI shopping assistant chatting live with one real \
human, against a real merchant's catalog over Razorpay test-mode APIs. This is an ordinary back-and-forth \
conversation: when you want to ask them something or check whether they want a recommendation, just say so \
in your reply — you do not need any special tool to talk to them, they will read what you write and reply \
directly in the next message.

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
6. Once create_checkout returns "pending_approval", give a final plain-language summary and stop \
shopping unless they ask for something new. Once it returns "captured", give the summary, then check \
its "upsell" array: if it has at least one entry, offer just the first one by name using its own \
priceDisplay and reason ("Want to add the <name> too — <reason>, <priceDisplay>? (yes/no)") and stop \
your turn there. If they say yes, call create_checkout again for that product id (quantity 1) and \
report the outcome, then stop. If they say no, or the array is empty, stop shopping unless they ask \
for something new. Never offer an upsell product that isn't actually in that array.
7. If create_checkout returns "pending_payment", nothing has been paid yet. Give the user its paymentUrl \
and its amountDisplay, ask them to pay it and tell you when they have, and stop your turn. When they say \
they've paid, call check_payment_status with its paymentLinkId and report exactly what it returns.

Never call create_checkout without an explicit yes from the human in this conversation first. Never \
claim a purchase happened unless create_checkout or check_payment_status actually returned status \
"captured" — "pending_payment" is not a purchase. Never guess a \
product id — only use ids you got from list_products, recommend_products, or an "upsell" entry. Never \
do paise-to-rupee math yourself — always quote the exact rupee amounts already given to you in \
"reasons", "amountDisplay", or "priceDisplay" fields; you are unreliable at that conversion so don't \
attempt it.`;

export interface ToolCallLogEntry {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface ConversationStep {
  thinking?: string;
  calls: ToolCallLogEntry[];
}

export interface TurnResult {
  reply: string;
  steps: ConversationStep[];
  ended: boolean;
}

export interface Session {
  messages: OllamaMessage[];
  turnsUsed: number;
}

export function createSession(): Session {
  return { messages: [{ role: "system", content: SYSTEM_PROMPT }], turnsUsed: 0 };
}

/**
 * One shared turn budget for the whole session (not per human message) — a
 * long reject/reject/accept negotiation and a direct-accept path should be
 * bounded by the same total number of model calls, matching the original
 * single-process CLI loop this was extracted from.
 */
export async function runTurn(session: Session, humanReply?: string): Promise<TurnResult> {
  if (humanReply !== undefined) {
    if (isExitPhrase(humanReply)) {
      return { reply: "👋 Ending the session.", steps: [], ended: true };
    }
    session.messages.push({ role: "user", content: humanReply });
  }

  const steps: ConversationStep[] = [];
  while (session.turnsUsed < MAX_TURNS) {
    session.turnsUsed++;
    const message = await chat(session.messages, tools);
    session.messages.push(message);

    if (message.tool_calls && message.tool_calls.length > 0) {
      const calls: ToolCallLogEntry[] = [];
      for (const call of message.tool_calls) {
        // A failing tool (unknown name, catalog-server down) becomes the tool's
        // result rather than an exception, so every tool call gets an answer and
        // the model can tell the user or try something else.
        let result: unknown;
        try {
          result = await runTool(call.function.name, call.function.arguments);
        } catch (err) {
          result = { error: "tool_failed", message: (err as Error).message };
        }
        calls.push({ name: call.function.name, arguments: call.function.arguments, result });
        session.messages.push({ role: "tool", content: JSON.stringify(result) });
      }
      steps.push({ thinking: message.content.trim() || undefined, calls });
      continue;
    }

    return { reply: message.content.trim(), steps, ended: false };
  }

  return {
    reply: "This session has used its maximum number of turns — please start a new session.",
    steps,
    ended: true,
  };
}
