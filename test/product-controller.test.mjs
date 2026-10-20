import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const source = process.env.CONTROLLER_SOURCE || resolve("src"),
  dir = await mkdtemp(join(tmpdir(), "product-controller-"));
await build({
  entryPoints: [join(source, "agent.ts")],
  outdir: dir,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
});
const { Agent } = await import(pathToFileURL(join(dir, "agent.js")));
await rm(dir, { recursive: true, force: true });
const step = { kind: "browse", goal: "Inspect details", done_when: "Details visible", texts: [], max_moves: 3 };
function agent() {
  const a = new Agent({ drex: {}, llm: {}, emit() {} });
  a.t0 = performance.now();
  a.notes = {};
  a.task = step.goal;
  a.plan = { steps: [step] };
  a.index = 0;
  return a;
}
test("stale pre-dispatch scroll target resolves once uniquely; ambiguous never clicks and dispatched failure never repeats", async () => {
  const a = agent();
  let clicks = 0;
  const scrolls = [];
  const tab = {
    scrollIntoView: async (node) => {
      scrolls.push(node);
      if (node === 1) throw Error("No node with given id found");
    },
    centre: async () => [2, 3],
    click: async () => clicks++,
    elements: async () => ({ els: [{ node: 2, role: "link", name: "Details" }] }),
  };
  await a.perform(tab, { kind: "scroll_click", el: { node: 1, role: "link", name: "Details" } });
  assert.deepEqual(scrolls, [1, 2]);
  assert.equal(clicks, 1);
  tab.elements = async () => ({
    els: [
      { node: 2, role: "link", name: "Details" },
      { node: 3, role: "link", name: "Details" },
    ],
  });
  assert.equal(
    (await a.perform(tab, { kind: "scroll_click", el: { node: 1, role: "link", name: "Details" } })).dispatched,
    false,
  );
  assert.equal(clicks, 1);
  tab.elements = async () => ({ els: [{ node: 2, role: "link", name: "Details" }] });
  tab.click = async () => {
    clicks++;
    throw Error("Unknown dispatch outcome");
  };
  await assert.rejects(
    a.perform(tab, { kind: "scroll_click", el: { node: 1, role: "link", name: "Details" } }),
    /Unknown dispatch/,
  );
  assert.equal(clicks, 2);
});
test("budget stop flushes native finish and preserves observed partial facts without claiming completion", async () => {
  const previous = globalThis.chrome,
    noop = { addListener() {}, removeListener() {} };
  globalThis.chrome = {
    tabs: { onCreated: noop },
    debugger: { onDetach: noop },
    windows: { getCurrent: async () => ({ id: 1 }), getLastFocused: async () => ({ id: 1 }) },
  };
  try {
    const a = agent();
    a.fixedPlan = { steps: [step] };
    a.windowTabs = async () => [];
    a.prepare = async () => {};
    a.browse = async () => {
      a.notes.price = "Public price 17.25";
      a.runBudget.start = performance.now() - 601000;
      a.check();
    };
    const out = await a.run("Find price");
    assert.equal(out.status, "partial");
    assert.match(out.answer, /17.25/);
    assert.ok(out.record.some((e) => e.type === "finish"));
    assert.equal(a.llm.runBudget, a.drex.runBudget);
  } finally {
    globalThis.chrome = previous;
  }
});
test("physical usage is accounted even when parsing a paid model response fails", async () => {
  const a = agent();
  const error = Object.assign(new Error("Invalid JSON"), {
    usd: 0.003,
    physicalCalls: 2,
    usage: { input_tokens: 100 },
    ms: 1,
  });
  await assert.rejects(
    a.llmCall("read", async () => {
      throw error;
    }),
    /Invalid JSON/,
  );
  assert.equal(a.totals.llmCalls, 2);
  assert.equal(a.totals.llmUsd, 0.003);
});
test("pagination rechecks exact public destination and origin before navigation", async () => {
  const a = agent();
  let visits = 0;
  const url = "http://owned.test/list?page=2";
  let fresh = url;
  const tab = {
    info: async () => ({ url: "http://owned.test/list" }),
    on: async () => ({ paginationURL: fresh, paginationLabel: "2" }),
    navigate: async () => visits++,
  };
  await a.perform(tab, { kind: "navigate_page", url, el: { node: 1, name: "2" } });
  assert.equal(visits, 1);
  fresh = "http://other.test/list?page=2";
  assert.equal((await a.perform(tab, { kind: "navigate_page", url, el: { node: 1, name: "2" } })).dispatched, false);
  assert.equal(visits, 1);
});
test("second identical check objection guides an alternative but third retains main incomplete-check cap", async () => {
  const a = agent();
  a.windowTabs = async () => [];
  a.currentTab = async () => ({ info: async () => ({ url: "http://owned.test" }) });
  a.llm.read = async () => ({
    json: { complete: false, evidence: "Confirmation absent", next_steps: [] },
    usd: 0,
    ms: 1,
  });
  const scr = { els: [], img1: "image" };
  assert.deepEqual(await a.verifyStep(step, scr), { rejected: "Confirmation absent" });
  assert.match((await a.verifyStep(step, scr)).rejected, /alternative supported route/);
  assert.equal((await a.verifyStep(step, scr)).terminal, true);
  assert.equal(a.totals.llmCalls, 3);
});
test("stale Details target cannot move to a different record context even when its name is unique", async () => {
  const a = agent();
  let clicks = 0,
    context = "Card B";
  const tab = {
    scrollIntoView: async (node) => {
      if (node === 1) throw Error("No node with given id found");
    },
    centre: async () => [3, 4],
    click: async () => clicks++,
    elements: async () => ({ els: [{ node: 2, role: "link", name: "Details", context, grid: { row: 2, col: 1 } }] }),
  };
  const act = {
    kind: "scroll_click",
    el: { node: 1, role: "link", name: "Details", context: "Card A", grid: { row: 2, col: 1 } },
  };
  assert.equal((await a.perform(tab, act)).dispatched, false);
  assert.equal(clicks, 0);
  context = "Card A";
  await a.perform(tab, act);
  assert.equal(clicks, 1);
  act.el.grid = { row: 1, col: 1 };
  assert.equal((await a.perform(tab, act)).dispatched, false);
  assert.equal(clicks, 1);
});
test("Drex failed physical calls retain honest unknown cost and visible reserved liability", async () => {
  // The failed transport returns accounting before the next admission check.
  const b = agent();
  b.drex.ask = async () => {
    const t = b.runBudget.reserve({ provider: "drex", maxCostUsd: 0.008 });
    b.runBudget.settle(t, { usd: null });
    throw Object.assign(new Error("Missing receipt"), { physicalCalls: 1, usd: null });
  };
  await assert.rejects(b.drexCall("state", {}, []), /Missing receipt/);
  assert.equal(b.totals.drexCalls, 1);
  assert.equal(b.record.at(-1).usd, null);
  const snapshot = b.snapshot();
  assert.equal(snapshot.budget.unknownCost, true);
  assert.equal(snapshot.budget.reservedCostUsd, 0.008);
  assert.equal(snapshot.budget.costComplete, false);
});
test("public interrupted snapshot preserves matching collection facts not yet flushed into notes", () => {
  const a = agent();
  a.collectionMutationEpoch = 0;
  a.collectionMemory = new Map([
    [
      "contract",
      {
        epoch: 0,
        sources: new Map([["http://owned.test/record/7", new Set(["Target product ordered 2023-01-17 for 17.25"])]]),
        completedDetails: new Set(["http://owned.test/record/7"]),
      },
    ],
  ]);
  const snapshot = a.snapshot("Deadline");
  assert.equal(snapshot.status, "partial");
  assert.match(snapshot.answer, /2023-01-17/);
  assert.match(snapshot.answer, /17.25/);
  assert.equal(JSON.parse(snapshot.answer).complete, false);
  assert.match(snapshot.evidence.collections[0].coverage, /do not establish complete/);
  a.collectionMutationEpoch = 1;
  assert.equal(a.snapshot().evidence.collections[0].historical, true);
});
test("waiting for the user does not use up the run deadline, and the answer comes from the user", async () => {
  const a = agent();
  a.runBudget.limits.maxSeconds = 0.05;
  setTimeout(() => a.answer("once"), 120); // longer than the whole run's time
  assert.equal(await a.waitForUser("approve", "Send message?"), "once");
  assert.ok(a.runBudget.remainingMs() > 0);
  a.check();
  assert.equal(a.pendingAsk, null);
  assert.ok(a.record.some((e) => e.type === "answer" && e.ok === "once"));
});
