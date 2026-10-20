// The runner's result (runner/src/result.mjs): the extension's finished run, mapped to the shape of Drex's
// /v1/browser/runs, so an agent reads a local run and a cloud run the same way.
import assert from "node:assert/strict";
import { test } from "node:test";
import { STATUS_OF, handoverKind, outcomeOf, resultOf, stepsOf, usageOf } from "../runner/src/result.mjs";

/** A finished run as the extension's worker returns it (LastRun), with the log entries the mapping reads. */
const run = (over = {}) => ({
  task: "find the cheapest SSD",
  model: "claude-haiku-5-5",
  planning: true,
  started: "2026-10-20T06:00:00.000Z",
  status: "done",
  message: "",
  answer: "Samsung 870 EVO 1TB, $89.99",
  notes: {},
  totals: { drexUsd: 0.0021, llmUsd: 0.0013, drexCalls: 5, llmCalls: 3, drexMoves: 5, llmMoves: 0, seconds: 31.6 },
  report: {
    url: "https://shop.example.com/ssd/870",
    title: "870 EVO",
    screenshot: "data:image/jpeg;base64,AA==",
    problems: [],
  },
  record: [
    {
      type: "llm",
      t: 1,
      purpose: "plan",
      tokens: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 },
    },
    {
      type: "plan",
      t: 2,
      plan: {
        steps: [
          { kind: "browse", goal: "Search for 1 TB SSDs sorted by price" },
          { kind: "read", goal: "Read the cheapest item" },
        ],
      },
    },
    { type: "step", t: 2, index: 0, status: "running" },
    { type: "drex", t: 3, tokens: { input_tokens: 4000 } },
    { type: "move", t: 3, who: "drex", what: "typed SSD" },
    { type: "drex", t: 4, tokens: { input_tokens: 4100 } },
    { type: "move", t: 4, who: "drex", what: "clicked Sort" },
    { type: "step", t: 5, index: 0, status: "done" },
    { type: "step", t: 5, index: 1, status: "running" },
    { type: "verification", t: 6, evidence: "Samsung 870 EVO 1TB $89.99", page: "https://shop.example.com/ssd" },
    {
      type: "llm",
      t: 6,
      purpose: "read",
      tokens: { input_tokens: 2000, output_tokens: 100, cache_creation_input_tokens: 300 },
    },
    { type: "step", t: 7, index: 1, status: "done" },
  ],
  ...over,
});

test("a finished run maps to the browser runs API shape", () => {
  const r = resultOf(run(), {
    id: "lrun_1",
    task: "find the cheapest SSD",
    start_url: "https://shop.example.com/",
    profile: "default",
    final_url: "https://shop.example.com/ssd/870",
    artifacts: [{ kind: "run_log", path: "/tmp/run.json" }],
  });
  assert.equal(r.status, "succeeded");
  assert.deepEqual(r.outcome, {
    kind: "completed",
    reason: null,
    evidence: [{ url: "https://shop.example.com/ssd", text: "Samsung 870 EVO 1TB $89.99" }],
  });
  assert.equal(r.answer, null); // no answer_schema: the answer is answer_text, as on the API
  assert.equal(r.answer_text, "Samsung 870 EVO 1TB, $89.99");
  assert.equal(r.final_url, "https://shop.example.com/ssd/870");
  assert.deepEqual(r.steps, [
    { n: 1, kind: "browse", goal: "Search for 1 TB SSDs sorted by price", moves: 2, result: "done" },
    { n: 2, kind: "read", goal: "Read the cheapest item", moves: 0, result: "done" },
  ]);
  assert.deepEqual(r.usage, {
    drex_input_tokens: 8100,
    llm_input_tokens: 3800, // cache reads and writes are input too
    llm_output_tokens: 300,
    drex_calls: 5,
    llm_calls: 3,
    browser_seconds: 32,
    cost_usd: 0.0034,
  });
  assert.deepEqual(r.artifacts, [{ kind: "run_log", path: "/tmp/run.json" }]);
  for (const k of ["id", "status", "answer", "answer_text", "outcome", "steps", "usage", "final_url", "artifacts"])
    assert.ok(k in r, k);
});

test("without a page's URL, final_url is the report's, unless the report is an error", () => {
  assert.equal(
    resultOf(run({ report: { url: "https://a.example/" } }), { final_url: null }).final_url,
    "https://a.example/",
  );
  assert.equal(
    resultOf(run({ report: { error: "x", url: "https://a.example/" } }), { final_url: null }).final_url,
    null,
  );
});

test("every outcome kind has the status Drex gives it", () => {
  const cases = [
    [{ status: "done" }, "completed", "succeeded"],
    [{ status: "partial", message: "Run cost limit reached" }, "limit_reached", "partial"],
    [{ status: "failed", message: "Gave up after 3 new plans" }, "site_error", "failed"],
    [{ status: "error", message: "boom" }, "internal_error", "failed"],
    [
      { status: "needs_user", message: "Needs approval before this action: Drex wants to click Place order." },
      "risky_action_denied",
      "partial",
    ],
    [{ status: "needs_user", message: "Please solve the CAPTCHA" }, "blocked_captcha", "partial"],
    [{ status: "needs_user", message: "Sign in to continue" }, "blocked_login", "partial"],
    [{ status: "stopped", message: "Stopped." }, "cancelled", "cancelled"],
  ];
  for (const [r, kind, status] of cases) {
    const out = resultOf(run(r));
    assert.equal(out.outcome.kind, kind, r.message);
    assert.equal(out.status, status, r.message);
  }
  assert.equal(resultOf(null).outcome.kind, "internal_error");
  assert.equal(resultOf(run(), { ended: "timeout" }).status, "timed_out");
  assert.equal(resultOf(run(), { ended: "cancelled" }).status, "cancelled");
  assert.deepEqual(STATUS_OF, {
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
});

test("a denied risky action reports what the agent wanted to do", () => {
  const o = outcomeOf(
    run({ status: "needs_user", message: "Needs approval before this action: Drex wants to click Pay." }),
  );
  assert.deepEqual(o, { kind: "risky_action_denied", reason: "Drex wants to click Pay." });
});

test("a hand-over is told apart by what the page shows when the message doesn't say", () => {
  const vague = "Drex needs you for this screen (a check, a login or a choice only you can make).";
  assert.equal(handoverKind(vague, { captcha: true }), "blocked_captcha");
  assert.equal(handoverKind(vague, { title: "Just a moment... verify you are human" }), "blocked_captcha");
  // no CAPTCHA seen: a sign-in, or another hand-over only the person can get past
  assert.equal(handoverKind(vague, { title: "Sign in" }), "blocked_login");
  assert.equal(handoverKind(vague), "blocked_login");
});

test("steps follow replans: each step is read from the plan in force when it started", () => {
  const steps = stepsOf({
    status: "partial",
    record: [
      {
        type: "plan",
        plan: {
          steps: [
            { kind: "browse", goal: "A" },
            { kind: "read", goal: "B" },
          ],
        },
      },
      { type: "step", index: 0, status: "running" },
      { type: "move", who: "drex", what: "x" },
      {
        type: "plan",
        replanned: true,
        plan: {
          steps: [
            { kind: "browse", goal: "A2" },
            { kind: "read", goal: "B" },
          ],
        },
      },
      { type: "step", index: 0, status: "running" },
      { type: "move", who: "llm", what: "y" },
      { type: "move", who: "drex", what: "z" },
    ],
  });
  assert.deepEqual(steps, [
    { n: 1, kind: "browse", goal: "A", moves: 1, result: "replanned" },
    { n: 2, kind: "browse", goal: "A2", moves: 2, result: "partial" },
  ]);
});

test("usage ignores entries without valid token counts", () => {
  const u = usageOf({
    record: [
      { type: "drex", tokens: { input_tokens: -5 } },
      { type: "llm", tokens: { input_tokens: "12", output_tokens: 1.5 } },
      { type: "llm", tokens: null },
      { type: "drex", tokens: { input_tokens: 10 } },
    ],
    totals: {},
  });
  assert.deepEqual(u, {
    drex_input_tokens: 10,
    llm_input_tokens: 0,
    llm_output_tokens: 0,
    drex_calls: 0,
    llm_calls: 0,
    browser_seconds: 0,
    cost_usd: 0,
  });
});
