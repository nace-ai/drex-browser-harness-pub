import { test } from "node:test";
import assert from "node:assert/strict";
const { fill } = await import(process.env.MACROS_SOURCE || "../src/macros.ts");
const url = "http://owned.test/form";
function fixture(selectedIndex, dispatched = true) {
  let acted = false;
  const original = {
    label: "E1",
    name: "Order",
    text: "Order",
    role: "combobox",
    select: true,
    node: 11,
    context: "Preferences",
    options: ["Name", "Price"],
  };
  const fresh = { ...original, node: 22, options: ["Price", "Name"] };
  const tab = {
    info: async () => ({ url, text: "Preferences" }),
    fieldValue: async (node) => {
      assert.equal(node, 22);
      return { selectedIndex, value: selectedIndex === 0 ? "sort-price" : "sort-name" };
    },
  };
  const a = {
    task: "Sort by price",
    notes: {},
    index: 0,
    log() {},
    openDetailTab: async (href) => chrome.tabs.create({ url: href }),
    currentTab: async () => tab,
    look: async () => ({ info: { url }, els: [acted ? fresh : original], img1: "fixture" }),
    llmCall: async (_p, fn) => fn(),
    llm: {
      fill: async () => ({
        json: {
          fields: [
            { label: "E1", desired_value: "Price", source_kind: "instruction", source_evidence: "Sort by price" },
          ],
          unresolved: [],
        },
      }),
    },
    act: async () => {
      acted = true;
      return dispatched ? { dispatched: true } : { blocked: true, dispatched: false };
    },
    read: async () => ({ verified: true }),
  };
  return a;
}
test("select verification rejects wrong semantic option at the old index after same-URL rerender", async () => {
  const a = fixture(1);
  const result = await fill.call(a, { kind: "fill", goal: a.task, save_as: "fields" });
  assert.ok(result.replan);
  const entry = JSON.parse(a.notes.fields)[0];
  assert.equal(entry.observed, "Name");
  assert.equal(entry.ok, false);
  assert.equal(entry.dispatched, true);
});
test("select verification accepts requested label moved to a new index without confusing backend value", async () => {
  const a = fixture(0);
  const result = await fill.call(a, { kind: "fill", goal: a.task, save_as: "fields" });
  assert.equal(result.verified, true);
  assert.equal(JSON.parse(a.notes.fields)[0].observed, "Price");
});
test("an assignment with no label is the schema's filler for an unused slot, not a field to fill", async () => {
  const a = fixture(0);
  const real = { label: "E1", desired_value: "Price", source_kind: "instruction", source_evidence: "Sort by price" };
  const filler = { label: "", desired_value: "", source_kind: "", source_evidence: "" };
  let acts = 0;
  const act = a.act;
  a.act = async (...args) => {
    acts++;
    return act(...args);
  };
  a.llm.fill = async () => ({ json: { fields: [filler, real, filler], unresolved: [] } });
  const result = await fill.call(a, { kind: "fill", goal: a.task, save_as: "fields" });
  assert.equal(result.verified, true);
  assert.equal(acts, 1);
  assert.equal(JSON.parse(a.notes.fields).length, 1);
});
test("returning from blocked action is an attempt, never proof of dispatch", async () => {
  const a = fixture(1, false);
  await fill.call(a, { kind: "fill", goal: a.task, save_as: "fields" });
  const entry = JSON.parse(a.notes.fields)[0];
  assert.equal(entry.attempted, true);
  assert.equal(entry.dispatched, false);
});

test("same unresolved desired fields are inspected once then read for current effects without repeating fill", async () => {
  const a = fixture(0);
  a.llm.fill = async () => ({
    json: { fields: [], unresolved: [{ field: "Submission confirmed", reason: "Not an editable field" }] },
  });
  const first = await fill.call(a, { kind: "fill", goal: a.task });
  assert.equal(first.replan[0].kind, "browse");
  const second = await fill.call(a, { kind: "fill", goal: a.task });
  assert.equal(second.replan.length, 1);
  assert.equal(second.replan[0].kind, "read");
});

// A toggle and unlabeled age and height boxes were never matched to a field, in other words each time, and the runs ended "Gave up after 6 new plans". The second miss of the same form step
// hands its fields to ordinary moves.
test("a form step unresolved twice in other words goes to ordinary moves instead of another plan around the fill", async () => {
  const a = fixture(0);
  let n = 0;
  a.llm.fill = async () => ({
    json: {
      fields: [],
      unresolved: [{ label: "Editors' Choice", reason: `no supplied label matches the toggle (${++n})` }],
    },
  });
  const step = { kind: "fill", goal: "Turn on Editors' Choice and set the score to 10", texts: [] };
  const first = await fill.call(a, step);
  assert.equal(first.replan.at(-1).kind, "fill"); // the first miss inspects the form, then fills again
  const second = await fill.call(a, step);
  assert.equal(second.replan.length, 1);
  assert.equal(second.replan[0].kind, "browse");
  assert.match(second.replan[0].goal, /ordinary moves.*Editors' Choice.*do not submit/);
});

test("fresh form identity rejects reused nodes, duplicates, and changed grid coordinates before typing", async () => {
  for (const change of ["reused", "duplicates", "grid"]) {
    let shots = 0,
      actions = 0;
    const original = {
      node: 1,
      label: "E1",
      role: "textbox",
      name: "Recipient",
      text: "Recipient",
      field: true,
      context: "Shipping",
      grid: { row: 1, col: 2 },
    };
    const candidates =
      change === "reused"
        ? [{ ...original, role: "button", field: false }]
        : change === "duplicates"
          ? [
              { ...original, node: 2 },
              { ...original, node: 3 },
            ]
          : [{ ...original, grid: { row: 2, col: 2 } }];
    const a = {
      task: "Type Alice as shipping recipient",
      notes: {},
      index: 0,
      log() {},
      currentTab: async () => ({ info: async () => ({ url, text: "Shipping" }) }),
      look: async () => ({ info: { url }, els: shots++ === 0 ? [original] : candidates }),
      llmCall: async (_p, fn) => fn(),
      llm: {
        fill: async () => ({
          json: {
            unresolved: [],
            fields: [
              { label: "E1", desired_value: "Alice", source_kind: "instruction", source_evidence: "Type Alice" },
            ],
          },
        }),
      },
      act: async () => {
        actions++;
        return { dispatched: true };
      },
    };
    const out = await fill.call(a, { kind: "fill", goal: a.task });
    assert.ok(out.replan, change);
    assert.equal(actions, 0, change);
  }
});
test("unique semantic field after rerender accepts new backend node but never the reused wrong node", async () => {
  let shots = 0,
    chosen;
  const original = {
    node: 1,
    label: "E1",
    role: "textbox",
    name: "Recipient",
    text: "Recipient",
    field: true,
    context: "Shipping",
    grid: { row: 1, col: 2 },
  };
  const replacement = { ...original, node: 2 };
  const a = {
    task: "Type Alice as shipping recipient",
    notes: {},
    index: 0,
    log() {},
    currentTab: async () => ({
      info: async () => ({ url, text: "Shipping" }),
      fieldValue: async (node) => {
        assert.equal(node, 2);
        return { value: "Alice" };
      },
    }),
    look: async () => ({
      info: { url },
      els: shots++ === 0 ? [original] : [{ ...original, role: "button", field: false }, replacement],
    }),
    llmCall: async (_p, fn) => fn(),
    llm: {
      fill: async () => ({
        json: {
          unresolved: [],
          fields: [{ label: "E1", desired_value: "Alice", source_kind: "instruction", source_evidence: "Type Alice" }],
        },
      }),
    },
    act: async (_tab, action) => {
      chosen = action.el.node;
      return { dispatched: true };
    },
    read: async () => ({ verified: true }),
  };
  assert.equal((await fill.call(a, { kind: "fill", goal: a.task })).verified, true);
  assert.equal(chosen, 2);
});

test("a multiselect assignment verifies the entire requested set, including removal of extra choices", async () => {
  for (const selected of [["General", "Wholesale"], ["General"], ["General", "Wholesale", "Guest"]]) {
    const field = {
      label: "E1",
      node: 1,
      name: "Customer groups",
      text: "Customer groups",
      role: "listbox",
      select: true,
      multiple: true,
      options: ["General", "Wholesale", "Guest"],
    };
    const url = "https://example.test/rule";
    let dispatched;
    const host = {
      task: "Select exactly General and Wholesale",
      notes: {},
      index: 0,
      log() {},
      currentTab: async () => ({
        info: async () => ({ url, text: "Customer groups" }),
        fieldValue: async () => ({ selectedOptions: selected, selectedIndex: 0 }),
      }),
      look: async () => ({ info: { url }, els: [field] }),
      llmCall: async (_purpose, fn) => fn(),
      llm: {
        fill: async () => ({
          json: {
            fields: [
              {
                label: "E1",
                desired_value: JSON.stringify(["General", "Wholesale"]),
                source_kind: "instruction",
                source_evidence: "exactly General and Wholesale",
              },
            ],
            unresolved: [],
          },
        }),
      },
      act: async (_tab, act) => {
        dispatched = act;
        return { dispatched: true };
      },
      read: async () => ({ verified: true }),
    };
    const result = await fill.call(host, { kind: "fill", goal: host.task, save_as: "fields" });
    assert.deepEqual(dispatched.values, ["General", "Wholesale"]);
    assert.equal(JSON.parse(host.notes.fields)[0].ok, selected.length === 2);
    assert.equal(!!result.replan, selected.length !== 2);
  }
});
