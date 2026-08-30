import { createInterface } from "node:readline/promises";
import { operatorApprove, operatorDeny } from "./catalog-client.js";

/**
 * Stands in for the human merchant operator who reviews gated checkouts.
 * This runs entirely outside the LLM's tool loop — the agent proposes a
 * checkout, sees a "pending_approval" result, and can only wait for this
 * to resolve. It never gets the approval token or a way to call these
 * endpoints itself.
 */
export async function reviewGate(approvalId: string, amount: number, currency: string, reasons: string[]) {
  console.log("\n⚠️  GATE TRIGGERED — human approval required before any money moves");
  console.log(`   amount: ${(amount / 100).toFixed(2)} ${currency}`);
  for (const reason of reasons) console.log(`   reason: ${reason}`);

  if (process.env.AUTO_APPROVE === "false") {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("   Approve this checkout? (y/n) ");
    rl.close();
    if (answer.trim().toLowerCase().startsWith("y")) {
      console.log("   → approved by human-operator\n");
      return operatorApprove(approvalId, "human-operator");
    }
    console.log("   → denied by human-operator\n");
    return operatorDeny(approvalId, "human-operator", "declined interactively");
  }

  console.log("   AUTO_APPROVE is on (demo mode) → simulating operator approval\n");
  return operatorApprove(approvalId, "demo-operator (AUTO_APPROVE)");
}
