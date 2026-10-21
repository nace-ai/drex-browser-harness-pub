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
  // an example the task quotes, input data, or the shape of each item of a list is not the answer's own shape
  assert.deepEqual(
    L.requiredFields(
      'The site returns a JSON object. For example the API gave {"id": 1, "price": 2}. What is the price?',
    ),
    [],
  );
  assert.deepEqual(L.requiredFields('Fill the form with this JSON object {"name": "Tom", "email": "t@x.io"}'), []);
  assert.deepEqual(
    L.requiredFields('Return a list of the products, each a JSON object {"name": "...", "price": 0}'),
    [],
  );
  assert.deepEqual(L.requiredFields('Answer with one JSON object {"name": "...", "price": 0}'), ["name", "price"]);
  // list wording after the object
  assert.deepEqual(L.requiredFields('Return one JSON object per order: {"id": 1, "total": 2}'), []);
  assert.deepEqual(
    L.requiredFields('Return a JSON object {"name": "...", "price": 0} for each of the three cheapest products.'),
    [],
  );
  assert.deepEqual(L.requiredFields('Return JSON objects, one for each product: {"name": "...", "price": 0}'), []);
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
  // a field the object inherits is not one it has
  assert.ok(!L.inFormat("{}", 'Return one JSON object {"constructor": 1, "toString": 2}'));
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
  assert.ok(!L.isRisky(click("Remove guests: 2")));
  assert.ok(!L.isRisky(click("Claim by post")));
  // the acts themselves still ask: one named record removed, or a send by post
  assert.ok(L.isRisky(click("Remove guest")));
  assert.ok(L.isRisky(click("Remove tag")));
  assert.ok(L.isRisky(click("Remove guest: Jane Doe")));
  assert.ok(L.isRisky(click("Remove tag: urgent")));
  assert.ok(L.isRisky(click("Remove passenger: John Smith")));
  assert.ok(L.isRisky(click("Remove room")));
  assert.ok(L.isRisky(click("Remove passenger")));
  assert.ok(L.isRisky(click("Remove guests and pay")));
  assert.ok(L.isRisky(click("Send by post")));
  assert.ok(L.isRisky(click("Remove item")));
  assert.ok(L.isRisky(click("Post")));
  assert.ok(L.isRisky(click("Delete account")));
});
