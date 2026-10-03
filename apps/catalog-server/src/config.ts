import "./load-env.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Catalog } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  razorpay: {
    keyId: env("RAZORPAY_KEY_ID", "rzp_test_placeholder"),
    keySecret: env("RAZORPAY_KEY_SECRET", "placeholder_secret"),
  },
  /** "simulated" runs fully unattended (no browser); "real_payment_link" returns a payable Razorpay test-mode URL. */
  paymentMode: (process.env.PAYMENT_MODE ?? "simulated") as "simulated" | "real_payment_link",
  approvalToken: env("APPROVAL_TOKEN", "demo-approver-token"),
  paths: {
    catalog: join(rootDir, "data", "catalog.json"),
    auditLog: join(rootDir, "..", "..", "data", "audit-log.jsonl"),
    policyState: join(rootDir, "..", "..", "data", "policy-state.json"),
  },
  policy: {
    currency: "INR",
    maxOrderAmount: 500000,
    maxDailySpendPerAgent: 1000000,
    allowedCategories: ["electronics", "accessories", "gift-cards"],
    gateAboveAmount: 300000,
  },
};

export function loadCatalog(): Catalog {
  const raw = readFileSync(config.paths.catalog, "utf8");
  return JSON.parse(raw) as Catalog;
}
