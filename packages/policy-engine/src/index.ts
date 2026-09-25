import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Every bound an operator places on what an agent is allowed to spend,
 * on what, and when a human must approve before money moves.
 * Amounts are in the smallest currency unit (paise for INR), matching Razorpay.
 */
export interface PolicyConfig {
  currency: string;
  maxOrderAmount: number;
  maxDailySpendPerAgent: number;
  allowedCategories: string[];
  /** Orders at or above this amount require explicit human approval before checkout proceeds. */
  gateAboveAmount: number;
}

export interface CheckoutRequest {
  actor: string;
  amount: number;
  currency: string;
  /** Every line item in the cart. Each one's category is checked, not just the first. */
  items: { name: string; category: string }[];
}

export interface PolicyDecision {
  allowed: boolean;
  requiresGate: boolean;
  reasons: string[];
}

interface PolicyState {
  date: string;
  spendByActor: Record<string, number>;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export class PolicyEngine {
  private config: PolicyConfig;
  private statePath: string;
  private state: PolicyState | null = null;

  constructor(config: PolicyConfig, statePath: string) {
    this.config = config;
    this.statePath = statePath;
  }

  private async loadState(): Promise<PolicyState> {
    if (this.state && this.state.date === todayKey()) return this.state;
    await mkdir(dirname(this.statePath), { recursive: true });
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as PolicyState;
      if (parsed.date === todayKey()) {
        this.state = parsed;
        return this.state;
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.state = { date: todayKey(), spendByActor: {} };
    return this.state;
  }

  private async saveState(): Promise<void> {
    if (!this.state) return;
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  /** Pure evaluation against configured bounds. Does not mutate spend state. */
  async evaluate(request: CheckoutRequest): Promise<PolicyDecision> {
    const reasons: string[] = [];
    let allowed = true;

    if (request.currency !== this.config.currency) {
      allowed = false;
      reasons.push(
        `currency ${request.currency} is not the merchant's configured currency ${this.config.currency}`
      );
    }

    if (request.items.length === 0) {
      allowed = false;
      reasons.push("cart has no line items");
    }

    for (const item of request.items) {
      if (!this.config.allowedCategories.includes(item.category)) {
        allowed = false;
        reasons.push(
          `"${item.name}" is in category "${item.category}", which is not in the allowed list [${this.config.allowedCategories.join(", ")}]`
        );
      }
    }

    if (request.amount > this.config.maxOrderAmount) {
      allowed = false;
      reasons.push(
        `order amount ${request.amount} exceeds the max single-order bound of ${this.config.maxOrderAmount}`
      );
    }

    const state = await this.loadState();
    const spentToday = state.spendByActor[request.actor] ?? 0;
    if (allowed && spentToday + request.amount > this.config.maxDailySpendPerAgent) {
      allowed = false;
      reasons.push(
        `agent "${request.actor}" would exceed its daily spend bound (${spentToday} spent + ${request.amount} requested > ${this.config.maxDailySpendPerAgent} limit)`
      );
    }

    const requiresGate = allowed && request.amount >= this.config.gateAboveAmount;
    if (requiresGate) {
      reasons.push(
        `order amount ${request.amount} is at or above the human-approval gate threshold of ${this.config.gateAboveAmount}`
      );
    }

    if (allowed && !requiresGate) {
      reasons.push("within all configured bounds; no human approval required");
    }

    return { allowed, requiresGate, reasons };
  }

  /** Call once a payment actually captures, to count it against the agent's daily bound. */
  async commitSpend(actor: string, amount: number): Promise<void> {
    const state = await this.loadState();
    state.spendByActor[actor] = (state.spendByActor[actor] ?? 0) + amount;
    await this.saveState();
  }

  getConfig(): PolicyConfig {
    return this.config;
  }
}
