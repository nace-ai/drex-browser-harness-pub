import assert from "node:assert/strict";
import { test } from "node:test";
import * as L from "../src/logic.ts";

const STATES = ["Please select a region, state or province.", "Alabama", "Georgia", "New York", "York", "Texas"];
const longSelect = (extra = {}) => ({
  label: "E4",
  role: "combobox",
  name: "State/Province",
  text: "combobox 'State/Province'",
  node: 4,
  box: [0, 0, 100, 20],
  select: true,
  options: STATES,
  selectedIndex: 0,
  longList: true,
  ...extra,
});

test("namedOptions: a long list's options the step or task names, as whole words, longest first", () => {
  // WebArena shopping 573: the state list held more than 30 options and showed Drex none of them
  assert.deepEqual([...L.namedOptions(STATES, "Set the address to 111 Magnolia Path, Atlanta, Georgia 30303")], [2]);
  assert.deepEqual([...L.namedOptions(STATES, "Ship it to New York")], [3, 4]); // "New York" before "York"
  assert.deepEqual([...L.namedOptions(STATES, "Pick a state")], []);
  assert.deepEqual([...L.namedOptions(STATES, "texas")], [5]); // case aside
  assert.deepEqual([...L.namedOptions(["Georgia (US)", "Georgia"], "Georgia")], [1]); // whole words only
});

test("buildOptions: a long list offers only the named options; a short one offers them all", () => {
  const moves = (els, wanted) =>
    Object.keys(L.buildOptions({ els, wanted }).acts).filter((k) => k.startsWith("choose"));
  assert.deepEqual(moves([longSelect()], "Move to Atlanta, Georgia"), ["choose 'Georgia' in E4"]);
  assert.deepEqual(moves([longSelect()], "Update my address"), []);
  const short = longSelect({ longList: undefined, options: ["Small", "Medium", "Large"] });
  assert.deepEqual(moves([short], ""), ["choose 'Medium' in E4", "choose 'Large' in E4"]);
  const act = L.buildOptions({ els: [longSelect()], wanted: "Georgia" }).acts["choose 'Georgia' in E4"];
  assert.deepEqual([act.kind, act.index, act.value], ["select", 2, "Georgia"]);
});
