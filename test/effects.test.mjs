import assert from "node:assert/strict";
import { test } from "node:test";
import * as L from "../src/logic.ts";

const page = (o = {}) => ({ dialogs: [], notes: [], url: "https://food.example/store/steam", title: "Steam", ...o });

test("effectOf names what a move opened, closed or announced, and where it went", () => {
  assert.equal(L.effectOf(page(), page({ dialogs: ["Review details"] })), `opened "Review details"`);
  assert.equal(L.effectOf(page({ dialogs: ["Your cart"] }), page()), `closed "Your cart"`);
  assert.equal(L.effectOf(page(), page({ notes: ["Item Added!"] })), `notice "Item Added!"`);
  assert.equal(
    L.effectOf(page(), page({ url: "https://food.example/checkout", title: "Checkout" })),
    "went to food.example/checkout",
  );
  assert.equal(L.effectOf(page({ notes: ["Item Added!"] }), page({ notes: ["Item Added!"] })), ""); // still showing: not new
  assert.equal(L.effectOf(null, page({ dialogs: ["x"] })), "");
});

test("the history shows each move's effect to Drex", () => {
  const plan = { steps: [{ kind: "browse", goal: "Add a soup and a drink", done_when: "d" }] };
  const s = L.stateText({
    task: "t",
    plan,
    index: 0,
    texts: [],
    info: { title: "x", url: "u" },
    history: [
      { what: "scrolled to and clicked button 'Wonton Soup'", changed: true, effect: `opened "Review details"` },
    ],
  });
  assert.match(s, /clicked button 'Wonton Soup' -> opened "Review details"/);
});

test("applyReplan replaces only the current step; later steps stay", () => {
  const steps = ["address", "cart", "checkout on Tuesday"].map((goal) => ({ goal }));
  const out = L.applyReplan(steps, 1, [{ goal: "search soup" }, { goal: "add soup" }]);
  assert.deepEqual(
    out.map((s) => s.goal),
    ["address", "search soup", "add soup", "checkout on Tuesday"],
  );
  assert.deepEqual(
    steps.map((s) => s.goal),
    ["address", "cart", "checkout on Tuesday"],
  ); // not changed in place
});
