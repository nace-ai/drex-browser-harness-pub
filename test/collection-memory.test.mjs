import { test } from "node:test";
import assert from "node:assert/strict";
const { collect } = await import(process.env.MACROS_SOURCE || "../src/macros.ts");
test("collection replans retain source facts and completed details, revisit incomplete details, and invalidate on mutation", async () => {
  const previous = globalThis.chrome;
  let opened = 0,
    contracts = 0,
    details = 0,
    completeDetail = false,
    detailValue = "17.25";
  const inputNotes = [];
  const url = "http://owned.test/list",
    href = "http://owned.test/record/42";
  globalThis.chrome = {
    tabs: {
      create: async () => {
        opened++;
        return { id: 3 };
      },
      remove: async () => {},
    },
  };
  const a = {
    task: "Total requested records",
    notes: {},
    index: 0,
    tabs: new Map(),
    agentTabId: 2,
    tabBindings: new Map(),
    check() {},
    log() {},
    llmCall: async (_p, fn) => fn(),
    llm: {
      collectionContract: async () => {
        contracts++;
        return {
          json: {
            intent: "enumerate_all",
            constraints: ["Requested records"],
            scope: "Current records",
            objective: "",
            sort_direction: "none",
          },
        };
      },
      collectionPreparation: async () => ({ json: { ready: true, sort_available: false, steps: [] } }),
      collect: async (args) => {
        if (args.info.url === href) {
          assert.equal(args.scope, "one_detail");
          details++;
          return {
            json: { evidence: "Record 42 total " + detailValue, complete: completeDetail, details: [], next: "" },
          };
        }
        assert.equal(args.scope, "collection");
        inputNotes.push(JSON.stringify(args.notes));
        return {
          json: {
            evidence: "List includes record 42; additional pages not yet established",
            complete: false,
            details: [href],
            next: "",
          },
        };
      },
    },
    openDetailTab: async (href) => chrome.tabs.create({ url: href }),
    currentTab: async () => ({
      id: a.agentTabId,
      settle: async () => {},
      info: async () => ({ url: a.agentTabId === 3 ? href : url, text: "Public records" }),
      eval: async () => ({ x: 0, y: 0 }),
      items: async () => [{ node: 7, text: "Record42" }],
      on: async () => [{ href, text: "Details" }],
    }),
    look: async (tab) => ({
      info: { url: tab.id === 3 ? href : url },
      els: [{ role: "link", name: "Details", text: "Details", label: "E8", node: 8 }],
      off: [],
      img1: "fixture",
    }),
    read: async () => ({
      replan: [{ kind: "collect", goal: "Continue requested records" }],
      why: "Coverage not established",
    }),
  };
  try {
    const step = { kind: "collect", goal: "Gather requested records", save_as: "records" };
    await collect.call(a, step);
    assert.equal(opened, 1);
    completeDetail = true;
    await collect.call(a, step);
    assert.equal(opened, 2, "Incomplete detail must be revisitable");
    assert.match(inputNotes[1], /17.25/, "Prior extracted facts must survive replan");
    const third = await collect.call(a, { ...step, save_as: "replanned_records" });
    assert.equal(opened, 2, "Completed detail must not reopen merely because save_as changed");
    assert.equal(details, 2);
    assert.equal(contracts, 1, "Same original task contract must not be regenerated");
    assert.ok(third.replan, "Visited detail does not establish collection coverage");
    const sources = JSON.parse(a.notes.replanned_records.split("\nCOLLECTION")[0]).sources;
    assert.equal(
      sources.filter((s) => s.source_id === href).length,
      1,
      "One detail URL is one evidence source, not two records",
    );
    a.collectionMutationEpoch = 1;
    detailValue = "29.75";
    await collect.call(a, step);
    assert.equal(opened, 3, "Potential data mutation invalidates reusable completed detail");
    assert.match(a.notes.records_historical, /17.25/);
    assert.match(a.notes.records, /29.75/);
    assert.equal(contracts, 1);
    a.task = "Different requested records";
    await collect.call(a, step);
    assert.equal(contracts, 2);
    assert.equal(opened, 4, "Different task cannot reuse prior detail completion");
  } finally {
    globalThis.chrome = previous;
  }
});
test("detail reads more than five fresh pages then stops repeated state without asserting full coverage", async () => {
  const previous = globalThis.chrome;
  let page = 0,
    reads = 0,
    closed = 0,
    moves = 0;
  const href = "http://owned.test/record/42",
    url = "http://owned.test/list";
  globalThis.chrome = { tabs: { create: async () => ({ id: 3 }), remove: async () => closed++ } };
  const a = {
    task: "Read complete record history",
    notes: {},
    index: 0,
    tabs: new Map(),
    agentTabId: 2,
    tabBindings: new Map(),
    totals: { drexMoves: 0 },
    check() {},
    log() {},
    llmCall: async (_p, fn) => fn(),
    llm: {
      collectionContract: async () => ({
        json: { intent: "enumerate_all", constraints: [], scope: "Records", objective: "", sort_direction: "none" },
      }),
      collectionPreparation: async () => ({ json: { ready: true, sort_available: false, steps: [] } }),
      collect: async (args) => {
        if (args.info.url === href) {
          reads++;
          return { json: { evidence: "Observed version " + page, complete: false, details: [], next: "click E1" } };
        }
        return { json: { evidence: "List incomplete", complete: false, details: [href], next: "" } };
      },
    },
    openDetailTab: async (href) => chrome.tabs.create({ url: href }),
    currentTab: async () => ({
      id: a.agentTabId,
      settle: async () => {},
      info: async () => ({ url: a.agentTabId === 3 ? href : url, text: "Version " + page }),
      eval: async () => ({ x: 0, y: 0 }),
      items: async () => [{ node: 7, text: "Record42" }],
      on: async () =>
        a.agentTabId === 3 ? { href: href + "?page=" + page, rel: "next", role: "link" } : [{ href, text: "Details" }],
    }),
    look: async (tab) => ({
      info: { url: tab.id === 3 ? href : url },
      els:
        tab.id === 3
          ? [{ label: "E1", node: 11, role: "link", name: "Next", text: "Next", box: [0, 0, 10, 10] }]
          : [{ role: "link", name: "Details", text: "Details", label: "E8", node: 8 }],
      off: [],
      img1: "fixture",
      img2: "fixture",
    }),
    drexCall: async () => ({ answers: { move: { choice: "click E1", probabilities: { "click E1": 1 } } } }),
    act: async () => {
      moves++;
      if (page < 6) page++;
    },
    read: async () => ({ replan: [{ kind: "collect", goal: "Coverage still incomplete" }] }),
  };
  try {
    const result = await collect.call(a, { kind: "collect", goal: a.task, save_as: "history" });
    assert.equal(reads, 7);
    assert.equal(moves, 7);
    assert.equal(closed, 1);
    assert.equal(a.agentTabId, 2);
    assert.ok(result.replan);
    assert.match(a.notes.history, /COLLECTION COVERAGE COMPLETE: false/);
    for (let i = 0; i < 7; i++) assert.ok(a.notes.history.includes("Observed version " + i));
  } finally {
    globalThis.chrome = previous;
  }
});
