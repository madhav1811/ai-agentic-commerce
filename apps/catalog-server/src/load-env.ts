import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Loads the repo-root `.env` (from src/ or dist/ alike). Import this first in
 * every entry point: other modules read process.env at import time. Variables
 * already set in the real environment win over the file. `quiet` keeps dotenv
 * from logging to stdout, which would corrupt the MCP stdio stream.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const envPath = join(repoRoot, ".env");
loadDotenv({ path: envPath, quiet: true });

/**
 * Re-reads `.env`, this time letting its values replace ones already loaded.
 * Used to pick up rotated Razorpay keys without a restart (which would lose
 * every in-memory hold, approval and pending payment).
 */
export function reloadEnv(): void {
  loadDotenv({ path: envPath, quiet: true, override: true });
}
