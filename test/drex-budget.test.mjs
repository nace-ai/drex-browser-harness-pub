import test from "node:test";
import assert from "node:assert/strict";
import { Drex, USD_PER_INPUT_TOKEN } from "../src/drex.ts";
import { RunBudget } from "../src/run-budget.ts";

const questions = { done: { type: "noul", instructions: "Task is done." } };
test("Drex rejects an unaffordable physical request before transport", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ answers: {}, usage: { input_tokens: 100 } }));
  });
  const drex = new Drex({ key: "fixture" });
  drex.runBudget = new RunBudget({ maxCostUsd: 0.005 });
  await assert.rejects(() => drex.ask("x".repeat(200000), questions), /reservation/);
  assert.equal(calls, 0);
});
test("Drex settles real usage once and releases unused admission cost", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(
      JSON.stringify({ answers: { done: { noul: 0.8 } }, usage: { input_tokens: 1000 }, request_id: "fixture" }),
    );
  });
  const drex = new Drex({ key: "fixture" });
  drex.runBudget = new RunBudget();
  const result = await drex.ask("state", questions);
  assert.equal(result.usd, 1000 * USD_PER_INPUT_TOKEN);
  assert.equal(drex.runBudget.spentUsd, result.usd);
  assert.equal(drex.runBudget.reservedUsd, 0);
  assert.equal(drex.runBudget.calls.drex, 1);
  assert.equal(calls, 1);
});
test("missing Drex usage cannot become a zero-cost result or a retry", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ answers: { done: { noul: 1 } } }));
  });
  const drex = new Drex({ key: "fixture" });
  drex.runBudget = new RunBudget();
  await assert.rejects(
    () => drex.ask("state", questions),
    (error) => /usage/.test(error.message) && error.physicalCalls === 1 && error.costUnknown === true,
  );
  assert.ok(drex.runBudget.reservedUsd > 0);
  await assert.rejects(() => drex.ask("state", questions), /unknown cost/);
  assert.equal(calls, 1);
});
test("truncated Drex receipt retains unknown billing and prevents another request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("{");
  });
  const drex = new Drex({ key: "fixture" });
  drex.runBudget = new RunBudget();
  await assert.rejects(() => drex.ask("state", questions), SyntaxError);
  assert.ok(drex.runBudget.reservedUsd > 0);
  await assert.rejects(() => drex.ask("state", questions), /unknown cost/);
  assert.equal(calls, 1);
});

test("a hanging Max request uses the remaining whole-run deadline", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    calls++;
    return await new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  });
  const drex = new Drex({ key: "fixture" });
  drex.runBudget = new RunBudget({ maxSeconds: 0.02 });
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(
      () => drex.ask("state", questions),
      (error) => error.physicalCalls === 1 && error.costUnknown === true,
    );
    assert.equal(calls, 1);
    assert.ok(drex.runBudget.reservedUsd > 0);
  } finally {
    clearTimeout(keepAlive);
  }
});
