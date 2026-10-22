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
  // the four mechanic switches on (src/accuracy.ts); every other accuracy switch stays off, as in a bundle without it
  define: { __DREX_ACC__: '"dragTo,datePicker,pickSuggestion,copyMove"' },
});
// llm's SDK import resolves from the real installation, independent of temp bundle location.
const { Agent, ReadCap } = await import(pathToFileURL(join(dir, "agent.js")));
// the accuracy switches are build-time: the confirmedChanges tests use an Agent built with them on, as build.mjs does
const accDir = await mkdtemp(join(tmpdir(), "drex-controller-acc-"));
await build({
  entryPoints: [join(source, "agent.ts")],
  outdir: accDir,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  define: { __DREX_ACC__: '"settingReadback,revealEvidence,confirmedChanges,answerGuard,answerRules"' },
});
const { Agent: AccAgent } = await import(pathToFileURL(join(accDir, "agent.js")));
await rm(accDir, { recursive: true, force: true });
const { Tab } = await import(pathToFileURL(join(source, "cdp.ts")));
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
  setTemporalFocused: async () => false, // not a date or time field: typed as before
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
function agent(llm, Kind = Agent) {
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
  const a = new Kind({ drex: {}, llm, emit() {} });
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

test("a drag that starts on a slider's handle sets a value without approval; a slide-to-act widget still asks", async () => {
  const slider = (over = {}) => ({
    names: ["Price range"],
    role: "slider",
    marks: [],
    submits: false,
    frame: false,
    payment: false,
    key: "slider|Price range",
    ...over,
  });
  const drag = { kind: "gesture", gesture: { kind: "drag", x: 10, y: 10, endX: 60, endY: 10 } };
  const run = async (under) => {
    const a = agent({});
    let asked = 0;
    a.askApproval = async () => (asked++, "once");
    a.perform = async () => {};
    a.capture = async () => null;
    await a.act(page({ pointTarget: async () => under() }), drag, "", scr, [], "llm", 1);
    return asked;
  };
  assert.equal(await run(() => slider()), 0);
  // the drag is the act, a CAPTCHA, or the slider sits where a click would ask: approval first
  assert.equal(await run(() => slider({ names: ["Slide to pay"] })), 1);
  assert.equal(await run(() => slider({ names: ["Slide to confirm"] })), 1);
  assert.equal(await run(() => slider({ names: ["Slide to verify you are human"] })), 1);
  assert.equal(await run(() => slider({ payment: true })), 1);
  assert.equal(await run(() => slider({ frame: true })), 1);
  // not a slider, or the start can't be read: approval first
  assert.equal(await run(() => slider({ role: "button", names: ["Upload"] })), 1);
  assert.equal(
    await run(() => {
      throw new Error("detached");
    }),
    1,
  );
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

// A reported Tahoe run (2026-10-20): at the move limit the helper said the filters were on and chose "step done";
// with a plan that answer was dropped, and the step failed with "did not finish in 12 moves"
const helperSays = (option, why = "The goal is on screen") =>
  response({
    decision: "move",
    user_need: "none",
    option,
    text: "",
    why,
    x: 0,
    y: 0,
    gesture: { kind: "hover", endX: 0, endY: 0, key: "", modifiers: [] },
    new_steps: [],
  });

test('with a plan, the helper\'s "step done" at the move limit ends the step instead of failing it', async () => {
  const a = agent({ rescue: async () => helperSays("step done", "Hot tub filter is applied") });
  a.look = async () => ({ ...scr, els: [next] });
  a.currentTab = async () => page();
  a.drexCall = drexSays(["click E1", 0.01]);
  a.act = async () => ({ dispatched: true, risky: false });
  assert.deepEqual(await a.browse({ ...step, max_moves: 5 }), {});
  assert.ok(a.record.some((e) => e.type === "tab" && /this step is done/.test(e.what)));
});

test("with a plan, the helper's \"step done\" after a move that can't be undone still needs the step check", async () => {
  let checks = 0;
  const a = agent({
    rescue: async () => helperSays("step done"),
    read: async () => {
      checks++;
      return response({ complete: true, evidence: "Order confirmation shown", text: "", next_steps: [] });
    },
  });
  a.look = async () => ({ ...scr, els: [order] });
  a.currentTab = async () => page();
  a.drexCall = drexSays(["click E2", 0.01]);
  a.act = async () => ({ dispatched: true, risky: true });
  assert.deepEqual(await a.browse({ ...step, max_moves: 5 }), {});
  assert.equal(checks, 1);
  assert.equal(a.notes.evidence1, "Order confirmation shown");
});

// Both reported Sheets runs: the plan opened https://sheets.new, which redirects to docs.google.com; that site
// wasn't trusted, so the notes (the table to type) were withheld there and the run could never fill the sheet
test("a first-plan URL that redirects by itself makes the site it lands on trusted; a move first does not", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = {
    tabs: { create: async () => ({ id: 7 }), group: async () => 1, get: async () => null, update: async () => ({}) },
    tabGroups: { update: async () => ({}) },
  };
  const docs = "https://docs.google.com";
  const named = () => {
    const a = agent(noLLM());
    a.windowId = 1;
    a.trusted = new Set(["https://sheets.new", "http://owned.test"]);
    a.namedUrls = new Set(["https://sheets.new"]);
    return a;
  };
  try {
    const a = named();
    await a.openOwnTab("https://sheets.new");
    a.trustLanding(7, "about:blank"); // still loading
    a.trustLanding(7, "https://sheets.new/"); // still on the named site
    assert.equal(a.trusted.has(docs), false);
    a.trustLanding(7, `${docs}/spreadsheets/d/1/edit`);
    assert.equal(a.trusted.has(docs), true);
    a.trustLanding(7, "https://accounts.google.com/signin"); // only the first site it lands on
    assert.equal(a.trusted.has("https://accounts.google.com"), false);

    const b = named(); // the agent moved before the page left the named site: where it goes is not the redirect
    await b.openOwnTab("https://sheets.new");
    b.approvals = false;
    b.perform = async () => {};
    b.capture = async () => "same";
    await b.act(page(), { kind: "key", key: "Enter" }, null, scr, [], "drex", 1);
    b.trustLanding(7, `${docs}/spreadsheets/d/1/edit`);
    assert.equal(b.trusted.has(docs), false);

    const c = named(); // a trusted site's URL that the first plan didn't name (a replan's) earns its redirect no trust
    await c.openOwnTab("http://owned.test/go?to=https://docs.google.com");
    c.trustLanding(7, `${docs}/spreadsheets/d/1/edit`);
    assert.equal(c.trusted.has(docs), false);

    const d = named(); // another tab's address is not this one's landing
    await d.openOwnTab("https://sheets.new");
    d.trustLanding(8, `${docs}/spreadsheets/d/1/edit`);
    assert.equal(d.trusted.has(docs), false);

    // the step waits for the redirect before its first look: settling ended on about:blank, and the first move (the
    // helper's click there) then made the landing a move's
    const hops = ["about:blank", "https://sheets.new/", `${docs}/spreadsheets/u/0/create`];
    globalThis.chrome.tabs.get = async (id) => ({ id, url: hops.shift() ?? `${docs}/x`, status: "loading" });
    const e = named();
    await e.openOwnTab("https://sheets.new");
    await e.awaitLanding();
    assert.equal(e.trusted.has(docs), true);
    assert.equal(hops.length, 0);

    globalThis.chrome.tabs.get = async (id) => ({ id, url: "https://sheets.new/", status: "complete" }); // no redirect
    const f = named();
    await f.openOwnTab("https://sheets.new");
    await f.awaitLanding();
    assert.equal(f.trusted.has(docs), false);
    f.trustLanding(7, `${docs}/spreadsheets/d/1/edit`); // the page's own later redirect, before any move, still counts
    assert.equal(f.trusted.has(docs), true);

    // the agent's own tab reused (the headphones rerun: Sony's store, then sheets.new): until the navigation commits the
    // tab still shows its old page, which is not where the planned URL landed
    const sony = "https://electronics.sony.com/audio/headphones/wh1000xm5";
    const states = [
      { url: sony, status: "complete" }, // openOwnTab's check for a redundant navigation
      { url: sony, status: "loading" },
      { url: sony, pendingUrl: "https://sheets.new/", status: "loading" },
      { url: `${docs}/spreadsheets/u/0/create`, status: "loading" },
    ];
    globalThis.chrome.tabs.get = async (id) => ({
      id,
      ...(states.shift() ?? { url: `${docs}/x`, status: "complete" }),
    });
    const g = named();
    g.trusted.add("https://electronics.sony.com");
    g.agentTabId = 7;
    g.ownTab = true;
    await g.openOwnTab("https://sheets.new");
    await g.awaitLanding();
    assert.equal(g.trusted.has(docs), true);
  } finally {
    globalThis.chrome = previous;
  }
});

// The rerun of the Tahoe task: the 9 listings were collected, but the check after the collection kept asking for what
// the list doesn't show (each listing's hot tub, whether Carson City is Lake Tahoe), and its third objection ended the
// run before the sheet was made: "Could not find what step 2 needs after 3 checks"
test("a collection whose check keeps objecting goes on with the records it gathered, the objection kept", async () => {
  const objecting = () =>
    agent({
      read: async () =>
        response({ complete: false, evidence: "Hot tub is only implied by the filter", text: "", next_steps: [step] }),
    });
  const collection = { ...step, kind: "collect", save_as: "listings" };
  const verify = { ...collection, kind: "verify", save_as: "listings_verification" };
  const a = objecting();
  a.notes = { listings: "9 homes: 3 Peaks Resort $215, ..." };
  assert.deepEqual((await a.read(verify, { requeue: collection })).replan.at(-1).kind, "collect");
  await a.read(verify, { requeue: collection });
  assert.deepEqual(await a.read(verify, { requeue: collection }), {});
  assert.match(a.notes.listings_unverified, /Hot tub is only implied/);
  assert.equal(a.incompleteChecks, 0);

  const b = objecting(); // nothing gathered: the third miss still ends the run
  for (let i = 0; i < 2; i++) await b.read(verify, { requeue: collection });
  assert.equal((await b.read(verify, { requeue: collection })).terminal, true);

  const c = objecting(); // a read's own answer missing three times still ends it
  c.notes = { listings: "9 homes" };
  const answer = { ...step, kind: "read", save_as: "answer" };
  for (let i = 0; i < 2; i++) await c.read(answer);
  assert.equal((await c.read(answer)).terminal, true);
});

// Fixed-build Tahoe run 5: the plan typed the collect step's note ({{listings_table}}) straight into the sheet, and
// Drex typed 4,035 characters of its evidence JSON at A1 (no step had written the table)
test("a step that would type a collection's evidence JSON gets a step writing it first", async () => {
  const a = agent(noLLM());
  const evidence = JSON.stringify({ instruction: "Source URLs identify evidence locations", sources: [] });
  a.notes = { listings: `${evidence}\nCOLLECTION COVERAGE COMPLETE: true`, query: "hot tub" };
  const sheet = {
    ...step,
    kind: "browse",
    goal: "Type the whole table text into cell A1",
    texts: [{ name: "table", text: "{{listings}}" }],
  };
  a.plan = { steps: [{ ...step, kind: "collect", save_as: "listings" }, sheet] };
  a.index = 1;
  assert.equal(a.writeEvidenceFirst(a.plan.steps[1]), true);
  const [written, typing] = a.plan.steps.slice(1);
  assert.equal(written.kind, "read");
  assert.equal(written.save_as, "listings_text");
  assert.match(written.goal, /Type the whole table text into cell A1/);
  assert.match(written.goal, /tab-separated/);
  assert.deepEqual(typing.texts, [{ name: "table", text: "{{listings_text}}" }]);
  assert.equal(a.writeEvidenceFirst(typing), false); // once written, the step types the text

  const plain = { ...sheet, texts: [{ name: "q", text: "{{query}}" }] }; // a plain note is typed as it is
  a.plan.steps.push(plain);
  assert.equal(a.writeEvidenceFirst(plain), false);
  const matches = JSON.stringify({ matches: [{ name: "Oak Cabin" }] }); // noteResolve's list notes stay its own
  a.notes.found = matches;
  assert.equal(a.writeEvidenceFirst({ ...sheet, texts: [{ name: "t", text: "{{found}}" }] }), false);
});

// Fixed-build Tahoe run 6a: an unlabeled click put the cursor in Sheets' menu search; the table typed there, a row and
// an Enter at a time, ran "Import file", and the step was taken as done
test("a table not typed at a one-line box is a move not made, and Drex's history says why", async () => {
  const a = agent({});
  a.approvals = false;
  a.capture = async () => "same";
  const history = [];
  const tab = page({ type: async () => false });
  const out = await a.act(tab, { kind: "type_cursor" }, "Name\tPrice\nCabin\t$108", scr, history, "drex", 1);
  assert.match(out.blocked, /one-line box/);
  assert.equal(history.at(-1).changed, false);
  assert.match(history.at(-1).note, /Escape/);
});

// Final Tahoe rerun 1: the collection's check, failing, put "Create a new Google Sheet and enter the listings" (opening
// sheets.new, no text) among its repairs, ahead of the plan's own table-writing read and sheet step; the sheet step
// then had nothing to type and the run gave up
test("a check's repair never brings a later step forward: no step opening what a later step opens", async () => {
  const collection = { ...step, kind: "collect", save_as: "listings" };
  const sheet = { ...step, open_url: "https://sheets.new", texts: [{ name: "table", text: "{{sheet_text}}" }] };
  const fix = { ...collection, goal: "Collect the 9 listings with their URLs" };
  const early = { ...step, open_url: "https://sheets.new", goal: "Create a new Google Sheet and enter the listings" };
  const a = agent({
    read: async () => response({ complete: false, evidence: "URLs missing", text: "", next_steps: [fix, early] }),
  });
  a.plan = { steps: [collection, { ...step, kind: "read", save_as: "sheet_text" }, sheet] };
  const out = await a.read(
    { ...collection, kind: "verify", save_as: "listings_verification" },
    { requeue: collection },
  );
  assert.deepEqual(
    out.replan.map((s) => s.goal),
    [fix.goal],
  );
});

// CI p-notes, on main as on PR #29: the plan names the user's notes tab use_tab 0; its first step opened Wikipedia in
// the agent's own tab, which took over logical tab 0, so the later steps on tab 0 checked Wikipedia, and the replan
// that followed reopened the notes page empty and saved it over the note
test("a tab the agent opens on another site gets a logical index of its own; a same-site copy takes the plan's tab", async () => {
  const previous = globalThis.chrome;
  const pages = new Map([
    [1, "http://notes.test/notes.html"],
    [2, "http://owned.test/"],
  ]);
  let next = 5;
  globalThis.chrome = {
    tabs: {
      get: async (id) => {
        if (!pages.has(id)) throw new Error("No tab");
        return { id, url: pages.get(id), status: "complete" };
      },
      create: async ({ url }) => {
        const id = next++;
        pages.set(id, url);
        return { id };
      },
      update: async (id, { url }) => {
        pages.set(id, url);
        return { id };
      },
      group: async () => 1,
    },
    tabGroups: { update: async () => ({}) },
  };
  const user = () => {
    const a = agent(noLLM());
    a.windowId = 1;
    a.startTabs = [
      { id: 1, url: pages.get(1) },
      { id: 2, url: pages.get(2) },
    ];
    a.tabBindings = new Map([
      [0, 1],
      [1, 2],
    ]);
    a.activePlanTab = 0;
    a.agentTabId = 1;
    a.ownTab = false;
    return a;
  };
  try {
    const a = user();
    await a.openOwnTab("https://en.wikipedia.org");
    assert.deepEqual(
      [...a.tabBindings],
      [
        [0, 1],
        [1, 2],
        [2, 5],
      ],
    );
    assert.equal(a.activePlanTab, 2);
    a.currentTab = async () => page();
    await a.prepare({ use_tab: 0, open_url: "" }); // the plan's notes tab is the user's notes tab again
    assert.equal(a.agentTabId, 1);

    const b = user(); // a working copy (the same site) still takes the plan's tab, as before
    b.activePlanTab = 1;
    b.agentTabId = 2;
    await b.openOwnTab("http://owned.test/search?q=item");
    assert.equal(b.tabBindings.get(1), 6);
    assert.equal(b.activePlanTab, 1);
    await b.openOwnTab("https://elsewhere.test/"); // that copy goes on to another site: tab 1 is the user's tab again
    assert.equal(b.tabBindings.get(1), 2);
    assert.equal(b.tabBindings.get(2), 6);
    assert.equal(b.activePlanTab, 2);
  } finally {
    globalThis.chrome = previous;
  }
});

test("an unattended run that needs the person ends with an answer in the task's format", async () => {
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
    a.unattended = true; // a benchmark runner: nobody is at the panel, so the run hands over and still answers
    a.prepare = async () => {};
    a.browse = async () => {
      await a.waitForUser("user", "Solve the CAPTCHA");
      return {};
    };
    const result = await a.run("Find the price. Answer as one JSON object");
    assert.equal(result.status, "needs_user");
    assert.equal(calls, 1);
    assert.equal(result.answer, '{"status":"NOT_FOUND"}');
  } finally {
    globalThis.chrome = previous;
  }
});
test("an unattended approval still waits for the runner's answer", async () => {
  const a = agent(noLLM());
  a.unattended = true;
  const asked = a.waitForUser("approve", "Place the order?");
  assert.ok(a.pendingAsk);
  a.answer("once");
  assert.equal(await asked, "once");
});
test("attended runs still wait for the person", async () => {
  const a = agent(noLLM());
  a.unattended = false;
  a.wantReport = null;
  const asked = a.waitForUser("user", "Solve the CAPTCHA");
  assert.ok(a.pendingAsk);
  a.answer(true);
  assert.equal(await asked, true);
});
test("unattended: a choice the user would make becomes a failed step, not a hand-over", async () => {
  let user_need = "choice";
  const a = agent({
    rescue: async () =>
      response({ decision: "ask_user", user_need, why: "Pick one of your saved addresses", new_steps: [] }),
  });
  a.unattended = true;
  let result = await a.rescue("help", "", scr, {}, {}, []);
  assert.equal(result.ask, undefined);
  assert.equal(result.fail, "Pick one of your saved addresses");
  for (user_need of ["captcha", "login", "payment"]) {
    result = await a.rescue("help", "", scr, {}, {}, []);
    assert.equal(result.ask, "Pick one of your saved addresses");
  }
});

// --- confirmedChanges: the site's own answers to a move are the run's record of what it changed ---------------------
// a tab with the real mutation record (cdp.Tab); a move's perform() feeds it the Network events of the site's answer
// and puts up the notices the page then shows
function siteTab() {
  const tab = new Tab(1);
  let shown = [];
  Object.assign(tab, {
    info: async () => info,
    eval: async () => null,
    settle: async () => {},
    notices: async () => ({ url: info.url, notes: shown, dialogs: [] }),
    elements: async () => ({ els: [], off: [] }),
    setTemporalFocused: async () => false,
  });
  let id = 0;
  // requests: [method, path, status, type]; a 3xx is a form post Chrome reports as redirected to a GET of the same
  // path; type is Chrome's resource type, XHR unless given (a form post that navigates is a Document)
  tab.answers = (requests, notices = []) => {
    for (const [method, path, status, type = "XHR"] of requests) {
      const requestId = String(++id);
      const url = `http://owned.test${path}`;
      const feed = (event, params) => tab.onEvent({ tabId: tab.id }, event, { requestId, ...params });
      feed("Network.requestWillBeSent", { documentURL: info.url, type, request: { method, url } });
      if (status >= 300 && status < 400)
        feed("Network.requestWillBeSent", {
          documentURL: url,
          type: "Document",
          request: { method: "GET", url },
          redirectResponse: { status, url },
        });
      feed("Network.responseReceived", { type: "XHR", response: { status: status < 400 ? 200 : status, url } });
    }
    shown = notices;
  };
  return tab;
}
const button = (name, extra = {}) => ({
  label: "E5",
  role: "button",
  name,
  text: `button '${name}'`,
  node: 5,
  box: [0, 20, 40, 30],
  ...extra,
});
const RULE =
  "a change in confirmed_changes is reported with the success status; a change in rejected_changes with the failure status";
const MUTATE_TASK =
  'Save the rule. Return exactly one JSON object with exactly these four fields: {"task_type":"RETRIEVE"|"MUTATE"|"NAVIGATE","status":"SUCCESS"|"NOT_FOUND_ERROR"|"DATA_VALIDATION_ERROR"|"UNKNOWN_ERROR","retrieved_data":array|null,"error_details":string|null}.';
const statusAnswer = (status) =>
  JSON.stringify({
    task_type: "MUTATE",
    status,
    retrieved_data: null,
    error_details: status === "SUCCESS" ? null : "?",
  });

// test_click_on_button_records_confirmed_change
test("confirmedChanges: a click on a button the site answers with a change and a success notice is a confirmed change", async () => {
  const save = { kind: "browse", goal: "Save the rule", done_when: "", texts: [], rules: "", max_moves: 5 };
  const a = agent({}, AccAgent);
  a.plan = { steps: [save] };
  a.capture = async () => null;
  const tab = siteTab();
  a.perform = async () => tab.answers([["POST", "/admin/rule/save/", 302]], ["You saved the rule."]);
  await a.act(tab, { kind: "click", el: button("Save Rule") }, null, scr, [], "drex", 1);
  const seen = a.observations.at(-1);
  assert.deepEqual(seen.confirmed, ["POST /admin/rule/save/ 302", "notice 'You saved the rule.'"]);
  assert.equal(seen.rejected, undefined);
  const change = { move: "clicked button 'Save Rule'", requests: ["POST /admin/rule/save/ 302"] };
  const logged = a.record.filter((e) => e.type === "change_confirmed");
  assert.deepEqual(
    logged.map(({ move, requests, notices }) => ({ move, requests, notices })),
    [{ ...change, notices: ["You saved the rule."] }],
  );
  assert.deepEqual(JSON.parse(a.notes.confirmed_changes), [
    { step: "Save the rule", ...change, notices: ["You saved the rule."] },
  ]);
  // an upvote link the site refuses (Reddit 720's HTTP 400) is a rejected change; Enter on a focused button counts too
  a.perform = async () => tab.answers([["POST", "/sv/44650.json", 400]]);
  await a.act(
    tab,
    { kind: "click", el: { ...button("Upvote"), role: "link", text: "link 'Upvote'" } },
    null,
    scr,
    [],
    "drex",
    1,
  );
  assert.deepEqual(a.observations.at(-1).rejected, ["POST /sv/44650.json 400"]);
  assert.equal(a.observations.at(-1).confirmed, undefined);
  assert.equal(a.record.filter((e) => e.type === "change_rejected").length, 1);
  assert.equal(JSON.parse(a.notes.rejected_changes)[0].requests[0], "POST /sv/44650.json 400");
  a.perform = async () => tab.answers([["PUT", "/rest/V1/carts/mine", 200]]);
  const focused = button("Apply Discount", { state: " (focused)" });
  await a.act(tab, { kind: "key", key: "Enter" }, null, { ...scr, els: [focused] }, [], "drex", 1);
  assert.deepEqual(a.observations.at(-1).confirmed, ["PUT /rest/V1/carts/mine 200"]);
  // a notice alone: an error notice rejects, even one that also reads like a success
  a.perform = async () => tab.answers([], ["The product could not be added to your cart."]);
  await a.act(tab, { kind: "click", el: button("Add to Cart") }, null, scr, [], "drex", 1);
  assert.deepEqual(a.observations.at(-1).rejected, ["notice 'The product could not be added to your cart.'"]);
  assert.equal(a.observations.at(-1).confirmed, undefined);
  // a success word under a negation is an error notice too (ruling 16): "unsuccessful", "not added"
  for (const notice of ["Payment unsuccessful", "Item not added"]) {
    a.perform = async () => tab.answers([], [notice]);
    await a.act(tab, { kind: "click", el: button("Continue") }, null, scr, [], "drex", 1);
    assert.deepEqual(a.observations.at(-1).rejected, [`notice '${notice}'`], notice);
    assert.equal(a.observations.at(-1).confirmed, undefined, notice);
  }
  assert.doesNotMatch(a.notes.confirmed_changes, /unsuccessful|not added/);
  // with the switch off nothing is recorded
  const off = agent({});
  off.plan = { steps: [save] };
  off.capture = async () => null;
  off.perform = async () => tab.answers([["POST", "/admin/rule/save/", 302]], ["You saved the rule."]);
  await off.act(tab, { kind: "click", el: button("Save Rule") }, null, scr, [], "drex", 1);
  assert.equal(off.observations.at(-1).confirmed, undefined);
  assert.equal(off.notes.confirmed_changes, undefined);
  assert.equal(off.record.filter((e) => e.type === "change_confirmed").length, 0);
});

// test_typing_never_confirms
test("confirmedChanges: typing, Enter in a field and scrolling never confirm a change, whatever the site answers", async () => {
  const a = agent({}, AccAgent);
  // a step that changes something: what keeps these moves out is the move, not the step
  a.plan = { steps: [{ kind: "browse", goal: "Update the customer's email", texts: [], rules: "", max_moves: 5 }] };
  a.capture = async () => null;
  const tab = siteTab();
  a.perform = async () => tab.answers([["POST", "/customer/account/save", 200]], ["Draft saved"]);
  const email = { label: "E3", role: "textbox", name: "Email", text: "textbox 'Email'", node: 3, box: [0, 0, 40, 10] };
  const field = { ...email, field: true };
  await a.act(tab, { kind: "type", el: field }, "me@owned.test", scr, [], "drex", 1);
  await a.act(tab, { kind: "click", el: field }, "me@owned.test", scr, [], "llm", 1);
  const inField = { ...scr, els: [{ ...field, state: " (focused)" }] };
  await a.act(tab, { kind: "key", key: "Enter" }, null, inField, [], "drex", 1);
  await a.act(tab, { kind: "scroll", down: true }, null, scr, [], "drex", 1);
  assert.equal(a.observations.length, 4);
  assert.ok(a.observations.every((o) => o.confirmed === undefined && o.rejected === undefined));
  assert.equal(a.record.filter((e) => /^change_/.test(e.type)).length, 0);
  assert.equal(a.notes.confirmed_changes, undefined);
});

// a run whose browse steps each click and get the given answers. Its final read writes `written`: with no answer text
// the run's final answer is written by terminalAnswer (finalAnswer here, which answers from `answers` in turn)
async function mutatingRun(steps, answers, written = "") {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    const asked = [];
    const a = agent(
      {
        plan: async () => response({ summary: "", answer_from: "", steps: steps.map(([s]) => s) }),
        read: async () =>
          response({ complete: true, evidence: "The rule list is shown", text: written, next_steps: [] }),
        finalAnswerHold: () => ({ calls: 1, usd: 0.002, ms: 1000 }),
        finalAnswer: async (args) => {
          asked.push(args);
          const answer = answers[asked.length - 1];
          if (answer instanceof Error) throw answer;
          return response({ evidence: "", supported: false, answer });
        },
      },
      AccAgent,
    );
    a.prepare = async () => {};
    a.capture = async () => null;
    const tab = siteTab();
    a.browse = async (step) => {
      const [, name, requests, notices] = steps.find(([s]) => s.goal === step.goal);
      a.perform = async () => tab.answers(requests, notices);
      await a.act(tab, { kind: "click", el: button(name) }, null, scr, [], "drex", 1);
      return {};
    };
    return { result: await a.run(MUTATE_TASK), asked };
  } finally {
    globalThis.chrome = previous;
  }
}
const browseStep = (goal) => ({ kind: "browse", goal, done_when: "", texts: [], rules: "", max_moves: 5 });

// test_answerguard_refuses_error_when_last_mutation_confirmed
test("confirmedChanges: an error status after the last mutating step's confirmed change is asked once more", async () => {
  const save = [
    browseStep("Save the rule"),
    "Save Rule",
    [["POST", "/admin/sales_rule/save/", 302]],
    ["You saved the rule."],
  ];
  // the second answer stands whatever it says: the retry is asked once, never forced to SUCCESS
  const answers = [statusAnswer("DATA_VALIDATION_ERROR"), statusAnswer("UNKNOWN_ERROR")];
  const { result, asked } = await mutatingRun([save], answers);
  assert.equal(asked.length, 2);
  assert.match(asked[0].notes.confirmed_changes, /Save the rule.*POST \/admin\/sales_rule\/save\/ 302/);
  assert.match(asked[1].reason, /POST \/admin\/sales_rule\/save\/ 302/);
  assert.match(asked[1].reason, /You saved the rule\./);
  assert.match(asked[1].reason, /DATA_VALIDATION_ERROR/);
  assert.ok(asked[1].reason.includes(RULE));
  assert.equal(result.answer, answers[1]);
  const finals = result.record.filter((e) => e.type === "final_answer");
  assert.deepEqual(
    finals.map((e) => e.retry),
    [undefined, "confirmed_change"],
  );
  // a success answer is never asked again
  const ok = await mutatingRun([save], [statusAnswer("SUCCESS")]);
  assert.equal(ok.asked.length, 1);
});

// test_answerguard_accepts_error_when_rejected_after
test("confirmedChanges: an add-to-cart 200 followed by a checkout 400 is not forced: the error answer stands", async () => {
  const add = [browseStep("Add the bars to the cart"), "Add to Cart", [["POST", "/checkout/cart/add", 200]], []];
  const pay = [browseStep("Check out"), "Next", [["POST", "/rest/V1/carts/mine/shipping-information", 400]], []];
  const answers = [statusAnswer("DATA_VALIDATION_ERROR"), statusAnswer("SUCCESS")];
  const { result, asked } = await mutatingRun([add, pay], answers);
  assert.equal(asked.length, 1);
  assert.equal(result.answer, answers[0]);
  assert.match(result.notes.rejected_changes, /Check out.*shipping-information 400/);
  assert.equal(result.record.filter((e) => e.type === "final_answer" && e.retry).length, 0);
});

// test_answerguard_accepts_error_when_last_mutation_not_reached (ruling 14)
test("confirmedChanges: an add-to-cart 200 before an order the run never placed is not forced: the error answer stands", async () => {
  const add = [browseStep("Add the bars to the cart"), "Add to Cart", [["POST", "/checkout/cart/add", 200]], []];
  const order = [browseStep("Place the order"), "Place Order", [], []]; // no request, no notice
  const answers = [statusAnswer("UNKNOWN_ERROR"), statusAnswer("SUCCESS")];
  const { result, asked } = await mutatingRun([add, order], answers);
  assert.equal(asked.length, 1);
  assert.equal(result.answer, answers[0]);
  assert.match(result.notes.confirmed_changes, /Add the bars to the cart/);
  assert.equal(result.record.filter((e) => e.type === "final_answer" && e.retry).length, 0);
  // a later step that only opens a page leaves the add-to-cart the last change: asked once more
  const history = [browseStep("Open the order history page"), "Orders", [], []];
  const again = await mutatingRun([add, history], answers);
  assert.equal(again.asked.length, 2);
  assert.equal(again.result.answer, answers[1]);
});

// test_answerguard_setting_step_xhr_post_not_a_change (ruling 15)
test("confirmedChanges: a filter step's XHR POST is no change to force; a navigating form post or a save step's is", async () => {
  const answers = [statusAnswer("NOT_FOUND_ERROR"), statusAnswer("SUCCESS")];
  // a single-page app's search: the filter step's POST is confirmed in the record, but nothing the task changed
  const filter = [browseStep("Apply the Legal filter"), "Apply", [["POST", "/api/search", 200]], []];
  const searched = await mutatingRun([filter], answers);
  assert.equal(searched.asked.length, 1);
  assert.equal(searched.result.answer, answers[0]);
  assert.match(searched.result.notes.confirmed_changes, /POST \/api\/search 200/); // the record itself is unchanged
  // a setting step whose form post navigates (a Document request) did change something
  const subscribe = [
    browseStep("Enter the email and subscribe"),
    "Sign Up",
    [["POST", "/newsletter/subscriber/new", 302, "Document"]],
    [],
  ];
  const subscribed = await mutatingRun([subscribe], answers);
  assert.equal(subscribed.asked.length, 2);
  assert.match(subscribed.asked[1].reason, /POST \/newsletter\/subscriber\/new 302/);
  assert.equal(subscribed.result.answer, answers[1]);
  // a step that sets nothing: its XHR POST confirms as before
  const save = [browseStep("Save the rule"), "Save Rule", [["POST", "/admin/rule/save", 200]], []];
  const saved = await mutatingRun([save], answers);
  assert.equal(saved.asked.length, 2);
  assert.equal(saved.result.answer, answers[1]);
});

// test_confirmed_change_retry_failure_logged
test("confirmedChanges: a retry whose request fails keeps the first answer and logs why", async () => {
  const save = [browseStep("Save the rule"), "Save Rule", [["POST", "/admin/rule/save", 200]], []];
  const answers = [statusAnswer("UNKNOWN_ERROR"), new Error("provider overloaded")];
  const { result, asked } = await mutatingRun([save], answers);
  assert.equal(asked.length, 2);
  assert.equal(result.answer, answers[0]);
  const failed = result.record.filter((e) => e.type === "final_answer" && e.retry === "confirmed_change");
  assert.deepEqual(
    failed.map(({ retry, error }) => ({ retry, error })),
    [{ retry: "confirmed_change", error: "provider overloaded" }],
  );
});

// test_final_read_error_status_retried_when_last_mutation_confirmed
test("confirmedChanges: the final read's own error answer after a confirmed last change is asked once more", async () => {
  const save = [
    browseStep("Save the rule"),
    "Save Rule",
    [["POST", "/admin/sales_rule/save/", 302]],
    ["You saved the rule."],
  ];
  const written = statusAnswer("DATA_VALIDATION_ERROR"); // well-formed: no terminalAnswer for it
  const { result, asked } = await mutatingRun([save], [statusAnswer("SUCCESS")], written);
  assert.equal(asked.length, 1);
  assert.match(asked[0].reason, /DATA_VALIDATION_ERROR/);
  assert.match(asked[0].reason, /POST \/admin\/sales_rule\/save\/ 302/);
  assert.match(asked[0].reason, /You saved the rule\./);
  assert.ok(asked[0].reason.includes(RULE));
  assert.equal(result.answer, statusAnswer("SUCCESS"));
  assert.equal(result.notes.final_task_answer, written); // the read's own note stays as it was written
  assert.deepEqual(
    result.record.filter((e) => e.type === "final_answer").map((e) => e.retry),
    ["confirmed_change"],
  );
});

// test_final_read_error_status_kept_when_no_confirmation
test("confirmedChanges: the final read's error answer stands when no change was confirmed", async () => {
  const save = [browseStep("Save the rule"), "Save Rule", [["GET", "/admin/sales_rule/", 200]], []];
  const written = statusAnswer("DATA_VALIDATION_ERROR");
  const { result, asked } = await mutatingRun([save], [statusAnswer("SUCCESS")], written);
  assert.equal(asked.length, 0);
  assert.equal(result.answer, written);
  assert.equal(result.record.filter((e) => e.type === "final_answer").length, 0);
});

// test_confirmation_skipped_on_non_mutating_step
test("confirmedChanges: the same click under a step that changes nothing (opening a page) records no change", async () => {
  const a = agent({}, AccAgent);
  a.plan = {
    steps: [{ kind: "browse", goal: "Open the issue page", done_when: "", texts: [], rules: "", max_moves: 5 }],
  };
  a.capture = async () => null;
  const tab = siteTab();
  a.perform = async () => tab.answers([["POST", "/admin/rule/save/", 302]], ["You saved the rule."]);
  await a.act(tab, { kind: "click", el: button("Save Rule") }, null, scr, [], "drex", 1);
  assert.equal(a.observations.at(-1).confirmed, undefined);
  assert.equal(a.observations.at(-1).rejected, undefined);
  assert.equal(a.record.filter((e) => /^change_/.test(e.type)).length, 0);
  assert.equal(a.notes.confirmed_changes, undefined);
});

// test_retry_survives_missing_plan
test("confirmedChanges: a run whose planning failed keeps its in-format error answer (no plan to check it against)", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    const answer = statusAnswer("UNKNOWN_ERROR");
    let asked = 0;
    const a = agent(
      {
        plan: async () => {
          throw Object.assign(new Error("Run time limit reached"), { code: "run_budget_exhausted" });
        },
        finalAnswerHold: () => ({ calls: 1, usd: 0.002, ms: 1000 }),
        finalAnswer: async () => {
          asked++;
          return response({ evidence: "", supported: false, answer });
        },
      },
      AccAgent,
    );
    a.plan = undefined; // as in a fresh agent: run() sets it only once planning succeeds
    const result = await a.run(MUTATE_TASK);
    assert.equal(result.status, "partial");
    assert.equal(asked, 1);
    assert.equal(result.answer, answer);
  } finally {
    globalThis.chrome = previous;
  }
});

// --- settingReadback: a setting step is done only when the page shows the value applied ------------------------------
const legalStep = {
  kind: "browse",
  goal: 'Filter the jobs by the category "Legal"',
  done_when: "The Legal category is applied",
  texts: [],
  rules: "",
  max_moves: 8,
};
// an agent on a setting step whose Drex says "step done" on every move. The tab's read-back answers from `readBack`
// (called with the literals and how many read-backs came before); Drex's read-back question is answered `applied`
// chosen: the values a move of the step set (typed, selected, ticked); only those are read back. By default every value
// these tests' steps name, as if the step's moves had set them
const CHOSEN = ["Legal", "Remote", "Full-time", "Newest", "Medium (1-2 bedroom)", "See 12 Homes", "Reviews"];
function readbackAgent({ readBack, applied = 0, llm = {}, Kind = AccAgent, steps = [legalStep], chosen = CHOSEN }) {
  const a = agent(llm, Kind);
  a.plan = { steps };
  a.task = "Find legal jobs";
  // a run resets the step's chosen values at each step: these steps' moves (Drex's "step done" only) set them again
  let held = [...chosen];
  Object.defineProperty(a, "stepChosen", {
    get: () => held,
    set: (v) => {
      held = [...chosen, ...v];
    },
    configurable: true,
  });
  const seen = { readBack: [], states: [], asked: [] };
  a.currentTab = async () =>
    page({
      mutationsSince: () => ({ confirmed: [], rejected: [] }),
      readBack: async (literals) => {
        seen.readBack.push(literals);
        return readBack(literals, seen.readBack.length - 1);
      },
    });
  a.drexCall = async (state, qs, images) => {
    if (!qs.move) {
      const [name, q] = Object.entries(qs)[0];
      seen.asked.push({ q: q.instructions, images });
      return { answers: { [name]: { noul: applied } }, ms: 1, usd: 0 };
    }
    seen.states.push(state);
    return { answers: { move: { choice: "step done", probabilities: { "step done": 0.99 } }, done: { noul: 0.99 } } };
  };
  return { a, seen };
}
const showsNone = (literals) => ({ found: {}, missing: literals });
const showsAll = (literals) => ({ found: Object.fromEntries(literals.map((l) => [l, "chip"])), missing: [] });
const readbacks = (a) =>
  a.record.filter((e) => e.type === "setting_readback").map(({ found, missing, miss }) => ({ found, missing, miss }));

// test_readback_miss_one_adds_note_and_continues
test("settingReadback: a step done before the page shows its value is not done; the next move reads why", async () => {
  const { a, seen } = readbackAgent({ readBack: (l, i) => (i === 0 ? showsNone(l) : showsAll(l)) });
  assert.deepEqual(await a.browse(legalStep), {});
  assert.deepEqual(seen.readBack, [["Legal"], ["Legal"]]);
  assert.equal(seen.states.length, 2); // the first "step done" was not taken: Drex made another move
  assert.doesNotMatch(seen.states[0], /applied yet/);
  assert.match(seen.states[1], /the page doesn't show Legal applied yet/);
  assert.deepEqual(readbacks(a), [
    { found: {}, missing: ["Legal"], miss: 1 },
    { found: { Legal: "chip" }, missing: [], miss: 0 },
  ]);
  assert.deepEqual(a.record.find((e) => e.type === "setting_readback").literals, ["Legal"]);
  assert.equal(a.record.find((e) => e.type === "setting_readback").step, 0);
  assert.equal(a.totals.llmCalls, 0); // a first miss costs no LLM call
  assert.equal(a.incompleteChecks, 0);
});

// test_readback_only_values_a_move_set
test("settingReadback: a value the step names but no move of it set is not read back (an open-the-form step)", async () => {
  // #39's targeted check: most of the 76 misses in 97 read-backs were values a fill or open-the-form step names before
  // it applies them
  const none = readbackAgent({ readBack: showsNone, chosen: [] });
  assert.deepEqual(await none.a.browse(legalStep), {});
  assert.deepEqual(none.seen.readBack, []); // nothing set: nothing read back, the step ends at its first "step done"
  assert.equal(none.seen.states.length, 1);
  assert.deepEqual(none.a.record.find((e) => e.type === "setting_readback_skipped").skipped, ["Legal"]);
  // a ticked checkbox "Legal (12)" sets "Legal"; the other named value no move set is left out
  const two = { ...legalStep, goal: 'Filter the jobs by "Legal" and "Remote"' };
  const some = readbackAgent({ readBack: showsAll, chosen: ["Legal (12)"], steps: [two] });
  assert.deepEqual(await some.a.browse(two), {});
  assert.deepEqual(some.seen.readBack, [["Legal"]]);
});

// test_readback_miss_two_calls_verifystep
test("settingReadback: the second miss asks the LLM about the missing values; its objection reaches Drex", async () => {
  const checks = [];
  const llm = {
    read: async (args) => {
      checks.push(args);
      return response({
        complete: false,
        evidence: "The category box holds Business and Financial Operations",
        text: "",
        next_steps: [{ ...legalStep, goal: "Pick Legal in the category list" }],
      });
    },
  };
  const { a, seen } = readbackAgent({ llm, readBack: (l, i) => (i < 2 ? showsNone(l) : showsAll(l)) });
  assert.deepEqual(await a.browse(legalStep), {}); // the LLM's next steps replan nothing: the step goes on
  assert.equal(checks.length, 1);
  assert.equal(checks[0].purpose, "verify");
  assert.match(checks[0].step.goal, /Legal/);
  assert.equal(seen.states.length, 3);
  assert.doesNotMatch(seen.states[1], /Business and Financial Operations/);
  assert.match(seen.states[2], /the page doesn't show Legal applied yet/);
  assert.match(seen.states[2], /Business and Financial Operations/);
  assert.deepEqual(
    readbacks(a).map((r) => r.miss),
    [1, 2, 0],
  );
  assert.equal(a.incompleteChecks, 0); // the read-back's misses are its own: the run's incomplete-check cap never moves
});

// test_readback_fails_open_after_three_misses
test("settingReadback: after three misses the step ends anyway, its values noted as unverified; the run goes on", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    let checks = 0;
    const llm = {
      read: async () => {
        checks++;
        return response({ complete: false, evidence: "No Legal filter shows", text: "", next_steps: [] });
      },
    };
    const reviews = { ...legalStep, goal: "Open the first job", done_when: "The job page is open" };
    const { a, seen } = readbackAgent({ llm, readBack: showsNone, steps: [legalStep, reviews] });
    a.fixedPlan = { steps: [legalStep, reviews] };
    a.prepare = async () => {};
    const result = await a.run("Find legal jobs");
    assert.equal(result.status, "done");
    assert.deepEqual(seen.readBack, [["Legal"], ["Legal"], ["Legal"]]); // the next step sets nothing: no read-back
    assert.equal(checks, 1);
    assert.deepEqual(
      readbacks(a).map((r) => r.miss),
      [1, 2, 3],
    );
    assert.deepEqual(JSON.parse(result.notes.unverified_settings), ["Legal"]);
    assert.deepEqual(
      result.record.filter((e) => e.type === "step").map((e) => [e.index, e.status]),
      [
        [0, "running"],
        [0, "done"],
        [1, "running"],
        [1, "done"],
      ],
    );
  } finally {
    globalThis.chrome = previous;
  }
});

// test_readback_refusal_costs_no_move
test("settingReadback: a 'step done' refused on the step's last move costs no move: the step fails open, no helper", async () => {
  let checks = 0;
  const llm = {
    read: async () => {
      checks++;
      return response({ complete: false, evidence: "No Legal filter shows", text: "", next_steps: [] });
    },
    rescue: async () => assert.fail("the read-back must not send the step to the out-of-moves helper"),
  };
  const last = { ...legalStep, max_moves: 5 };
  const { a, seen } = readbackAgent({ llm, readBack: showsNone, steps: [last] });
  a.look = async () => ({ ...scr, els: [next] });
  a.act = async () => ({ dispatched: true });
  const decide = a.drexCall;
  let moves = 0;
  // four ordinary moves, then "step done" on the fifth and last
  a.drexCall = async (state, qs, images) =>
    qs.move && moves++ < 4
      ? { answers: { move: { choice: "click E1", probabilities: { "click E1": 0.99 } }, done: { noul: 0.01 } } }
      : decide(state, qs, images);
  assert.deepEqual(await a.browse(last), {});
  assert.deepEqual(
    readbacks(a).map((r) => r.miss),
    [1, 2, 3],
  );
  assert.equal(checks, 1); // the miss-2 check only
  assert.deepEqual(JSON.parse(a.notes.unverified_settings), ["Legal"]);
  assert.equal(seen.readBack.length, 3);
});

// test_readback_drex_confirm_counts_as_found
test("settingReadback: a value the page script misses but Drex sees applied on the screen counts as found", async () => {
  const { a, seen } = readbackAgent({ readBack: showsNone, applied: 0.9 });
  assert.deepEqual(await a.browse(legalStep), {});
  assert.equal(seen.states.length, 1);
  assert.deepEqual(seen.asked, [{ q: "Is Legal applied or selected on the screen now?", images: [scr.img1] }]);
  assert.deepEqual(readbacks(a), [{ found: { Legal: "drex" }, missing: [], miss: 0 }]);
  // one question a miss, naming every missing value; a value the page shows is not asked about
  const two = { ...legalStep, goal: 'Filter the jobs by "Legal", "Remote" and "Full-time"' };
  const both = readbackAgent({
    readBack: () => ({ found: { "Full-time": "aria-checked" }, missing: ["Legal", "Remote"] }),
    applied: 0.5, // below DONE_SURE: not confirmed
    steps: [two],
  });
  let calls = 0;
  const original = both.a.drexCall;
  both.a.drexCall = async (state, qs, images) => {
    if (!qs.move && ++calls > 1) return { answers: { [Object.keys(qs)[0]]: { noul: 0.95 } } };
    return original(state, qs, images);
  };
  assert.deepEqual(await both.a.browse(two), {});
  assert.deepEqual(
    both.seen.asked.map((x) => x.q),
    ["Are Legal and Remote both applied or selected on the screen now?"],
  );
  assert.deepEqual(readbacks(both.a), [
    { found: { "Full-time": "aria-checked" }, missing: ["Legal", "Remote"], miss: 1 },
    { found: { "Full-time": "aria-checked", Legal: "drex", Remote: "drex" }, missing: [], miss: 0 },
  ]);
});

// test_readback_skips_non_setting_steps
test("settingReadback: a step that sets nothing, or a build without the switch, reads nothing back", async () => {
  const open = { ...legalStep, goal: "Open the Reviews tab", done_when: "The reviews are shown" };
  const nothing = readbackAgent({ readBack: showsNone, steps: [open] });
  assert.deepEqual(await nothing.a.browse(open), {});
  assert.deepEqual(nothing.seen.readBack, []);
  assert.deepEqual(readbacks(nothing.a), []);
  // a setting step whose values are all actions it clicked has nothing to read back either
  const click = { ...legalStep, goal: 'Set the filters and click "See 12 Homes"' };
  const clicked = readbackAgent({ readBack: showsNone, steps: [click] });
  clicked.a.capture = async () => "after";
  clicked.a.perform = async () => {};
  let moves = 0;
  const decide = clicked.a.drexCall;
  clicked.a.look = async () => ({ ...scr, els: [{ ...next, name: "See 12 Homes", text: "button 'See 12 Homes'" }] });
  clicked.a.drexCall = async (state, qs, images) =>
    qs.move && moves++ === 0
      ? { answers: { move: { choice: "click E1", probabilities: { "click E1": 0.99 } }, done: { noul: 0.01 } } }
      : decide(state, qs, images);
  assert.deepEqual(await clicked.a.browse(click), {});
  assert.deepEqual(clicked.seen.readBack, []);
  // the switch off: the same setting step ends on Drex's word, as before
  const off = readbackAgent({ readBack: showsNone, Kind: Agent });
  assert.deepEqual(await off.a.browse(legalStep), {});
  assert.deepEqual(off.seen.readBack, []);
  assert.deepEqual(off.seen.asked, []);
  assert.deepEqual(readbacks(off.a), []);
});

// test_readback_resets_on_step_advance
test("settingReadback: each step counts its own misses: the next step's first miss is miss 1 again", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    const llm = { read: async () => response({ complete: false, evidence: "Not shown", text: "", next_steps: [] }) };
    const sort = { ...legalStep, goal: 'Sort the jobs by "Newest"', done_when: "Newest is the sort" };
    // the first step misses twice, then shows Legal; the second misses once, then shows Newest
    const answers = [showsNone, showsNone, showsAll, showsNone, showsAll];
    const { a } = readbackAgent({ llm, readBack: (l, i) => answers[i](l), steps: [legalStep, sort] });
    a.fixedPlan = { steps: [legalStep, sort] };
    a.prepare = async () => {};
    const result = await a.run("Find legal jobs");
    assert.equal(result.status, "done");
    assert.deepEqual(
      readbacks(a).map((r) => [r.missing, r.miss]),
      [
        [["Legal"], 1],
        [["Legal"], 2],
        [[], 0],
        [["Newest"], 1],
        [[], 0],
      ],
    );
    assert.equal(result.notes.unverified_settings, undefined);
  } finally {
    globalThis.chrome = previous;
  }
});

// a fill step: its macro's finish is a step done like any other
test("settingReadback: a fill step whose values the page doesn't show goes on as Drex's moves, with the note", async () => {
  const { fill } = await import(pathToFileURL(join(process.env.MACROS_SOURCE || source, "macros.ts")));
  const size = {
    kind: "fill",
    goal: 'Choose "Medium (1-2 bedroom)" as the unit size',
    done_when: "Medium (1-2 bedroom) is selected",
    texts: [],
    rules: "",
    max_moves: 8,
  };
  const { a, seen } = readbackAgent({
    llm: { fill: async () => response({ why: "No fields to fill", fields: [], unresolved: [] }) },
    readBack: (l, i) => (i === 0 ? showsNone(l) : showsAll(l)),
    steps: [size],
  });
  a.read = async () => ({});
  assert.deepEqual(await fill.call(a, size), {});
  assert.deepEqual(seen.readBack, [["Medium (1-2 bedroom)"], ["Medium (1-2 bedroom)"]]);
  assert.equal(seen.states.length, 1);
  assert.match(seen.states[0], /the page doesn't show Medium \(1-2 bedroom\) applied yet/);
  // the switch off: the fill step ends with its own check, as before
  const off = readbackAgent({
    llm: { fill: async () => response({ why: "No fields to fill", fields: [], unresolved: [] }) },
    readBack: showsNone,
    steps: [size],
    Kind: Agent,
  });
  off.a.read = async () => ({});
  assert.deepEqual(await fill.call(off.a, size), {});
  assert.deepEqual(off.seen.readBack, []);
});

// the final read is told which settings were never seen applied
test("settingReadback: the final read gets the unverified settings and the rule to check them", async () => {
  const llm = fixtureLLM();
  const sent = [];
  llm.client.messages.create = async (body) => {
    sent.push(body);
    return {
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: "text", text: JSON.stringify({ complete: true, evidence: "Legal shown", text: "3 jobs" }) }],
    };
  };
  const final = { ...step, kind: "read", save_as: "final_task_answer", finalCheck: true };
  const notes = { unverified_settings: JSON.stringify(["Legal"]) };
  await llm.read({ task: "Find legal jobs", planText: "", step: final, notes, info, image, finalRead: true });
  await llm.read({ task: "Find legal jobs", planText: "", step: final, notes: {}, info, image, finalRead: true });
  assert.match(JSON.stringify(sent[0].system), /unverified_settings.*never seen applied/);
  assert.match(JSON.stringify(sent[0].messages), /unverified_settings.*Legal/);
  assert.doesNotMatch(JSON.stringify(sent[1].system), /unverified_settings/);
});

// --- revealEvidence ---------------------------------------------------------------------------------------------------
// a page as the reveal's page script sees it: where each text is ("in_view", "occluded", "off_screen"), by its
// normalised words. revealFacts answers as the script does: each literal's place, and with scroll on and none of them
// in view, the first one on the page scrolled to the middle of the screen. `picker`: a picker open until Escape and a
// blur; `stays`: it stays open; `under`: where texts are while the picker is open (under it)
const revealPage = (places, { picker = "", stays = false, under = {} } = {}) => {
  const state = { picker, escaped: false, calls: [], keys: [] };
  const tab = page({
    eval: async () => null, // the nuisance pop-up closer: none here
    key: async (k) => {
      state.keys.push(k);
      state.escaped = true;
    },
    revealFacts: async (literals, opts) => {
      state.calls.push({ literals, opts });
      if (opts.blur && state.escaped && !stays) state.picker = "";
      const at = (l) => (state.picker && under[L.normalizeLiteral(l)]) || places[L.normalizeLiteral(l)] || "none";
      const found = Object.fromEntries(literals.map((l) => [l, at(l)]));
      const first = literals.find((l) => found[l] !== "none");
      const hides = (l) => found[l] === "occluded" || found[l] === "off_screen";
      const scrolled = !opts.scroll
        ? ""
        : opts.main !== undefined
          ? hides(opts.main)
            ? opts.main
            : ""
          : !Object.values(found).includes("in_view") && first
            ? first
            : "";
      if (scrolled) places[L.normalizeLiteral(scrolled)] = "in_view";
      return { found, picker: state.picker, closerName: "", scrolled };
    },
  });
  return { tab, state };
};
// an agent at the end of a planned run whose answer note is `answer`; the final read's evidence comes from `read`
function revealAgent(tab, { Kind = AccAgent, answer, evidence } = {}) {
  const a = agent(
    { read: async () => response({ complete: true, evidence: evidence ?? "", text: answer, next_steps: [] }) },
    Kind,
  );
  a.agentTabId = 1;
  a.planning = true;
  a.plan = { steps: [{ ...step, kind: "read", save_as: "answer" }], answer_from: "answer" };
  a.currentTab = async () => tab;
  return a;
}
const revealedOf = (a) =>
  a.record
    .filter((e) => e.type === "evidence_revealed")
    .map(({ literals, found, closed, scrolled, reason }) => ({ literals, found, closed, scrolled, reason }));
const movesOf = (a) => a.record.filter((e) => e.type === "move").map((e) => e.what);
const WIND_ANSWER = "Current wind speed in Calgary is 13 km/h from the south, with gusts up to 20 km/h.";
const WIND_EVIDENCE = "Today's Conditions shows 'Wind 13 km/h S'.";

// test_reveal_prefers_final_read_evidence_literal
test("revealEvidence: the fact the final read cited is scrolled into view though another answer token is in view", async () => {
  const { tab, state } = revealPage({ "13 km h": "off_screen", "13 km": "off_screen", "20 km": "in_view" });
  const a = revealAgent(tab, { answer: WIND_ANSWER, evidence: WIND_EVIDENCE });
  await a.read(a.plan.steps[0]); // the run's final read: its evidence is kept for the reveal
  await a.showEvidence();
  assert.deepEqual(state.calls.at(-1).literals, ["Wind 13 km/h S", "13 km/h", "13 km"]);
  assert.deepEqual(movesOf(a), ["scrolled the answer ('13 km/h') into view"]);
  assert.deepEqual(revealedOf(a), [
    {
      literals: ["Wind 13 km/h S", "13 km/h", "13 km"],
      found: { "Wind 13 km/h S": "none", "13 km/h": "off_screen", "13 km": "off_screen" },
      closed: [],
      scrolled: "13 km/h",
      reason: "",
    },
  ]);
  // the switch off: the answer's tokens, "20 km" among them in view, so nothing scrolls; the activation is logged
  const evals = [];
  const old = page({
    eval: async (expr) => (
      evals.push(expr),
      {
        closer: null,
        closerName: "",
        visible: true,
        scrolled: "",
        found: { "13 km": "off_screen", "20 km": "in_view" },
      }
    ),
    revealFacts: async () => assert.fail("the switch off keeps the old page script"),
  });
  const off = revealAgent(old, { Kind: Agent, answer: WIND_ANSWER, evidence: WIND_EVIDENCE });
  await off.read(off.plan.steps[0]);
  await off.showEvidence();
  assert.ok(evals.at(-1).endsWith(`(${JSON.stringify(["13 km", "20 km"])}, true)`));
  assert.deepEqual(movesOf(off), []);
  assert.deepEqual(revealedOf(off), [
    {
      literals: ["13 km", "20 km"],
      found: { "13 km": "off_screen", "20 km": "in_view" },
      closed: [],
      scrolled: null,
      reason: "'20 km' is already in view",
    },
  ]);
});

// test_reveal_scrolls_main_literal_even_if_minor_in_view
test("revealEvidence: the main literal (also in the answer) is scrolled to though a minor value is in view", async () => {
  const { tab, state } = revealPage({ 180: "occluded", 35: "in_view" });
  const answer = "Without Auto Pay, 4 lines come to a total of $180/mo.";
  const a = revealAgent(tab, { answer, evidence: "The banner row shows '$35' and the total '$180'." });
  await a.read(a.plan.steps[0]);
  await a.showEvidence();
  assert.deepEqual(state.calls.at(-1).opts, { scroll: true, blur: false, main: "$180" });
  assert.deepEqual(movesOf(a), ["scrolled the answer ('$180') into view"]);
  const event = a.record.find((e) => e.type === "evidence_revealed");
  assert.equal(event.main, "$180");
  assert.equal(event.scrolled, "$180");
});

// test_reveal_main_in_view_minor_hidden_no_scroll
test("revealEvidence: the main literal in view and a minor value hidden scrolls nothing", async () => {
  const { tab, state } = revealPage({ 180: "in_view", 35: "off_screen" });
  const answer = "Without Auto Pay, 4 lines come to a total of $180/mo.";
  const a = revealAgent(tab, { answer, evidence: "The banner row shows '$35' and the total '$180'." });
  await a.read(a.plan.steps[0]);
  await a.showEvidence();
  assert.equal(state.calls.at(-1).opts.main, "$180");
  assert.deepEqual(movesOf(a), []);
  const event = a.record.find((e) => e.type === "evidence_revealed");
  assert.equal(event.main, "$180");
  assert.equal(event.scrolled, null);
  assert.equal(event.reason, "'$180' is already in view");
});

// test_single_reveal
test("revealEvidence: a run reveals once, at its end, and makes no move after the reveal", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = runChrome();
  try {
    const { tab, state } = revealPage({ "13 km h": "off_screen" });
    const read = { ...step, kind: "read", goal: "Read the current wind", save_as: "wind" };
    const a = revealAgent(tab, { answer: WIND_ANSWER, evidence: WIND_EVIDENCE });
    a.llm.plan = async () => response({ summary: "", answer_from: "wind", steps: [read] });
    a.llm.finalAnswerHold = () => ({ calls: 1, usd: 0.002, ms: 1000 });
    a.windowTabs = async () => [{ id: 1, url: info.url, status: "complete", active: true }];
    a.prepare = async () => {};
    const result = await a.run("What is the wind in Calgary?");
    assert.equal(result.status, "done");
    assert.equal(state.calls.filter((c) => c.opts.scroll).length, 1);
    assert.equal(revealedOf(a).length, 1);
    assert.deepEqual(movesOf(a), ["scrolled the answer ('13 km/h') into view"]);
    const at = result.record.findIndex((e) => e.type === "evidence_revealed");
    assert.deepEqual(
      result.record.slice(at + 1).map((e) => e.type),
      ["finish"],
    );
  } finally {
    globalThis.chrome = previous;
  }
});

// test_reveal_logs_not_found
test("revealEvidence: a fact the page doesn't hold is logged as not found, and nothing scrolls", async () => {
  const { tab, state } = revealPage({});
  const a = revealAgent(tab, { answer: WIND_ANSWER, evidence: WIND_EVIDENCE });
  await a.read(a.plan.steps[0]);
  await a.showEvidence();
  assert.deepEqual(movesOf(a), []);
  assert.deepEqual(state.keys, []);
  assert.deepEqual(revealedOf(a), [
    {
      literals: ["Wind 13 km/h S", "13 km/h", "13 km"],
      found: { "Wind 13 km/h S": "none", "13 km/h": "none", "13 km": "none" },
      closed: [],
      scrolled: null,
      reason: "no literal is on the page",
    },
  ]);
  // nothing to look for at all: still logged, with why
  const empty = revealPage({});
  const none = revealAgent(empty.tab, { answer: "Added it to the cart.", evidence: "The cart shows the item" });
  await none.read(none.plan.steps[0]);
  await none.showEvidence();
  assert.deepEqual(empty.state.calls, []);
  assert.deepEqual(revealedOf(none), [
    { literals: [], found: {}, closed: [], scrolled: null, reason: "no literal to show" },
  ]);
});

// test_reveal_scrolls_occluded_literal
test("revealEvidence: a fact on screen but under a sticky banner is scrolled clear", async () => {
  const { tab } = revealPage({ 180: "occluded" });
  const a = revealAgent(tab, {
    answer: "The total is $180/mo for 4 lines without Auto Pay.",
    evidence: "The price row shows $180/mo with Auto Pay off",
  });
  await a.read(a.plan.steps[0]);
  await a.showEvidence();
  assert.deepEqual(movesOf(a), ["scrolled the answer ('$180') into view"]);
  assert.deepEqual(revealedOf(a), [
    { literals: ["$180"], found: { $180: "occluded" }, closed: [], scrolled: "$180", reason: "" },
  ]);
});

// test_reveal_closes_open_picker_not_cart_dialog
test("revealEvidence: a picker hiding a fact is closed with Escape and a blur; one hiding nothing, or a cart pop-up, is not", async () => {
  const NOTICE = "Availability is not yet released. Check back on January 10, 2027";
  const notice = L.normalizeLiteral(NOTICE);
  const evidence = `The info notice says "${NOTICE}"`;
  const answer = "No date is available yet: check back on January 10, 2027.";
  // the notice is on the page but under the date picker the run's last moves opened
  const { tab, state } = revealPage(
    { [notice]: "in_view" },
    { picker: "dialog 'Choose a date'", under: { [notice]: "occluded" } },
  );
  const a = revealAgent(tab, { answer, evidence });
  await a.read(a.plan.steps[0]);
  await a.showEvidence();
  assert.deepEqual(state.keys, ["Escape"]);
  // the look (the notice occluded), the blur after the Escape, the look again, then the reveal
  assert.deepEqual(
    state.calls.map((c) => c.opts),
    [
      { scroll: false, blur: false },
      { scroll: false, blur: true },
      { scroll: false, blur: false },
      { scroll: true, blur: false, main: "Availability is not yet released. Check back on January 10, 2027" },
    ],
  );
  assert.deepEqual(movesOf(a), ["closed the dialog 'Choose a date' left open over the answer (Escape)"]);
  assert.deepEqual(revealedOf(a), [
    {
      literals: [NOTICE],
      found: { [NOTICE]: "in_view" },
      closed: ["dialog 'Choose a date'"],
      scrolled: null,
      reason: `'${NOTICE}' is already in view`,
    },
  ]);
  // every literal in view: the picker open beside it hides nothing, so no Escape is sent and it stays open
  const beside = revealPage({ [notice]: "in_view" }, { picker: "dialog 'Choose a date'" });
  const n = revealAgent(beside.tab, { answer, evidence });
  await n.read(n.plan.steps[0]);
  await n.showEvidence();
  assert.deepEqual(beside.state.keys, []);
  assert.equal(beside.state.picker, "dialog 'Choose a date'");
  assert.deepEqual(
    beside.state.calls.map((c) => c.opts),
    [
      { scroll: false, blur: false },
      { scroll: true, blur: false, main: NOTICE },
    ],
  );
  assert.deepEqual(movesOf(n), []);
  assert.deepEqual(revealedOf(n)[0].closed, []);
  // no literal on the page: nothing a picker could hide either
  const absent = revealPage({}, { picker: "listbox 'Month'" });
  const z = revealAgent(absent.tab, { answer, evidence });
  await z.read(z.plan.steps[0]);
  await z.showEvidence();
  assert.deepEqual(absent.state.keys, []);
  // a picker Escape didn't close is not reported closed; the hidden notice is still scrolled to
  const stuck = revealPage(
    { [notice]: "off_screen" },
    { picker: "listbox 'Month'", stays: true, under: { [notice]: "occluded" } },
  );
  const b = revealAgent(stuck.tab, { answer, evidence });
  await b.read(b.plan.steps[0]);
  await b.showEvidence();
  assert.deepEqual(stuck.state.keys, ["Escape"]);
  assert.deepEqual(movesOf(b), [`scrolled the answer ('${NOTICE}') into view`]);
  assert.deepEqual(revealedOf(b)[0].closed, []);
  // an "Added to your cart" pop-up is evidence: with a fact still hidden, the page script reports no picker beside it,
  // so no Escape is sent
  const cart = revealPage({ "added to your cart": "in_view", "169 95": "off_screen" });
  const c = revealAgent(cart.tab, {
    answer: "Added the clog to your cart for $169.95.",
    evidence: "The panel says 'Added to your cart' at $169.95",
  });
  await c.read(c.plan.steps[0]);
  await c.showEvidence();
  assert.deepEqual(revealedOf(c)[0].found, { "Added to your cart": "in_view", "$169.95": "off_screen" });
  assert.deepEqual(cart.state.keys, []);
  // the answer's own amount is the main literal: it is scrolled to though the pop-up's words are in view (ruling 18)
  assert.deepEqual(movesOf(c), ["scrolled the answer ('$169.95') into view"]);
  assert.deepEqual(revealedOf(c)[0].closed, []);
});

const dragEls = () => {
  const box = (label, name, node, x, extra = {}) => ({
    label,
    role: "button",
    name,
    text: `button '${name}'`,
    state: "",
    node,
    box: [x, 0, x + 10, 10],
    documentPosition: [x, 0, 10, 10],
    ...extra,
  });
  return [box("E1", "Submit", 1, 0), box("E2", "s", 2, 20, { draggable: true }), box("E3", "L", 3, 40)];
};
// Drex's drag move is offered only when the step or task speaks of dragging (DRAG_HINT in agent.ts)
const dragStep = {
  ...step,
  goal: "Drag the small box onto the large one",
  done_when: "The small box is in the large one",
};
const dragAgent = (llm) => {
  const a = agent(llm);
  a.task = "Drag the small box into the large box";
  a.plan = { steps: [dragStep] };
  return a;
};

test("test_drag_pick_then_drop_choice: Drex picks 'drag E2', then the element to drop it onto; the drag is made and logged", async () => {
  const els = dragEls();
  const a = dragAgent(noLLM());
  a.look = async () => ({ ...scr, els });
  const dragged = [];
  a.currentTab = async () => page({ dragTo: async (from, to) => (dragged.push([from, to]), true) });
  a.capture = async () => "after";
  let approvals = 0;
  a.askApproval = async () => (approvals++, "always");
  const asked = [];
  a.drexCall = async (state, qs) => {
    asked.push({ state, qs });
    if (qs.to) return { answers: { to: { choice: "E3", probabilities: { E3: 0.9, E1: 0.1 } } }, ms: 1, usd: 0 };
    const choice = asked.filter((q) => q.qs.move).length === 1 ? "drag E2" : "step done";
    const done = choice === "step done" ? 0.99 : 0.01;
    return { answers: { move: { choice, probabilities: { [choice]: 0.99 } }, done: { noul: done } }, ms: 1, usd: 0 };
  };
  assert.deepEqual(await a.browse(dragStep), {});
  assert.equal(asked[0].qs.move.criteria["drag E2"] !== undefined, true);
  assert.equal(asked[0].qs.move.criteria["drag E1"], undefined); // only the draggable element has a drag move
  const drop = asked.find((q) => q.qs.to);
  assert.equal(drop.qs.to.type, "choice");
  assert.match(
    drop.qs.to.instructions,
    /^Drop it onto which element\? The element you drag is centred at x 25, y 5 on screen\./,
  );
  assert.deepEqual(Object.keys(drop.qs.to.criteria), ["E1", "E3"]); // every other tagged element
  // each target says where it is from the dragged element, then what it is
  assert.equal(drop.qs.to.criteria.E3, "to the right, 20 px: button 'L'");
  assert.equal(drop.qs.to.criteria.E1, "to the left, 20 px: button 'Submit'");
  assert.match(drop.state, /YOUR MOVE: drag E2/);
  assert.deepEqual(dragged, [[2, 3]]);
  const log = a.record.find((e) => e.type === "drag_to");
  assert.deepEqual([log.from, log.to, log.changed], ["E2", "E3", true]);
  // the drop is recorded like Drex's move: what was offered, what it chose and how sure it was
  const choices = a.record.filter((e) => e.type === "decision");
  assert.deepEqual(
    choices.map((e) => [e.sub, e.choice]),
    [
      [undefined, "drag E2"],
      ["drop", "E3"],
    ],
  );
  const dropped = choices[1];
  assert.equal(dropped.who, "drex");
  assert.equal(dropped.p, 0.9);
  assert.deepEqual(dropped.top, [
    ["E3", 0.9],
    ["E1", 0.1],
  ]);
  assert.deepEqual(dropped.topText, [
    ["to the right, 20 px: button 'L'", 0.9],
    ["to the left, 20 px: button 'Submit'", 0.1],
  ]);
  assert.equal(dropped.options, 2);
  assert.ok(a.record.some((e) => e.type === "move" && e.what === "dragged E2 (button 's') onto E3 (button 'L')"));
  assert.equal(approvals, 1); // a drag has no control name to check: asked like a drag gesture
});

test("test_drag_option_needs_drag_hint: with no drag, drop, move or sort word in the step or task, Drex is offered no drag", async () => {
  const run = async (task, goal, done_when) => {
    const a = agent(noLLM());
    a.task = task;
    a.look = async () => ({ ...scr, els: dragEls() });
    a.currentTab = async () => page({ dragTo: async () => true });
    a.capture = async () => "after";
    const asked = [];
    a.drexCall = async (state, qs) => {
      asked.push(qs);
      return { answers: { move: { choice: "step done", probabilities: { "step done": 0.99 } }, done: { noul: 0.99 } } };
    };
    await a.browse({ ...step, goal, done_when });
    return asked[0].move.criteria;
  };
  // a page whose library marks a card draggable, on a step that only submits
  const none = await run("Submit the form", "Submit the form", "The form is sent");
  assert.equal(none["drag E2"], undefined);
  assert.ok("click E2" in none); // the element is still clickable
  // the word may come from the step's goal, its done_when or the task
  assert.ok("drag E2" in (await run("Submit the form", "Move the card to Done", "The form is sent")));
  assert.ok("drag E2" in (await run("Submit the form", "Submit the form", "Card A sits in Done after the drag")));
  assert.ok("drag E2" in (await run("Drop the file onto the folder", "Submit the form", "The form is sent")));
});

test("test_drag_not_on_screen_not_logged: a drag dragTo could not send (null) is not dispatched and logs no drag_to", async () => {
  const els = dragEls();
  const a = dragAgent(noLLM());
  const dragged = [];
  const result = await a.perform(page({ dragTo: async (from, to) => (dragged.push([from, to]), null) }), {
    kind: "drag_to",
    el: els[1],
    to: els[2],
  });
  assert.deepEqual(result, { dispatched: false, reason: "The element to drag or its target is not on screen" });
  assert.deepEqual(dragged, [[2, 3]]);
  assert.equal(
    a.record.find((e) => e.type === "drag_to"),
    undefined,
  );
  // in a run: the move is recorded as not made, with the reason, and no drag_to event is counted
  const b = dragAgent(noLLM());
  b.look = async () => ({ ...scr, els });
  b.currentTab = async () => page({ dragTo: async () => null });
  b.capture = async () => "after";
  b.askApproval = async () => "always";
  const states = [];
  b.drexCall = async (state, qs) => {
    states.push(state);
    if (qs.to) return { answers: { to: { choice: "E3", probabilities: { E3: 0.9 } } }, ms: 1, usd: 0 };
    const choice = states.length === 1 ? "drag E2" : "step done";
    const done = choice === "step done" ? 0.99 : 0.01;
    return { answers: { move: { choice, probabilities: { [choice]: 0.99 } }, done: { noul: done } }, ms: 1, usd: 0 };
  };
  await b.browse(dragStep);
  assert.equal(
    b.record.find((e) => e.type === "drag_to"),
    undefined,
  );
  assert.equal(
    b.record.some((e) => e.type === "move" && e.what === "dragged E2 (button 's') onto E3 (button 'L')"),
    false,
  );
  assert.match(states.at(-1), /dragged E2 \(button 's'\) onto E3 \(button 'L'\).*not on screen/);
});

test("test_drop_choice_labels_positions: the drop choice names grid cells and the centre, offers no canvas, and places other targets by direction", async () => {
  // a 3x3 grid of the scan's repeated controls (e.grid), the page's canvas, and a button outside the grid
  const tile = (i) => {
    const row = Math.floor(i / 3) + 1,
      column = (i % 3) + 1,
      x = column * 50,
      y = row * 50;
    return {
      label: `E${i + 2}`,
      role: "button",
      name: "Tile",
      text: "button 'Tile'",
      state: "",
      node: i + 2,
      group: `p:${i + 2}`,
      box: [x, y, x + 40, y + 40],
      documentPosition: [x, y, 40, 40],
      grid: { row, column, ordinal: i + 1, total: 9 },
      draggable: true,
    };
  };
  const els = [
    {
      label: "E1",
      role: "canvas",
      text: "canvas (no label)",
      state: "",
      node: 1,
      box: [400, 0, 560, 210],
      documentPosition: [400, 0, 160, 210],
    },
    ...Array.from({ length: 9 }, (_, i) => tile(i)),
    {
      label: "E11",
      role: "button",
      name: "Submit",
      text: "button 'Submit'",
      state: "",
      node: 11,
      box: [50, 250, 90, 270],
      documentPosition: [50, 250, 40, 20],
    },
  ];
  const a = dragAgent(noLLM());
  a.look = async () => ({ ...scr, els });
  a.currentTab = async () => page({ dragTo: async () => true });
  a.capture = async () => "after";
  a.askApproval = async () => "always";
  const asked = [];
  a.drexCall = async (state, qs) => {
    asked.push(qs);
    if (qs.to) return { answers: { to: { choice: "E6", probabilities: { E6: 0.97, E5: 0.03 } } }, ms: 1, usd: 0 };
    const choice = asked.filter((q) => q.move).length === 1 ? "drag E9" : "step done";
    const done = choice === "step done" ? 0.99 : 0.01;
    return { answers: { move: { choice, probabilities: { [choice]: 0.99 } }, done: { noul: done } }, ms: 1, usd: 0 };
  };
  assert.deepEqual(await a.browse(dragStep), {});
  const drop = asked.find((q) => q.to).to;
  // the dragged tile (row 3, column 2) is the anchor
  assert.match(drop.instructions, /The element you drag is at row 3, column 2 of a 3×3 grid\./);
  assert.equal(drop.criteria.E1, undefined); // the canvas is no drop target
  assert.equal(drop.criteria.E9, undefined); // nor the dragged tile itself
  assert.equal(drop.criteria.E6, "row 2, column 2 of a 3×3 grid (the centre): button 'Tile'");
  assert.equal(drop.criteria.E2, "row 1, column 1 of a 3×3 grid: button 'Tile'");
  assert.equal(drop.criteria.E10, "row 3, column 3 of a 3×3 grid: button 'Tile'");
  // the button outside the grid: direction and distance from the dragged tile's centre (120,170) to its own (70,260)
  assert.equal(drop.criteria.E11, "below, 90 px: button 'Submit'");
  assert.equal(Object.keys(drop.criteria).length, 9);
  const log = a.record.find((e) => e.type === "drag_to");
  assert.deepEqual([log.from, log.to], ["E9", "E6"]);
});

const copyEls = () => {
  const box = (label, role, name, node, x, extra = {}) => ({
    label,
    role,
    name,
    text: `${role} '${name}'`,
    state: "",
    node,
    box: [x, 0, x + 10, 10],
    documentPosition: [x, 0, 10, 10],
    ...extra,
  });
  return [
    box("E1", "button", "Submit", 1, 0),
    box("E2", "paragraph", "Lorem ipsum", 2, 20, { ownText: true }),
    box("E3", "textbox", "Answer", 3, 40, { field: true }),
    box("E4", "textbox", "Date", 4, 60, { field: true, readOnly: true }),
  ];
};

test("test_copy_pick_then_paste_choice_logs_copied: Drex picks 'copy the text of E2', then an editable field; the copy is made and logged", async () => {
  const run = async (goal) => {
    const a = agent(noLLM());
    a.look = async () => ({ ...scr, els: copyEls() });
    const copied = [];
    a.currentTab = async () => page({ copyInto: async (from, to) => (copied.push([from, to]), { chars: 11 }) });
    a.capture = async () => "after";
    a.askApproval = async () => "always";
    const asked = [];
    a.drexCall = async (state, qs) => {
      asked.push({ state, qs });
      if (qs.to) return { answers: { to: { choice: "E3", probabilities: { E3: 0.9 } } }, ms: 1, usd: 0 };
      const choice =
        asked.filter((q) => q.qs.move).length === 1 && "copy the text of E2" in qs.move.criteria
          ? "copy the text of E2"
          : "step done";
      const done = choice === "step done" ? 0.99 : 0.01;
      return { answers: { move: { choice, probabilities: { [choice]: 0.99 } }, done: { noul: done } }, ms: 1, usd: 0 };
    };
    await a.browse({ ...step, goal });
    return { a, asked, copied };
  };
  const { a, asked, copied } = await run("Copy the text into the box");
  assert.ok(asked[0].qs.move.criteria["copy the text of E2"] !== undefined);
  const paste = asked.find((q) => q.qs.to);
  assert.equal(paste.qs.to.type, "choice");
  assert.equal(paste.qs.to.instructions, "Paste it into which field?");
  assert.deepEqual(Object.keys(paste.qs.to.criteria), ["E3"]); // editable fields only: not the read-only one, not a button
  assert.match(paste.state, /YOUR MOVE: copy the text of E2/);
  assert.deepEqual(copied, [[2, 3]]);
  const log = a.record.find((e) => e.type === "copied");
  assert.deepEqual([log.from, log.to, log.chars], ["E2", "E3", 11]);
  // no copy, paste or duplicate in the step or task: the move is not offered
  const none = await run("Sort descending");
  assert.equal(none.asked[0].qs.move.criteria["copy the text of E2"], undefined);
  assert.deepEqual(none.copied, []);
});

test("test_copy_pair_paused_after_no_change: a copy that changed nothing is not offered into that field again; with none left the copy is paused", async () => {
  const els = copyEls();
  els.push({ ...els[2], label: "E5", name: "Other", text: "textbox 'Other'", node: 5, box: [80, 0, 90, 10] });
  const a = agent(noLLM());
  a.planning = false;
  a.look = async () => ({ ...scr, els, jpeg: "same" });
  a.agentTabId = 1;
  a.capture = async () => "same"; // nothing ever changes
  const copied = [],
    clicked = [];
  a.currentTab = async () =>
    page({
      copyInto: async (from, to) => (copied.push([from, to]), { chars: 11 }),
      click: async (x, y) => clicked.push([x, y]),
    });
  a.askApproval = async () => "always";
  const asked = [];
  const pastes = ["E3", "E5"];
  a.drexCall = async (state, qs) => {
    asked.push(qs);
    if (qs.to) {
      const choice = pastes.shift();
      return { answers: { to: { choice, probabilities: { [choice]: 0.9 } } }, ms: 1, usd: 0 };
    }
    if (asked.filter((q) => q.move).length > 3) throw new Error("enough moves");
    const probabilities = { "copy the text of E2": 0.9, "click E1": 0.1 };
    return { answers: { move: { choice: "copy the text of E2", probabilities }, done: { noul: 0.01 } }, ms: 1, usd: 0 };
  };
  await assert.rejects(a.browse({ ...step, goal: "Copy the text" }), /enough moves/);
  const targets = asked.filter((q) => q.to).map((q) => Object.keys(q.to.criteria));
  assert.deepEqual(targets, [["E3", "E5"], ["E5"]]); // E3 was copied into in vain
  assert.deepEqual(copied, [
    [2, 3],
    [2, 5],
  ]);
  // no target left: the copy is not offered again and the next doable move is taken
  const moves = asked.filter((q) => q.move);
  assert.ok("copy the text of E2" in moves[2].move.criteria);
  assert.equal(moves[3].move.criteria["copy the text of E2"], undefined);
});

test("test_drag_pair_paused_after_no_change: a drop that changed nothing is not offered again; with none left the drag is paused", async () => {
  const els = dragEls();
  els[0] = { ...els[0], name: "Info", text: "button 'Info'" };
  const a = dragAgent(noLLM());
  a.planning = false;
  a.look = async () => ({ ...scr, els, jpeg: "same" });
  a.agentTabId = 1; // the agent's own tab: its screenshot after each move is compared
  a.capture = async () => "same"; // the screen never changes: every move changed nothing
  const dragged = [],
    clicked = [];
  a.currentTab = async () =>
    page({
      dragTo: async (from, to) => (dragged.push([from, to]), false),
      click: async (x, y) => clicked.push([x, y]),
    });
  a.askApproval = async () => "always";
  const asked = [];
  const drops = ["E3", "E1"];
  a.drexCall = async (state, qs) => {
    asked.push(qs);
    if (qs.to) {
      const choice = drops.shift();
      return { answers: { to: { choice, probabilities: { [choice]: 0.9 } } }, ms: 1, usd: 0 };
    }
    if (asked.filter((q) => q.move).length > 3) throw new Error("enough moves");
    const probabilities = { "drag E2": 0.9, "click E1": 0.1 };
    return { answers: { move: { choice: "drag E2", probabilities }, done: { noul: 0.01 } }, ms: 1, usd: 0 };
  };
  await assert.rejects(a.browse(dragStep), /enough moves/);
  const dropQs = asked.filter((q) => q.to).map((q) => Object.keys(q.to.criteria));
  // the second time, E3 (dropped onto in vain) is not offered; the third time no drop is left, so no question
  assert.deepEqual(dropQs, [["E1", "E3"], ["E1"]]);
  assert.deepEqual(dragged, [
    [2, 3],
    [2, 1],
  ]);
  // the drag is paused: Drex's next choice that can still make progress is taken, and the drag is not offered again
  assert.equal(clicked.length, 1);
  const moves = asked.filter((q) => q.move);
  assert.equal(moves.length, 4);
  assert.ok("drag E2" in moves[2].move.criteria);
  assert.equal(moves[3].move.criteria["drag E2"], undefined);
  assert.ok(a.record.some((e) => e.type === "tab" && /'drag E2 \(button 's'\)' changed nothing before/.test(e.what)));
});

test("test_rescue_drag_to_labels: the helper's drag_to gesture names both elements by tag; an unknown tag is rejected", async () => {
  const els = dragEls();
  let seen;
  const helper = (from, to) =>
    agent({
      rescue: async (args) => {
        seen = args;
        return response({
          decision: "gesture",
          why: "Drag the small box into the large one",
          user_need: "none",
          option: "",
          text: "",
          x: 0,
          y: 0,
          gesture: { kind: "drag_to", endX: 0, endY: 0, key: "", modifiers: [], from, to },
        });
      },
    });
  const here = { ...scr, els, shot: { scale: 2 } };
  const { opts, acts } = buildOptions({ els, dragTo: true, dragHint: true });
  const a = helper("E2", "E3");
  a.task = "Submit the form"; // no drag word: the helper's drag_to by tags needs the switch alone
  const result = await a.rescue("Drag the box", "State", here, opts, acts, []);
  assert.deepEqual(result.act, { kind: "drag_to", el: els[1], to: els[2] });
  assert.equal(seen.dragTo, true); // the switch is on: the helper is offered the drag_to gesture
  assert.equal(seen.opts["drag E2"], undefined); // it names the drop target itself, so Drex's half-move is not offered
  const dragged = [];
  await a.perform(page({ dragTo: async (from, to) => (dragged.push([from, to]), false) }), result.act);
  assert.deepEqual(dragged, [[2, 3]]);
  const log = a.record.find((e) => e.type === "drag_to");
  assert.deepEqual([log.from, log.to, log.changed], ["E2", "E3", false]);
  // a tag that is not on screen, or the same element twice, is no drag
  await assert.rejects(helper("E2", "E9").rescue("Drag the box", "State", here, opts, acts, []), /Invalid helper/);
  await assert.rejects(helper("E2", "E2").rescue("Drag the box", "State", here, opts, acts, []), /Invalid helper/);
  // the provider's schema: drag_to with from and to only when the switch asks for it
  const gestureSchema = async (dragTo) => {
    const llm = fixtureLLM();
    let body;
    llm.client.messages.create = async (b) => {
      body = b;
      return {
        model: "claude-haiku-5-5",
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: "text", text: JSON.stringify({ decision: "give_up", why: "x" }) }],
      };
    };
    await llm.rescue({ state: "", reason: "", image, opts: {}, ...(dragTo ? { dragTo } : {}) });
    return { gesture: body.output_config.format.schema.properties.gesture, system: JSON.stringify(body.system) };
  };
  const on = await gestureSchema(true);
  assert.ok(on.gesture.properties.kind.enum.includes("drag_to"));
  assert.deepEqual(
    ["from", "to"].map((k) => [on.gesture.properties[k].type, on.gesture.required.includes(k)]),
    [
      ["string", true],
      ["string", true],
    ],
  );
  assert.match(on.system, /drag_to/);
  const off = await gestureSchema(false);
  assert.ok(!off.gesture.properties.kind.enum.includes("drag_to"));
  assert.equal(off.gesture.properties.from, undefined);
  assert.doesNotMatch(off.system, /drag_to/);
});

// MiniWoB book-flight (round 6): "Emmonak, AK" typed into From and never committed; the next city went into the same
// field. pickSuggestion (on in this bundle): after the typing, the matching suggestion is picked and logged.
const fromField = {
  label: "E1",
  role: "textbox",
  name: "From:",
  text: "textbox 'From:'",
  node: 5,
  field: true,
  box: [0, 0, 100, 20],
};
const suggestTab = (pick, calls, over = {}) =>
  page({
    click: async () => void calls.push("click"),
    setTemporal: async () => false,
    clearField: async () => void calls.push("clear"),
    type: async (text) => (calls.push(`type ${text}`), true),
    waitForSuggestions: async () => (calls.push("wait"), true),
    // the field carries an autocomplete hint (jQuery UI's ui-autocomplete-input class, say)
    autocompleteHint: async (node) => (calls.push(`hint ${node}`), true),
    markSuggestions: async (node) => (calls.push(`mark ${node}`), 1000),
    pickSuggestion: async (node, typed, since, ms) => (
      calls.push(`pick ${node} ${typed} ${since}${ms === undefined ? "" : ` ms=${ms}`}`),
      pick(typed)
    ),
    ...over,
  });
const picks = (a) =>
  a.record
    .filter((e) => e.type === "suggestion_picked")
    .map(({ field, typed, picked, ok }) => ({ field, typed, picked, ok }));

test("test_typeinto_picks_suggestion_and_logs: the typed field's suggestion is picked after the typing, logged and kept", async () => {
  const a = agent(noLLM());
  const calls = [];
  const tab = suggestTab(() => ({ ok: true, picked: "Emmonak, AK (EMK)" }), calls);
  await a.perform(tab, { kind: "type", el: fromField }, "Emmonak, AK");
  // a hinted field: the lists on screen are noted before the typing, so the pick only sees what the typing opened
  assert.deepEqual(calls, ["click", "clear", "hint 5", "mark 5", "type Emmonak, AK", "pick 5 Emmonak, AK 1000"]);
  assert.deepEqual(picks(a), [{ field: "E1", typed: "Emmonak, AK", picked: "Emmonak, AK (EMK)", ok: true }]);
  assert.equal(a.pickedSuggestions[5], "Emmonak, AK (EMK)");
  // a combobox (a hint in itself) still waits for its list as before, then picks
  calls.length = 0;
  await a.perform(tab, { kind: "type", el: { ...fromField, role: "combobox", node: 6, label: "E2" } }, "Boston");
  assert.deepEqual(calls, ["click", "clear", "mark 6", "type Boston", "wait", "pick 6 Boston 1000"]);
  assert.equal(picks(a).length, 2);
  // nothing appeared after the typing: nothing logged, nothing kept
  const quiet = suggestTab(() => ({ ok: false }), calls);
  await a.perform(quiet, { kind: "type", el: { ...fromField, node: 7, label: "E3" } }, "Alice");
  assert.equal(picks(a).length, 2);
  assert.equal(a.pickedSuggestions[7], undefined);
  // the picked field typed again, with nothing appearing this time: its earlier pick no longer stands for its value
  await a.perform(quiet, { kind: "type", el: fromField }, "Kotlik");
  assert.equal(a.pickedSuggestions[5], "");
  assert.equal(picks(a).length, 2);
  // a plain field with no autocomplete hint: typed with no mark and no wait for suggestions
  calls.length = 0;
  const plain = suggestTab(() => assert.fail("no pick on a field without a hint"), calls, {
    autocompleteHint: async (node) => (calls.push(`hint ${node}`), false),
  });
  await a.perform(plain, { kind: "type", el: { ...fromField, node: 12, label: "E5", name: "Full name" } }, "Alice");
  assert.deepEqual(calls, ["click", "clear", "hint 12", "type Alice"]);
  // a search box, a text area and a number box are typed as before, with no suggestion read
  for (const el of [
    { ...fromField, node: 8, name: "Search flights", text: "textbox 'Search flights'" },
    { ...fromField, node: 9, multi: true, textarea: true },
    { ...fromField, node: 10, role: "spinbutton" },
  ]) {
    calls.length = 0;
    await a.perform(tab, { kind: "type", el }, "boots");
    assert.deepEqual(calls, ["click", "clear", "type boots"], el.name);
  }
});

test("test_suggestion_no_retry: after a pick that failed, the same field's next typing reads no suggestions", async () => {
  const a = agent(noLLM());
  const calls = [];
  const tab = suggestTab(() => ({ ok: false, picked: "" }), calls);
  await a.perform(tab, { kind: "type", el: fromField }, "Emmonak, AK");
  await a.perform(tab, { kind: "type", el: fromField }, "Emmonak, AK");
  assert.equal(calls.filter((c) => c.startsWith("pick")).length, 1);
  assert.equal(calls.filter((c) => c.startsWith("mark")).length, 1);
  assert.deepEqual(picks(a), [{ field: "E1", typed: "Emmonak, AK", picked: "", ok: false }]);
  assert.equal(a.pickedSuggestions[5], undefined);
  // another field still gets its pick
  await a.perform(tab, { kind: "type", el: { ...fromField, node: 11, label: "E4" } }, "Nome");
  assert.equal(calls.filter((c) => c.startsWith("pick")).length, 2);
});

test("test_suggestion_quiet_field_not_waited_again: a field where nothing appeared gets no second wait", async () => {
  const a = agent(noLLM());
  const calls = [];
  const count = (what) => calls.filter((c) => c.startsWith(what)).length;
  const quiet = suggestTab(() => ({ ok: false }), calls);
  await a.perform(quiet, { kind: "type", el: fromField }, "Emmonak, AK");
  await a.perform(quiet, { kind: "type", el: fromField }, "Emmonak, AK"); // a retry or a replan on the same field
  assert.deepEqual([count("hint"), count("mark"), count("pick")], [1, 1, 1]);
  assert.deepEqual(picks(a), []);
  // a notice of no results says the field has suggestions, just none for that text: its next typing looks again
  calls.length = 0;
  const empty = suggestTab(() => ({ ok: false, noResults: true }), calls);
  const other = { ...fromField, node: 13, label: "E6" };
  await a.perform(empty, { kind: "type", el: other }, "Emonak");
  await a.perform(empty, { kind: "type", el: other }, "Emmonak, AK");
  assert.equal(count("pick"), 2);
  assert.deepEqual(picks(a), []);
  // a combobox whose list never came in waitForSuggestions' wait: one look for a notice, no second wait
  calls.length = 0;
  const late = suggestTab(() => ({ ok: false }), calls, {
    waitForSuggestions: async () => (calls.push("wait"), false),
  });
  await a.perform(late, { kind: "type", el: { ...fromField, role: "combobox", node: 14, label: "E7" } }, "Boston");
  assert.deepEqual(calls, ["click", "clear", "mark 14", "type Boston", "wait", "pick 14 Boston 1000 ms=0"]);
});

if (!process.env.CONTROLLER_SOURCE) {
  const { fill } = await import(pathToFileURL(join(process.env.MACROS_SOURCE || source, "macros.ts")));
  const fillStep = { ...step, kind: "fill", goal: "Fill the From field", save_as: "form" };
  // a fill that types "Emmonak, AK" into From through the agent's own moves; the page's field holds what typing and
  // the pick leave there (shown: what the page itself makes of the typed text)
  const filling = (pick, shown = (typed) => typed) => {
    let value = "";
    const calls = [];
    const a = agent({
      fill: async () =>
        response({
          why: "",
          fields: [
            { label: "E1", desired_value: "Emmonak, AK", source_kind: "instruction", source_evidence: "From: Emmonak" },
          ],
          unresolved: [],
        }),
    });
    a.look = async () => ({ ...scr, els: [fromField] });
    a.capture = async () => "after";
    a.read = async () => ({ verified: true });
    const tab = suggestTab(
      (typed) => {
        const r = pick(typed);
        if (r.ok) value = r.picked;
        return r;
      },
      calls,
      {
        type: async (text) => {
          value = shown(text);
          return true;
        },
        fieldValue: async () => ({ value }),
      },
    );
    a.currentTab = async () => tab;
    return [a, calls];
  };
  test("test_fill_accepts_picked_value: a fill that typed 'Emmonak, AK' and committed 'Emmonak, AK (EMK)' verifies", async () => {
    const [a] = filling(() => ({ ok: true, picked: "Emmonak, AK (EMK)" }));
    assert.deepEqual(await fill.call(a, fillStep), { verified: true });
    const [entry] = JSON.parse(a.notes.form);
    assert.deepEqual([entry.requested, entry.observed, entry.ok], ["Emmonak, AK", "Emmonak, AK (EMK)", true]);
    assert.equal(picks(a).length, 1);
  });
  test("test_fill_exact_when_no_suggestion: with no suggestion picked, the fill's value check stays exact", async () => {
    // nothing appeared after the typing: the field holds the typed text, which verifies as before
    const [plain, calls] = filling(() => ({ ok: false }));
    assert.deepEqual(await fill.call(plain, fillStep), { verified: true });
    assert.ok(calls.includes("pick 5 Emmonak, AK 1000"), "the typing looked for a suggestion");
    // the page changed the value by itself, with no pick of ours: a mismatch, as before
    const [changed] = filling(
      () => ({ ok: false }),
      (typed) => `${typed} (EMK)`,
    );
    const out = await fill.call(changed, fillStep);
    assert.match(out.why, /Form value verification failed/);
    assert.equal(JSON.parse(changed.notes.form)[0].ok, false);
    // a pick that failed is no accepted value either
    const [failed] = filling(
      () => ({ ok: false, picked: "Emmonak, AK (EMK)" }),
      (typed) => `${typed} (EMK)`,
    );
    assert.match((await fill.call(failed, fillStep)).why, /Form value verification failed/);
  });
}

// MiniWoB choose-date (round 6): the date field is read-only and opens a jQuery UI calendar; Drex clicked "Prev" over
// and over, the LLM typed into the field. datePicker (on in this bundle): a "type" move on a read-only field with a
// date sets it through Tab.setDate, in one move, logged as date_picked.
const dateField = {
  label: "E1",
  role: "textbox",
  name: "",
  text: "textbox (no label)",
  state: " (read-only: click it to open what sets it)",
  node: 3,
  readOnly: true,
  box: [0, 0, 100, 20],
  documentPosition: [0, 0, 100, 20],
};
const datePicks = (a) =>
  a.record.filter((e) => e.type === "date_picked").map(({ field, date, ok, clicks }) => ({ field, date, ok, clicks }));

test("test_perform_type_on_readonly_uses_setdate_and_logs: the calendar sets the read-only field; no typing", async () => {
  const a = agent(noLLM());
  const calls = [];
  let answer = { ok: true, clicks: 9 };
  const tab = page({
    setDate: async (node, date) => (calls.push(["setDate", node, date]), answer),
    click: async () => void calls.push("click"),
  });
  a.typeInto = async (_tab, el, text) => (calls.push(["typeInto", el.label, text]), true);
  const move = { kind: "type", el: dateField, text: { name: "date", text: "04/08/2016" } };
  assert.equal(await a.perform(tab, move, "04/08/2016"), undefined);
  assert.deepEqual(calls, [["setDate", 3, { y: 2016, m: 4, d: 8 }]]); // typeInto is not reached
  assert.deepEqual(datePicks(a), [{ field: "E1", date: "04/08/2016", ok: true, clicks: 9 }]);
  // the calendar didn't set it (nor a native date input's setter, which setDate tries too): logged, and the move is
  // reported as not made; the field is not clicked or typed into again (Enter would pick a highlighted day)
  calls.length = 0;
  answer = { ok: false, clicks: 1 };
  assert.deepEqual(await a.perform(tab, move, "04/08/2016", true), {
    dispatched: false,
    reason: "The calendar did not set the date",
  });
  assert.deepEqual(calls, [["setDate", 3, { y: 2016, m: 4, d: 8 }]]);
  assert.deepEqual(datePicks(a).at(-1), { field: "E1", date: "04/08/2016", ok: false, clicks: 1 });
  // not a date, or not a read-only field: typed as before, with no calendar
  calls.length = 0;
  await a.perform(tab, move, "Boston");
  await a.perform(tab, { kind: "type", el: { ...dateField, readOnly: undefined, field: true } }, "04/08/2016");
  assert.deepEqual(calls, ["click", ["typeInto", "E1", "Boston"], "click", ["typeInto", "E1", "04/08/2016"]]);
  assert.equal(datePicks(a).length, 2);

  // a step with no texts whose goal names the date: Drex is offered that date for the read-only field (only there),
  // and the move is one entry in the history
  const b = agent(noLLM());
  b.task = "Select 04/08/2016 as the date and hit submit.";
  const submit = { ...next, name: "Submit", text: "button 'Submit'", node: 4, box: [0, 40, 40, 60] };
  const from = { ...dateField, label: "E3", node: 5, readOnly: undefined, field: true, text: "textbox 'From:'" };
  b.look = async () => ({ ...scr, els: [dateField, submit, from] });
  const set = [];
  b.currentTab = async () => page({ setDate: async (node, date) => (set.push([node, date]), { ok: true, clicks: 9 }) });
  b.capture = async () => "after";
  b.askApproval = async () => assert.fail("setting a date asks no approval");
  const asked = [];
  b.drexCall = async (state, qs) => {
    asked.push(qs);
    const choice = asked.length === 1 ? "type date into E1" : "step done";
    const done = choice === "step done" ? 0.99 : 0.01;
    return { answers: { move: { choice, probabilities: { [choice]: 0.99 } }, done: { noul: done } }, ms: 1, usd: 0 };
  };
  const pick = { ...step, goal: "Select 04/08/2016 as the date", done_when: "The field shows 04/08/2016", texts: [] };
  assert.deepEqual(await b.browse(pick), {});
  const criteria = asked[0].move.criteria;
  assert.match(criteria["type date into E1"], /'04\/08\/2016'/);
  assert.equal(criteria["type date into E3"], undefined); // not offered on the editable field
  assert.equal(criteria["type date at the cursor"], undefined);
  assert.deepEqual(set, [[3, { y: 2016, m: 4, d: 8 }]]);
  assert.deepEqual(datePicks(b), [{ field: "E1", date: "04/08/2016", ok: true, clicks: 9 }]);
  assert.ok(b.record.some((e) => e.type === "move" && e.what === "set E1 to 04/08/2016"));
  // a step whose words name two different dates: no such move
  const c = agent(noLLM());
  c.task = "Fly out 12/03/2016 and back 12/10/2016.";
  c.look = b.look;
  const seen = [];
  c.drexCall = async (state, qs) => {
    seen.push(qs);
    return {
      answers: { move: { choice: "step done", probabilities: { "step done": 0.99 } }, done: { noul: 0.99 } },
      ms: 1,
      usd: 0,
    };
  };
  await c.browse({ ...step, goal: "Set the departure date", texts: [] });
  assert.equal(seen[0].move.criteria["type date into E1"], undefined);
});

test("selection readback uses the actual requested option and bounds mismatch recovery", async () => {
  const a = agent(noLLM());
  const el = {
    label: "E1",
    node: 11,
    role: "combobox",
    name: "Sort",
    text: "Sort",
    select: true,
    options: ["Name", "Price"],
    selectedIndex: 0,
    box: [0, 0, 100, 30],
  };
  let selections = 0;
  const tab = page({
    selectOption: async () => {
      selections++;
    },
    fieldValue: async () => ({ selectedOptions: ["Name"], selectedIndex: 0 }),
    elements: async () => ({ els: [el], off: [] }),
  });
  const action = { kind: "select", el, index: 1, value: "Price" };
  const here = { ...scr, els: [el] };
  const first = await a.act(tab, action, null, here, [], "drex", 1, "", { step });
  assert.equal(first.dispatched, true);
  assert.ok(first.replan);
  assert.match(first.why, /requested.*Price.*observed.*Name/);
  const second = await a.act(tab, action, null, here, [], "drex", 1, "", { step });
  // the same mismatch again doesn't stop the run: no second replan, the note stays for the checks
  assert.equal(second.dispatched, true);
  assert.ok(!second.replan && !second.partial);
  assert.match(a.notes.setting_mismatch, /requested.*Price.*observed.*Name/);
  assert.equal(selections, 2);
});
