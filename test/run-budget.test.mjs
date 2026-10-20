import { test } from "node:test";
import assert from "node:assert/strict";
import { RunBudget, RunLimit } from "../src/run-budget.ts";
test("physical request admission reserves simultaneous cost and caps forty Haiku calls", () => {
  const b = new RunBudget();
  const pending = b.reserve({ provider: "drex", maxCostUsd: 0.06 });
  assert.throws(() => b.reserve({ provider: "anthropic", maxCostUsd: 0.04 }), RunLimit);
  b.settle(pending, { usd: 0.001 });
  for (let i = 0; i < 40; i++) {
    const t = b.reserve({ provider: "anthropic", maxCostUsd: 0.002 });
    b.settle(t, { usd: 0.001 });
  }
  assert.equal(b.calls.anthropic, 40);
  assert.throws(() => b.reserve({ provider: "anthropic", maxCostUsd: 0 }), /physical-call/);
});
test("known undispatched attempts release slots while unknown dispatched costs stop all later calls", () => {
  const b = new RunBudget();
  const a = b.reserve({ provider: "anthropic", maxCostUsd: 0.005 });
  b.settle(a, { dispatched: false });
  assert.equal(b.calls.anthropic, 0);
  assert.equal(b.reservedUsd, 0);
  const t = b.reserve({ provider: "anthropic", maxCostUsd: 0.005 });
  b.settle(t, { usd: null });
  assert.equal(b.calls.anthropic, 1);
  assert.equal(b.reservedUsd, 0.005);
  assert.throws(() => b.check(), /unknown cost/);
  assert.throws(() => b.reserve({ provider: "drex", maxCostUsd: 0 }), /unknown cost/);
  assert.throws(() => b.settle(t, { usd: 0 }), /already settled/);
});
test("remaining request deadline is bounded by whole run and actual overruns stop admission", () => {
  let now = 0;
  const b = new RunBudget({}, () => now);
  assert.equal(b.remainingMs(), 600000);
  now = 599991;
  assert.equal(b.remainingMs(), 9);
  now = 600000;
  assert.equal(b.remainingMs(), 0);
  assert.throws(() => b.check(), /time limit/);
  const other = new RunBudget();
  const t = other.reserve({ provider: "drex", maxCostUsd: 0.001 });
  other.settle(t, { usd: 0.081 });
  assert.throws(() => other.check(), /cost limit/);
});
test("time spent waiting for the user does not count against the deadline", () => {
  let now = 0;
  const b = new RunBudget({ maxSeconds: 10 }, () => now);
  now = 4000;
  b.pause();
  now = 900000;
  assert.equal(b.remainingMs(), 6000);
  b.resume();
  assert.equal(b.remainingMs(), 6000);
  now = 905000;
  assert.equal(b.remainingMs(), 1000);
  b.check();
});
test("a hold keeps its calls, cost and time from ordinary requests until it is released", () => {
  let now = 0;
  const b = new RunBudget({ maxHaikuCalls: 3, maxCostUsd: 0.01, maxSeconds: 60 }, () => now);
  b.hold({ calls: 1, usd: 0.002, ms: 20000 });
  assert.equal(b.remainingMs(), 40000);
  for (let i = 0; i < 2; i++) b.settle(b.reserve({ provider: "anthropic", maxCostUsd: 0.001 }), { usd: 0.001 });
  assert.throws(() => b.reserve({ provider: "anthropic", maxCostUsd: 0.001 }), /physical-call/);
  assert.throws(() => b.reserve({ provider: "drex", maxCostUsd: 0.0065 }), /remaining run cost/);
  now = 40000;
  assert.throws(() => b.check(), /time limit/);
  assert.equal(b.release(), true);
  assert.equal(b.remainingMs(), 20000);
  b.check();
  b.settle(b.reserve({ provider: "anthropic", maxCostUsd: 0.002 }), { usd: 0.002 });
  assert.equal(b.calls.anthropic, 3);
  assert.equal(b.release(), false);
});
test("a hold the limits can't spare is not made", () => {
  const b = new RunBudget({ maxHaikuCalls: 1 });
  b.hold({ calls: 1, usd: 0.001, ms: 1000 });
  assert.equal(b.held, null);
  b.settle(b.reserve({ provider: "anthropic", maxCostUsd: 0.001 }), { usd: 0.001 });
});
