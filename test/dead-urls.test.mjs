import assert from "node:assert/strict";
import { test } from "node:test";
import * as L from "../src/logic.ts";

test("deadPage: a page whose title or opening text says 404 or page not found", () => {
  // WebArena admin 710: the planner's /admin/reports/report_shipping/ showed Magento's "404 Error Page not found"
  assert.ok(L.deadPage({ title: "404 Not Found", text: "" }));
  assert.ok(L.deadPage({ title: "Magento Admin", text: "Dashboard\n404 Error\nPage not found." }));
  assert.ok(L.deadPage({ title: "Oops", text: "Sorry, this page doesn't exist." }));
  assert.ok(!L.deadPage({ title: "Search results", text: "No results for Don_Gato1" }));
  // a 404 deep in a long page (an order number, a product code) is not the page saying it is missing
  assert.ok(!L.deadPage({ title: "Orders", text: `${"order row ".repeat(80)} #000000404 Pending` }));
});

test("guessedUrl: an address neither in the user's tabs nor in the task's text", () => {
  const tabs = ["http://127.0.0.1:19014/", "http://shop.test/admin/dashboard/"];
  assert.ok(L.guessedUrl("http://127.0.0.1:19014/u/Don_Gato1", "Upvote Don_Gato1's nyc post", tabs));
  assert.ok(!L.guessedUrl("http://127.0.0.1:19014/", "Upvote the post", tabs)); // the user's own tab
  assert.ok(!L.guessedUrl("http://shop.test/admin/dashboard", "Open the report", tabs)); // same page, no slash
  assert.ok(!L.guessedUrl("https://example.com/docs/a", "Read https://example.com/docs/a and summarise", [])); // the task names it
  assert.ok(!L.guessedUrl("", "anything", tabs));
  assert.ok(!L.guessedUrl("about:blank", "anything", tabs));
});
