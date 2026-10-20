import assert from "node:assert/strict";
import { test } from "node:test";
import * as L from "../src/logic.ts";

const step = {
  kind: "batch",
  goal: "Report the spam in the inbox",
  question: "Is this email spam?",
  choices: [
    { name: "spam", description: "a scam or unwanted bulk mail", action: "Report it as spam" },
    { name: "keep", description: "anything real", action: "" },
  ],
  rules: "spam: scams. keep: people.",
};

test("chunks hold at most 16 items (Drex takes at most 16 questions per call)", () => {
  const sizes = L.chunks(Array.from({ length: 50 }, (_, i) => i)).map((c) => c.length);
  assert.deepEqual(sizes, [16, 16, 16, 2]);
  assert.deepEqual(L.chunks([]), []);
});

test("itemQuestions: one choice question per item, quoting its text, with the step's choices", () => {
  const qs = L.itemQuestions(step, [{ text: "DoorDash Craving something?" }, { text: "Mom Sunday dinner?" }]);
  assert.deepEqual(Object.keys(qs), ["I1", "I2"]);
  assert.equal(qs.I1.type, "choice");
  assert.match(qs.I1.instructions, /"DoorDash Craving something\?"/);
  assert.match(qs.I1.instructions, /Is this email spam\?/);
  assert.deepEqual(Object.keys(qs.I2.criteria), ["spam", "keep"]);
});

test("batchState carries the task, question, answers with their actions, and rules", () => {
  const s = L.batchState({ task: "sort my inbox", step, info: { title: "Inbox", url: "https://mail.example/" } });
  assert.match(s, /THE QUESTION FOR EACH ITEM: Is this email spam\?/);
  assert.match(s, /- spam: a scam or unwanted bulk mail \(then: Report it as spam\)/);
  assert.match(s, /- keep: anything real \(then: leave it as it is\)/);
  assert.match(s, /RULES:\nspam: scams/);
});

test("batchSummary lists how many items got each answer", () => {
  const s = L.batchSummary(step, { spam: ["A", "B"], keep: ["C"] });
  assert.match(s, /^spam \(2\): A; B/m);
  assert.match(s, /^keep \(1\): C/m);
});
