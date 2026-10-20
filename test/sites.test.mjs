import assert from "node:assert/strict";
import { test } from "node:test";
import { siteFor, sitesForTask } from "../src/sites.ts";

const SITES = [
  { key: "gmail", name: "Gmail", url_prefixes: ["mail.google.com"], names: ["gmail", "google mail"] },
  {
    key: "google-sheets",
    name: "Google Sheets",
    url_prefixes: ["docs.google.com/spreadsheets"],
    names: ["google sheets"],
  },
  { key: "docs", name: "Google Docs", url_prefixes: ["docs.google.com"], names: ["google docs"] },
  { key: "x", name: "X", url_prefixes: ["x.com"], names: ["x", "twitter"] },
];

test("siteFor picks the longest matching URL prefix", () => {
  assert.equal(siteFor(SITES, "https://docs.google.com/spreadsheets/d/1/edit").key, "google-sheets");
  assert.equal(siteFor(SITES, "https://docs.google.com/document/d/1/edit").key, "docs");
  assert.equal(siteFor(SITES, "https://mail.google.com/mail/u/0/#inbox").key, "gmail");
  assert.equal(siteFor(SITES, "https://www.x.com/home").key, "x");
  assert.equal(siteFor(SITES, "https://box.com/"), null);
  assert.equal(siteFor(SITES, "not a url"), null);
});

test("sitesForTask matches whole words in the task and open tabs", () => {
  assert.deepEqual(
    sitesForTask(SITES, "Sort my Gmail inbox", []).map((s) => s.key),
    ["gmail"],
  );
  assert.deepEqual(
    sitesForTask(SITES, "Post this on Twitter", []).map((s) => s.key),
    ["x"],
  );
  assert.deepEqual(
    sitesForTask(SITES, "Fix the max value in xls", []).map((s) => s.key),
    [],
  );
  assert.deepEqual(
    sitesForTask(SITES, "summarize this", ["https://docs.google.com/document/d/9"]).map((s) => s.key),
    ["docs"],
  );
});
