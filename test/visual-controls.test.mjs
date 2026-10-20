// Controls the MiniWoB visual tasks exposed: menu items that open a submenu on hover, click targets known only by
// a registered listener, and fill assignments that must name a supplied field.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Tab } from "../src/cdp.ts";
import { LLM } from "../src/llm.ts";
import * as L from "../src/logic.ts";
import { streamed } from "./stream-fake.mjs";

const el = (label, text, extra = {}) => ({ label, text, state: "", box: [0, 0, 10, 10], ...extra });

test("a menu item with a closed submenu can be pointed at, not only clicked; other controls get no hover", () => {
  const { opts, acts } = L.buildOptions({
    els: [
      el("E2", "menuitem 'Jinny'", { role: "menuitem", name: "Jinny", submenu: true, state: " (has a submenu)" }),
      el("E3", "menuitem 'Olwen'", { role: "menuitem", name: "Olwen" }),
      el("E4", "button 'Submit'", { role: "button", name: "Submit" }),
    ],
  });
  assert.equal(acts["hover E2"].kind, "hover");
  assert.match(opts["hover E2"], /without clicking: opens its submenu/);
  assert.equal(acts["click E2"].kind, "click"); // a click stays possible: some menus open on click
  assert.equal(acts["hover E3"], undefined);
  assert.equal(acts["hover E4"], undefined);
  // pointing changes nothing that needs approval or a readiness check, and Drex's history says what it did
  assert.equal(L.isRisky(acts["hover E2"]), false);
  assert.equal(L.isRiskyGesture(acts["hover E2"]), false);
  assert.equal(L.whatOf(acts["hover E2"]), "pointed at menuitem 'Jinny' (has a submenu)");
});

test("right after a hover, only Drex's own 'step done' ends the step, not a sure screen check", () => {
  // MiniWoB click-menu: Jinny's submenu open, the check 90% sure "Jinny>Lynett is selected", Drex 91% on Lynett
  assert.equal(L.isStepDone(0.897, "click E6", 0.906, false, true), false);
  assert.equal(L.isStepDone(0.897, "click E6", 0.906, false, false), true); // after any other move: unchanged
  assert.equal(L.isStepDone(0.7, "step done", 0.9, false, true), true);
  assert.equal(L.isStepDone(0.95, "click E6", 0.5, true, true), false); // also with no plan
});

test("Tab.hover moves the mouse there and presses nothing", async () => {
  const tab = new Tab(7);
  tab.overlay = false;
  const sent = [];
  tab.send = async (method, params = {}) => {
    sent.push([method, params.type, params.x, params.y]);
    return {};
  };
  await tab.hover(31, 115);
  assert.deepEqual(sent, [["Input.dispatchMouseEvent", "mouseMoved", 31, 115]]);
});

test("Tab.clickListener asks DOMDebugger for event types, counts only click-like ones, and remembers the answer", async () => {
  const tab = new Tab(7);
  const asked = [];
  const listeners = { tile: ["click"], text: ["mouseover", "focus"], touch: ["touchstart"] };
  tab.send = async (method, params) => {
    asked.push(params.objectId);
    assert.equal(method, "DOMDebugger.getEventListeners");
    if (params.objectId === "gone") throw new Error("Could not find node with given id");
    return { listeners: listeners[params.objectId].map((type) => ({ type, useCapture: false })) };
  };
  assert.equal(await tab.clickListener(1, "tile"), true);
  assert.equal(await tab.clickListener(2, "text"), false); // a hover-only listener doesn't make it a click target
  assert.equal(await tab.clickListener(3, "touch"), true);
  assert.equal(await tab.clickListener(4, "gone"), false); // a node that went away is not a target
  assert.equal(await tab.clickListener(1, "tile"), true);
  assert.deepEqual(asked, ["tile", "text", "touch", "gone"]); // node 1 was answered from the cache
});

test("fill's assignments can name only the fields it was given", async () => {
  const llm = streamed(
    new LLM({
      key: "fixture",
      runOptions: { efficiency: { contextBudget: false, promptCache: false, cheapCollection: false } },
    }),
  );
  llm.client.messages.countTokens = async () => ({ input_tokens: 100 });
  let body;
  llm.client.messages.create = async (b) => {
    body = b;
    return {
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            why: "the table says Female",
            fields: [
              { label: "E2", desired_value: "Female", source_kind: "evidence_note", source_evidence: "gender_value" },
            ],
            unresolved: [],
          }),
        },
      ],
    };
  };
  const r = await llm.fill({
    task: "Enter the value of Gender into the text field and press Submit.",
    step: { kind: "fill", goal: "Enter the recorded Gender value", texts: [{ name: "text field", text: "Female" }] },
    notes: { gender_value: "Female" },
    info: { title: "Read Table", url: "http://wob.test/read-table.html", text: "Gender Female" },
    image: "data:image/png;base64,aW1hZ2U=",
    fields: [
      { label: "E2", role: "textbox" },
      { label: "E2", role: "textbox" },
    ],
  });
  assert.equal(r.json.fields[0].label, "E2");
  const sent = JSON.stringify(body);
  assert.ok(sent.includes('"label":{"type":"string","enum":["E2"]}'), "the label is an enum of the supplied labels");
});
