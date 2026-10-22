import { test } from "node:test";
import assert from "node:assert/strict";
import { LLM } from "../src/llm.ts";
import { RunBudget } from "../src/run-budget.ts";
import { streamed } from "./stream-fake.mjs";
const reply = (json) => ({
  model: "claude-haiku-5-5",
  stop_reason: "end_turn",
  usage: { input_tokens: 900, output_tokens: 120 },
  content: [{ type: "text", text: JSON.stringify(json) }],
});
const task =
  'Return the date I last ordered my olive bread. Return exactly one JSON object {"status":"SUCCESS"|"NOT_FOUND_ERROR","retrieved_data":array|null}.';
const answer = '{"status":"SUCCESS","retrieved_data":["2022-12-12"]}';
function setup() {
  const llm = streamed(new LLM({ key: "fixture" })); // the default efficiency: compaction and retrieval on
  llm.client.messages.countTokens = async (body) => ({ input_tokens: Math.ceil(JSON.stringify(body).length / 4) });
  return llm;
}
test("the run's own final answer is one bounded request in the task's format, paid from the held reserve", async () => {
  const llm = setup();
  llm.runBudget = new RunBudget({ maxHaikuCalls: 3 });
  llm.runBudget.hold(llm.finalAnswerHold());
  // ordinary work used every call and nearly all the cost the hold doesn't keep back
  for (let i = 0; i < 2; i++)
    llm.runBudget.settle(llm.runBudget.reserve({ provider: "anthropic", maxCostUsd: 0 }), { usd: 0 });
  const rest = llm.runBudget.limits.maxCostUsd - llm.runBudget.heldUsd - 1e-6;
  const spend = llm.runBudget.reserve({ provider: "drex", maxCostUsd: rest });
  llm.runBudget.settle(spend, { usd: rest });
  assert.throws(() => llm.runBudget.reserve({ provider: "anthropic", maxCostUsd: 0 }), /physical-call/);
  const sent = [];
  llm.client.messages.create = async (body) => {
    sent.push(body);
    return reply({ evidence: "Order #000000162, 12/12/22, holds Bread Batard Olive", supported: true, answer });
  };
  // notes far larger than the request's target: compacted, never fetched in extra rounds
  const notes = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [`order${i}`, `Order #0000001${i} placed ${i}/1/23: Kosher meal, coat rack`]),
  );
  notes.order162 = "Order #000000162 placed 12/12/22: Whole Foods Market Bread Batard Olive";
  assert.equal(llm.runBudget.release(), true);
  const r = await llm.finalAnswer({ task, reason: "partial: Run Haiku physical-call limit reached", notes });
  assert.equal(r.json.answer, answer);
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0].messages), /Bread Batard Olive/); // the fact the task asks about is kept
  assert.ok(sent[0].max_tokens <= 1500);
  assert.equal(sent[0].output_config.format.schema.properties.context_requests, undefined); // no retrieval rounds
  assert.equal(llm.runBudget.calls.anthropic, 3);
});
test("a final answer cut off at its output limit is refused, not retried", async () => {
  const llm = setup();
  let sent = 0;
  llm.client.messages.create = async () => {
    sent++;
    return { ...reply({ evidence: "", supported: false, answer: "" }), stop_reason: "max_tokens" };
  };
  await assert.rejects(llm.finalAnswer({ task, reason: "failed: gave up", notes: {} }), /truncated/);
  assert.equal(sent, 1);
});
// test_final_prompt_carries_confirmed_changes
test("the final answer and the final read get the run's confirmed changes and the rule for reporting them", async () => {
  const rule =
    "a change in confirmed_changes is reported with the success status; a change in rejected_changes with the failure status";
  const llm = setup();
  const sent = [];
  llm.client.messages.create = async (body) => {
    sent.push(body);
    return reply({ evidence: "Rule saved", supported: true, answer });
  };
  const change = { step: "Save the rule", move: "clicked button 'Save'", requests: ["POST /rule/save 302"] };
  const notes = { confirmed_changes: JSON.stringify([{ ...change, notices: ["You saved the rule."] }]) };
  await llm.finalAnswer({ task, reason: "partial: Run time limit reached", notes });
  assert.ok(JSON.stringify(sent[0].system).includes(rule));
  assert.match(JSON.stringify(sent[0].messages), /confirmed_changes.*POST \/rule\/save 302/);
  const page = {
    title: "Rules",
    url: "http://shop.test/rules",
    text: "You saved the rule.",
    truncated: false,
    chars: 19,
  };
  const read = { kind: "read", goal: "Report the result", save_as: "final_task_answer" };
  llm.client.messages.create = async (body) => {
    sent.push(body);
    return reply({ complete: true, evidence: "Rule saved", text: answer, next_steps: [] });
  };
  await llm.read({ task, planText: "", step: read, notes, info: page, image: "", finalRead: true });
  assert.ok(JSON.stringify(sent[1].system).includes(rule));
  assert.match(JSON.stringify(sent[1].messages), /confirmed_changes/);
  // a run that recorded no change is asked as before: no rule about notes it doesn't have
  await llm.finalAnswer({ task, reason: "partial: Run time limit reached", notes: { price: "17.25" } });
  assert.ok(!JSON.stringify(sent[2].system).includes(rule));
});
