import assert from "node:assert/strict";
import { test } from "node:test";
import * as L from "../src/logic.ts";

test("wantedDateOrder: a step that sorts by date, newest or oldest first", () => {
  assert.equal(
    L.wantedDateOrder({ goal: "Sort the orders grid by Purchase Date, newest first", done_when: "" }),
    "desc",
  );
  assert.equal(L.wantedDateOrder({ goal: "Sort by date", done_when: "the most recent order is at the top" }), "desc");
  assert.equal(L.wantedDateOrder({ goal: "Order by created date ascending", done_when: "" }), "asc");
  // no sort, or a sort by something other than a date
  assert.equal(L.wantedDateOrder({ goal: "Open the most recent order", done_when: "" }), null);
  assert.equal(L.wantedDateOrder({ goal: "Sort by price, lowest first", done_when: "" }), null);
});

test("shownDateOrder: the rows' dates top to bottom", () => {
  // WebArena admin 202: one click on Purchase Date put January 2022 at the top
  const asc = [
    "000000263 Jan 11, 2022 3:12 PM Canceled",
    "000000204 Feb 2, 2022 Canceled",
    "000000300 May 23, 2023 Canceled",
  ];
  assert.equal(L.shownDateOrder(asc).order, "asc");
  assert.equal(L.shownDateOrder([...asc].reverse()).order, "desc");
  assert.equal(L.shownDateOrder(asc.slice(0, 2)), null); // too few rows to tell
  assert.equal(L.shownDateOrder(["no date here", "nor here", "nothing"]), null);
});
