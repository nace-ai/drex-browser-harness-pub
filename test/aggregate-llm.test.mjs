import { test } from "node:test";
import assert from "node:assert/strict";
import { ACC, COMPUTED_RULE } from "../src/accuracy.ts";
import { COST } from "../src/cost.ts";
import { LLM } from "../src/llm.ts";
import { hasComputed } from "../src/logic.ts";
import { streamed } from "./stream-fake.mjs";

const reply = (json) => ({
  model: "claude-haiku-5-5",
  stop_reason: "end_turn",
  usage: { input_tokens: 900, output_tokens: 120 },
  content: [{ type: "text", text: JSON.stringify(json) }],
});
// An LLM whose provider answers every request with json. sent holds what the provider received; calls holds what the
// request methods passed to call(), whose purpose and content the provider's request does not carry.
function setup(json) {
  const llm = streamed(new LLM({ key: "fixture" })); // the default efficiency: compaction and retrieval on
  llm.client.messages.countTokens = async (body) => ({ input_tokens: Math.ceil(JSON.stringify(body).length / 4) });
  const sent = [];
  llm.client.messages.create = async (body) => {
    sent.push(structuredClone(body));
    return reply(json);
  };
  const calls = [];
  const call = llm.call.bind(llm);
  llm.call = (args) => {
    calls.push(args);
    return call(args);
  };
  return { llm, sent, calls };
}
const systemText = (body) =>
  typeof body.system === "string" ? body.system : body.system.map((block) => block.text).join("\n");
const decode = (body) => JSON.parse(body.messages[0].content.find((block) => block.type === "text").text);
const noImage = (body) => body.messages.every((m) => m.content.every((block) => block.type !== "image"));
// the provider takes a schema whose every property is required and that allows nothing else
const strict = (schema) => {
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  assert.equal(schema.additionalProperties, false);
};

const task =
  'How many reviews of the Zoe Bag are 4 or 5 stars? Return exactly one JSON object {"status":"SUCCESS"|"NOT_FOUND_ERROR","retrieved_data":array|null}.';
const contract = {
  intent: "enumerate_all",
  constraints: ["rated 4 or 5 stars"],
  objective: "",
  objective_field: "",
  scope: "the reviews of the Zoe Bag",
  sort_direction: "none",
  ranked_count: 0,
};
const headers = ["author", "date", "stars", "review", "text"];
const sample = [
  "Amanda Jun 5, 2023 5 stars Love the bag",
  "Marcus Jun 7, 2023 2 stars The strap broke in a week",
  "Ines Jun 9, 2023 4 stars Roomy, and the zip is smooth",
];
const spec = {
  op: "count",
  field: "",
  filters: [{ field: "stars", op: "gte", value: "4" }],
  group_by: "",
  output: "",
  order: "none",
  limit: 0,
  semantic_constraints: [],
};

test("aggregationSpec is one text-only collect request whose field names are the list's headers", async () => {
  const { llm, sent, calls } = setup(spec);
  const r = await llm.aggregationSpec({ task, contract, headers, sample });
  assert.deepEqual(r.json, spec);
  assert.equal(sent.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].purpose, "collect");
  assert.equal(typeof calls[0].content, "string"); // no screenshot: the rows' text is the evidence
  assert.ok(noImage(sent[0]));
  const { properties } = sent[0].output_config.format.schema;
  assert.deepEqual(properties.op.enum, [
    "none",
    "count",
    "sum",
    "avg",
    "min",
    "max",
    "list",
    "top",
    "argmax",
    "argmin",
  ]);
  for (const name of ["field", "group_by", "output"]) assert.deepEqual(properties[name].enum, ["", ...headers]);
  assert.deepEqual(properties.filters.items.properties.op.enum, ["eq", "neq", "contains", "gte", "lte", "between"]);
  assert.deepEqual(properties.order.enum, ["asc", "desc", "none"]);
  assert.equal(properties.limit.type, "integer");
  assert.equal(properties.semantic_constraints.items.type, "string");
  strict(calls[0].schema);
  strict(calls[0].schema.properties.filters.items);
});

test("the spec request carries the original task, the contract, the headers and the sample whole", async () => {
  const { llm, sent, calls } = setup(spec);
  await llm.aggregationSpec({ task, contract, headers, sample });
  assert.deepEqual(JSON.parse(calls[0].content), { original_task: task, contract, headers, sample });
  // the compaction a request goes through must not cut what the enums above are built from
  const payload = decode(sent[0]);
  assert.equal(payload.original_task, task);
  assert.deepEqual(payload.contract, contract);
  assert.deepEqual(payload.headers, headers);
  assert.deepEqual(payload.sample, sample);
  const system = systemText(sent[0]);
  assert.match(system, /from the ORIGINAL user task only/);
  // star conditions are written on the stars field, the one a rating's star count is read into
  assert.match(system, /a star count \(4 or 5 stars is stars gte 4; 1 or 2 stars is stars lte 2\)/);
  assert.match(system, /goes to semantic_constraints instead/);
  assert.match(system, /never invent a header/);
});

test("a header listed twice makes one enum value, and none is asked for when the page lists no header", async () => {
  const { llm, calls } = setup(spec);
  await llm.aggregationSpec({ task, contract, headers: ["status", "status", "total", ""], sample });
  assert.deepEqual(calls[0].schema.properties.field.enum, ["", "status", "total"]);
  await llm.aggregationSpec({ task, contract, headers: [], sample: [] });
  assert.deepEqual(calls[1].schema.properties.output.enum, [""]);
});

test("with the staticSchema switch the spec's field names are free text, so the schema is the same for every list", async () => {
  COST.staticSchema = true;
  try {
    const { llm, calls } = setup(spec);
    await llm.aggregationSpec({ task, contract, headers, sample });
    const { properties } = calls[0].schema;
    for (const name of ["field", "group_by", "output"]) assert.equal(properties[name].enum, undefined);
    assert.equal(properties.op.enum.length, 10); // the enums that never change stay
  } finally {
    delete COST.staticSchema;
  }
});

const rows = [
  { row: 0, text: "Loaf, Rye Caraway $4.99" },
  { row: 1, text: "Review by Amanda: it broke in a week" },
  { row: 2, text: "Sourdough Boule $6.50" },
];
const verdicts = {
  rows: [
    { row: 0, verdict: "qualifies", quote: "Loaf, Rye Caraway" },
    { row: 1, verdict: "fails", quote: "it broke in a week" },
    { row: 2, verdict: "needs_detail", quote: "Sourdough Boule" },
  ],
};

test("screenRows is one text-only collect request that judges each row, and returns the verdicts", async () => {
  const { llm, sent, calls } = setup(verdicts);
  const r = await llm.screenRows({ task, contract, rows });
  assert.deepEqual(r.json, verdicts);
  assert.equal(sent.length, 1);
  assert.equal(calls[0].purpose, "collect");
  assert.equal(typeof calls[0].content, "string");
  assert.ok(noImage(sent[0]));
  const answer = sent[0].output_config.format.schema.properties.rows;
  assert.equal(answer.type, "array");
  assert.deepEqual(answer.items.properties.verdict.enum, ["fails", "qualifies", "needs_detail"]);
  assert.equal(answer.items.properties.row.type, "integer");
  assert.equal(answer.items.properties.quote.type, "string");
  strict(calls[0].schema);
  strict(calls[0].schema.properties.rows.items);
  const system = systemText(sent[0]);
  assert.match(system, /by meaning rather than literal words/);
  assert.match(system, /Never call a row qualifies on a guess/);
});

test("the rows reach the model with the task and the contract, each as it was listed", async () => {
  const { llm, sent, calls } = setup(verdicts);
  await llm.screenRows({ task, contract, rows });
  assert.deepEqual(JSON.parse(calls[0].content), { original_task: task, contract, rows });
  const payload = decode(sent[0]);
  assert.equal(payload.original_task, task);
  assert.deepEqual(payload.contract, contract);
  assert.equal(payload.context_incomplete, false); // all of them fit: no row is left to a retrieval round
  const shown = payload.evidence.map((e) => JSON.parse(e.text)).sort((a, b) => a.row - b.row);
  assert.deepEqual(shown, rows);
});

test("hasComputed is true for a note that holds a computed value, and for nothing else", () => {
  const counted = JSON.stringify({ matches: [], computed: { op: "count", value: 3 } });
  assert.equal(hasComputed({ a: counted }), true);
  assert.equal(hasComputed({ a: "plain", b: JSON.stringify({ matches: [] }) }), false);
  // a computed value of null is still a computation: the rule is what says it is missing
  assert.equal(hasComputed({ a: JSON.stringify({ computed: { op: "sum", value: null, unresolved: ["x"] } }) }), true);
  assert.equal(hasComputed({ plain: "17.25", counted }), true); // any one note will do
  // the object under computed, not the word
  assert.equal(hasComputed({ a: JSON.stringify({ matches: [], computed: null }) }), false);
  assert.equal(hasComputed({ a: JSON.stringify({ matches: [], computed: 3 }) }), false);
  assert.equal(hasComputed({ a: JSON.stringify({ matches: [], computed: "three" }) }), false);
  assert.equal(hasComputed({ a: JSON.stringify([{ computed: { op: "count", value: 3 } }]) }), false);
  assert.equal(hasComputed({ a: "{not json", b: 'the word "computed" in a sentence' }), false);
  assert.equal(hasComputed({ a: 3, b: null, c: { computed: { op: "count" } } }), false); // notes are text
  for (const notes of [undefined, null, "", counted, 3, {}]) assert.equal(hasComputed(notes), false);
});

const page = { title: "Reviews", url: "http://shop.test/reviews", text: "Reviews 12", truncated: false, chars: 10 };
const final = { kind: "read", goal: "Report the result", save_as: "final_task_answer" };
const answer = '{"status":"SUCCESS","retrieved_data":[3]}';
// one reply that every request below can read: a read's, a verify's and a final answer's fields
const all = {
  availability: "available",
  complete: true,
  evidence: "3 of 12 reviews",
  text: answer,
  next_steps: [],
  supported: true,
  answer,
};
const computed = JSON.stringify({
  matches: [],
  computed: { op: "count", value: 3, rows_total: 12, rows_used: 3, spec, unresolved: [] },
});
const plain = { reviews: JSON.stringify({ matches: [] }), price: "17.25" };

test("the computed-value rule says to report the value as it is, and a missing one as missing", () => {
  assert.match(COMPUTED_RULE, /calculated in code over every row the collection read/);
  assert.match(COMPUTED_RULE, /report it exactly as it is, with the format's success status/);
  assert.match(COMPUTED_RULE, /When computed\.value is null the value is missing/);
  assert.match(COMPUTED_RULE, /never with an error status for the missing computation/);
});

test("with the aggregate switch on, the final read and the final answer get the computed-value rule for a computed note", async () => {
  ACC.aggregate = true;
  try {
    const { llm, sent } = setup(all);
    const read = (notes, finalRead = true) =>
      llm.read({ task, planText: "", step: final, notes, info: page, image: "", finalRead });
    await read({ reviews: computed });
    assert.ok(systemText(sent[0]).includes(COMPUTED_RULE));
    assert.match(JSON.stringify(sent[0].messages), /computed/); // the note itself is in the request
    // notes with no computed value are asked as before: no rule about a value they don't have
    await read(plain);
    assert.ok(!systemText(sent[1]).includes(COMPUTED_RULE));
    // only the final read writes the answer: a read step on the way to it gets no such rule
    await read({ reviews: computed }, false);
    assert.ok(!systemText(sent[2]).includes(COMPUTED_RULE));
    await llm.finalAnswer({ task, reason: "partial: Run time limit reached", notes: { reviews: computed } });
    assert.ok(systemText(sent[3]).includes(COMPUTED_RULE));
    await llm.finalAnswer({ task, reason: "partial: Run time limit reached", notes: plain });
    assert.ok(!systemText(sent[4]).includes(COMPUTED_RULE));
    assert.equal(sent.length, 5);
  } finally {
    delete ACC.aggregate;
  }
});

test("with the aggregate switch off, a computed note changes neither the final read nor the final answer", async () => {
  const { llm, sent } = setup(all);
  const notes = { reviews: computed };
  await llm.read({ task, planText: "", step: final, notes, info: page, image: "", finalRead: true });
  await llm.finalAnswer({ task, reason: "partial: Run time limit reached", notes });
  assert.equal(sent.length, 2);
  for (const body of sent) assert.ok(!systemText(body).includes(COMPUTED_RULE));
});
