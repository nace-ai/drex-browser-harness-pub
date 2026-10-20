import assert from "node:assert/strict";
import { test } from "node:test";
import * as L from "../src/logic.ts";

test("directPlan: the task as written is the one browse step, no texts, room for a whole task", () => {
  const plan = L.directPlan("Order a wonton soup on DoorDash");
  assert.equal(plan.direct, true);
  assert.equal(plan.steps.length, 1);
  const [s] = plan.steps;
  assert.equal(s.kind, "browse");
  assert.equal(s.goal, "Order a wonton soup on DoorDash");
  assert.match(s.done_when, /Order a wonton soup on DoorDash/);
  assert.deepEqual(s.texts, []);
  assert.equal(s.open_url, "");
  assert.equal(s.use_tab, -1);
  assert.equal(L.moveBudget(s), L.DIRECT_MOVES);
});

test("stateText: a direct run has no plan block, a planned run does", () => {
  const info = { title: "x", url: "u" };
  const direct = L.stateText({
    task: "find the cheapest flight",
    plan: L.directPlan("find the cheapest flight"),
    index: 0,
    texts: [],
    history: [],
    info,
  });
  assert.doesNotMatch(direct, /THE PLAN:/);
  assert.match(direct, /YOUR STEP NOW: find the cheapest flight/);
  const plan = { steps: [{ kind: "browse", goal: "open flights", done_when: "?" }] };
  assert.match(
    L.stateText({ task: "t", plan, index: 0, texts: [], history: [], info }),
    /THE PLAN:\n1\. \[NOW\] open flights/,
  );
});

test("buildOptions direct: every field gets a 'type into' move the LLM writes for, plus typing at the cursor", () => {
  const els = [
    { label: "E1", text: "combobox 'Where to?'", state: "", box: [0, 0, 10, 10], field: true },
    { label: "E2", text: "button 'Search'", state: "", box: [0, 0, 10, 10] },
  ];
  const { acts, opts } = L.buildOptions({ els, direct: true });
  assert.equal(acts["type into E1"].kind, "write");
  assert.match(opts["type into E1"], /written for you/);
  assert.equal(acts["click E1"].kind, "click");
  assert.ok(!("type into E2" in acts));
  assert.equal(acts["type at the cursor"].kind, "write_cursor");
  assert.doesNotMatch(opts["ask for help"], /type text/);
  assert.equal(L.whatOf(acts["type into E1"]), "typed into combobox 'Where to?'");
  // without direct (a planned run with no texts) there is no typing move at all
  assert.ok(!("type into E1" in L.buildOptions({ els }).acts));
  assert.match(L.buildOptions({ els }).opts["ask for help"], /type text you were not given/);
});

test("buildOptions direct: a text the helper typed earlier is offered as well, without a second 'type into' kind", () => {
  const els = [{ label: "E1", text: "textbox 'Phone'", state: "", box: [0, 0, 10, 10], field: true }];
  const texts = ["a", "b", "c", "d", "e"].map((n) => ({ name: n, text: n }));
  assert.equal(L.buildOptions({ els, texts, direct: true }).acts["type into E1"].kind, "write");
  assert.equal(L.buildOptions({ els, texts: texts.slice(0, 1), direct: true }).acts["type a into E1"].kind, "type");
});

test("isStepDone strict (no plan): a borderline whole-task check does not end the run while Drex moves on", () => {
  assert.equal(L.isStepDone(0.678, "click E22", 0.508, true), false); // DoorDash: burger in the cart, Drex picks Continue
  assert.equal(L.isStepDone(0.678, "click E22", 0.508), true); // ...which the planned-step rule ends
  assert.equal(L.isStepDone(0.717, "click D1", 0.691, true), false); // Google Flights booking options
  assert.equal(L.isStepDone(0.9, "click D1", 0.95, true), true); // a sure check still ends it
  assert.equal(L.isStepDone(0.65, "step done", 0.8, true), true); // Drex itself says done
  assert.equal(L.isStepDone(0.3, "step done", 0.8, true), false);
});

test("direct: Drex can ask the LLM whether the task is finished, and is told to before stopping", () => {
  const els = [{ label: "E1", text: "button 'Continue'", state: "", box: [0, 0, 10, 10] }];
  const d = L.buildOptions({ els, direct: true });
  assert.equal(d.acts["ask if finished"].kind, "check_done");
  assert.match(d.opts["step done"], /plainly shows the final result/);
  assert.match(d.opts["ask for help"], /anything you are unsure about/);
  assert.ok(!("ask if finished" in L.buildOptions({ els }).acts));
  const s = L.stateText({
    task: "order a burger",
    plan: L.directPlan("order a burger"),
    index: 0,
    texts: [],
    history: [],
    info: { title: "x", url: "u" },
  });
  assert.match(s, /NO PLAN: .*choose 'ask if finished' unless the screen plainly shows the final result/);
  assert.match(L.MOVE_Q_DIRECT, /'ask if finished'/);
  // a paused circle never leaves only the meta options
  const paused = new Set([L.whatOf(d.acts["click E1"])]);
  assert.ok(
    "click E1" in L.withoutMoves(d, paused).acts ||
      !Object.values(L.withoutMoves(d, paused).acts).every((a) =>
        ["check_done", "step_done", "stuck", "ask_user", "wait"].includes(a.kind),
      ),
  );
});

test("stateText: a move the helper made shows its reason in Drex's history", () => {
  const history = [
    {
      what: "clicked button 'Back to store'",
      changed: true,
      note: "The burger is missing from the cart; add a burger first.",
    },
  ];
  const s = L.stateText({
    task: "t",
    plan: L.directPlan("t"),
    index: 0,
    texts: [],
    history,
    info: { title: "x", url: "u" },
  });
  assert.match(
    s,
    /1\. clicked button 'Back to store' \(the helper made this move: The burger is missing from the cart; add a burger first\.\)/,
  );
});
