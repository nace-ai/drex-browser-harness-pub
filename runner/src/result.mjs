// Turns the extension's finished run (LastRun: status, message, answer, record, totals, report) into the result shape
// of Drex's browser runs API (/v1/browser/runs), so an agent's code reads a local run and a cloud run the same way.
// Pure functions: tested without a browser.

/** outcome.kind → status, as Drex derives it. */
export const STATUS_OF = Object.freeze({
  completed: "succeeded",
  not_found: "succeeded",
  blocked_login: "partial",
  blocked_captcha: "partial",
  risky_action_denied: "partial",
  limit_reached: "partial",
  site_error: "failed",
  internal_error: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
});

const APPROVAL = /^Needs approval before this action: /; // agent.ts waitForUser, when a coding agent's run hands over
const CAPTCHA = /captcha|are you (a )?(human|robot)|verify (that )?you are (a )?human|press (and|&) hold|bot check/i;

/**
 * Why a run that handed the screen to a person stopped: a risky action it wasn't allowed, a CAPTCHA, or else a
 * sign-in. Any other hand-over (a choice only a person can make) is blocked_login too: it needs the person, and the
 * API has no kind of its own for it. page: what the runner saw on the agent's tab then ({title, captcha}), when it
 * could look.
 */
export function handoverKind(message, page = {}) {
  if (APPROVAL.test(message)) return "risky_action_denied";
  if (page.captcha || CAPTCHA.test(message) || CAPTCHA.test(page.title ?? "")) return "blocked_captcha";
  return "blocked_login";
}

/**
 * The outcome of a run. ended: how the runner ended it, when it did ("timeout": past --max-seconds and its grace;
 * "cancelled": a signal or the MCP client cancelled). page: the agent's tab, for a hand-over.
 */
export function outcomeOf(run, { ended = null, page = {} } = {}) {
  if (ended === "timeout") return { kind: "timed_out", reason: "The run went past its time limit and was stopped." };
  if (ended === "cancelled") return { kind: "cancelled", reason: "The run was cancelled." };
  const message = run?.message || null;
  switch (run?.status) {
    case "done":
      return { kind: "completed", reason: null };
    case "needs_user": {
      const kind = handoverKind(message ?? "", page);
      return { kind, reason: (message ?? "").replace(APPROVAL, "") || null };
    }
    case "partial": // a run limit ran out (time, cost, LLM calls, or a request whose cost is unknown)
      return { kind: "limit_reached", reason: message };
    case "failed": // the agent gave up: the steps kept failing on this site
      return { kind: "site_error", reason: message };
    case "stopped":
      return { kind: "cancelled", reason: message };
    default: // "error", or no run at all
      return { kind: "internal_error", reason: message || "The run ended without a result." };
  }
}

const int = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

/** Token counts from the run's log: each Drex and LLM request logs the usage its receipt reported. */
export function usageOf(run) {
  let drexIn = 0;
  let llmIn = 0;
  let llmOut = 0;
  for (const e of run?.record ?? []) {
    const t = e?.tokens;
    if (!t || typeof t !== "object") continue;
    if (e.type === "drex") drexIn += int(t.input_tokens);
    else if (e.type === "llm") {
      // cached input is input too: Drex bills LLM input tokens, cache reads and writes included
      llmIn += int(t.input_tokens) + int(t.cache_read_input_tokens) + int(t.cache_creation_input_tokens);
      llmOut += int(t.output_tokens);
    }
  }
  const totals = run?.totals ?? {};
  const num = (v) => (Number.isFinite(v) ? v : 0);
  return {
    drex_input_tokens: drexIn,
    llm_input_tokens: llmIn,
    llm_output_tokens: llmOut,
    drex_calls: int(totals.drexCalls),
    llm_calls: int(totals.llmCalls),
    browser_seconds: Math.round(num(totals.seconds)),
    cost_usd: +(num(totals.drexUsd) + num(totals.llmUsd)).toFixed(5),
  };
}

/**
 * The steps the run worked on, in order: {n, kind, goal, moves, result}. A replan replaces the plan the step
 * indexes point into, so each step is read from the plan in force when it started. A step still open when the run
 * ended takes the run's end as its result.
 */
export function stepsOf(run) {
  const steps = [];
  let plan = [];
  let open = null;
  const end = { done: "done", partial: "partial", failed: "failed", needs_user: "stopped", stopped: "stopped" };
  for (const e of run?.record ?? []) {
    if (e?.type === "plan" && Array.isArray(e.plan?.steps)) plan = e.plan.steps;
    else if (e?.type === "step" && Number.isInteger(e.index)) {
      if (e.status === "running") {
        if (open) open.result = "replanned"; // a step left without an end of its own: the plan changed under it
        const s = plan[e.index] ?? {};
        open = { n: steps.length + 1, kind: s.kind ?? "browse", goal: String(s.goal ?? ""), moves: 0, result: "" };
        steps.push(open);
      } else if (open) {
        open.result = e.status;
        open = null;
      }
    } else if (e?.type === "move" && open) open.moves++;
  }
  if (open) open.result = end[run?.status] ?? "failed";
  for (const s of steps) if (!s.result) s.result = "replanned";
  return steps;
}

/** Page facts the run checked (the LLM's verifications), as outcome.evidence: at most 20, the latest. */
export function evidenceOf(run) {
  const out = [];
  for (const e of run?.record ?? [])
    if (e?.type === "verification" && typeof e.evidence === "string" && e.evidence.trim())
      out.push({ url: typeof e.page === "string" ? e.page : null, text: e.evidence.slice(0, 2000) });
  return out.slice(-20);
}

/**
 * The run's result, in the shape of GET /v1/browser/runs/{id}, plus where the local artifacts are.
 * meta: {id, task, start_url, profile, created_at, started_at, finished_at, final_url, ended, page, artifacts}.
 * `answer` is the structured answer an answer_schema asks for; the runner takes no schema yet, so it is null and
 * the answer is in answer_text, as on the API without a schema.
 */
export function resultOf(run, meta = {}) {
  const outcome = { ...outcomeOf(run, meta), evidence: evidenceOf(run) };
  const status = STATUS_OF[outcome.kind] ?? "failed";
  const report = run?.report && typeof run.report === "object" && !run.report.error ? run.report : null;
  return {
    id: meta.id ?? null,
    object: "browser_run",
    mode: "local",
    status,
    task: meta.task ?? run?.task ?? null,
    start_url: meta.start_url ?? null,
    answer: null,
    answer_text: typeof run?.answer === "string" ? run.answer : "",
    outcome,
    final_url: meta.final_url ?? report?.url ?? null,
    steps: stepsOf(run),
    usage: usageOf(run),
    model: run?.model ?? null,
    profile: meta.profile ?? null,
    artifacts: meta.artifacts ?? [],
    created_at: meta.created_at ?? null,
    started_at: meta.started_at ?? run?.started ?? null,
    finished_at: meta.finished_at ?? null,
  };
}

/** A failure before any run: missing keys, no browser, a busy profile. Same envelope as the API's errors. */
export function errorOf(code, message) {
  return { error: { type: "runner_error", code, message } };
}
