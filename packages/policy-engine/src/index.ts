import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

/**
 * Thrown by `commitSpend` when the spend *was* counted in memory but writing
 * the state file failed. Any other error from `commitSpend` means the spend
 * was not counted at all.
 */
export class SpendNotPersistedError extends Error {
  constructor(cause: unknown) {
    super(`spend counted in memory but not saved: ${(cause as Error)?.message ?? cause}`, { cause });
    this.name = "SpendNotPersistedError";
  }
}

/** The policy day (UTC date) a spend counts against. */
export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export class PolicyEngine {
  private config: PolicyConfig;
  private statePath: string;
  private state: PolicyState | null = null;
  /** In-flight (not yet captured) spend per actor. In memory, like the orders it guards. */
  private reservedByActor = new Map<string, number>();
  /**
   * Tail of the state queue. Loading, updating and writing the spend state run
   * one at a time, so concurrent captures can't interleave writes to the state
   * file, and two loads at the day rollover can't each install a fresh state.
   */
  private stateQueue: Promise<unknown> = Promise.resolve();

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

  /** Writes to a temp file and renames it over the real one, so a crash mid-write can't leave a truncated file. */
  private async saveState(): Promise<void> {
    if (!this.state) return;
    const tmpPath = `${this.statePath}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(this.state, null, 2), "utf8");
      await rename(tmpPath, this.statePath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.stateQueue.then(fn);
    this.stateQueue = run.catch(() => undefined);
    return run;
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

    const state = await this.serialize(() => this.loadState());
    const spentToday = state.spendByActor[request.actor] ?? 0;
    const reserved = this.reservedByActor.get(request.actor) ?? 0;
    if (allowed && spentToday + reserved + request.amount > this.config.maxDailySpendPerAgent) {
      allowed = false;
      reasons.push(
        `agent "${request.actor}" would exceed its daily spend bound (${spentToday} spent + ${reserved} held for in-flight orders + ${request.amount} requested > ${this.config.maxDailySpendPerAgent} limit)`
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

  /**
   * Holds `amount` against the actor's daily bound while an order is in flight
   * (awaiting human approval or an unpaid payment link), so in-flight orders
   * can't collectively exceed the cap. Pair every call with `release`.
   */
  reserve(actor: string, amount: number): void {
    this.reservedByActor.set(actor, (this.reservedByActor.get(actor) ?? 0) + amount);
  }

  release(actor: string, amount: number): void {
    const remaining = (this.reservedByActor.get(actor) ?? 0) - amount;
    if (remaining > 0) this.reservedByActor.set(actor, remaining);
    else this.reservedByActor.delete(actor);
  }

  /**
   * Call once a payment actually captures, to count it against the agent's
   * daily bound. Counts in memory first, then saves. Rejects with
   * `SpendNotPersistedError` if only the save failed (the spend still counts
   * for this process); any other rejection means it was not counted.
   *
   * `saleDay` is the day the payment captured (from `todayKey()` at that
   * moment). A commit retried after that day has ended resolves `false`
   * without counting: it belonged to a day whose cap no longer applies, and
   * must not eat into today's.
   */
  commitSpend(actor: string, amount: number, saleDay: string = todayKey()): Promise<boolean> {
    return this.serialize(async () => {
      const state = await this.loadState();
      if (state.date !== saleDay) return false;
      state.spendByActor[actor] = (state.spendByActor[actor] ?? 0) + amount;
      try {
        await this.saveState();
      } catch (err) {
        throw new SpendNotPersistedError(err);
      }
      return true;
    });
  }

  getConfig(): PolicyConfig {
    return this.config;
  }
}
