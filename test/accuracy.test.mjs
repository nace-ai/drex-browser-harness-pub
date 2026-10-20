import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionNote, collectionNoteRefs, jsonObject, withNoteValue } from "../src/logic.ts";
import { recordFrom } from "../src/macros.ts";

// a collectLite note as WebArena 587 saved it: the order that holds the item, with no item name
const ORDER_NOTE = JSON.stringify({
  read_by: "Drex judged each row against the task's conditions and screened the records it opened",
  order: "the list runs by date desc; the first match is the answer",
  answer: { source: "http://shop/sales/order/view/order_id/180/", row: "000000180 3/11/23 $65.32 Complete" },
  matches: [{ source: "http://shop/sales/order/view/order_id/180/", row: "000000180 3/11/23 $65.32 Complete" }],
});

test("collectionNote reads a list reading's JSON and nothing else", () => {
  assert.ok(collectionNote(ORDER_NOTE));
  assert.ok(collectionNote(JSON.stringify({ answer: { source_id: "x", fact: "FIRST QUALIFIED" } })));
  assert.equal(collectionNote("Jiffy Corn Muffin Cornbread Mix"), null);
  assert.equal(collectionNote('{"task_type":"MUTATE","status":"SUCCESS"}'), null);
  assert.equal(collectionNote("{not json"), null);
});

test("a step that types or names a list's note is found; plain notes and unnamed notes are not", () => {
  const notes = { ps3_item: ORDER_NOTE, nickname: "GamingEmma", other_list: ORDER_NOTE };
  const typed = { goal: "Search the site for the product", texts: [{ name: "search", text: "{{ps3_item}}" }] };
  assert.deepEqual(collectionNoteRefs(typed, notes), ["ps3_item"]);
  const named = { goal: "Open the best-fitting option from ps3_item.", texts: [] };
  assert.deepEqual(collectionNoteRefs(named, notes), ["ps3_item"]);
  const plain = { goal: "Type {{nickname}} into the form", texts: [{ name: "n", text: "{{nickname}}" }] };
  assert.deepEqual(collectionNoteRefs(plain, notes), []);
  // a name inside another word is not a reference
  assert.deepEqual(collectionNoteRefs({ goal: "Open ps3_items_page", texts: [] }, notes), []);
});

test("withNoteValue types the value, names it in the goal, and never types the JSON", () => {
  const step = {
    goal: "Search the site for the exact product name {{ps3_item}} and open it",
    done_when: "The page of {{ps3_item}} is open",
    rules: "",
    texts: [
      { name: "search", text: "{{ps3_item}}" },
      { name: "nickname", text: "GamingEmma" },
    ],
  };
  const filled = withNoteValue(step, ["ps3_item"], "Sony PS3 Controller");
  assert.equal(filled.goal, "Search the site for the exact product name Sony PS3 Controller and open it");
  assert.equal(filled.done_when, "The page of Sony PS3 Controller is open");
  assert.deepEqual(filled.texts, [
    { name: "search", text: "Sony PS3 Controller" },
    { name: "nickname", text: "GamingEmma" },
  ]);
  const named = withNoteValue(
    { goal: "Open the best one from fits (closest to 23 cards)", texts: [] },
    ["fits"],
    "HEIYING Case",
  );
  assert.equal(named.goal, 'Open the best one from fits ("HEIYING Case") (closest to 23 cards)');
  // no value: the text that would carry the JSON is dropped, the rest stays
  const empty = withNoteValue(step, ["ps3_item"], "");
  assert.deepEqual(empty.texts, [{ name: "nickname", text: "GamingEmma" }]);
});

test("recordFrom keeps a record's own lines from its identifier on, not the site's menus", () => {
  const page = `My Account Sign Out ${"Menu ".repeat(200)} Order # 000000180 Complete Items Ordered Jiffy Corn Muffin Cornbread Mix $6.99`;
  const kept = recordFrom(page, "000000180 3/11/23 $65.32 Complete View Order", 80);
  assert.match(kept, /^000000180 Complete Items Ordered Jiffy Corn Muffin/);
  // no identifier in the row: the start of the page
  assert.equal(recordFrom("a  b c", "Complete", 3), "a b");
});

test("jsonObject finds the object inside a sentence and nothing in prose", () => {
  assert.equal(
    jsonObject('Here it is: {"task_type":"MUTATE","status":"SUCCESS"} done.'),
    '{"task_type":"MUTATE","status":"SUCCESS"}',
  );
  assert.equal(jsonObject("Your review was submitted and is awaiting moderation.}"), "");
  assert.equal(jsonObject("Status: NOT_FOUND. The page was reached."), "");
});
