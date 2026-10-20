import type { BudgetHold, BudgetProvider, BudgetSnapshot, BudgetTicket, LimitsInput, RunLimits } from "./types.ts";

/** Shared admission budget for one browser task, across every physical model request. */
export class RunLimit extends Error {
  declare code: string;
  constructor(message: string) {
    super(message);
    this.name = "RunLimit";
    this.code = "run_budget_exhausted";
  }
}

export class RunBudget {
  declare limits: RunLimits;
  declare now: () => number;
  declare start: number;
  declare pausedMs: number;
  declare pausedAt: number | null;
  declare uncertain: boolean;
  declare stopped: boolean;
  declare spentUsd: number;
  declare tickets: Map<number, BudgetTicket>;
  declare nextId: number;
  declare calls: Record<BudgetProvider, number>;
  /** A reserve that ordinary requests can't touch: the run's final answer, written however the run ends. */
  declare held: BudgetHold | null;

  constructor(
    { maxHaikuCalls = 40, maxCostUsd = 0.08, maxSeconds = 600 }: Partial<RunLimits> = {},
    now: () => number = () => performance.now(),
  ) {
    if (
      !Number.isInteger(maxHaikuCalls) ||
      maxHaikuCalls < 1 ||
      ![maxCostUsd, maxSeconds].every((value) => Number.isFinite(value) && value > 0)
    ) {
      throw new Error("Invalid run limits");
    }
    this.limits = { maxHaikuCalls, maxCostUsd, maxSeconds };
    this.now = now;
    this.start = now();
    this.pausedMs = 0; // time spent waiting for the user (approvals, hand-overs) doesn't count against the deadline
    this.pausedAt = null;
    this.uncertain = false;
    this.stopped = false;
    this.spentUsd = 0;
    this.tickets = new Map();
    this.nextId = 0;
    this.calls = { anthropic: 0, drex: 0 };
    this.held = null;
  }

  /** The time left for ordinary work: a held reserve's time is not part of it until release(). */
  remainingMs(): number {
    const elapsed = (this.pausedAt ?? this.now()) - this.start - this.pausedMs;
    return Math.max(0, Math.floor(this.limits.maxSeconds * 1000 - elapsed - (this.held?.ms ?? 0)));
  }

  /** Keeps calls, cost and time back from every ordinary request until release(): the run's final answer has room
   * whichever limit ends its other work. A hold larger than the limits leaves nothing back. */
  hold({ calls, usd, ms }: BudgetHold): void {
    if (![calls, usd, ms].every((value) => Number.isFinite(value) && value >= 0))
      throw new Error("Invalid budget hold");
    const fits =
      calls < this.limits.maxHaikuCalls && usd < this.limits.maxCostUsd && ms < this.limits.maxSeconds * 1000;
    this.held = fits ? { calls, usd, ms } : null;
  }

  /** Gives the held reserve back to the run (for its final answer). True when there was one. */
  release(): boolean {
    const had = this.held !== null;
    this.held = null;
    return had;
  }

  get heldUsd(): number {
    return this.held?.usd ?? 0;
  }

  /** The run waits for the user from now until resume(): the deadline's clock stops. */
  pause(): void {
    this.pausedAt ??= this.now();
  }

  resume(): void {
    if (this.pausedAt === null) return;
    this.pausedMs += this.now() - this.pausedAt;
    this.pausedAt = null;
  }

  /** The run was stopped: a model call still running (a retry waiting out its backoff) sends nothing more. */
  stop(): void {
    this.stopped = true;
  }

  check(): void {
    if (this.stopped) {
      throw new RunLimit("Run stopped");
    }
    if (this.uncertain) {
      throw new RunLimit("Run stopped because a dispatched request has unknown cost");
    }
    if (this.remainingMs() <= 0) {
      throw new RunLimit("Run time limit reached");
    }
    if (this.spentUsd + this.reservedUsd + this.heldUsd >= this.limits.maxCostUsd - 1e-12) {
      throw new RunLimit("Run cost limit reached");
    }
  }

  get reservedUsd(): number {
    return [...this.tickets.values()].reduce((sum, ticket) => sum + ticket.reserved, 0);
  }

  reserve({ provider, maxCostUsd }: { provider: BudgetProvider; maxCostUsd: number }): number {
    this.check();
    if (!["anthropic", "drex"].includes(provider) || !Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
      throw new Error("Invalid model cost reservation");
    }
    const pending = [...this.tickets.values()].filter(
      (ticket) => ticket.provider === "anthropic" && !ticket.settled,
    ).length;
    if (
      provider === "anthropic" &&
      this.calls.anthropic + pending + (this.held?.calls ?? 0) >= this.limits.maxHaikuCalls
    ) {
      throw new RunLimit("Run Haiku physical-call limit reached");
    }
    if (this.spentUsd + this.reservedUsd + this.heldUsd + maxCostUsd > this.limits.maxCostUsd + 1e-12) {
      throw new RunLimit("Request reservation exceeds remaining run cost");
    }
    const id = ++this.nextId;
    this.tickets.set(id, { provider, reserved: maxCostUsd, settled: false });
    return id;
  }

  settle(ticket: number, { usd = null, dispatched = true }: { usd?: number | null; dispatched?: boolean } = {}): void {
    const entry = this.tickets.get(ticket);
    if (!entry || entry.settled) {
      throw new Error("Unknown or already settled model reservation");
    }
    if (usd !== null && (!Number.isFinite(usd) || usd < 0)) {
      throw new Error("Invalid settled model cost");
    }
    entry.settled = true;
    if (dispatched && usd === null) this.uncertain = true;
    if (dispatched) this.calls[entry.provider]++;
    if (!dispatched || usd !== null) {
      this.tickets.delete(ticket);
      // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style -- a dispatched ticket reaching here has a cost; ! is banned by no-non-null-assertion
      if (dispatched) this.spentUsd += usd as number;
    }
    // Unknown billed usage retains its liability and blocks all further admission.
  }

  snapshot(): BudgetSnapshot {
    return {
      limits: { ...this.limits },
      knownCostUsd: this.spentUsd,
      reservedCostUsd: this.reservedUsd,
      unknownCost: this.uncertain,
      costComplete: !this.uncertain && this.tickets.size === 0,
      physicalCalls: { ...this.calls },
      remainingMs: this.remainingMs(),
    };
  }
}

/** Run limits set in the extension's storage (chrome.storage.local "runLimits", e.g. {"maxSeconds": 900}): only known,
 * valid values are kept; anything else falls back to the defaults. */
export function limitsFrom(value: LimitsInput): Partial<RunLimits> {
  const out: Partial<RunLimits> = {};
  if (!value || typeof value !== "object") return out;
  if (Number.isInteger(value.maxHaikuCalls) && (value.maxHaikuCalls as number) >= 1)
    out.maxHaikuCalls = value.maxHaikuCalls as number;
  for (const key of ["maxCostUsd", "maxSeconds"] as const)
    if (Number.isFinite(value[key]) && (value[key] as number) > 0) out[key] = value[key] as number;
  return out;
}
