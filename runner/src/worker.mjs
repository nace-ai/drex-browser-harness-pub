import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Ajv from "ajv";
import { DEFAULT_MODEL, runTask } from "./run.mjs";
import { HostedBudget } from "./hosted-budget.mjs";
import { modelTransport } from "./worker-transport.mjs";

export const PROTOCOL_VERSION = "2";
const schema = JSON.parse(await fs.readFile(new URL("../protocol/run-spec.v2.json", import.meta.url), "utf8"));
const validate = new Ajv({ strict: true, allowUnionTypes: true }).compile(schema);

const endpoint = (value, allowLocal) => {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.hash ||
    u.search ||
    !(allowLocal ? ["https:", "http:"] : ["https:"]).includes(u.protocol)
  )
    throw new Error("Invalid worker endpoint.");
  return u;
};
// "api.anthropic.com." is another origin to the browser but the same host to DNS and to the egress proxy
const bareHost = (host) => host.toLowerCase().replace(/\.+$/, "");

/** What a report needs: the run, its key and the Drex callback. Without these the worker cannot tell Drex anything. */
export function callbackConfig(env) {
  if (!/^brun_[0-9a-f]{32}$/.test(env.DREX_RUN_ID ?? "")) throw new Error("Invalid run id.");
  if (!/^whsec_[A-Za-z0-9+/]{43}=$/.test(env.DREX_CALLBACK_SECRET ?? "")) throw new Error("Invalid callback key.");
  const allowLocal = env.DREX_WORKER_ALLOW_LOCAL === "1";
  const drex = endpoint(env.DREX_BASE_URL, allowLocal);
  const callback = endpoint(env.DREX_CALLBACK_URL, allowLocal);
  if (callback.origin !== drex.origin || callback.pathname !== "/api/webhooks/browser-runs")
    throw new Error("Callback must belong to Drex.");
  return {
    allowLocal,
    drex: drex.href,
    callback: callback.href,
    runId: env.DREX_RUN_ID,
    callbackKey: Buffer.from(env.DREX_CALLBACK_SECRET.slice(6), "base64"),
  };
}

export function workerConfig(env) {
  const target = callbackConfig(env);
  if (env.DREX_PROTOCOL_VERSION !== PROTOCOL_VERSION) throw new Error("Unsupported browser protocol version.");
  const spec = JSON.parse(env.DREX_RUN_SPEC ?? "");
  if (!validate(spec)) throw new Error("Invalid browser run specification.");
  const drex = new URL(target.drex);
  const llm = endpoint(env.LLM_BASE_URL ?? "https://api.anthropic.com", target.allowLocal);
  // the transport calls /v1/... on these origins: a path prefix would be dropped silently
  if (drex.pathname !== "/" || llm.pathname !== "/") throw new Error("Invalid worker endpoint.");
  const forbidden = new Set([drex.hostname, llm.hostname, "console.nace.ai", "api.anthropic.com"].map(bareHost));
  for (const origin of spec.allowed_origins) {
    const u = new URL(origin);
    if (
      u.origin !== origin ||
      !["http:", "https:"].includes(u.protocol) ||
      (!target.allowLocal && (u.port || !u.hostname.includes(".") || u.hostname.endsWith(".local"))) ||
      forbidden.has(bareHost(u.hostname))
    )
      throw new Error("Invalid browser origin.");
  }
  const start = new URL(spec.start_url);
  if (start.username || start.password || !spec.allowed_origins.includes(start.origin))
    throw new Error("Start URL is not allowed.");
  return { ...target, spec, llm: llm.href };
}

export function finishedEvent(runId, result) {
  const allowed = new Set([
    "completed",
    "not_found",
    "blocked_login",
    "blocked_captcha",
    "risky_action_denied",
    "limit_reached",
    "site_error",
    "internal_error",
  ]);
  const kind = allowed.has(result.outcome.kind)
    ? result.outcome.kind
    : result.outcome.kind === "timed_out"
      ? "limit_reached"
      : "internal_error";
  return {
    type: "browser_run.finished",
    timestamp: new Date().toISOString(),
    data: {
      run_id: runId,
      outcome: {
        kind,
        reason: result.outcome.reason?.slice(0, 2000) ?? null,
        evidence: (result.outcome.evidence ?? []).slice(0, 20),
      },
      answer: result.answer ?? null,
      answer_text: result.answer_text?.slice(0, 20000) ?? null,
      final_url: result.final_url ?? null,
      steps: result.steps?.slice(0, 200) ?? [],
      usage: Object.fromEntries(
        ["drex_input_tokens", "llm_input_tokens", "llm_output_tokens"].map((k) => [
          k,
          Number.isSafeInteger(result.usage?.[k]) && result.usage[k] >= 0 ? result.usage[k] : 0,
        ]),
      ),
      // Local file paths are not public artifact links. Storage is a separate rollout dependency.
      artifacts: [],
    },
  };
}

const DELIVERY_MS = 30000;
// the window a funded report gets when its funds are already gone
const LAST_REPORT_MS = 1000;

export async function deliver(config, event, { timeoutMs = DELIVERY_MS } = {}) {
  const body = JSON.stringify(event);
  if (Buffer.byteLength(body) > 1_000_000) throw new Error("Worker report exceeds callback limit.");
  const id = `msg_${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", config.callbackKey).update(`${id}.${timestamp}.${body}`).digest("base64");
    let response;
    try {
      response = await fetch(config.callback, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": `v1,${signature}`,
        },
        body,
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
      });
    } catch {
      /* retry transient network failures, with the same event id/body */
    }
    if (response) {
      await response.body?.cancel().catch(() => {});
      if (response.ok) return;
      if (response.status < 500) throw new Error(`Callback refused (${response.status}).`);
    }
    const wait = Math.min(250 * 2 ** Math.min(attempt, 4), 4000, deadline - Date.now());
    if (wait > 0) await delay(wait);
  }
  throw new Error("Callback delivery deadline exceeded.");
}

// kept back from the run's own budget for the runner to read the extension's result before the hard stop
const REPORT_MS = 5000;

export async function runWorker(env = process.env, { signal } = {}) {
  let config;
  try {
    config = workerConfig(env);
  } catch (error) {
    // Drex settles a refused run (protocol, spec) as internal_error when it reports, not at its deadline. Without a
    // valid run id, key and callback (callbackConfig throws again) nothing can be reported.
    const target = callbackConfig(env);
    const event = finishedEvent(target.runId, {
      outcome: { kind: "internal_error", reason: "Browser worker refused its configuration." },
    });
    try {
      await deliver(target, event);
    } catch (failure) {
      // the refusal stays the error: its delivery failing is secondary
      throw Object.assign(error, { delivery: failure });
    }
    throw error;
  }
  const { spec } = config;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "drex-browser-run-"));
  const endsAt = Date.now() + spec.limits.max_seconds * 1000;
  const deadline = AbortSignal.timeout(spec.limits.max_seconds * 1000);
  // runTask is given no model, so the extension runs DEFAULT_MODEL, the model Drex pins LLM prices for
  const budget = new HostedBudget(spec.funding, { llmModel: DEFAULT_MODEL });
  const combined = AbortSignal.any([deadline, budget.signal, signal ?? new AbortController().signal]);
  let result;
  try {
    if (env.DREX_EXPECTED_WORKER_SHA) {
      const build = JSON.parse(await fs.readFile(new URL("../build-info.json", import.meta.url), "utf8"));
      if (build.dirty || build.sha !== env.DREX_EXPECTED_WORKER_SHA)
        throw new Error("Worker release does not match the selected build.");
    }
    combined.throwIfAborted();
    let task = spec.task;
    if (spec.answer_schema)
      task += `\nReturn your final answer as JSON matching this schema, without Markdown fences:\n${JSON.stringify(spec.answer_schema)}`;
    task += `\nOnly these sites can be opened; any other address is blocked: ${spec.allowed_origins.join(", ")}`;
    result = await runTask(
      {
        task,
        url: spec.start_url,
        allowedOrigins: spec.allowed_origins,
        tempProfile: true,
        profile: "worker",
        headed: false,
        allowRisky: false,
        out: directory,
        // the extension's budget starts after Chromium and the start page: it must end before this worker's deadline
        endsAt: endsAt - REPORT_MS,
        limits: {
          maxCostUsd: spec.limits.max_cost_usd,
          maxSeconds: spec.limits.max_seconds,
          maxLlmCalls: spec.limits.max_llm_calls,
        },
      },
      {
        // Only placeholders reach Chromium. Local keys stay in Node; E2B uses proxy injection.
        env: { DREX_API_KEY: "worker-transport", ANTHROPIC_API_KEY: "worker-transport" },
        signal: combined,
        // a funding stop is billed by the second: Chromium closes at once, without waiting for the agent's result,
        // which Drex discards for a budget stop or an unconfirmed provider outcome anyway
        killSignal: budget.signal,
        onCleanup: () => budget.beginCleanup(),
        handleSignals: false,
        allowLocal: config.allowLocal,
        transport: modelTransport({
          drexUrl: config.drex,
          llmUrl: config.llm,
          drexKey: env.DREX_API_KEY,
          llmKey: env.ANTHROPIC_API_KEY,
          signal: combined,
          budget,
        }),
      },
    );
    if (deadline.aborted && result.outcome.kind === "cancelled")
      result.outcome = { ...result.outcome, kind: "limit_reached", reason: "Run time limit reached." };
    if (spec.answer_schema) {
      try {
        result.answer = JSON.parse(result.answer_text);
      } catch {
        result.answer = null;
      } // Drex owns answer_invalid and settlement.
    }
  } catch {
    result = {
      outcome: {
        kind: deadline.aborted ? "limit_reached" : "internal_error",
        reason: deadline.aborted ? "Run time limit reached." : "Browser worker could not complete the run.",
      },
    };
  } finally {
    budget.beginCleanup();
    await fs.rm(directory, { recursive: true, force: true });
  }
  if (budget.held > 0n && !budget.signal.aborted) budget.stop(false);
  if (budget.signal.aborted && !budget.exhausted)
    result.outcome = { kind: "internal_error", reason: "A provider outcome could not be confirmed." };
  if (budget.exhausted) result.outcome = { kind: "limit_reached", reason: "Funded browser budget exhausted." };
  result.usage = budget.usage;
  const event = finishedEvent(config.runId, result);
  event.data.budget_exhausted = budget.exhausted;
  event.data.resource_bound_nusd = (
    budget.spent +
    budget.held +
    budget.elapsed * budget.prices.browser_second
  ).toString();
  budget.dispose();
  // the report is sent and retried only within the funded lifetime the cleanup reserve leaves; a 1-second window
  // is still given when nothing is left (a grant that expired before the run), so Drex hears of the run at all
  await deliver(config, event, {
    timeoutMs: Math.min(DELIVERY_MS, Math.max(LAST_REPORT_MS, budget.until(0n) - budget.now())),
  });
  return event;
}
