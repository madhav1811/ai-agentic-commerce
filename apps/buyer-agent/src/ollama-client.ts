import type { ToolDef } from "./tools.js";

const BASE_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b-instruct";

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaChatResponse {
  message: OllamaMessage;
  done: boolean;
}

/**
 * A single free, local, fully offline chat turn against Ollama — no API key,
 * no per-token billing, no network call beyond localhost. Requires
 * `ollama serve` running and the configured model pulled (`ollama pull qwen2.5:7b-instruct`).
 */
export async function chat(messages: OllamaMessage[], tools: ToolDef[]): Promise<OllamaMessage> {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools, stream: false }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Ollama request failed (${res.status}): ${text}\n` +
        `Is 'ollama serve' running, and have you run 'ollama pull ${MODEL}'?`
    );
  }
  const data = (await res.json()) as OllamaChatResponse;
  return data.message;
}
