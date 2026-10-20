import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { streamed } from "./stream-fake.mjs";

const source = process.env.CONTROLLER_SOURCE || resolve("src");
const dir = await mkdtemp(join(tmpdir(), "drex-controller-"));
await build({
  entryPoints: [join(source, "agent.ts"), join(source, "llm.ts")],
  outdir: dir,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
});
// llm's SDK import resolves from the real installation, independent of temp bundle location.
const { Agent, ReadCap } = await import(pathToFileURL(join(dir, "agent.js")));
const { LLM } = await import(pathToFileURL(join(source, "llm.ts")));
const L = await import(pathToFileURL(join(source, "logic.ts")));
const { buildOptions } = L;
const { Drex } = await import(pathToFileURL(join(source, "drex.ts")));
await rm(dir, { recursive: true, force: true });
const image = "data:image/png;base64,aW1hZ2U=";
function fixtureLLM() {
  const llm = streamed(
    new LLM({
      key: "fixture",
      runOptions: { efficiency: { contextBudget: false, promptCache: false, cheapCollection: false } },
    }),
  );
  llm.client.messages.countTokens = async () => ({ input_tokens: 100 });
  return llm;
}
const response = (json) => ({
  json,
  text: JSON.stringify(json),
  usd: 0,
  ms: 1,
  model: "fixture",
  usage: { input_tokens: 0, output_tokens: 0 },
});
const step = {
  kind: "browse",
  goal: "Sort descending",
  done_when: "Descending selected",
  texts: [],
  rules: "",
  max_moves: 5,
};
const scr = {
  img1: image,
  img2: image,
  els: [],
  off: [],
  info: { title: "List", url: "http://owned.test/list" },
  thumb: "",
};
const info = { ...scr.info, text: "Sort: ascending", chars: 15 };
// a tab whose moves do nothing; over: what a test needs it to do instead
const page = (over = {}) => ({
  id: 1,
  info: async () => info,
  eval: async () => null,
  settle: async () => {},
  notices: async () => ({ url: info.url, notes: [], dialogs: [] }),
  elements: async () => ({ els: [], off: [] }),
  ...over,
});
const next = {
  label: "E1",
  role: "button",
  name: "Next page",
  text: "button 'Next page'",
  node: 1,
  box: [0, 0, 10, 10],
};
const order = {
  label: "E2",
  role: "button",
  name: "Place order",
  text: "button 'Place order'",
  node: 2,
  box: [20, 0, 40, 10],
};
const drexSays = (...choices) => {
  let i = 0;
  return async () => {
    const [choice, done] = choices[Math.min(i++, choices.length - 1)];
    return { answers: { move: { choice, probabilities: { [choice]: 0.99 } }, done: { noul: done } }, ms: 1, usd: 0 };
  };
};
const noLLM = () => new Proxy({}, { get: (_, k) => async () => assert.fail(`no LLM call expected (${String(k)})`) });
function agent(llm) {
  if (!llm.collectionPreparation)
    llm.collectionPreparation = async () =>
      response({
        ready: true,
        evidence: "Fixture scope prepared",
        sort_available: false,
        observed_sort_direction: "none",
        steps: [],
      });
  if (!llm.collectionContract)
    llm.collectionContract = async () =>
      response({ intent: "enumerate_all", constraints: [], objective: "", scope: "fixture records" });
  if (llm.read && !llm.readiness)
    llm.readiness = async (args) => {
      const r = await llm.read(args);
      return { ...r, json: { ...r.json, decision: r.json.complete ? "ready" : "not_ready" } };
    };
  const a = new Agent({ drex: {}, llm, emit() {} });
  a.t0 = performance.now();
  a.task = "Sort descending";
  a.notes = {};
  a.index = 0;
  a.plan = { steps: [step] };
  a.currentTab = async () => ({ info: async () => info });
  a.look = async () => scr;
  a.windowTabs = async () => [];
  return a;
}

test("read transmits actual screenshot and consumes structured evidence at provider boundary", async () => {
  const llm = fixtureLLM();
  let sent;
  llm.client.messages.create = async (body) => {
    sent = body;
    return {
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [
        {
          type: "text",
          text: JSON.stringify({ availability: "available", evidence: "visible blocks", text: "4", next_steps: [] }),
        },
      ],
    };
  };
  const got = await llm.read({ task: "Count blocks", planText: "", step, notes: {}, info, image });
  assert.equal(sent.messages[0].content[0].type, "image");
  assert.equal(sent.messages[0].content[0].source.data, "aW1hZ2U=");
  assert.equal(got.json.text, "4");
});

test("visual rescue receives unmodified raw image before annotated image", async () => {
  const llm = fixtureLLM();
  let sent;
  llm.client.messages.create = async (body) => {
    sent = body;
    return {
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            decision: "move",
            option: "click E1",
            why: "raw color match",
            text: "",
            x: 0,
            y: 0,
            new_steps: [],
          }),
        },
      ],
    };
  };
  await llm.rescue({
    state: "",
    reason: "Inspect color",
    image: "data:image/png;base64,dGFnZ2Vk",
    rawImage: image,
    opts: { "click E1": "Click tile" },
  });
  assert.deepEqual(
    sent.messages[0].content.filter((b) => b.type === "image").map((b) => b.source.data),
    ["aW1hZ2U=", "dGFnZ2Vk"],
  );
});

test("readiness/read/fill keep full image and deliver optional focus image with geometry", async () => {
  const llm = fixtureLLM();
  const sent = [];
  llm.client.messages.create = async (body) => {
    sent.push(body);
    return {
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: "text", text: JSON.stringify({ availability: "available" }) }],
    };
  };
  const focus = {
    image: "data:image/png;base64,em9vbQ==",
    sourceRectCSS: [0, 20, 150, 200],
    output: [1280, 800],
    scale: 4,
  };
  const args = {
    task: "Inspect",
    planText: "",
    step,
    notes: {},
    info,
    image,
    fields: [],
    candidates: [],
    observations: [],
    focus,
  };
  for (const method of ["read", "fill", "readiness"]) await llm[method](args);
  for (const body of sent) {
    const content = body.messages[0].content;
    assert.deepEqual(
      content.filter((b) => b.type === "image").map((b) => b.source.data),
      ["aW1hZ2U=", "em9vbQ=="],
    );
    const text = JSON.parse(content.find((b) => b.type === "text").text);
    assert.deepEqual(text.focus.sourceRectCSS, [0, 20, 150, 200]);
    assert.equal(text.focus.image, undefined);
  }
});

test("canvas exposes inspection instead of an arbitrary center click", () => {
  const canvas = { label: "E2", role: "canvas", text: "canvas", box: [0, 0, 100, 100] };
  const { acts } = buildOptions({ els: [canvas] });
  assert.equal(
    Object.values(acts).some((a) => a.el === canvas && a.kind === "click"),
    false,
  );
  assert.equal(
    Object.values(acts).some((a) => a.el === canvas && a.kind === "look"),
    true,
  );
});

test('after a risky click, a confident "step done" still needs the screen check', async () => {
  const correction = { ...step, goal: "Choose descending in sort control" };
  const a = agent({
    read: async () =>
      response({ complete: false, evidence: "Ascending is selected", text: "", next_steps: [correction] }),
  });
  a.look = async () => ({ ...scr, els: [order] });
  a.drexCall = drexSays(["click E2", 0.01], ["step done", 0.99]);
  a.act = async (_tab, act) => ({ dispatched: true, risky: L.isRisky(act) });
  const result = await a.browse(step);
  assert.deepEqual(result.replan, [correction]);
  assert.match(result.why, /Ascending/);
});

test("a plain browse step makes no LLM calls: no readiness check, no step check", async () => {
  const a = agent(noLLM());
  a.look = async () => ({ ...scr, els: [next] });
  a.currentTab = async () => page();
  a.drexCall = drexSays(["click E1", 0.01], ["press enter", 0.01], ["step done", 0.99]);
  let performed = 0;
  a.perform = async () => performed++;
  a.capture = async () => "after";
  assert.deepEqual(await a.browse(step), {});
  assert.equal(performed, 2);
  assert.equal(a.totals.llmCalls, 0);
});

test("a missing read result replans without storing an invented final answer", async () => {
  const a = agent({
    read: async () =>
      response({
        complete: false,
        evidence: "Reviews tab is collapsed",
        text: "",
        next_steps: [{ ...step, goal: "Open Reviews" }],
      }),
  });
  const result = await a.read({ ...step, kind: "read", save_as: "answer" });
  assert.equal(result.replan[0].goal, "Open Reviews");
  assert.equal(result.replan.at(-1).save_as, "answer");
  assert.equal(a.notes.answer, undefined);
});

test("a confirmed risky step keeps the screen check as evidence", async () => {
  const a = agent({
    read: async () =>
      response({ complete: true, evidence: "Submitted for moderation", text: "Submitted", next_steps: [] }),
  });
  a.look = async () => ({ ...scr, els: [order] });
  a.drexCall = drexSays(["click E2", 0.01], ["step done", 0.99]);
  a.act = async (_tab, act) => ({ dispatched: true, risky: L.isRisky(act) });
  const result = await a.browse({ ...step, goal: "Submit review" });
  assert.deepEqual(result, {});
  assert.equal(a.notes.evidence1, "Submitted for moderation");
});

test("helper-selected Place order cannot bypass an incomplete-form readiness rejection", async () => {
  const a = agent({
    read: async (args) => {
      assert.match(args.step.goal, /BEFORE ACTION readiness/);
      return response({ complete: false, evidence: "Required slider value is wrong", text: "", next_steps: [step] });
    },
  });
  let performed = 0;
  a.perform = async () => performed++;
  a.capture = async () => "same";
  const out = await a.act(page(), { kind: "click", el: order }, null, scr, [], "llm", 1);
  assert.equal(performed, 0);
  assert.match(out.why, /slider/);
  assert.equal(a.pendingReplan, undefined); // the outcome is returned, never left on the agent
});

test("meta completion choice never dispatches a browser operation", async () => {
  const a = agent({});
  a.perform = async () => assert.fail("step_done is not an action");
  await a.act(
    { notices: async () => ({ url: info.url, notes: [], dialogs: [] }) },
    { kind: "step_done" },
    null,
    scr,
    [],
    "drex",
    0.2,
  );
});

test("same no-progress action is blocked despite volatile ancestor text and rerender IDs", async () => {
  const a = agent({});
  let performed = 0;
  let el = {
    role: "checkbox",
    name: "Option",
    text: "Option",
    state: "(not checked)",
    node: 1,
    box: [0, 0, 10, 10],
    context: "Time left 10",
  };
  const tab = {
    notices: async () => ({ url: info.url, notes: [], dialogs: [] }),
    settle: async () => {},
    elements: async () => ({ els: [el] }),
    info: async () => info,
  };
  a.perform = async () => performed++;
  a.capture = async () => "same";
  for (let i = 0; i < 3; i++) {
    el = { ...el, node: i + 1, context: `Time left ${10 - i}` };
    await a.act(tab, { kind: "click", el }, null, { ...scr, els: [el], jpeg: "same" }, [], "llm", 1);
  }
  assert.equal(performed, 2);
});

test("readiness runs only before risky clicks: not before Enter or an ordinary click", async () => {
  let checks = 0;
  const a = agent({
    readiness: async () => {
      checks++;
      return response({ decision: "ready", evidence: "Cart holds the requested items", next_steps: [] });
    },
  });
  let performed = 0;
  a.perform = async () => performed++;
  a.capture = async () => "same";
  a.approvals = false;
  const tab = page({ elements: async () => ({ els: [next, order], off: [] }) });
  const here = { ...scr, els: [next, order], jpeg: "same" };
  await a.act(tab, { kind: "key", key: "Enter" }, null, here, [], "drex", 1);
  await a.act(tab, { kind: "click", el: next }, null, here, [], "drex", 1);
  assert.equal(checks, 0);
  const out = await a.act(tab, { kind: "click", el: order }, null, here, [], "drex", 1);
  assert.equal(checks, 1);
  assert.equal(performed, 3);
  assert.deepEqual(out, { dispatched: true, risky: true });
});

test("a risky click whose target moved during the readiness check is not made and counts as no progress", async () => {
  const a = agent({ readiness: async () => response({ decision: "ready", evidence: "Ready", next_steps: [] }) });
  a.perform = async () => assert.fail("a stale target must not be clicked");
  a.approvals = false;
  const moved = { ...order, box: [20, 300, 40, 310] };
  const history = [];
  const out = await a.act(
    page({ elements: async () => ({ els: [moved], off: [] }) }),
    { kind: "click", el: order },
    null,
    { ...scr, els: [order] },
    history,
    "drex",
    1,
  );
  assert.equal(out.blocked, "stale target");
  assert.equal(history[0].changed, false);
  assert.equal([...a.noProgress.values()][0], 1);
  // content elsewhere on the page may change: only the target counts
  let performed = 0;
  a.perform = async () => performed++;
  a.capture = async () => null;
  const ticker = { label: "E3", role: "link", name: "Deal ends in 5s", text: "x", node: 3, box: [0, 50, 10, 60] };
  await a.act(
    page({ elements: async () => ({ els: [order, ticker], off: [] }) }),
    { kind: "click", el: order },
    null,
    { ...scr, info: { ...info, url: "http://owned.test/other" }, els: [order] },
    [],
    "drex",
    1,
  );
  assert.equal(performed, 1);
});

test("confirmed prior submission is not sent twice and still requires separate step verification", async () => {
  let performed = 0;
  let verified = 0;
  const a = agent({
    readiness: async () =>
      response({
        decision: "already_done",
        evidence: "Same order was placed; visible confirmation retained",
        next_steps: [],
      }),
    read: async () => {
      verified++;
      return response({ complete: true, evidence: "Order confirmed", text: "", next_steps: [] });
    },
  });
  a.perform = async () => performed++;
  const out = await a.act(
    page({ info: async () => ({ ...info, text: "Order placed" }) }),
    { kind: "click", el: order },
    null,
    scr,
    [],
    "llm",
    1,
  );
  assert.equal(performed, 0);
  assert.equal(verified, 1);
  assert.deepEqual(out, { stepDone: true });
});

test("already_done with an incomplete larger step does not mark the step successful", async () => {
  const a = agent({
    readiness: async () => response({ decision: "already_done", evidence: "Order already placed", next_steps: [] }),
    read: async () => response({ complete: false, evidence: "Receipt still needs opening", text: "", next_steps: [] }),
  });
  a.perform = async () => assert.fail("A repeated order must not dispatch");
  const out = await a.act(page(), { kind: "click", el: order }, null, scr, [], "drex", 1);
  assert.equal(out.stepDone, undefined);
  assert.equal(out.blocked, "already done");
  assert.match(a.notes.action_already_done, /Receipt still needs opening/);
});

test("readiness field correction retains the pending original Submit exactly once", async () => {
  const original = {
    ...step,
    kind: "browse",
    goal: "Submit the correctly filled form",
    open_url: "http://owned.test/form",
    use_tab: 0,
  };
  const correction = { ...step, kind: "fill", goal: "Correct the required value" };
  const decision = {
    decision: "not_ready",
    complete: false,
    evidence: "Value wrong",
    text: "",
    next_steps: [correction],
  };
  const a = agent({ readiness: async () => response(decision), read: async () => response(decision) });
  a.plan.steps = [original];
  a.activeBrowseStep = original;
  const action = { kind: "click", el: order };
  let out = await a.act(page(), action, null, scr, [], "llm", 1);
  assert.equal(out.replan[0].kind, "fill");
  assert.equal(out.replan.at(-1).goal, original.goal);
  assert.equal(out.replan.at(-1).open_url, "");
  decision.next_steps = [...out.replan];
  a.noProgress = new Map();
  out = await a.act(page(), action, null, scr, [], "llm", 1);
  assert.equal(out.replan.filter((s) => s.goal === original.goal).length, 1);
});

test("logical initial tab follows its owned search copy while another initial tab stays explicit", async () => {
  const pages = new Map([
    [1, "http://owned.test/"],
    [99, "http://owned.test/other"],
  ]);
  globalThis.chrome = {
    tabs: {
      get: async (id) => {
        if (!pages.has(id)) throw new Error("No tab");
        return { id, url: pages.get(id) };
      },
      create: async ({ url }) => {
        pages.set(2, url);
        return { id: 2 };
      },
      update: async (id, { url }) => {
        pages.set(id, url);
      },
    },
  };
  const a = agent({
    read: async (args) => response({ complete: true, evidence: args.info.url, text: args.info.url, next_steps: [] }),
  });
  a.startTabs = [{ id: 1 }, { id: 99 }];
  a.tabBindings = new Map([
    [0, 1],
    [1, 99],
  ]);
  a.activePlanTab = 0;
  a.agentTabId = 1;
  a.ownTab = false;
  a.group = async () => {};
  a.currentTab = async () => ({
    settle: async () => {},
    info: async () => ({ ...info, url: pages.get(a.agentTabId) }),
  });
  a.windowTabs = async () => [...pages].map(([id, url]) => ({ id, url, title: url }));
  await a.prepare({ use_tab: 0, open_url: "http://owned.test/search?q=item" });
  await a.prepare({ use_tab: 0, open_url: "" });
  await a.read({ ...step, kind: "read", save_as: "result" });
  assert.equal(a.notes.result, "http://owned.test/search?q=item");
  assert.equal(pages.get(1), "http://owned.test/");
  await a.prepare({ use_tab: 1, open_url: "" });
  assert.equal(a.agentTabId, 99);
});

test("empty choice criteria are rejected before any provider request", async () => {
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return { ok: true, json: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }) };
  };
  try {
    await assert.rejects(
      new Drex({ key: "fixture", url: "http://127.0.0.1:1" }).ask("state", {
        item: { type: "choice", instructions: "Extract fields", criteria: {} },
      }),
      /criteria/,
    );
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

if (!process.env.CONTROLLER_SOURCE) {
  const { fill, collect } = await import(pathToFileURL(join(process.env.MACROS_SOURCE || source, "macros.ts")));
  test("a batch step without choices fails visibly instead of turning into a collection", async () => {
    const a = agent({ collect: async () => assert.fail("no silent switch to a collect step") });
    a.drexCall = async () => assert.fail("nothing to decide");
    const result = await a.batch({ ...step, kind: "batch", choices: [], question: "Extract names", save_as: "names" });
    assert.match(result.fail, /no choices/);
    assert.equal(result.terminal, true);
  });
  test("collection detail tab closes and restores logical list binding and other initial tab", async () => {
    const detailURL = "http://owned.test/detail";
    const removed = [];
    let detached = 0;
    const a = agent({
      collect: async (args) =>
        response({ complete: true, evidence: "Record fields", details: args.rows.length ? [detailURL] : [], next: "" }),
    });
    a.agentTabId = 2;
    a.ownTab = true;
    a.activePlanTab = 0;
    a.tabBindings = new Map([
      [0, 2],
      [1, 99],
    ]);
    let grouped = 0;
    globalThis.chrome = {
      tabs: {
        create: async () => ({ id: 3 }),
        remove: async (id) => removed.push(id),
        group: async () => {
          grouped++;
          return 5;
        },
      },
      tabGroups: { update: async () => {} },
    };
    const tab = (id) => ({
      id,
      settle: async () => {},
      info: async () => ({ ...info, url: id === 3 ? detailURL : info.url }),
      eval: async () => ({ x: 0, y: 0 }),
      items: async () => (id === 3 ? [] : [{ node: 7, text: "Record" }]),
      on: async () => [{ href: detailURL, text: "Details" }],
      detach: async () => detached++,
    });
    a.currentTab = async () => {
      const t = tab(a.agentTabId);
      a.tabs.set(t.id, t);
      return t;
    };
    a.look = async (t) => ({
      ...scr,
      els: [{ label: "E1", role: "link", name: "Details", text: "link 'Details'", node: 7 }],
      info: { ...info, url: t.id === 3 ? detailURL : info.url },
    });
    a.runOptions.efficiency.cheapCollection = false; // This fixture supplies the original per-detail reader.
    a.read = async () => ({});
    await collect.call(a, step);
    assert.equal(grouped, 1); // the detail tab goes into the agent's "Drex" tab group
    assert.equal(a.agentTabId, 2);
    assert.equal(a.activePlanTab, 0);
    assert.deepEqual(
      [...a.tabBindings],
      [
        [0, 2],
        [1, 99],
      ],
    );
    assert.deepEqual(removed, [3]);
    assert.equal(detached, 1);
  });
  test("empty fill assignments still check full form completion", async () => {
    let checked = false;
    const a = agent({ fill: async () => response({ why: "No text fields", fields: [], unresolved: [] }) });
    a.read = async (s) => {
      checked = s.kind === "verify";
      return { fail: "Required choices missing" };
    };
    const result = await fill.call(a, step);
    assert.equal(checked, true);
    assert.match(result.fail, /choices missing/);
  });
  test("already checked checkbox is not toggled off during fill", async () => {
    const box = { label: "E1", role: "checkbox", text: "checkbox consent", node: 1, state: "(checked)" };
    const a = agent({
      fill: async () =>
        response({
          why: "",
          fields: [
            { label: "E1", desired_value: "true", source_kind: "instruction", source_evidence: "Consent requested" },
          ],
          unresolved: [],
        }),
    });
    a.look = async () => ({ ...scr, els: [box] });
    a.currentTab = async () => ({ info: async () => info, fieldValue: async () => ({ checked: true }) });
    a.act = async () => assert.fail("Already selected control must not be clicked");
    a.read = async () => ({});
    assert.deepEqual(await fill.call(a, step), {});
  });
  test("collection never navigates a detail link with a delete query", async () => {
    const destructive = "http://owned.test/?action=delete&id=1";
    const a = agent({
      collect: async (args) => {
        assert.deepEqual(args.rows[0].links, []);
        return response({ evidence: "One record", complete: true, details: [destructive], next: "" });
      },
    });
    a.currentTab = async () => ({
      info: async () => info,
      eval: async () => ({ x: 0, y: 0 }),
      items: async () => [{ node: 1, text: "Record" }],
      on: async () => [{ href: destructive, text: "Details" }],
    });
    globalThis.chrome = { tabs: { update: async () => assert.fail("Mutation link must not be followed") } };
    a.read = async () => ({});
    assert.deepEqual(await collect.call(a, step), {});
  });
  test("collection distinguishes next page and same-document tab from another item review link", async () => {
    const els = [
      { label: "E1", node: 1, role: "link", name: "12 Reviews", text: "12 Reviews" },
      { label: "E2", node: 2, role: "link", name: "Page Next", text: "Page Next" },
      { label: "E3", node: 3, role: "tab", name: "Reviews", text: "Reviews" },
    ];
    const metadata = {
      1: { href: "http://owned.test/another-product#reviews", role: "link" },
      2: { href: "http://owned.test/list?page=2", rel: "next", pagination: true },
      3: { href: "http://owned.test/list#reviews", role: "tab", controls: "reviews" },
    };
    const a = agent({
      collect: async (args) => {
        assert.equal(args.options["click E1"], undefined);
        assert.ok(args.options["click E2"]);
        assert.ok(args.options["click E3"]);
        return response({ evidence: "Records read", complete: true, details: [], next: "" });
      },
    });
    a.look = async () => ({ ...scr, els });
    a.currentTab = async () => ({
      info: async () => info,
      eval: async () => ({ x: 0, y: 0 }),
      items: async () => [],
      on: async (node) => metadata[node],
    });
    a.read = async () => ({});
    assert.deepEqual(await collect.call(a, step), {});
  });
}

test("explicit tab switch updates logical binding context without inventing indices", async () => {
  const a = agent({});
  a.background = true;
  a.startTabs = [{ id: 1 }, { id: 2 }];
  a.tabBindings = new Map([
    [0, 10],
    [1, 2],
  ]);
  a.activePlanTab = 0;
  await a.perform({}, { kind: "tab", tab: { id: 2 } });
  assert.equal(a.activePlanTab, 1);
  await a.perform({}, { kind: "tab", tab: { id: 77 } });
  assert.equal(a.activePlanTab, -1);
  assert.deepEqual(
    [...a.tabBindings],
    [
      [0, 10],
      [1, 2],
    ],
  );
});

test("redundant navigation to owned current URL preserves edited form state", async () => {
  const a = agent({});
  a.agentTabId = 7;
  a.ownTab = true;
  const page = { url: "http://owned.test/form", value: "-5", checked: true };
  a.afterShot = { tabId: 7, jpeg: "previous" };
  globalThis.chrome = {
    tabs: {
      get: async () => ({ url: page.url }),
      update: async (_id, { url }) => {
        page.url = url;
        page.value = "6";
        page.checked = false;
      },
    },
  };
  await a.openOwnTab("http://owned.test:80/form");
  assert.equal(page.value, "-5");
  assert.equal(page.checked, true);
  assert.equal(a.afterShot, null);
});

test("actual navigation invalidates cached screenshot and records historical-state boundary", async () => {
  const a = agent({});
  a.agentTabId = 7;
  a.ownTab = true;
  a.afterShot = { tabId: 7, jpeg: "old-form" };
  let visited;
  globalThis.chrome = {
    tabs: {
      get: async () => ({ url: "http://owned.test/form" }),
      update: async (_id, o) => {
        visited = o.url;
      },
    },
  };
  await a.openOwnTab("http://owned.test/results");
  assert.equal(visited, "http://owned.test/results");
  assert.equal(a.afterShot, null);
  assert.equal(a.observations.at(-1).action, "navigation boundary");
});

test("ordinary extraction uses availability while verification and final reads retain completion", async () => {
  const llm = fixtureLLM();
  const schemas = [];
  llm.client.messages.create = async (body) => {
    const schema = body.output_config.format.schema;
    schemas.push(schema);
    const answer = schema.properties.availability
      ? { availability: "available", text: "Franciska", evidence: "Visible first name", next_steps: [] }
      : schema.properties.verdict
        ? { verdict: "fail", text: "", evidence: "Target not met", next_steps: [] }
        : { complete: false, text: "", evidence: "Submission not done", next_steps: [] };
    return {
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: "text", text: JSON.stringify(answer) }],
    };
  };
  const args = {
    task: "Read name then submit it",
    planText: "Read then browse",
    step: { kind: "read", goal: "Read first name" },
    notes: {},
    info,
    image,
  };
  const extract = await llm.read(args);
  assert.equal(extract.json.complete, true);
  assert.equal(extract.json.text, "Franciska");
  assert.equal(schemas[0].properties.complete, undefined);
  assert.equal((await llm.read({ ...args, purpose: "verify" })).json.complete, false);
  assert.equal((await llm.read({ ...args, finalRead: true })).json.complete, false);
  assert.equal(schemas[1].properties.availability, undefined);
  const a = agent({ read: async () => extract });
  a.plan.steps = [
    { kind: "read", goal: "Read first name", save_as: "name" },
    { kind: "browse", goal: "Submit name" },
  ];
  await a.read(a.plan.steps[0]);
  assert.equal(a.notes.name, "Franciska");
  assert.equal(a.plan.steps[1].goal, "Submit name");
});

test("step verification has explicit current target without pending plan actions", async () => {
  const llm = fixtureLLM();
  let sent;
  llm.client.messages.create = async (body) => {
    sent = body;
    return {
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [
        {
          type: "text",
          text: JSON.stringify({ verdict: "pass", evidence: "Grid values match", text: "Matched", next_steps: [] }),
        },
      ],
    };
  };
  const got = await llm.read({
    task: "Match grid then submit",
    planText: "1 Check grid\n2 Submit",
    step: { kind: "verify", goal: "Grid matches pattern", done_when: "All rows match" },
    notes: {},
    info,
    image,
    purpose: "verify",
  });
  const payload = JSON.parse(sent.messages[0].content.find((x) => x.type === "text").text);
  assert.deepEqual(payload.verification_target, { goal: "Grid matches pattern", done_when: "All rows match" });
  assert.equal(payload.plan, undefined);
  assert.equal(payload.task_context, "Match grid then submit");
  assert.equal(sent.output_config.format.schema.properties.complete, undefined);
  assert.equal(got.json.complete, true);
});

test("read and readiness transmit typed current checkbox state with grid identity", async () => {
  const el = {
    label: "E5",
    node: 5,
    role: "checkbox",
    text: "checkbox",
    state: "(not checked)",
    checked: false,
    indeterminate: false,
    grid: { row: 1, column: 1, ordinal: 1, total: 28 },
  };
  const received = [];
  const a = agent({
    read: async (args) => {
      received.push(args.candidates[0]);
      return response({ complete: true, evidence: "Observed", text: "No", next_steps: [] });
    },
    readiness: async (args) => {
      received.push(args.candidates[0]);
      return response({ decision: "not_ready", evidence: "unchecked", next_steps: [] });
    },
  });
  a.look = async () => ({ ...scr, els: [el] });
  await a.read({ kind: "read", goal: "Read checked state", save_as: "state" });
  await a.act(page(), { kind: "click", el: order }, "", { ...scr, els: [el, order] }, [], "drex", 1);
  for (const candidate of received) {
    assert.equal(candidate.checked, false);
    assert.equal(candidate.indeterminate, false);
    assert.deepEqual(candidate.grid, el.grid);
    assert.equal(candidate.role, "checkbox");
  }
  assert.equal(received.length, 2);
});

test("precommit evidence attaches only to exact dispatched action and cannot override failed verification", async () => {
  const a = agent({
    readiness: async () =>
      response({ decision: "ready", evidence: "All four requested tiles selected", next_steps: [] }),
    read: async () => response({ complete: false, evidence: "Server rejected submit", text: "", next_steps: [] }),
  });
  let performed = 0;
  a.perform = async () => performed++;
  a.capture = async () => null;
  a.approvals = false;
  const here = { ...scr, els: [order] };
  const tab = page({ elements: async () => ({ els: [order], off: [] }) });
  await a.act(tab, { kind: "click", el: order }, "", here, [], "llm", 1);
  assert.equal(performed, 1);
  assert.equal(a.observations.length, 1);
  assert.match(a.observations[0].precommit.evidence, /four requested/);
  assert.equal(a.observations[0].precommit.action, a.observations[0].action);
  assert.match((await a.verifyStep(step, here)).rejected, /Server rejected/);
  a.noProgress = new Map();
  await a.act(
    page({ elements: async () => ({ els: [], off: [] }) }),
    { kind: "click", el: order },
    "",
    here,
    [],
    "llm",
    1,
  ); // the target went away
  assert.equal(performed, 1);
  assert.equal(a.observations.length, 1);
  a.noProgress = new Map();
  a.llm.readiness = async () => response({ decision: "not_ready", evidence: "Wrong form", next_steps: [step] });
  await a.act(tab, { kind: "click", el: order }, "", here, [], "llm", 1);
  assert.equal(performed, 1);
  assert.equal(a.observations.length, 1);
});

if (!process.env.CONTROLLER_SOURCE) {
  const { collect } = await import(pathToFileURL(join(process.env.MACROS_SOURCE || source, "macros.ts")));
  test("qualified contract overrides broadened planner enumeration only after detail verification", async () => {
    const href = "http://owned.test/item";
    let verified = 0,
      finalGoal = "";
    const contract = {
      intent: "choose_qualified",
      constraints: ["Fits capacity 5"],
      objective: "",
      scope: "Suitable item",
    };
    const a = agent({
      collectionContract: async (args) => {
        assert.equal(args.task, "Choose best suitable item fitting capacity 5");
        return response(contract);
      },
      collect: async (args) => {
        if (args.rows.length) {
          assert.deepEqual(args.contract, contract);
          assert.doesNotMatch(args.step.goal, /list every item/);
          return response({
            complete: false,
            evidence: "Candidate fits; another is too small",
            details: [],
            next: "scroll down",
            selection: {
              href,
              facts: ["Capacity 6"],
              constraints_satisfied: true,
              comparison: "Other observed capacity 3 fails",
            },
          });
        }
        return response({ complete: true, evidence: "Capacity 6 on detail", details: [], next: "" });
      },
      read: async (args) => {
        verified++;
        assert.match(args.step.goal, /every original-task constraint/);
        return response({ complete: true, evidence: "Detail confirms6", text: "Verified", next_steps: [] });
      },
    });
    a.task = "Choose best suitable item fitting capacity 5";
    a.agentTabId = 2;
    a.ownTab = true;
    globalThis.chrome = { tabs: { create: async () => ({ id: 3 }), remove: async () => {} } };
    const tab = (id) => ({
      id,
      settle: async () => {},
      info: async () => ({ ...info, url: id === 3 ? href : info.url }),
      eval: async () => ({ x: 0, y: 0 }),
      items: async () => (id === 3 ? [] : [{ node: 7, text: "Capacity6" }]),
      on: async () => [{ href, text: "Details" }],
      detach: async () => {},
    });
    a.currentTab = async () => {
      const t = tab(a.agentTabId);
      a.tabs.set(t.id, t);
      return t;
    };
    a.look = async (t) => ({
      ...scr,
      els: [{ label: "E1", role: "link", name: "Details", text: "link 'Details'", node: 7 }],
      info: { ...info, url: t.id === 3 ? href : info.url },
    });
    a.read = async (s) => {
      finalGoal = s.goal;
      assert.doesNotMatch(s.done_when, /every item/);
      assert.doesNotMatch(s.question, /every item/);
      return {};
    };
    a.drexCall = async () => assert.fail("Qualified verified candidate should not crawl next page");
    assert.deepEqual(
      await collect.call(a, {
        ...step,
        goal: "list every item in catalog",
        done_when: "All pages and every item inspected",
        question: "List every item",
        save_as: "items",
      }),
      {},
    );
    assert.equal(verified, 1);
    assert.match(a.notes.items, /QUALIFIED SELECTION/);
    assert.match(finalGoal, /choose_qualified/);
    assert.doesNotMatch(finalGoal, /list every item in catalog/);
  });
  test("explicit optimum and enumerate-all contracts cannot finish from a qualifying candidate alone", async () => {
    for (const intent of ["objective_optimum", "enumerate_all"]) {
      let finalGoal = "";
      const contract = {
        intent,
        constraints: [],
        objective: intent === "objective_optimum" ? "lowest price" : "",
        scope: "All matching records",
      };
      const a = agent({
        collectionContract: async () => response(contract),
        collect: async () =>
          response({
            complete: false,
            evidence: "One candidate; remaining pages unknown",
            details: [],
            next: "",
            selection: { href: info.url, facts: ["Cheap"], constraints_satisfied: true, comparison: "One item" },
          }),
      });
      a.currentTab = async () => ({
        info: async () => info,
        eval: async () => ({ x: 0, y: 0 }),
        items: async () => [],
      });
      a.read = async (s) => {
        finalGoal = s.goal;
        return { fail: "Coverage missing" };
      };
      const result = await collect.call(a, { ...step, save_as: "all" });
      assert.equal(result.fail, "Coverage missing");
      assert.match(a.notes.all, /COVERAGE COMPLETE: false/);
      assert.match(finalGoal, new RegExp(intent));
      assert.doesNotMatch(a.notes.all, /QUALIFIED SELECTION/);
    }
  });
}

if (!process.env.CONTROLLER_SOURCE) {
  const { fill } = await import(pathToFileURL(join(process.env.MACROS_SOURCE || source, "macros.ts")));
  test("desired-state extractor receives identity without current state and retains provenance after diff", async () => {
    const box = {
      label: "E1",
      name: "Consent",
      context: "Preferences (not checked)",
      text: "checkbox Consent",
      role: "checkbox",
      node: 1,
      state: "(not checked)",
      checked: false,
      grid: { row: 1, column: 1 },
      box: [1, 2, 3, 4],
    };
    let checked = false;
    const a = agent({
      fill: async (args) => {
        assert.equal(args.fields[0].checked, undefined);
        assert.equal(args.fields[0].description, undefined);
        assert.equal(args.fields[0].state, undefined);
        assert.equal(args.fields[0].name, "Consent");
        assert.equal(args.fields[0].context, "Preferences");
        return response({
          why: "User requests consent",
          fields: [
            { label: "E1", desired_value: "true", source_kind: "instruction", source_evidence: "Select Consent" },
          ],
          unresolved: [],
        });
      },
    });
    a.look = async () => ({ ...scr, els: [box] });
    a.currentTab = async () => ({ info: async () => info, fieldValue: async () => ({ checked }) });
    a.act = async () => {
      checked = true;
    };
    a.read = async () => ({});
    await fill.call(a, { ...step, save_as: "form" });
    assert.equal(checked, true);
    assert.equal(JSON.parse(a.notes.form)[0].source_evidence, "Select Consent");
  });
  test("unresolved desired state replans inspection without preserving current state as success", async () => {
    const a = agent({
      fill: async () =>
        response({
          why: "Relative target lacks baseline",
          fields: [],
          unresolved: [{ label: "E1", reason: "Increase requires known baseline" }],
        }),
    });
    a.currentTab = async () => ({ info: async () => info });
    a.read = async () => assert.fail("Unresolved form cannot verify as complete");
    a.act = async () => assert.fail("Unresolved desired state cannot mutate");
    const result = await fill.call(a, { ...step, kind: "fill" });
    assert.equal(result.replan[0].kind, "browse");
    assert.equal(result.replan[1].kind, "fill");
    assert.match(result.why, /known baseline/);
    assert.equal(a.notes.form, undefined);
  });
}

test("helper drag coordinates map from original image to CSS and dispatch typed gesture", async () => {
  const a = agent({
    rescue: async () =>
      response({
        decision: "gesture",
        why: "Move requested object",
        x: 40,
        y: 60,
        gesture: { kind: "drag", endX: 100, endY: 120, key: "", modifiers: [] },
      }),
  });
  const result = await a.rescue("Drag object", "State", { ...scr, shot: { scale: 2 } }, {}, {}, []);
  assert.deepEqual(result.act, { kind: "gesture", gesture: { kind: "drag", x: 20, y: 30, endX: 50, endY: 60 } });
  let dispatched;
  await a.perform(
    {
      gesture: async (spec) => {
        dispatched = spec;
      },
    },
    result.act,
  );
  assert.deepEqual(dispatched, result.act.gesture);
});

test("point clicks, drags, double-clicks and key chords are risky: approval first, once per task", async () => {
  const a = agent({});
  let asked = 0;
  a.askApproval = async () => {
    asked++;
    return "always";
  };
  let performed = 0;
  a.perform = async () => performed++;
  a.capture = async () => null;
  for (const act of [
    { kind: "gesture", gesture: { kind: "drag", x: 1, y: 1, endX: 5, endY: 5 } },
    { kind: "point", x: 3, y: 3 },
    { kind: "gesture", gesture: { kind: "keychord", key: "Enter", modifiers: [] } },
  ])
    await a.act(page(), act, "", scr, [], "llm", 1);
  assert.equal(asked, 1);
  assert.equal(performed, 3);
  const b = agent({});
  b.askApproval = async () => false;
  b.perform = async () => assert.fail("declined gesture must not run");
  await assert.rejects(
    b.act(page(), { kind: "gesture", gesture: { kind: "double_click", x: 1, y: 1 } }, "", scr, [], "llm", 1),
    /declined/,
  );
  const c = agent({});
  c.askApproval = async () => assert.fail("hover changes nothing; approvals off asks nothing");
  c.perform = async () => {};
  c.capture = async () => null;
  await c.act(page(), { kind: "gesture", gesture: { kind: "hover", x: 1, y: 1 } }, "", scr, [], "llm", 1);
  c.approvals = false;
  await c.act(page(), { kind: "point", x: 1, y: 1 }, "", scr, [], "llm", 1);
  assert.equal(L.isRiskyGesture({ kind: "point" }), true);
  assert.equal(L.isRiskyGesture({ kind: "gesture", gesture: { kind: "hover" } }), false);
});

test("a point click goes ahead without approval on a harmless target, and asks on a risky or changed one", async () => {
  const target = (over = {}) => ({
    names: ["1 year"],
    role: "option",
    marks: [],
    submits: false,
    frame: false,
    payment: false,
    key: "option|1 year",
    ...over,
  });
  // a chart's range option (coinmarketcap): no approval, the click is made
  const a = agent({});
  a.askApproval = async () => assert.fail("a range option asks no approval");
  a.capture = async () => null;
  const seen = [];
  let clicked = 0;
  const harmless = page({
    pointTarget: async (x, y, opts) => (seen.push([x, y, opts?.hover ?? true]), target()),
    click: async () => clicked++,
  });
  await a.act(harmless, { kind: "point", x: 5, y: 6 }, "", scr, [], "llm", 1);
  assert.equal(clicked, 1);
  assert.deepEqual(seen, [
    [5, 6, true], // read with the mouse there: a control that shows on hover is what counts
    [5, 6, false], // and again just before the click
  ]);
  // an icon-only Delete under the point: approval first, and a decline stops the run with no click
  const b = agent({});
  let asked = "";
  b.askApproval = async (message) => ((asked = message), false);
  const deletes = page({
    pointTarget: async () => target({ names: ["Delete photo"], role: "button", key: "button|Delete photo" }),
    click: async () => assert.fail("a declined Delete is not clicked"),
  });
  await assert.rejects(b.act(deletes, { kind: "point", x: 5, y: 6 }, "", scr, [], "llm", 1), /declined/);
  assert.match(asked, /Delete photo/);
  // the page changed under the point after the check (a Delete slid in): no click, no approval asked
  const c = agent({});
  c.askApproval = async () => assert.fail("the changed target is not clicked or asked about");
  let reads = 0;
  const shifting = page({
    pointTarget: async () => (reads++ ? target({ names: ["Delete"], role: "button", key: "button|Delete" }) : target()),
    click: async () => assert.fail("no click on the changed target"),
  });
  const history = [];
  const out = await c.act(shifting, { kind: "point", x: 5, y: 6 }, "", scr, history, "llm", 1);
  assert.equal(out.blocked, "stale target");
  assert.match(history.at(-1).note, /changed before the click/);
  // the same "Continue" in the same place now submits a payment form: its key is unchanged, its risk is not
  const d = agent({});
  d.askApproval = async () => assert.fail("the now-risky target is not clicked or asked about");
  let looks = 0;
  const same = { names: ["Continue"], role: "button", key: "button|Continue" };
  const paying = page({
    pointTarget: async () => target(looks++ ? { ...same, submits: true, payment: true } : same),
    click: async () => assert.fail("no click on a target that turned risky"),
  });
  const out2 = await d.act(paying, { kind: "point", x: 5, y: 6 }, "", scr, [], "llm", 1);
  assert.equal(out2.blocked, "stale target");
});

test("the end-of-run pop-up close is read with the mouse there and clicked only when the gate would not ask", async () => {
  const run = async (closerName, under) => {
    const a = agent({});
    a.agentTabId = 1;
    a.planning = true;
    let clicks = 0;
    const reads = [];
    const tab = page({
      eval: async () => ({ closer: [5, 6], closerName, visible: false, scrolled: "" }),
      pointTarget: async (x, y, opts) => (reads.push(opts?.hover ?? true), under),
      click: async () => clicks++,
    });
    a.currentTab = async () => tab;
    await a.showEvidence();
    return { clicks, reads };
  };
  const t = (over) => ({ marks: [], submits: false, frame: false, payment: false, key: "", ...over });
  // a plain Close, and a close glyph the gate would call a nameless button: closed, read after a hover
  const close = await run("Close", t({ names: ["Close"], role: "button" }));
  assert.equal(close.clicks, 2);
  assert.ok(close.reads.every((h) => h === true));
  assert.equal((await run("×", t({ names: ["×"], role: "button" }))).clicks, 2);
  // a risky name beside the close name, or a nameless icon a hover laid over it: left alone
  assert.equal((await run("Close", t({ names: ["Close", "Delete account"], role: "button" }))).clicks, 0);
  assert.equal((await run("×", t({ names: ["×", "Delete account"], role: "button" }))).clicks, 0);
  assert.equal((await run("Close", t({ names: ["Close"], role: "button", overlay: true }))).clicks, 0);
  // the hover swapped the control: its names no longer include the close name
  assert.equal((await run("Close", t({ names: ["Remove"], role: "button" }))).clicks, 0);
});

test("a hover points at the item's centre without a click, and its history entry says it only revealed", async () => {
  const a = agent({});
  a.askApproval = async () => assert.fail("pointing asks no approval");
  a.capture = async () => null;
  const pointed = [];
  const tab = page({
    hover: async (x, y) => pointed.push([x, y]),
    click: async () => assert.fail("a hover clicks nothing"),
  });
  const menu = { ...next, role: "menuitem", name: "Jinny", text: "menuitem 'Jinny'", box: [0, 0, 20, 10] };
  const history = [];
  await a.act(tab, { kind: "hover", el: menu }, "", scr, history, "drex", 1);
  assert.deepEqual(pointed, [[10, 5]]);
  assert.equal(history.at(-1).revealOnly, true);
  await a.act(page({ click: async () => {} }), { kind: "click", el: next }, "", scr, history, "drex", 1);
  assert.equal(history.at(-1).revealOnly, undefined);
});

if (!process.env.CONTROLLER_SOURCE) {
  const { fill } = await import(pathToFileURL(join(process.env.MACROS_SOURCE || source, "macros.ts")));
  test("fill prevalidates all assignments before dispatching an earlier valid mutation", async () => {
    const valid = { label: "E1", desired_value: "true", source_kind: "instruction", source_evidence: "Select first" };
    for (const bad of [{ label: "E2", desired_value: "true" }, valid]) {
      const a = agent({ fill: async () => response({ why: "Set controls", fields: [valid, bad], unresolved: [] }) });
      a.currentTab = async () => ({ info: async () => info });
      a.look = async () => ({
        ...scr,
        els: [
          { label: "E1", role: "checkbox", node: 1 },
          { label: "E2", role: "checkbox", node: 2 },
        ],
      });
      a.act = async () => assert.fail("Malformed later assignment must prevent all dispatch");
      const result = await fill.call(a, step);
      assert.ok(result.fail);
    }
  });
}

if (!process.env.CONTROLLER_SOURCE) {
  const { collect } = await import(pathToFileURL(join(process.env.MACROS_SOURCE || source, "macros.ts")));
  test("collection suggests preparation then falls back to traversal", async () => {
    const contract = {
      intent: "enumerate_all",
      constraints: ["All account orders"],
      objective: "",
      scope: "All account orders",
      sort_direction: "none",
    };
    const a = agent({
      collectionContract: async () => response(contract),
      collectionPreparation: async (args) => {
        assert.deepEqual(args.contract, contract);
        return response({
          ready: false,
          evidence: "Homepage, not account orders",
          sort_available: false,
          observed_sort_direction: "none",
          steps: [{ ...step, kind: "browse", goal: "Open account orders list", max_moves: 100 }],
        });
      },
      collect: async () => assert.fail("Unprepared homepage must not be enumerated"),
    });
    a.currentTab = async () => ({ info: async () => info, items: async () => assert.fail("No rows before prepared") });
    for (let i = 0; i < 3; i++) {
      const got = await collect.call(a, step);
      assert.equal(got.replan[0].max_moves, 12);
      assert.equal(got.replan.at(-1).open_url, "");
    }
    a.currentTab = async () => ({ info: async () => info, eval: async () => ({ x: 0, y: 0 }), items: async () => [] });
    a.llm.collect = async () =>
      response({ evidence: "Visible rows checked manually", complete: true, details: [], next: "" });
    a.read = async () => ({ reachedVerification: true });
    assert.equal((await collect.call(a, step)).reachedVerification, true);
    assert.match(a.notes.collection_preparation, /manually/);
  });
  test("objective collection rejects incorrect observed sort direction for both minimum and maximum", async () => {
    for (const direction of ["asc", "desc"]) {
      const a = agent({
        collectionContract: async () =>
          response({
            intent: "objective_optimum",
            constraints: ["Matching products"],
            objective: direction === "asc" ? "Lowest price" : "Highest price",
            scope: "Matching products",
            sort_direction: direction,
          }),
        collectionPreparation: async () =>
          response({
            ready: true,
            evidence: "Wrong sort direction",
            sort_available: true,
            observed_sort_direction: direction === "asc" ? "desc" : "asc",
            steps: [{ ...step, goal: "Set required price sort" }],
          }),
        collect: async () => assert.fail("Wrong ordering cannot start optimum collection"),
      });
      a.currentTab = async () => ({ info: async () => info });
      const result = await collect.call(a, step);
      assert.match(result.why, /Prepare collection/);
    }
  });
  // e2e/site/filters.html: "cheapest nonstop flight" among three shown, next to a Price chip that doesn't sort
  test("a list that is all on the page is read for its optimum without sorting first", async () => {
    const a = agent({
      collectionContract: async () =>
        response({
          intent: "objective_optimum",
          constraints: ["Nonstop flights"],
          objective: "Lowest price",
          scope: "Nonstop flights",
          sort_direction: "asc",
        }),
      collectionPreparation: async () =>
        response({
          ready: true,
          evidence: "Three nonstop flights shown; a Price control exists",
          sort_available: true,
          observed_sort_direction: "none",
          whole_list_on_page: true,
          steps: [{ ...step, goal: "Sort by price" }],
        }),
      collect: async () =>
        response({ evidence: "JetBlue $229 is the cheapest of three", complete: true, details: [], next: "" }),
    });
    a.currentTab = async () => ({ info: async () => info, eval: async () => ({ x: 0, y: 0 }), items: async () => [] });
    a.read = async () => ({ verifiedByReader: true });
    const result = await collect.call(a, step);
    assert.equal(result.replan, undefined);
    assert.equal(result.verifiedByReader, true);
  });
}

if (!process.env.CONTROLLER_SOURCE) {
  const { fill } = await import(pathToFileURL(join(process.env.MACROS_SOURCE || source, "macros.ts")));
  test("fill value verification excludes original submission completion condition", async () => {
    const a = agent({ fill: async () => response({ why: "No assignments needed", fields: [], unresolved: [] }) });
    a.currentTab = async () => ({ info: async () => info });
    let verified;
    a.read = async (value) => {
      verified = value;
      return {};
    };
    await fill.call(a, {
      ...step,
      goal: "Fill requested fields",
      done_when: "Submit pressed visibly once",
      question: "Has Submit been pressed?",
    });
    assert.doesNotMatch(verified.done_when, /Submit pressed visibly once/);
    assert.match(verified.done_when, /submission is not required/);
    assert.doesNotMatch(verified.question, /Has Submit/);
    assert.match(verified.question, /before submission/);
  });
}

test("absent collection filter continues row extraction and evidence verification", async () => {
  const { collect } = await import(pathToFileURL(join(process.env.MACROS_SOURCE || source, "macros.ts")));
  const a = agent({
    collectionPreparation: async () =>
      response({ ready: false, evidence: "No date filter exists", sort_available: false, steps: [] }),
    collect: async () => response({ evidence: "Two public records inspected", complete: true, details: [], next: "" }),
  });
  let enumerated = 0;
  a.currentTab = async () => ({
    info: async () => info,
    eval: async () => ({ x: 0, y: 0 }),
    items: async () => {
      enumerated++;
      return [];
    },
  });
  a.read = async () => ({ verifiedByReader: true });
  assert.equal((await collect.call(a, step)).verifiedByReader, true);
  assert.equal(enumerated, 1);
});
test("missing evidence without helper repair triggers inspection without inventing an answer", async () => {
  const a = agent({
    read: async () => response({ complete: false, evidence: "Exact price filter absent", next_steps: [] }),
  });
  const result = await a.read({ ...step, kind: "read", save_as: "answer" });
  assert.equal(result.fail, undefined);
  assert.equal(result.replan[0].kind, "browse");
  assert.equal(result.replan.at(-1).save_as, "answer");
  assert.equal(a.notes.answer, undefined);
});
test("the helper hands over for a login or a choice only the user can make; a hand-over with no reason is giving up", async () => {
  let user_need = "none";
  const a = agent({
    rescue: async () =>
      response({
        decision: "ask_user",
        user_need,
        why: user_need === "none" ? "Missing exact option" : "Pick one of your saved addresses",
        new_steps: [],
      }),
  });
  let result = await a.rescue("help", "", scr, {}, {}, []);
  assert.equal(result.ask, undefined);
  assert.equal(result.fail, "Missing exact option");
  for (user_need of ["login", "choice"]) {
    result = await a.rescue("help", "", scr, {}, {}, []);
    assert.equal(result.ask, "Pick one of your saved addresses");
  }
  a.planning = false;
  user_need = "none";
  assert.equal((await a.rescue("help", "", scr, {}, {}, [])).ask, "Missing exact option"); // no plan: any hand-over waits for you
});
// Drex can hand the screen over at a consent dialog after the run's first call. With a plan,
// its hand-over goes past the helper first, which confirms a real wall or closes the pop-up; with planning off (the
// user drives) it is handed over at once, without an LLM call.
test('Drex "ask user" goes past the helper with a plan, and straight to you without one', async () => {
  let reason = "";
  const a = agent({
    rescue: async (args) => {
      reason = JSON.stringify(args);
      return response({ decision: "ask_user", user_need: "captcha", why: "Solve the CAPTCHA", new_steps: [] });
    },
  });
  a.drexCall = drexSays(["ask user", 0.01], ["step done", 0.99]);
  let asked = "";
  a.askUser = async (m) => {
    asked = m;
  };
  assert.deepEqual(await a.browse(step), {});
  assert.equal(asked, "Solve the CAPTCHA");
  assert.match(reason, /cookie, consent/);
  const b = agent(noLLM());
  b.planning = false;
  b.drexCall = drexSays(["ask user", 0.01], ["step done", 0.99]);
  b.askUser = async (m) => {
    asked = m;
  };
  assert.deepEqual(await b.browse(step), {});
  assert.match(asked, /choice only you can make/);
});
test("a search engine's CAPTCHA on the way to the task's site is not handed over: the run goes back to the site", async () => {
  const a = agent({});
  a.site = "https://www.nvidia.com/";
  a.agentTabId = 1;
  a.notes = {};
  const went = [];
  const tab = page({
    info: async () => ({ ...info, url: "https://www.google.com/sorry/index?continue=x" }),
    navigate: async (url) => went.push(url),
  });
  a.currentTab = async () => tab;
  a.waitForUser = async () => assert.fail("a search engine's check is not the user's");
  await a.askUser("Solve the CAPTCHA");
  assert.deepEqual(went, ["https://www.nvidia.com/"]);
  assert.match(a.notes.search_engine_blocked, /www\.nvidia\.com's own menus/);
  // on the task's own site a CAPTCHA is the user's
  const b = agent({});
  b.site = "https://www.nvidia.com/";
  b.agentTabId = 1;
  b.currentTab = async () => page({ info: async () => ({ ...info, url: "https://www.nvidia.com/verify" }) });
  let waited = 0;
  b.waitForUser = async () => (waited++, true);
  await b.askUser("Solve the CAPTCHA");
  assert.equal(waited, 1);
});
// Runs could scroll a results page until the call limit. Four scrolls in a
// row hand the next move to the helper, which may replan; a second run of them ends the step.
test("a run of scrolls goes to the helper once, and a second run ends the step", async () => {
  const reasons = [];
  const a = agent({
    rescue: async (args) => {
      reasons.push(args.reason);
      return response({
        decision: "move",
        user_need: "none",
        option: "scroll down",
        text: "",
        why: "look further",
        x: 0,
        y: 0,
        gesture: { kind: "hover", endX: 0, endY: 0, key: "", modifiers: [] },
        new_steps: [],
      });
    },
  });
  a.drexCall = drexSays(["scroll down", 0]);
  let scrolled = 0;
  // every scroll brings other rows into view
  const rows = () => [
    { ...next, label: "E1", name: `row ${scrolled}`, text: `link 'row ${scrolled}'`, node: 10 + scrolled },
  ];
  const tab = page({ scroll: async () => scrolled++, elements: async () => ({ els: rows(), off: [] }) });
  a.currentTab = async () => tab;
  a.look = async () => ({ ...scr, els: rows() });
  a.capture = async () => null;
  const out = await a.browse({ ...step, max_moves: 20 });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /scrolled 4 times in a row/);
  assert.match(out.fail, /got stuck twice/);
  assert.equal(scrolled, 8); // 4 by Drex, 1 by the helper, 3 more by Drex
});
test("a repeat of a click that changed nothing goes to the helper, who may replan; a second repeat ends the step", async () => {
  const deadClicks = (rescue) => {
    const a = agent({ rescue });
    // Drex clicks, clicks again, then scrolls twice: every move leaves the screen as it was
    a.drexCall = drexSays(["click E1", 0], ["click E1", 0], ["scroll down", 0]);
    a.agentTabId = 1;
    a.look = async () => ({ ...scr, els: [next], jpeg: "same" });
    a.currentTab = async () => page({ click: async () => {}, scroll: async () => {} });
    a.capture = async () => "same"; // the screen after the click: unchanged
    return a;
  };
  const reasons = [];
  const replanned = await deadClicks(async (args) => {
    reasons.push(args.reason);
    return response({
      decision: "replan",
      user_need: "none",
      option: "",
      text: "",
      why: "use the filter",
      x: 0,
      y: 0,
      gesture: { kind: "hover", endX: 0, endY: 0, key: "", modifiers: [] },
      new_steps: [step],
    });
  }).browse({ ...step, max_moves: 20 });
  assert.match(reasons[0], /changed nothing on screen before/);
  assert.equal(replanned.why, "use the filter");
  const helped = deadClicks(async () =>
    response({
      decision: "move",
      user_need: "none",
      option: "click E1",
      text: "",
      why: "try again",
      x: 0,
      y: 0,
      gesture: { kind: "hover", endX: 0, endY: 0, key: "", modifiers: [] },
      new_steps: [],
    }),
  );
  const ended = await helped.browse({ ...step, max_moves: 20 });
  assert.match(ended.fail, /got stuck twice/);
});
// a scroll run and an unrelated dead move are two different loops: one of each is not "stuck twice"
test("a dead-move round and a later scroll run each go to the helper; neither ends the step", async () => {
  const reasons = [];
  const a = agent({
    rescue: async (args) => {
      reasons.push(args.reason);
      return response({
        decision: reasons.length === 1 ? "move" : "replan",
        user_need: "none",
        option: reasons.length === 1 ? "scroll down" : "",
        text: "",
        why: "use the filter",
        x: 0,
        y: 0,
        gesture: { kind: "hover", endX: 0, endY: 0, key: "", modifiers: [] },
        new_steps: reasons.length === 1 ? [] : [step],
      });
    },
  });
  // Drex clicks a control that changes nothing, clicks it again, then scrolls a list whose rows change each time
  a.drexCall = drexSays(["click E1", 0], ["click E1", 0], ["scroll down", 0]);
  a.agentTabId = 1;
  let scrolled = 0;
  const rows = () => [{ ...next, label: "E1", name: `row ${scrolled}`, text: `link 'row ${scrolled}'`, node: 10 }];
  a.look = async () => ({ ...scr, els: rows(), jpeg: `shot ${scrolled}` });
  const tab = page({
    click: async () => {},
    scroll: async () => scrolled++,
    elements: async () => ({ els: rows(), off: [] }),
  });
  a.currentTab = async () => tab;
  a.capture = async () => `shot ${scrolled}`;
  const out = await a.browse({ ...step, max_moves: 20 });
  assert.equal(reasons.length, 2, reasons.join("\n"));
  assert.match(reasons[0], /changed nothing on screen before/);
  assert.match(reasons[1], /scrolled 4 times in a row/);
  assert.equal(out.fail, undefined);
  assert.equal(out.why, "use the filter");
});
// A run used to end on "The agent can't work on ." after a click opened a blank tab.
test("a blank tab a click opened is closed, and the run goes on in the tab the click was made in", async () => {
  const previous = globalThis.chrome;
  const removed = [];
  globalThis.chrome = {
    tabs: {
      get: async (id) =>
        id === 7
          ? { id, url: "about:blank", status: "complete", active: true }
          : { id, url: "https://www.bestbuy.com/site/x", status: "complete", active: true },
      remove: async (id) => removed.push(id),
      update: async () => {},
    },
  };
  try {
    const a = agent({});
    a.agentTabId = 1;
    a.newTabId = 7;
    a.activePlanTab = 0;
    a.tabBindings = new Map([[0, 1]]);
    a.startTabs = [{ id: 1, url: "https://www.bestbuy.com/", active: true }];
    a.group = async () => {};
    const tab = page();
    a.tabs = new Map([[1, tab]]);
    a.currentTab = Object.getPrototypeOf(a).currentTab;
    const got = await a.currentTab();
    assert.equal(got, tab);
    assert.equal(a.agentTabId, 1);
    assert.deepEqual(removed, [7]);
    assert.equal(a.tabBindings.get(0), 1);
  } finally {
    globalThis.chrome = previous;
  }
});

// Collect steps could read result lists a model call per item until the run's call cap. A collect step's
// model calls are capped; past the cap it ends with what it read, and calls outside a collect step aren't counted.
test("a collect step's model reads are capped, and the step ends with what it read", async () => {
  const a = agent({});
  const call = () => a.llmCall("collect", async () => ({ json: {}, usd: 0, ms: 1, physicalCalls: 1 }));
  for (let i = 0; i < 10; i++) await call(); // outside a collect step: not counted
  a.collectCalls = 0;
  for (let i = 0; i < 6; i++) await call();
  await assert.rejects(call(), /used its 6 model reads/);
  a.collectCalls = null;
  await call();
  // a collect step that runs out of reads ends done, with a note saying so, instead of failing the run
  const b = agent({});
  b.llmCall = async () => {
    throw new ReadCap("out of reads");
  };
  assert.deepEqual(await b.collectCapped({ ...step, kind: "collect", save_as: "rows" }), {});
  assert.match(b.notes.collection_read_cap, /answer from what was read/);
  assert.equal(b.collectCalls, null);
});

// window.open() and then setting its address: the tab is blank and loaded for a moment, then loads the page
test("a click-opened tab that is blank only until its page starts is kept", async () => {
  const previous = globalThis.chrome;
  const removed = [];
  let asked = 0;
  globalThis.chrome = {
    tabs: {
      get: async (id) =>
        id === 7 && asked++ === 0
          ? { id, url: "about:blank", status: "complete", active: true }
          : { id, url: "https://pay.example.com/checkout", status: "loading", active: true },
      remove: async (id) => removed.push(id),
      update: async () => {},
    },
  };
  try {
    const a = agent({});
    a.agentTabId = 1;
    a.newTabId = 7;
    a.startTabs = [{ id: 1, url: "https://www.bestbuy.com/", active: true }];
    a.group = async () => {};
    const tab = page();
    a.tabs = new Map([[7, tab]]);
    a.currentTab = Object.getPrototypeOf(a).currentTab;
    assert.equal(await a.currentTab(), tab);
    assert.equal(a.agentTabId, 7);
    assert.deepEqual(removed, []);
  } finally {
    globalThis.chrome = previous;
  }
});

// the address shows only once the page answers: a slow page is pending, its tab loading, and still kept
test("a click-opened tab still blank while its page is pending is kept", async () => {
  const previous = globalThis.chrome;
  const removed = [];
  let asked = 0;
  globalThis.chrome = {
    tabs: {
      get: async (id) =>
        id === 7 && asked++ === 0
          ? { id, url: "about:blank", status: "complete", active: true }
          : { id, url: "about:blank", pendingUrl: "https://shop.example.com/item", status: "loading", active: true },
      remove: async (id) => removed.push(id),
      update: async () => {},
    },
  };
  try {
    const a = agent({});
    a.agentTabId = 1;
    a.newTabId = 7;
    a.startTabs = [{ id: 1, url: "https://www.bestbuy.com/", active: true }];
    a.group = async () => {};
    const tab = page();
    a.tabs = new Map([[7, tab]]);
    a.currentTab = Object.getPrototypeOf(a).currentTab;
    assert.equal(await a.currentTab(), tab);
    assert.equal(a.agentTabId, 7);
    assert.deepEqual(removed, []);
  } finally {
    globalThis.chrome = previous;
  }
});

test("the helper asked by Drex hands over to the user in the browse loop", async () => {
  const a = agent({
    rescue: async () => response({ decision: "ask_user", user_need: "choice", why: "Which card?", new_steps: [] }),
  });
  a.drexCall = drexSays(["ask for help", 0.01], ["step done", 0.99]);
  let asked = "";
  a.askUser = async (m) => {
    asked = m;
  };
  assert.deepEqual(await a.browse(step), {});
  assert.equal(asked, "Which card?");
});
const runChrome = () => {
  const noop = { addListener() {}, removeListener() {} };
  return {
    tabs: { onCreated: noop },
    debugger: { onDetach: noop },
    windows: { getCurrent: async () => ({ id: 1 }), getLastFocused: async () => ({ id: 1 }) },
  };
};
test("a step that keeps asking for new plans ends the run after the recovery cap", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    const a = agent({});
    a.fixedPlan = { steps: [step] };
    a.prepare = async () => {};
    let calls = 0;
    a.browse = async () => {
      calls++;
      return { replan: [step], why: "Inspect further" };
    };
    const result = await a.run("Inspect safely");
    assert.equal(result.status, "failed");
    assert.match(result.message, /Gave up after 6 new plans/);
    assert.equal(calls, 7);
  } finally {
    globalThis.chrome = previous;
  }
});
test("a permanently failing step (the helper gives up every time) ends the run", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    const a = agent({});
    a.fixedPlan = { steps: [step] };
    a.prepare = async () => {};
    let calls = 0;
    a.browse = async () => {
      calls++;
      return { fail: "The page has no such option" };
    };
    const result = await a.run("Do the impossible");
    assert.equal(result.status, "failed");
    assert.equal(calls, 7);
  } finally {
    globalThis.chrome = previous;
  }
});
test("a read that keeps finding its answer missing ends after three tries", async () => {
  const a = agent({
    read: async () =>
      response({
        complete: false,
        evidence: "No price shown",
        text: "",
        next_steps: [{ ...step, goal: "Scroll to the price" }],
      }),
  });
  const readStep = { ...step, kind: "read", save_as: "price" };
  assert.ok((await a.read(readStep)).replan);
  assert.ok((await a.read(readStep)).replan);
  const third = await a.read(readStep);
  assert.equal(third.terminal, true);
  assert.match(third.fail, /No price shown/);
});
test("no final read is appended with planning off or with a fixed plan", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    for (const setup of [
      (a) => {
        a.planning = false;
      },
      (a) => {
        a.fixedPlan = { steps: [step] };
      },
    ]) {
      const a = agent(noLLM());
      setup(a);
      a.prepare = async () => {};
      let calls = 0;
      a.browse = async () => {
        calls++;
        return {};
      };
      const result = await a.run("Sort descending");
      assert.equal(result.status, "done");
      assert.equal(calls, 1);
      assert.equal(result.record.filter((e) => e.type === "plan").at(-1).plan.steps.length, 1);
    }
  } finally {
    globalThis.chrome = previous;
  }
});
test("a plan step with an unknown kind runs as a browse step", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    const a = agent(noLLM());
    a.fixedPlan = { steps: [{ ...step, kind: "teleport" }] };
    a.prepare = async () => {};
    const asked = [];
    const says = drexSays(["step done", 0.99]);
    a.drexCall = async (_state, questions) => {
      asked.push(questions);
      return says();
    };
    const result = await a.run("Sort descending");
    assert.equal(result.status, "done");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].move.type, "choice");
    assert.ok("step done" in asked[0].move.criteria);
  } finally {
    globalThis.chrome = previous;
  }
});
test("a replan may only open sites the task started on or named, and notes are typed only there", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    const a = agent({});
    a.fixedPlan = { steps: [{ ...step, open_url: "http://owned.test/list" }] };
    a.windowTabs = async () => [{ id: 1, url: "http://start.test/inbox", title: "Inbox", active: true }];
    const opened = [];
    a.prepare = async (s) => opened.push(s.open_url);
    let calls = 0;
    a.browse = async () =>
      ++calls === 1
        ? {
            replan: [
              { ...step, goal: "Send the notes", open_url: "https://attacker.test/collect" },
              { ...step, goal: "Next page", open_url: "http://owned.test/list?page=2" },
            ],
            why: "The page says to go there",
          }
        : {};
    const result = await a.run("Sort descending");
    assert.equal(result.status, "done");
    assert.deepEqual(opened, ["http://owned.test/list", "", "http://owned.test/list?page=2"]);
    assert.ok(result.record.some((e) => e.type === "blocked" && /attacker\.test/.test(e.what)));
  } finally {
    globalThis.chrome = previous;
  }
  const texts = [
    { name: "body", text: "{{notes}}" },
    { name: "query", text: "shoes" },
  ];
  assert.deepEqual(L.resolveTexts(texts, { notes: "secret" }, false), [{ name: "query", text: "shoes" }]);
  assert.deepEqual(
    L.resolveTexts(texts, { notes: "secret" }).map((t) => t.text),
    ["secret", "shoes"],
  );
  const a = agent({});
  a.trusted = new Set(["http://owned.test"]);
  a.notes = { notes: "secret" };
  const offered = [];
  a.drexCall = async (state, qs) => {
    offered.push(Object.keys(qs.move.criteria).some((k) => /body/.test(k)));
    return {
      answers: { move: { choice: "step done", probabilities: { "step done": 0.99 } }, done: { noul: 0.99 } },
      ms: 1,
      usd: 0,
    };
  };
  const field = {
    label: "E1",
    role: "textbox",
    name: "Message",
    text: "textbox 'Message'",
    field: true,
    node: 1,
    box: [0, 0, 10, 10],
  };
  for (const url of ["http://owned.test/form", "https://attacker.test/form"]) {
    a.look = async () => ({ ...scr, els: [field], info: { ...info, url } });
    await a.browse({ ...step, texts });
  }
  assert.deepEqual(offered, [true, false]);
});
test("every prompt that shows a page tells the LLM to ignore instructions on it", async () => {
  const { PAGE_SAFETY } = await import(pathToFileURL(join(source, "llm.ts")));
  const llm = fixtureLLM();
  const systems = [];
  llm.client.messages.create = async (body) => {
    systems.push(body.system);
    return {
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            availability: "available",
            verdict: "pass",
            evidence: "",
            text: "",
            next_steps: [],
            decision: "ready",
            fields: [],
            unresolved: [],
            why: "",
            ready: true,
            steps: [],
            sort_available: false,
            observed_sort_direction: "none",
            complete: true,
            details: [],
            next: "",
          }),
        },
      ],
    };
  };
  const args = {
    task: "t",
    planText: "",
    step,
    notes: {},
    info,
    image,
    fields: [],
    candidates: [],
    observations: [],
    rows: [],
    options: {},
    state: "",
    reason: "",
    opts: {},
    field: "f",
    moves: [],
    tabs: [],
    today: "",
    contract: {},
  };
  for (const m of ["read", "readiness", "fill", "collect", "collectionPreparation", "rescue", "write", "plan"])
    await llm[m](args);
  await llm.read({ ...args, purpose: "verify" });
  await llm.read({ ...args, finalRead: true });
  assert.equal(systems.length, 10);
  for (const s of systems) assert.ok(s.includes(PAGE_SAFETY));
});
if (!process.env.CONTROLLER_SOURCE) {
  const { collect, mutating } = await import(pathToFileURL(join(process.env.MACROS_SOURCE || source, "macros.ts")));
  test("collection follows only shown, non-mutating links of the page", async () => {
    const shown = "http://owned.test/item/1";
    const hidden = "http://owned.test/item/2"; // drawn in the row, but not an element Drex could see
    const unsubscribe = "http://owned.test/list/unsubscribe?id=1";
    const opened = [];
    const a = agent({
      collect: async (args) => {
        if (!args.rows.length) return response({ evidence: "Detail read", complete: true, details: [], next: "" });
        assert.deepEqual(
          args.rows[0].links.map((l) => l.href),
          [shown],
        );
        return response({ evidence: "One record", complete: true, details: [hidden, unsubscribe, shown], next: "" });
      },
    });
    a.look = async () => ({
      ...scr,
      els: [
        { label: "E1", role: "link", name: "Details", text: "link 'Details'", node: 7 },
        { label: "E2", role: "link", name: "Stop emails", text: "link 'Stop emails'", node: 8 },
      ],
    });
    a.currentTab = async () => ({
      id: a.agentTabId,
      settle: async () => {},
      info: async () => info,
      eval: async () => ({ x: 0, y: 0 }),
      detach: async () => {},
      items: async () => (a.agentTabId === 3 ? [] : [{ node: 1, text: "Record" }]),
      on: async () => [
        { href: shown, text: "Details" },
        { href: hidden, text: "More" },
        { href: unsubscribe, text: "Stop emails" },
      ],
    });
    globalThis.chrome = {
      tabs: {
        create: async ({ url }) => {
          opened.push(url);
          return { id: 3 };
        },
        remove: async () => {},
        group: async () => 5,
      },
      tabGroups: { update: async () => {} },
    };
    a.runOptions.efficiency.cheapCollection = false; // This fixture supplies the original per-detail reader.
    a.read = async () => ({});
    await collect.call(a, step);
    assert.deepEqual(opened, [shown]);
    for (const t of ["Unsubscribe", "/account/signout", "mark-as-read", "Log out", "/archive?id=1", "Approve", "Add"])
      assert.equal(mutating(t), true, t);
    for (const t of ["Details", "/orders/123", "/posts/1", "Address book", "Page 2"])
      assert.equal(mutating(t), false, t);
  });
}

// --- second review ---------------------------------------------------------------------------------------------------
test("a planned action task whose final check finds no confirmation ends done with a caveat, not more actions", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    let reads = 0,
      browses = 0;
    const a = agent({
      plan: async () => response({ summary: "", answer_from: "", steps: [{ ...step, goal: "Send the message" }] }),
      read: async (args) => {
        reads++;
        assert.equal(args.finalRead, true);
        return response({
          complete: false,
          evidence: "The sent message is no longer on screen",
          text: "",
          next_steps: [{ ...step, goal: "Send it again" }],
        });
      },
    });
    a.prepare = async () => {};
    a.browse = async () => {
      browses++;
      return {};
    };
    const result = await a.run("Send Bob the report");
    assert.equal(result.status, "done");
    assert.equal(browses, 1);
    assert.equal(reads, 1);
    assert.match(result.answer, /Not confirmed on screen: The sent message/);
  } finally {
    globalThis.chrome = previous;
  }
});

test('rejected step checks count toward the cap: Drex saying "step done" every move stops after three checks', async () => {
  let checks = 0;
  const a = agent({
    read: async () => {
      checks++;
      return response({ complete: false, evidence: "No confirmation yet", text: "", next_steps: [] });
    },
  });
  a.look = async () => ({ ...scr, els: [order] });
  a.drexCall = drexSays(["click E2", 0.01], ["step done", 0.99]);
  a.act = async (_tab, act) => ({ dispatched: true, risky: L.isRisky(act) });
  const result = await a.browse(step);
  assert.equal(checks, 3);
  assert.equal(result.terminal, true);
  assert.match(result.fail, /No confirmation yet/);
});

test("with planning off, failed checks never replan", async () => {
  const a = agent({
    read: async () => response({ complete: false, evidence: "Wrong item", text: "", next_steps: [step] }),
    readiness: async () => response({ decision: "not_ready", evidence: "Wrong item in cart", next_steps: [step] }),
  });
  a.planning = false;
  assert.deepEqual(await a.verifyStep(step, scr), { rejected: "Wrong item" });
  a.perform = async () => assert.fail("not ready");
  const out = await a.act(page(), { kind: "click", el: order }, null, scr, [], "drex", 1);
  assert.equal(out.replan, undefined);
  assert.equal(out.blocked, "Wrong item in cart");
});

test("the miss count starts over when the plan moves to the next step", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    let reads = 0;
    const a = agent({
      read: async () =>
        ++reads <= 3
          ? response({
              complete: false,
              evidence: "Price below the fold",
              text: "",
              next_steps: [{ ...step, goal: "Scroll to the price" }],
            })
          : response({ complete: true, evidence: "Price shown", text: "$5", next_steps: [] }),
    });
    a.fixedPlan = { steps: [{ ...step, kind: "read", save_as: "price" }], answer_from: "price" };
    a.prepare = async () => {};
    a.browse = async () => ({});
    const result = await a.run("Find the price");
    assert.equal(result.status, "done");
    assert.equal(result.answer, "$5");
    assert.equal(reads, 4);
  } finally {
    globalThis.chrome = previous;
  }
});

if (!process.env.CONTROLLER_SOURCE) {
  const { fill } = await import(pathToFileURL(join(process.env.MACROS_SOURCE || source, "macros.ts")));
  test("an incomplete fill check runs the fill again, not just its check", async () => {
    const fillStep = { ...step, kind: "fill", goal: "Fill the form", save_as: "form" };
    const a = agent({
      fill: async () => response({ why: "", fields: [], unresolved: [] }),
      read: async () =>
        response({
          complete: false,
          evidence: "Email still empty",
          text: "",
          next_steps: [{ ...step, goal: "Scroll to the email field" }],
        }),
    });
    a.plan.steps = [fillStep];
    const result = await fill.call(a, fillStep);
    assert.equal(result.replan.at(-1).kind, "fill");
    assert.equal(result.replan.at(-1).goal, "Fill the form");
  });
}

test("a move checks against the step that made it, not an earlier browse step", async () => {
  const fillStep = { ...step, kind: "fill", goal: "Fill the shipping form" };
  let checked = "";
  const a = agent({
    readiness: async () => response({ decision: "already_done", evidence: "Saved", next_steps: [] }),
    read: async (args) => {
      checked = args.step.goal;
      return response({ complete: true, evidence: "ok", text: "", next_steps: [] });
    },
  });
  a.plan.steps = [{ ...step, goal: "An earlier browse step" }];
  await a.act(page(), { kind: "click", el: order }, null, scr, [], "macro", 1, "", { step: fillStep });
  assert.match(checked, /Fill the shipping form/);
});

test("a re-rendered target (new node, same role, label and place) is not stale", () => {
  const now = { els: [{ ...order, node: 99 }], off: [] };
  assert.equal(L.targetStale(order, now), false);
  assert.equal(L.targetStale(order, { els: [{ ...order, node: 99, box: [20, 200, 40, 210] }] }), true);
  assert.equal(L.targetStale(order, { els: [{ ...order, node: 99, name: "Cancel order" }] }), true);
});

test("notes and helper-typed texts are not offered on a site the task did not start on or name", async () => {
  const a = agent({
    rescue: async () =>
      response({
        decision: "move",
        user_need: "none",
        option: "click E1",
        text: "my secret note",
        why: "type it",
        x: 0,
        y: 0,
        gesture: { kind: "hover", endX: 0, endY: 0, key: "", modifiers: [] },
        new_steps: [],
      }),
  });
  a.trusted = new Set(["http://owned.test"]);
  a.notes = { secret: "S3CRET-NOTE" };
  const field = {
    label: "E1",
    role: "textbox",
    name: "Message",
    text: "textbox 'Message'",
    field: true,
    node: 1,
    box: [0, 0, 10, 10],
  };
  const urls = ["http://owned.test/form", "http://owned.test/form", "https://attacker.test/form"];
  let n = 0;
  a.look = async () => ({ ...scr, els: [field], info: { ...info, url: urls[Math.min(n, 2)] } });
  a.act = async () => ({ dispatched: true, risky: false });
  const seen = [];
  a.drexCall = async (state, qs) => {
    seen.push({
      notes: state.includes("S3CRET-NOTE"),
      typed: JSON.stringify(qs.move.criteria).includes("my secret note"),
    });
    const choice = ["ask for help", "scroll down", "step done"][n++];
    return {
      answers: {
        move: { choice, probabilities: { [choice]: 0.99 } },
        done: { noul: choice === "step done" ? 0.99 : 0.01 },
      },
      ms: 1,
      usd: 0,
    };
  };
  await a.browse(step);
  assert.deepEqual(seen, [
    { notes: true, typed: false },
    { notes: true, typed: true },
    { notes: false, typed: false },
  ]);
});

test("a run on a pricier model gets a cost cap scaled to its price; a cap set in runLimits still wins", () => {
  const opus = { model: "claude-opus-5-5" };
  assert.ok(Math.abs(new Agent({ drex: {}, llm: { ...opus }, emit() {} }).runBudget.limits.maxCostUsd - 3.2) < 1e-9);
  assert.equal(
    new Agent({ drex: {}, llm: { ...opus }, emit() {}, runOptions: { limits: { maxCostUsd: 0.1 } } }).runBudget.limits
      .maxCostUsd,
    0.1,
  );
  assert.equal(
    new Agent({ drex: {}, llm: { model: "claude-haiku-5-5" }, emit() {} }).runBudget.limits.maxCostUsd,
    0.08,
  );
});
test("a planned run that ends at a limit still answers the task in its format, with the request kept back for it", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    const finals = [];
    const json = '{"task_type":"RETRIEVE","status":"SUCCESS","retrieved_data":[17.25],"error_details":null}';
    const a = agent({
      plan: async () => response({ summary: "", answer_from: "", steps: [{ ...step, goal: "Find the price" }] }),
      finalAnswerHold: () => ({ calls: 1, usd: 0.002, ms: 1000 }),
      finalAnswer: async (args) => {
        finals.push(args);
        return response({ evidence: "Public price 17.25 in the notes", supported: true, answer: json });
      },
      read: async () => assert.fail("the planned final read never runs: the limit came first"),
    });
    a.prepare = async () => {};
    a.browse = async () => {
      assert.equal(a.runBudget.held.calls, 1); // kept back from the start, before any step
      a.notes.price = "Public price 17.25";
      throw Object.assign(new Error("Run Haiku physical-call limit reached"), { code: "run_budget_exhausted" });
    };
    const result = await a.run("Find the price. Answer as one JSON object");
    assert.equal(result.status, "partial");
    assert.equal(result.answer, json);
    assert.equal(finals.length, 1);
    assert.match(finals[0].reason, /^partial: Run Haiku physical-call limit/);
    assert.equal(finals[0].notes.price, "Public price 17.25");
    assert.equal(a.runBudget.held, null);
  } finally {
    globalThis.chrome = previous;
  }
});
test("a run with nothing kept back, or one you stopped, makes no final-answer call", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    for (const stop of [false, true]) {
      let calls = 0; // a failing assertion inside finalAnswer would be swallowed by the run's fallback: count instead
      const a = agent({
        plan: async () => response({ summary: "", answer_from: "", steps: [step] }),
        finalAnswerHold: () => ({ calls: 1, usd: 0.002, ms: 1000 }),
        finalAnswer: async () => {
          calls++;
          return response({ evidence: "", supported: false, answer: "unexpected" });
        },
      });
      if (!stop) a.planning = false; // planning off: nothing is kept back
      a.prepare = async () => {};
      a.browse = async () => {
        a.notes.price = "Public price 17.25";
        if (stop) a.stop();
        throw Object.assign(new Error("Run time limit reached"), { code: "run_budget_exhausted" });
      };
      const result = await a.run("Find the price");
      assert.equal(result.status, stop ? "stopped" : "partial");
      assert.equal(calls, 0);
      assert.equal(JSON.parse(result.answer).complete, false);
      assert.match(result.answer, /17.25/);
    }
  } finally {
    globalThis.chrome = previous;
  }
});
test("a final answer that fails without a Stop leaves the run's limit status and its collected facts", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    let calls = 0;
    const a = agent({
      plan: async () => response({ summary: "", answer_from: "", steps: [step] }),
      finalAnswerHold: () => ({ calls: 1, usd: 0.002, ms: 1000 }),
      finalAnswer: async () => {
        calls++;
        throw new Error("Final answer was truncated");
      },
    });
    a.prepare = async () => {};
    a.browse = async () => {
      a.notes.price = "Public price 17.25";
      throw Object.assign(new Error("Run time limit reached"), { code: "run_budget_exhausted" });
    };
    const result = await a.run("Find the price");
    assert.equal(result.status, "partial");
    assert.equal(result.message, "Run time limit reached");
    assert.equal(calls, 1);
    assert.match(result.answer, /17.25/);
  } finally {
    globalThis.chrome = previous;
  }
});
test("a final check's JSON answer stays parseable when the outcome isn't confirmed on screen", async () => {
  const json = '{"task_type":"MUTATE","status":"SUCCESS","retrieved_data":null,"error_details":null}';
  const a = agent({
    read: async () => response({ complete: false, evidence: "The review form is gone", text: json, next_steps: [] }),
  });
  a.plan = { steps: [step], answer_from: "final_task_answer" };
  await a.read({ ...step, kind: "read", finalCheck: true, save_as: "final_task_answer" });
  assert.equal(a.notes.final_task_answer, json);
  assert.match(a.notes.final_task_answer_unconfirmed, /The review form is gone/);
});
test("a final answer in prose when the task asks for JSON is written again in the format", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    const json = '{"task_type":"NAVIGATE","status":"SUCCESS","retrieved_data":null,"error_details":null}';
    let reason = "";
    const a = agent({
      plan: async () => response({ summary: "", answer_from: "", steps: [step] }),
      read: async () =>
        response({ complete: true, evidence: "Sorted list shown", text: "Sorted list verified.", next_steps: [] }),
      finalAnswerHold: () => ({ calls: 1, usd: 0.002, ms: 1000 }),
      finalAnswer: async (args) => {
        reason = args.reason;
        return response({ evidence: "Sorted list shown", supported: true, answer: json });
      },
    });
    a.prepare = async () => {};
    a.browse = async () => ({});
    const result = await a.run("Sort the list. Return exactly one JSON object.");
    assert.equal(result.status, "done");
    assert.equal(result.answer, json);
    assert.match(reason, /not in the format the task asks for.*Sorted list verified\./);
    let plainCalls = 0;
    const plain = agent({
      plan: async () => response({ summary: "", answer_from: "", steps: [step] }),
      read: async () =>
        response({ complete: true, evidence: "Sorted list shown", text: "Sorted list verified.", next_steps: [] }),
      finalAnswerHold: () => ({ calls: 1, usd: 0.002, ms: 1000 }),
      finalAnswer: async () => {
        plainCalls++;
        return response({ evidence: "", supported: false, answer: "unexpected" });
      },
    });
    plain.prepare = async () => {};
    plain.browse = async () => ({});
    assert.equal((await plain.run("Sort the list")).answer, "Sorted list verified."); // a prose answer to a prose task stands
    // a file's name is no format: "package.json" asks for none
    assert.equal((await plain.run("Sort the list in package.json")).answer, "Sorted list verified.");
    assert.equal(plainCalls, 0);
  } finally {
    globalThis.chrome = previous;
  }
});
test("a run handed over to the person makes no final-answer call: its answer says why it stopped", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    let calls = 0;
    const a = agent({
      plan: async () => response({ summary: "", answer_from: "", steps: [step] }),
      finalAnswerHold: () => ({ calls: 1, usd: 0.002, ms: 1000 }),
      finalAnswer: async () => {
        calls++;
        return response({ evidence: "", supported: false, answer: '{"status":"NOT_FOUND"}' });
      },
    });
    a.wantReport = true; // a coding agent's run: the person is at the coding agent, so the run hands over
    a.prepare = async () => {};
    a.browse = async () => {
      await a.waitForUser("user", "Which account should I use?");
      return {};
    };
    const result = await a.run("Find the price. Answer as one JSON object");
    assert.equal(result.status, "needs_user");
    assert.equal(calls, 0);
    assert.match(result.answer, /Which account should I use\?/);
  } finally {
    globalThis.chrome = previous;
  }
});
