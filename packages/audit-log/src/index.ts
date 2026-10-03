import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Every money-moving decision an agent makes gets one of these, in order,
 * before and after the fact. `prevHash`/`hash` form a tamper-evident chain:
 * editing or deleting a past entry breaks every hash after it, so the log
 * is provable, not just readable.
 */
export interface AuditEntry {
  seq: number;
  timestamp: string;
  actor: string;
  action:
    | "catalog_query"
    | "checkout_requested"
    | "policy_evaluated"
    | "gate_required"
    | "gate_approved"
    | "gate_denied"
    | "gate_expired"
    | "order_created"
    | "payment_pending"
    | "payment_captured"
    | "payment_failed"
    | "checkout_declined"
    | "upsell_offered";
  amount?: number;
  currency?: string;
  orderId?: string;
  status: "info" | "allowed" | "denied" | "pending" | "success" | "failure";
  reasons: string[];
  details?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export type AuditEntryInput = Omit<AuditEntry, "seq" | "timestamp" | "prevHash" | "hash">;

const GENESIS_HASH = "0".repeat(64);

function hashEntry(entry: Omit<AuditEntry, "hash">): string {
  const payload = JSON.stringify({
    seq: entry.seq,
    timestamp: entry.timestamp,
    actor: entry.actor,
    action: entry.action,
    amount: entry.amount ?? null,
    currency: entry.currency ?? null,
    orderId: entry.orderId ?? null,
    status: entry.status,
    reasons: entry.reasons,
    details: entry.details ?? null,
    prevHash: entry.prevHash,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export class AuditLog {
  private filePath: string;
  private seq = 0;
  private lastHash = GENESIS_HASH;
  private ready: Promise<void>;
  /** Tail of the write queue — every append chains onto it so entries are written strictly one at a time. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.ready = this.hydrate();
  }

  private async hydrate(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line) as AuditEntry;
        this.seq = entry.seq;
        this.lastHash = entry.hash;
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /**
   * Appends a new entry, chained to the previous one, and returns it.
   *
   * Calls are serialized: without this, two concurrent checkouts would both
   * read the same `lastHash` before either append finished, writing two
   * entries with the same `prevHash` and breaking the chain on honest traffic.
   */
  record(input: AuditEntryInput): Promise<AuditEntry> {
    const entry = this.writeQueue.then(() => this.append(input));
    // Keep the queue alive if one append fails; the caller still sees the rejection.
    this.writeQueue = entry.catch(() => undefined);
    return entry;
  }

  private async append(input: AuditEntryInput): Promise<AuditEntry> {
    await this.ready;
    const draft = {
      seq: this.seq + 1,
      timestamp: new Date().toISOString(),
      prevHash: this.lastHash,
      ...input,
    };
    const hash = hashEntry(draft);
    const entry: AuditEntry = { ...draft, hash };
    await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    // Only advance the chain once the entry is actually on disk.
    this.seq = draft.seq;
    this.lastHash = hash;
    return entry;
  }

  async readAll(): Promise<AuditEntry[]> {
    await this.ready;
    try {
      const raw = await readFile(this.filePath, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AuditEntry);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Recomputes every hash in the chain and reports the first break, if any. */
  async verifyChain(): Promise<{ valid: boolean; brokenAtSeq?: number }> {
    const entries = await this.readAll();
    let expectedPrev = GENESIS_HASH;
    for (const entry of entries) {
      if (entry.prevHash !== expectedPrev) return { valid: false, brokenAtSeq: entry.seq };
      const { hash, ...rest } = entry;
      const recomputed = hashEntry(rest);
      if (recomputed !== hash) return { valid: false, brokenAtSeq: entry.seq };
      expectedPrev = hash;
    }
    return { valid: true };
  }
}
