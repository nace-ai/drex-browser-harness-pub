import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCost } from "../src/cost.ts";
import { compactOptions, searchField, taskForMoves } from "../src/logic.ts";
import { EvidenceContext, packEvidence } from "../src/context.ts";

const FORMAT =
  'Return exactly one JSON object with exactly these four fields:\n{"task_type":"RETRIEVE","status":"SUCCESS"}';

test("parseCost reads switches and numbers, and nothing from an empty spec", () => {
  assert.deepEqual(parseCost(""), {});
  assert.deepEqual(parseCost("noThink, cap=0.006,,drexText"), { noThink: true, cap: 0.006, drexText: true });
});

test("taskForMoves leaves out the answer format and is the same when applied twice", () => {
  const task = `Return the date I last ordered my olive bread.\n\n${FORMAT}`;
  const moves = taskForMoves(task);
  assert.match(moves, /^Return the date I last ordered my olive bread\./);
  assert.doesNotMatch(moves, /task_type/);
  assert.equal(taskForMoves(moves), moves);
  assert.equal(taskForMoves("Open the Video Game category page"), "Open the Video Game category page");
});

test("compactOptions clips context, drops icon characters and repeated off-screen names", () => {
  const out = compactOptions({
    "click E1": "Click link ' My Cart'",
    "hover E2":
      "Point at menuitem 'Electronics' (has a submenu) without clicking: opens its submenu, to choose an item in it",
    "click D1":
      "Click link 'Add to Wish List' (in \"Add to Compare; grid row 1, column 1; link 1 of 12\") (1.0 screens down) (scrolls to it first)",
    "click D2":
      "Click link 'Add to Wish List' (in \"Add to Compare; grid row 1, column 2; link 2 of 12\") (1.0 screens down) (scrolls to it first)",
    "click D3": "Click link 'Page 2' (2.6 screens down) (scrolls to it first)",
  });
  assert.equal(out["click E1"], "Click link 'My Cart'");
  assert.equal(out["hover E2"], "Hover menuitem 'Electronics' (has a submenu): opens its submenu");
  assert.ok(out["click D1"]);
  assert.equal(out["click D2"], undefined); // the same link again, one scroll away
  assert.equal(out["click D3"], "Click link 'Page 2' (2.6 screens down)");
});

test("searchField is a site's search box, not any text field", () => {
  assert.ok(searchField({ role: "combobox", name: " Search", text: "combobox ' Search'" }));
  assert.ok(searchField({ role: "searchbox", name: "q", text: "" }));
  assert.ok(!searchField({ role: "textbox", name: "Email", text: "textbox 'Email'" }));
  assert.ok(!searchField({ role: "textbox", name: "Search", text: "", multi: true }));
  // a form's field whose name only contains the letters (Enter would submit the form)
  assert.ok(!searchField({ role: "textbox", name: "Research topic", text: "textbox 'Research topic'" }));
  assert.ok(searchField({ role: "textbox", name: "Search products", text: "textbox 'Search products'" }));
});

test("packEvidence keeps every shown chunk in page order, as text, and lists what was left out", () => {
  const store = new EvidenceContext();
  const page = Array.from({ length: 30 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
  const compacted = store.compact(
    { task: "t", page: { url: "u", title: "T", text: page }, candidates: [{ label: "E1", text: "button 'Go'" }] },
    { maxBytes: 1800 },
  );
  const packed = packEvidence(compacted);
  assert.equal(packed.task, "t");
  assert.equal(packed.evidence, undefined);
  assert.equal(packed.context_catalog, undefined);
  assert.match(String(packed.candidates), /^E1; role|^E1/);
  const text = String(packed.page_text);
  const shown = [...text.matchAll(/line (\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(
    shown,
    [...shown].sort((a, b) => a - b),
  );
  assert.ok(packed.left_out);
});
