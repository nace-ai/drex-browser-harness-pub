import { RunLimit } from "./run-budget.ts";
import type { RunBudget } from "./run-budget.ts";
import type { DrexAnswer, DrexReply, DrexBody, Questions, RequestUsage } from "./types.ts";
// Drex Max client: one POST /v1/systemone per decision, with images. Production reads images since 2026-10-18
// (checked: a blank page and an app screen get opposite answers, same as the test console).
// Price: $0.06 per million input tokens, output free.

export const DREX_URL = "https://console.nace.ai/v1/systemone";
export const DREX_MODEL = "drex-max";
export const USD_PER_INPUT_TOKEN = 0.06e-6;

// Admission reserves the request's own size with a margin (text at ~3 characters a token, each image well above the
// 2,000-3,000 tokens a screenshot costs), at most MAX_INPUT_TOKENS; the provider's usage then settles it. A request
// that costs more than reserved is still settled in full, and the run stops at its next check.
const MAX_INPUT_TOKENS = 131072;
export function reservationTokens(state: unknown, questions: Questions, images: string[] = []): number {
  const text = JSON.stringify({ state, questions }).length;
  return Math.min(MAX_INPUT_TOKENS, Math.ceil(2 * (text / 3 + 4096 * images.length)) + 1024);
}

/** A key whose account can't use Drex Max. Prod answers a text-only request for it with its default model (HTTP 200,
 * "model": "drex-v2.0") instead of an error, and one with screenshots with HTTP 422 "images require drex-max": either
 * way the run stops at once and says so. */
export class WrongModel extends Error {}
const named = (model: string): string => (model === DREX_MODEL ? "Drex Max" : model);
const ASK = "Ask the Drex team to turn it on for the account, or use a key from an account that has it.";
export const wrongModelMessage = (want: string, got: unknown): string =>
  `This Drex key gets ${String(got)}, not ${named(want)}: its account doesn't have ${named(want)} yet. ${ASK}`;
const noModelMessage = (want: string, said: string): string =>
  `This Drex key can't use ${named(want)}: its account doesn't have ${named(want)} yet (Drex said: ${said}). ${ASK}`;

const requestError = <E extends Error>(
  error: E,
  ms: number,
  usd: number | null = null,
  usage: RequestUsage | null = null,
) => Object.assign(error, { physicalCalls: 1, ms, usd, usage, costUnknown: usd === null });

/** A reply's JSON body. null (or undefined) has always thrown a TypeError at the first field read; this says so. Anything else is read field by field as unknown. */
export function bodyOf(json: unknown): DrexBody {
  if (json === null || json === undefined) throw new Error("Drex answered with an empty JSON body");
  return json;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RawQuestion = { type?: unknown; instructions?: unknown; criteria?: unknown } | null | undefined;

export class Drex {
  declare key: string;
  declare url: string;
  declare model: string;
  declare retryBaseMs: number;
  declare runBudget?: RunBudget;

  constructor({
    key,
    url = DREX_URL,
    model = DREX_MODEL,
    retryBaseMs = 2000,
  }: {
    key: string;
    url?: string;
    model?: string;
    retryBaseMs?: number;
  }) {
    this.key = key;
    this.url = url;
    this.model = model;
    this.retryBaseMs = retryBaseMs;
  }

  /** Waits before the next attempt; within a capped run, only while the run's deadline leaves room for it. */
  async backoff(attempt: number, last: string): Promise<void> {
    const wait = Math.min(this.retryBaseMs * (attempt + 1), this.retryBaseMs * 4);
    if (this.runBudget && this.runBudget.remainingMs() <= wait)
      throw new RunLimit(`Run time limit reached while retrying Drex: ${last}`);
    await sleep(wait);
  }

  /** questions: {name: {type: "choice", instructions, criteria: {key: description}} | {type: "noul", instructions}} */
  async ask(state: unknown, questions: Questions, images: string[] = []): Promise<DrexReply> {
    const asked: unknown = questions;
    if (
      !asked ||
      typeof asked !== "object" ||
      Array.isArray(asked) ||
      !Object.keys(asked).length ||
      Object.keys(asked).length > 16
    ) {
      throw new Error("Drex questions must contain between 1 and 16 named questions");
    }
    for (const q of Object.values(asked as Record<string, RawQuestion>)) {
      if (!q || !(["choice", "noul"] as unknown[]).includes(q.type) || typeof q.instructions !== "string")
        throw new Error("Invalid Drex question type or instructions");
      if (
        q.type === "choice" &&
        (!q.criteria ||
          typeof q.criteria !== "object" ||
          Array.isArray(q.criteria) ||
          !Object.keys(q.criteria).length ||
          Object.values(q.criteria).some((v) => typeof v !== "string"))
      ) {
        throw new Error("Drex choice criteria must be a nonempty named string map");
      }
    }
    const body = JSON.stringify({ model: this.model, state, questions, images });
    const reserve = reservationTokens(state, questions, images) * USD_PER_INPUT_TOKEN;
    let last = "";
    for (let attempt = 0; attempt < 7; attempt++) {
      // ~45 s of retries (with a run budget: as long as its deadline allows, and each retry passes its cost check):
      // rides out a short network drop or a 429/529 (prod caps in-flight requests per model). Error answers and
      // failed connections bill nothing, so they are released, not charged.
      const t0 = performance.now();
      let r: Response;
      const budget = this.runBudget;
      const ticket = budget?.reserve({ provider: "drex", maxCostUsd: reserve });
      const signal = this.runBudget
        ? AbortSignal.timeout(Math.max(1, Math.ceil(this.runBudget.remainingMs())))
        : undefined;
      try {
        r = await fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
          body,
          signal,
        });
      } catch (e) {
        if (budget && ticket && signal?.aborted) {
          // the run's deadline cut a request that was already sent: whether it was billed is unknown
          budget.settle(ticket, { usd: null });
          throw requestError(e as Error, performance.now() - t0);
        }
        if (budget && ticket) budget.settle(ticket, { dispatched: false });
        last = String(e);
        await this.backoff(attempt, last);
        continue;
      }
      const ms = performance.now() - t0;
      if (r.ok) {
        let json: unknown;
        try {
          json = await r.json();
        } catch (error) {
          if (budget && ticket) budget.settle(ticket, { usd: null });
          throw ticket ? requestError(error as Error, performance.now() - t0) : error;
        }
        const j = bodyOf(json);
        const usage: RequestUsage = j.usage || {};
        const tokens = usage.input_tokens;
        const known = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0;
        const usd = known ? tokens * USD_PER_INPUT_TOKEN : null;
        if (budget && ticket) {
          // a 2xx answer without usage was billed for an unknown amount: the run stops with the reservation kept
          budget.settle(ticket, { usd });
          if (!known)
            throw requestError(new Error("Drex response has no billable usage; run paused with reserved cost."), ms);
          try {
            budget.check();
          } catch (error) {
            throw requestError(error as Error, ms, usd, usage);
          }
        }
        if (j.model && j.model !== this.model)
          throw requestError(new WrongModel(wrongModelMessage(this.model, j.model)), ms, usd, usage);
        return { answers: j.answers as DrexReply["answers"], usage, ms, usd: usd ?? 0, requestId: j.request_id };
      }
      if (budget && ticket) budget.settle(ticket, { dispatched: false });
      const text = await r.text().catch(() => "");
      last = `HTTP ${r.status}: ${text.slice(0, 300)}`;
      if (r.status === 401 || r.status === 403) throw new Error(`Drex key rejected (${last})`);
      const said =
        r.status === 422 && /requires? drex-max/i.test(text)
          ? (/"message":"([^"]*)"/.exec(text) ?? [undefined, text.slice(0, 120)])[1]
          : null;
      if (said) throw new WrongModel(noModelMessage(this.model, said));
      if (r.status < 500 && r.status !== 429) break;
      await this.backoff(attempt, last);
    }
    throw new Error(`Drex call failed: ${last}`);
  }
}

/** A reply's answer to one question. A reply without answers, or without this one, has always thrown a TypeError at the first field read; this says so. */
function answerOf(reply: DrexReply, name: string): DrexAnswer {
  const a = reply.answers?.[name];
  if (!a) throw new Error(`Drex reply has no answer "${name}"`);
  return a;
}

/** The chosen option of a choice question, its probability (undefined if the reply has none for it), and every option's probability. */
export function pick(
  reply: DrexReply,
  name: string,
): { choice: string | undefined; p: number | undefined; probs: Record<string, number> } {
  const a = answerOf(reply, name);
  if (!a.probabilities) throw new Error(`Drex answer "${name}" has no probabilities`);
  return { choice: a.choice, p: a.probabilities[String(a.choice)], probs: a.probabilities };
}

/** The probability of "yes" for a yes/no (noul) question (undefined if the reply has none). */
export function yes(reply: DrexReply, name: string): number | undefined {
  return answerOf(reply, name).noul;
}
