import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOptions } from "../src/logic.ts";
test("pagination exposes direct URL moves for visible and offscreen public links", () => {
  const visible = {
    label: "E2",
    name: "2",
    text: "link '2'",
    role: "link",
    box: [0, 0, 20, 20],
    paginationURL: "http://owned.test/list?p=2",
    paginationLabel: "Page 2",
  };
  const off = { ...visible, label: "D1", paginationURL: "http://owned.test/list?p=3", paginationLabel: "Page 3" };
  const { opts, acts } = buildOptions({ els: [visible], off: [off] });
  assert.equal(acts["open page E2"].kind, "navigate_page");
  assert.equal(acts["open page E2"].url, visible.paginationURL);
  assert.equal(acts["open page D1"].url, off.paginationURL);
  assert.match(opts["open page D1"], /Page 3/);
  const normal = buildOptions({ els: [{ ...visible, paginationURL: "" }] });
  assert.equal(normal.acts["open page E2"], undefined);
  assert.equal(normal.acts["click E2"].kind, "click");
});
