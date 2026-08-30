import { createInterface, type Interface } from "node:readline/promises";

/**
 * One shared readline interface for the whole session. Creating a fresh
 * interface per prompt (and closing it) drops any input already buffered
 * on stdin after the first read — this keeps the taste-checkpoint loop
 * working across many back-and-forth turns.
 */
let rl: Interface | null = null;

function getInterface(): Interface {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

export async function prompt(label: string): Promise<string> {
  try {
    const answer = await getInterface().question(label);
    return answer.trim();
  } catch (err) {
    // A piped (non-tty) stdin can close itself between turns while the model
    // is thinking; recreate the interface once and retry rather than crashing.
    if ((err as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") {
      rl = null;
      const answer = await getInterface().question(label);
      return answer.trim();
    }
    throw err;
  }
}

export function closePrompt(): void {
  rl?.close();
  rl = null;
}

const EXIT_PHRASES = new Set(["exit", "quit", "stop", "bye", "goodbye", "done", "no more", "nothing else", "that's all"]);

export function isExitPhrase(text: string): boolean {
  return EXIT_PHRASES.has(text.trim().toLowerCase());
}
