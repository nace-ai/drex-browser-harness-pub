import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Drex, USD_PER_INPUT_TOKEN, reservationTokens } from "../src/drex.ts";
import { LLM, transientError, unsentError } from "../src/llm.ts";
import { PRICES } from "../src/models.ts";
import { maxInputTokens } from "../src/providers.ts";
import { RunBudget, RunLimit, limitsFrom } from "../src/run-budget.ts";
import { EvidenceContext } from "../src/context.ts";
import { detailLabel, mutating } from "../src/macros.ts";
import { streamed } from "./stream-fake.mjs";

const dir = await mkdtemp(join(tmpdir(), "review-fixes-"));
await build({
  entryPoints: [join(resolve("src"), "agent.ts")],
  outdir: dir,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
});
const { Agent } = await import(pathToFileURL(join(dir, "agent.js")));
await rm(dir, { recursive: true, force: true });

const questions = { done: { type: "noul", instructions: "Task is done." } };
const reply = (usage = { input_tokens: 100, output_tokens: 20 }) => ({
  model: "claude-haiku-5-5",
  stop_reason: "end_turn",
  usage,
  content: [{ type: "text", text: JSON.stringify({ text: "ok" }) }],
});
const schema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
function llmWith(create) {
  const llm = streamed(
    new LLM({
      key: "fixture",
      retryBaseMs: 1,
      runOptions: { efficiency: { contextBudget: false, promptCache: false, cheapCollection: false } },
    }),
  );
  llm.runBudget = new RunBudget();
  llm.client.messages.countTokens = async () => ({ input_tokens: 100 });
  llm.client.messages.create = create;
  return llm;
}

test("Drex: one 529 then success keeps the run going and counts the cost once", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    ++calls === 1
      ? new Response("overloaded", { status: 529 })
      : new Response(JSON.stringify({ answers: { done: { noul: 0.9 } }, usage: { input_tokens: 1000 } })),
  );
  const drex = new Drex({ key: "fixture", retryBaseMs: 1 });
  drex.runBudget = new RunBudget();
  const r = await drex.ask("state", questions);
  assert.equal(calls, 2);
  assert.equal(r.usd, 1000 * USD_PER_INPUT_TOKEN);
  assert.equal(drex.runBudget.spentUsd, r.usd);
  assert.equal(drex.runBudget.reservedUsd, 0);
  assert.equal(drex.runBudget.calls.drex, 1);
  assert.equal(drex.runBudget.uncertain, false);
  drex.runBudget.check();
});

test("Drex: a dropped connection is retried, a 2xx without usage stops the run as uncertain", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ answers: { done: { noul: 1 } } }));
  });
  const drex = new Drex({ key: "fixture", retryBaseMs: 1 });
  drex.runBudget = new RunBudget();
  await assert.rejects(
    () => drex.ask("state", questions),
    (e) => e.costUnknown === true,
  );
  assert.equal(calls, 2);
  assert.equal(drex.runBudget.uncertain, true);
});

test("Drex reserves by request size, not the 131k-token maximum", () => {
  const small = reservationTokens("state", questions, ["img", "img"]);
  assert.ok(small < 20000 && small * USD_PER_INPUT_TOKEN < 0.0012);
  assert.equal(reservationTokens("x".repeat(2e6), questions), 131072);
});

test("LLM: one 529 then success keeps the run going and counts the cost once", async () => {
  let calls = 0;
  const llm = llmWith(async () => {
    if (++calls === 1) throw Object.assign(new Error("Overloaded"), { status: 529 });
    return reply();
  });
  const r = await llm.call({ purpose: "read", system: "s", schema, content: JSON.stringify({ task: "t" }) });
  assert.equal(calls, 2);
  assert.equal(r.physicalCalls, 1);
  assert.equal(r.usd, llm.cost("claude-haiku-5-5", { input_tokens: 100, output_tokens: 20 }));
  assert.equal(llm.runBudget.spentUsd, r.usd);
  assert.equal(llm.runBudget.calls.anthropic, 1);
  assert.equal(llm.runBudget.uncertain, false);
  llm.runBudget.check();
});

test("LLM: a 2xx without usage, or a timeout after sending, leaves the cost unknown", async () => {
  const noUsage = llmWith(async () => reply(null));
  await assert.rejects(noUsage.call({ purpose: "read", system: "s", schema, content: "{}" }), /usage/);
  assert.equal(noUsage.runBudget.uncertain, true);
  const timeout = llmWith(async () => {
    throw Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });
  });
  await assert.rejects(timeout.call({ purpose: "read", system: "s", schema, content: "{}" }), /timed out/);
  assert.equal(timeout.runBudget.uncertain, true);
  assert.equal(transientError(Object.assign(new Error("x"), { status: 429 })), true);
  assert.equal(transientError(Object.assign(new Error("bad"), { status: 400 })), false);
});

// A plan call's fetch failed ("Failed to fetch") through all three quick retries and the run ended before its
// first move. A request that never reached the server bills nothing and is tried longer.
test("LLM: a request that never reached the server is retried longer than an error answer, and bills nothing", async () => {
  let calls = 0;
  const flaky = llmWith(async () => {
    if (++calls <= 5) throw new TypeError("Failed to fetch");
    return reply({ input_tokens: 100, output_tokens: 20 });
  });
  const r = await flaky.call({ purpose: "read", system: "s", schema, content: "{}" });
  assert.equal(calls, 6);
  assert.equal(r.physicalCalls, 1);
  assert.equal(flaky.runBudget.uncertain, false);
  let overloaded = 0;
  const busy = llmWith(async () => {
    overloaded++;
    throw Object.assign(new Error("Overloaded"), { status: 529 });
  });
  await assert.rejects(busy.call({ purpose: "read", system: "s", schema, content: "{}" }), /Overloaded/);
  assert.equal(overloaded, 4); // an error answer keeps its three retries
  assert.equal(unsentError(new TypeError("Failed to fetch")), true);
  assert.equal(unsentError(Object.assign(new Error("Failed to fetch"), { status: 500 })), false);
  assert.equal(unsentError(new TypeError("Cannot read properties of undefined")), false);
});

test("an LLM call whose last attempt failed still counts the cost of the attempts before it", async () => {
  const a = new Agent({ drex: {}, llm: {}, emit() {} });
  a.t0 = performance.now();
  const error = Object.assign(new Error("lost"), { usd: null, knownCostUsd: 0.002, physicalCalls: 2, ms: 1 });
  await assert.rejects(
    a.llmCall("read", async () => {
      throw error;
    }),
    /lost/,
  );
  assert.equal(a.totals.llmUsd, 0.002);
  assert.equal(a.totals.llmCalls, 2);
});

test("default caps are 40 calls, 600 s and $0.08, and can be set from storage", () => {
  const a = new Agent({ drex: {}, llm: {}, emit() {} });
  assert.deepEqual(a.runBudget.limits, { maxHaikuCalls: 40, maxCostUsd: 0.08, maxSeconds: 600 });
  assert.deepEqual(limitsFrom({ maxSeconds: 900, maxHaikuCalls: 2.5, maxCostUsd: -1, other: 1 }), { maxSeconds: 900 });
  const b = new Agent({ drex: {}, llm: {}, emit() {}, runOptions: { limits: limitsFrom({ maxHaikuCalls: 30 }) } });
  assert.equal(b.runBudget.limits.maxHaikuCalls, 30);
  assert.equal(b.runBudget.limits.maxSeconds, 600);
});

test("collection contracts are remembered within a run only", async () => {
  const previous = globalThis.chrome,
    noop = { addListener() {}, removeListener() {} };
  globalThis.chrome = {
    tabs: { onCreated: noop },
    debugger: { onDetach: noop },
    windows: { getCurrent: async () => ({ id: 1 }), getLastFocused: async () => ({ id: 1 }) },
  };
  try {
    const llm = { contracts: new Map([["Find", Promise.resolve({ json: { intent: "enumerate_all" } })]]) };
    const a = new Agent({ drex: {}, llm, emit() {}, plan: { steps: [{ kind: "browse", goal: "g" }] } });
    a.windowTabs = async () => [];
    a.prepare = async () => {};
    a.browse = async () => ({});
    await a.run("Find");
    assert.equal(llm.contracts.size, 0);
  } finally {
    globalThis.chrome = previous;
  }
});

test("under the byte cap, a fill's fields survive and older notes go first", () => {
  const store = new EvidenceContext();
  const fields = Array.from({ length: 12 }, (_, i) => ({ label: `E${i}`, name: `Field ${i}`, role: "textbox" }));
  const notes = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`note${i}`, `Earlier observation ${i} `.repeat(40)]),
  );
  const out = store.compact({ task: "Fill the form", notes, fields }, { maxBytes: 4000 });
  const kept = out.evidence.map((e) => e.path);
  assert.ok(kept.filter((p) => p === "fields").length >= 1);
  const fieldChunks = [...store.entries.values()].filter((e) => e.path === "fields").length;
  assert.equal(kept.filter((p) => p === "fields").length, fieldChunks);
  assert.ok(out.context_incomplete);
});

test("only plain detail labels open records; claims, disputes, tickets and returns never do", () => {
  for (const ok of [
    "View Order",
    "View",
    "Details",
    "View details",
    "View order #1001",
    "View details for order 1001",
    "See details",
  ])
    assert.equal(detailLabel(ok), true, ok);
  for (const no of [
    "Open dispute",
    "Open return",
    "Open a claim",
    "Open ticket",
    "Open",
    "View refund",
    "Inspect",
    "Cancel order details",
  ])
    assert.equal(detailLabel(no), false, no);
  for (const w of ["Open a claim", "Open dispute", "Open ticket", "Start return", "Request refund"])
    assert.equal(mutating(w), true, w);
});

test("a deadline that stops retries is a budget stop (partial), not an error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("overloaded", { status: 529 }));
  const drex = new Drex({ key: "fixture", retryBaseMs: 1000 });
  drex.runBudget = new RunBudget({ maxSeconds: 0.05 });
  await assert.rejects(
    () => drex.ask("state", questions),
    (e) => e instanceof RunLimit && e.code === "run_budget_exhausted",
  );
  assert.equal(drex.runBudget.uncertain, false);
  const llm = llmWith(async () => {
    throw Object.assign(new Error("Overloaded"), { status: 529 });
  });
  llm.retryBaseMs = 1000;
  llm.runBudget = new RunBudget({ maxSeconds: 0.05 });
  await assert.rejects(llm.call({ purpose: "read", system: "s", schema, content: "{}" }), (e) => e instanceof RunLimit);
  assert.equal(llm.runBudget.uncertain, false);
});

test("an HTTP error answer (400/401) bills nothing: released, not an unknown cost", async () => {
  for (const status of [400, 401]) {
    let calls = 0;
    const llm = llmWith(async () => {
      calls++;
      throw Object.assign(new Error(`HTTP ${status}`), { status });
    });
    await assert.rejects(llm.call({ purpose: "read", system: "s", schema, content: "{}" }), new RegExp(String(status)));
    assert.equal(calls, 1); // not retried
    assert.equal(llm.runBudget.uncertain, false);
    assert.equal(llm.runBudget.reservedUsd, 0);
    assert.equal(llm.runBudget.calls.anthropic, 0);
    llm.runBudget.check();
  }
});

const unreadableError = () =>
  Object.assign(new Error("Failed to process successful response"), { status: 200, unreadable: true });
/** The LLM's reservations and the costs they were settled at, in order. */
function reservations(llm) {
  const ceilings = [];
  const settled = [];
  const reserve = llm.runBudget.reserve.bind(llm.runBudget);
  const settle = llm.runBudget.settle.bind(llm.runBudget);
  llm.runBudget.reserve = (request) => {
    ceilings.push(request.maxCostUsd);
    return reserve(request);
  };
  llm.runBudget.settle = (ticket, outcome) => {
    settled.push(outcome?.usd ?? null);
    return settle(ticket, outcome);
  };
  return { ceilings, settled };
}

test("LLM: a 200 answer that couldn't be read is settled at its reservation and sent again, not an unknown cost", async () => {
  let calls = 0;
  const llm = llmWith(async () => {
    if (++calls <= 2) throw unreadableError();
    return reply();
  });
  const { ceilings, settled } = reservations(llm);
  const r = await llm.call({ purpose: "read", system: "s", schema, content: JSON.stringify({ task: "t" }) });
  assert.equal(calls, 3);
  assert.equal(r.unreadable, 2);
  assert.equal(r.unreadableCauses.length, 2);
  assert.equal(r.physicalCalls, 3);
  assert.equal(llm.runBudget.calls.anthropic, 3);
  assert.equal(llm.runBudget.uncertain, false);
  assert.ok(settled[0] >= ceilings[0] && settled[1] >= ceilings[1]);
  const answered = llm.cost(llm.model, reply().usage);
  assert.ok(Math.abs(llm.runBudget.spentUsd - (settled[0] + settled[1] + answered)) < 1e-12);
  assert.ok(Math.abs(r.knownCostUsd - llm.runBudget.spentUsd) < 1e-12);
  llm.runBudget.check();
});

test("LLM: an unreadable answer whose input the estimate undercounts is settled at its byte bound, not its reservation", async () => {
  let calls = 0;
  let sent;
  const llm = llmWith(async (body) => {
    sent = body;
    if (++calls === 1) throw unreadableError();
    return reply();
  });
  const { ceilings, settled } = reservations(llm);
  // dense non-English text: the estimate (the fake count of 100 tokens) is far below what it can be billed for
  await llm.call({ purpose: "read", system: "s", schema, content: JSON.stringify({ task: "読む".repeat(2000) }) });
  const rates = PRICES[llm.model];
  const most = (maxInputTokens(sent) * rates[0] + sent.max_tokens * rates[1]) / 1e6;
  assert.ok(most > ceilings[0]);
  assert.ok(Math.abs(settled[0] - most) < 1e-12);
  assert.equal(llm.runBudget.uncertain, false);
});

test("LLM: an unreadable answer with no bound on its input (an image of unknown size) is an unknown cost, not resent", async () => {
  let calls = 0;
  const llm = llmWith(async () => {
    calls++;
    throw unreadableError();
  });
  llm.maxInput = () => null;
  const error = await llm
    .call({ purpose: "read", system: "s", schema, content: JSON.stringify({ task: "t" }) })
    .catch((e) => e);
  assert.equal(calls, 1);
  assert.equal(error.unreadable, true);
  assert.equal(llm.runBudget.uncertain, true);
});

test("LLM: a third unreadable answer in one call stops it with an unknown cost, after exactly two resends", async () => {
  let calls = 0;
  const llm = llmWith(async () => {
    calls++;
    throw unreadableError();
  });
  const error = await llm
    .call({ purpose: "read", system: "s", schema, content: JSON.stringify({ task: "t" }) })
    .catch((e) => e);
  assert.equal(calls, 3);
  assert.equal(error.unreadable, 2);
  assert.equal(error.physicalCalls, 3);
  assert.equal(llm.runBudget.calls.anthropic, 3);
  assert.equal(llm.runBudget.uncertain, true);
});

test("LLM: a mid-stream overload past its resends is not released as unbilled (its 529 came in a 200)", async () => {
  let calls = 0;
  const llm = llmWith(async () => {
    calls++;
    throw Object.assign(new Error("Overloaded"), { name: "AI_StreamProviderError", status: 529, unreadable: true });
  });
  await assert.rejects(llm.call({ purpose: "read", system: "s", schema, content: JSON.stringify({ task: "t" }) }));
  assert.equal(calls, 3);
  assert.equal(llm.runBudget.calls.anthropic, 3);
  assert.equal(llm.runBudget.uncertain, true);
});

test("LLM: an unreadable answer with no time left for the backoff ends the run as a time limit, its cost settled", async () => {
  let calls = 0;
  const llm = llmWith(async () => {
    calls++;
    throw unreadableError();
  });
  llm.retryBaseMs = 60_000;
  llm.runBudget = new RunBudget({ maxSeconds: 30 });
  const { ceilings, settled } = reservations(llm);
  await assert.rejects(
    llm.call({ purpose: "read", system: "s", schema, content: JSON.stringify({ task: "t" }) }),
    (e) => e instanceof RunLimit && /while retrying/.test(e.message) && e.cause?.unreadable === true,
  );
  assert.equal(calls, 1);
  assert.ok(settled[0] >= ceilings[0]);
  assert.equal(llm.runBudget.spentUsd, settled[0]);
  assert.equal(llm.runBudget.uncertain, false);
});

test("LLM: a run stopped while an unreadable answer waits out its backoff sends nothing more", async () => {
  let calls = 0;
  const llm = llmWith(async () => {
    calls++;
    llm.runBudget.stop(); // Stop pressed while this answer was coming back
    throw unreadableError();
  });
  await assert.rejects(
    llm.call({ purpose: "read", system: "s", schema, content: JSON.stringify({ task: "t" }) }),
    (e) => e instanceof RunLimit && /stopped/.test(e.message),
  );
  assert.equal(calls, 1);
});

test("Agent: Stop stops the run's budget, so a model call still in flight retries nothing", () => {
  const a = new Agent({ drex: {}, llm: {}, emit() {} });
  a.stop();
  assert.throws(() => a.runBudget.reserve({ provider: "anthropic", maxCostUsd: 0.001 }), /stopped/);
});

test("Agent: a failed model call logs its cause chain; a call with resends logs what each was", async () => {
  const a = new Agent({ drex: {}, llm: {}, emit() {} });
  a.t0 = performance.now();
  const records = [];
  a.log = (kind, data) => records.push({ kind, ...data });
  await a.llmCall("read", async () => ({ usd: 0.001, physicalCalls: 3, unreadable: 2, unreadableCauses: ["a", "b"] }));
  const wrapped = Object.assign(new Error("Failed to process successful response"), {
    name: "AI_APICallError",
    cause: Object.assign(new Error("Response body is empty"), { name: "AI_EmptyResponseBodyError" }),
    requestBodyValues: { messages: "secret page text", key: "sk-ant-secret" },
  });
  await assert.rejects(
    a.llmCall("plan", async () => {
      throw wrapped;
    }),
  );
  assert.deepEqual(
    records.map((r) => r.kind),
    ["llm", "llm_error"],
  );
  assert.equal(records[0].unreadable_retries, 2);
  assert.deepEqual(records[0].unreadable_causes, ["a", "b"]);
  assert.equal(records[1].purpose, "plan");
  assert.match(records[1].error, /AI_EmptyResponseBodyError: Response body is empty/);
  assert.doesNotMatch(JSON.stringify(records), /secret/);
});

/** send() through the real AI SDK and Anthropic provider, the 200 answer given as server-sent events. */
async function sendWith(events, body) {
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const { send } = await import("../src/providers.ts");
  const sse = events?.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const model = createAnthropic({
    apiKey: "fixture",
    fetch: async () =>
      new Response(body === undefined ? sse : body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  })("claude-haiku-4-5");
  const request = {
    model: "claude-haiku-4-5",
    max_tokens: 100,
    system: "s",
    messages: [{ role: "user", content: [] }],
  };
  return send(request, { keys: {}, timeout: 5000, model }).catch((e) => e);
}
const started = {
  type: "message_start",
  message: {
    id: "m",
    type: "message",
    role: "assistant",
    model: "m",
    content: [],
    stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  },
};
const overloaded = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };

test("send: a 200 stream that breaks with an overload event mid-answer is an unreadable answer, not a $0 one", async () => {
  const text = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
  const delta = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"a":' } };
  const e = await sendWith([started, text, delta, overloaded]);
  assert.ok(e instanceof Error);
  assert.equal(e.unreadable, true);
  assert.equal(e.status, 529);
});

test("send: a 200 stream that closes before its last events is an unreadable answer, not a complete $0 one", async () => {
  const text = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
  const delta = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } };
  const e = await sendWith([started, text, delta]);
  assert.ok(e instanceof Error);
  assert.equal(e.unreadable, true);
});

test("send: an overload before the stream starts is a plain 529 (retried unbilled), not an unreadable answer", async () => {
  const e = await sendWith([overloaded]);
  assert.equal(e.status, 529);
  assert.equal(e.unreadable, undefined);
});

test("send: a 200 with no body, an empty body or a body that isn't the event stream is unreadable", async () => {
  for (const body of [null, "", '{"x":1}']) assert.equal((await sendWith(null, body)).unreadable, true, String(body));
});

test("describeError shows the cause chain beneath an SDK wrapper, and never throws on what it is given", async () => {
  const { describeError } = await import("../src/errors.ts");
  const empty = Object.assign(new Error("Response body is empty"), { name: "AI_EmptyResponseBodyError" });
  const wrapped = Object.assign(new Error("Failed to process successful response"), {
    name: "AI_APICallError",
    statusCode: 200,
    cause: empty,
    responseHeaders: { "request-id": "req_1", "content-type": "text/event-stream" },
  });
  assert.equal(
    describeError(wrapped),
    "AI_APICallError: Failed to process successful response, status 200, request-id req_1, content-type text/event-stream <- AI_EmptyResponseBodyError: Response body is empty",
  );
  assert.equal(describeError(Object.assign(Object.create(null), { message: 5 })), "Error: ");
  assert.equal(describeError(Object.assign(new Error("x"), { cause: "a string" })), "Error: x <- a string");
  const loop = new Error("loop");
  loop.cause = loop;
  assert.equal(describeError(loop).split(" <- ").length, 5);
  assert.equal(describeError(null), "");
});
