import assert from "node:assert/strict";
import { test } from "node:test";
import * as L from "../src/logic.ts";

// The answer format a WebArena-Verified task carries (the eval appends it to the intent).
const FORMAT =
  'Return exactly one JSON object with exactly these four fields:\n{"task_type":"RETRIEVE"|"MUTATE"|"NAVIGATE","status":"SUCCESS"|"NOT_FOUND_ERROR","retrieved_data":array|null,"error_details":string|null}.';
const TASK = `Tell me the usernames of the top commenters.\n\n${FORMAT}`;

test("requiredFields reads the fields a task spells out, and none when it only says JSON", () => {
  assert.deepEqual(L.requiredFields(TASK), ["task_type", "status", "retrieved_data", "error_details"]);
  assert.deepEqual(L.requiredFields("Answer as one JSON object"), []);
  assert.deepEqual(L.requiredFields("Write the package.json for this project"), []);
});

test("inFormat accepts only the spelled-out object, not the right data in another shape", () => {
  const ok =
    '{"task_type":"RETRIEVE","status":"SUCCESS","retrieved_data":[{"username":"Hammer94"}],"error_details":null}';
  assert.ok(L.inFormat(ok, TASK));
  // WebArena reddit 27-31: the values were right, the shape was not, and the grader read neither
  assert.ok(!L.inFormat('[{"username":"Hammer94","count":0}]', TASK));
  assert.ok(!L.inFormat(`[${ok}]`, TASK));
  assert.ok(!L.inFormat('{"order_count":0,"amount":0}', TASK));
  assert.ok(!L.inFormat("The top commenter is Hammer94.", TASK));
  // a task that only asks for JSON keeps the old rule: any object or array
  assert.ok(L.inFormat('[{"a":1}]', "Find the price. Answer as one JSON object"));
});

test("isRisky lets a submenu, a search's count or chip, and mail 'by post' through", () => {
  const click = (name, extra = {}) => ({ kind: "click", el: { name, text: `button '${name}'`, ...extra } });
  // a navigation menu item that only opens its submenu (USPS's "Send")
  assert.ok(!L.isRisky(click("Send", { role: "menuitem", submenu: true })));
  assert.ok(L.isRisky(click("Send", { role: "menuitem" })));
  assert.ok(!L.isRisky(click("Remove guests")));
  assert.ok(!L.isRisky(click("Remove location: Seattle")));
  assert.ok(!L.isRisky(click("Claim by post")));
  // the acts themselves still ask
  assert.ok(L.isRisky(click("Remove item")));
  assert.ok(L.isRisky(click("Post")));
  assert.ok(L.isRisky(click("Delete account")));
});
