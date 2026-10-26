// collectLite with the aggregate and listCoverage switches: the rows of the list typed as records, a count, total or
// top N computed in code over every row read, the list's own count read from its text, its per-page select set to the
// largest size, paging on until the rows read reach the count, and the LLM re-screening a list Drex found no match in.
// A fake host and tab over pages of rows; no page, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACC } from "../src/accuracy.ts";
import { ReadCap } from "../src/errors.ts";
const { collectLite } = await import(process.env.MACROS_SOURCE || "../src/macros.ts");

const SITE = "http://shop.test";
const NEXT = { role: "link", name: "Next", text: "link 'Next'", label: "E1", node: 99, box: [0, 0, 10, 10] };
const SIZER = 77; // the per-page select's node

// the spec of a task that computes nothing; the tests' specs are written over it
const NO_SPEC = {
  op: "none",
  field: "",
  filters: [],
  group_by: "",
  output: "",
  order: "none",
  limit: 0,
  semantic_constraints: [],
};
/** One row of a list as the page shows it: its text, its header-to-cell pairs, its rating, and the address and text of
 * its link (none: a row with no detail to open). */
const row = (text, cells = [], more = {}) => ({ text, cells, rating: null, href: "", linkText: "", ...more });

/** A collectLite host over a list of pages, each an array of rows. text: what each page shows above its rows (a
 * string, or a function of the page's index and whether its per-page select was set to the largest size); next: whether
 * a page shows a Next link; spec: the aggregation spec the LLM writes; verdict: Drex's row verdict by the row's text;
 * screen: the LLM's re-screen verdicts; sizer: the per-page select ({ options, selectedIndex, rows }, rows being the
 * first page at the largest size); detail: Drex's reading of a record's own page, by its address. */
function fixture({
  task,
  contract,
  pages,
  text = "",
  next = (i) => i < pages.length - 1,
  spec = null,
  verdict = () => "fails",
  screen = [],
  sizer = null,
  detail = () => "match",
}) {
  const calls = {
    aggregationSpec: [],
    screenRows: [],
    records: 0,
    selectOption: [],
    selectValues: [],
    act: 0,
    opened: [],
    drex: [],
    items: 0,
    info: 0,
    look: 0,
    on: 0,
  };
  const events = [];
  let page = 0,
    grown = false,
    detailHref = "";
  const shown = () => (page === 0 && grown ? sizer.rows : pages[page]);
  const url = () => `${SITE}/orders?p=${page + 1}`;
  const nodes = new Map(); // the rows of the page on screen, by node
  const list = {
    id: 1,
    settle: async () => {},
    info: async () => {
      calls.info++;
      const top = typeof text === "function" ? text(page, grown) : text;
      const body = [top, ...shown().map((r) => r.text)].filter(Boolean).join("\n");
      return { title: "Orders", url: url(), text: body, truncated: false, chars: body.length };
    },
    items: async () => {
      calls.items++;
      nodes.clear();
      return shown().map((r, i) => {
        const node = 1000 * (page + 1) + (grown ? 500 : 0) + i;
        nodes.set(node, r);
        return { key: r.text.toLowerCase().slice(0, 160), text: r.text, node, checkbox: false, checked: false };
      });
    },
    records: async (items) => {
      calls.records++;
      return items.map((item, index) => {
        const r = nodes.get(item.node);
        return { index, text: item.text, cells: r?.cells ?? [], rating: r?.rating ?? null, href: r?.href ?? "" };
      });
    },
    on: async (node) => {
      calls.on++;
      // the Next link sits in the list's pagination
      if (node === NEXT.node)
        return { href: "", rel: "next", role: null, controls: null, expanded: false, pagination: true, tag: "A" };
      const r = nodes.get(node);
      return r?.href ? [{ href: r.href, text: r.linkText }] : [];
    },
    selectOption: async (node, index) => {
      calls.selectOption.push([node, index]);
      if (sizer && node === SIZER) grown = true;
    },
    selectValues: async (node, values) => {
      calls.selectValues.push([node, values]);
      return false; // a native select that isn't multiple
    },
  };
  const detailTab = {
    id: 2,
    settle: async () => {},
    info: async () => ({ title: "Order", url: detailHref, text: `Order ${detailHref}`, truncated: false, chars: 30 }),
  };
  const host = {
    task,
    index: 0,
    notes: {},
    totals: { drexMoves: 0 },
    collectionPreparationAttempts: 0,
    tabs: new Map(),
    tabBindings: new Map(),
    agentTabId: 1,
    ownTab: true,
    newTabId: null,
    activePlanTab: null,
    afterShot: null,
    check() {},
    log(event, data) {
      events.push([event, data]);
    },
    llmCall: async (_purpose, call) => call(),
    llm: {
      collectionContract: async () => ({ json: contract }),
      aggregationSpec: async (input) => {
        calls.aggregationSpec.push(input);
        return { json: spec ?? { ...NO_SPEC } };
      },
      screenRows: async (input) => {
        calls.screenRows.push(input);
        return { json: { rows: screen } };
      },
    },
    drexCall: async (state, questions) => {
      const asked = Object.keys(questions);
      if (asked.includes("relevant")) {
        calls.drex.push("relevant");
        return { answers: { relevant: { noul: 0.9 } } };
      }
      if (asked.includes("sorted")) {
        calls.drex.push("sorted");
        const way = contract.sort_direction;
        return { answers: { sorted: { choice: way, probabilities: { [way]: 0.95 } } } };
      }
      if (asked.includes("match")) {
        calls.drex.push("match");
        const decision = detail(JSON.parse(state).current_public_record.url);
        return {
          answers: {
            match: { choice: decision, probabilities: { [decision]: 0.99 } },
            coverage: { choice: "complete", probabilities: { complete: 0.99 } },
          },
        };
      }
      // the row screen: one question per row (R1..R16), each quoting its row
      calls.drex.push("rows");
      return {
        answers: Object.fromEntries(
          asked.map((key) => {
            const choice = verdict(/^ROW: "(.*)"\n/.exec(questions[key].instructions)?.[1] ?? "");
            return [key, { choice, probabilities: { [choice]: 0.95 } }];
          }),
        ),
      };
    },
    currentTab: async () => (host.agentTabId === 2 ? detailTab : list),
    look: async (tab) => {
      calls.look++;
      if (tab.id === 2) return { info: { title: "Order", url: detailHref }, els: [], off: [], img1: "", img2: "" };
      const els = [];
      if (!(page === 0 && grown) && next(page)) els.push(NEXT);
      if (sizer && page === 0)
        els.push({
          role: "combobox",
          name: "Show",
          text: "combobox 'Show'",
          label: "E2",
          node: SIZER,
          box: [0, 20, 10, 30],
          select: true,
          options: sizer.options,
          selectedIndex: grown ? sizer.options.length - 1 : sizer.selectedIndex,
        });
      shown().forEach((r, i) => {
        if (r.href)
          els.push({
            role: "link",
            name: r.linkText,
            text: `link '${r.linkText}'`,
            label: `E${i + 3}`,
            node: 500 + i,
            box: [0, 40 + 10 * i, 10, 50 + 10 * i],
          });
      });
      return { info: { title: "Orders", url: url() }, els, off: [], img1: "", img2: "" };
    },
    // a macro move: the only one a list's reading makes here is its Next link
    act: async () => {
      calls.act++;
      page++;
      return {};
    },
    openDetailTab: async (href) => {
      calls.opened.push(href);
      detailHref = href;
      return { id: 2 };
    },
  };
  return { host, calls, events, note: () => JSON.parse(host.notes.list) };
}

const BOTH = ["aggregate", "listCoverage"];
/** Runs the collect step with these accuracy switches on, and only for the call. */
async function run(f, switches = BOTH) {
  for (const name of switches) ACC[name] = true;
  try {
    return await collectLite.call(f.host, { kind: "collect", goal: f.host.task, save_as: "list" });
  } finally {
    for (const name of switches) delete ACC[name];
  }
}
const eventsNamed = (f, name) => f.events.filter(([e]) => e === name).map(([, data]) => data);

// an admin order grid: 7 orders over two pages, 3 of them canceled
const HEAD = ["ID", "Purchase Date", "Bill-to Name", "Grand Total (Base)", "Status"];
const ORDERS = [
  ["000000129", "Jun 5, 2023", "Julia Williams", "$1,234.56", "Canceled"],
  ["000000128", "May 1, 2023", "Jane Doe", "$40.00", "Complete"],
  ["000000127", "Apr 2, 2023", "Grace Nguyen", "$12.50", "Pending"],
  ["000000126", "Mar 9, 2023", "Alex Martin", "$99.00", "Canceled"],
  ["000000125", "Feb 7, 2023", "Bob Jones", "$5.25", "Complete"],
  ["000000124", "Jan 4, 2023", "Lily Potter", "$75.10", "Canceled"],
  ["000000123", "Jan 2, 2023", "Sam Lee", "$18.00", "Complete"],
].map((cells) =>
  row(
    cells.join(" "),
    HEAD.map((h, i) => [h, cells[i]]),
  ),
);
const COUNT_TASK = "How many orders were canceled?";
const COUNT_CONTRACT = {
  intent: "enumerate_all",
  constraints: ["status is Canceled"],
  objective: "",
  objective_field: "",
  scope: "the order history",
  sort_direction: "none",
  ranked_count: 0,
};
const COUNT_SPEC = { ...NO_SPEC, op: "count", filters: [{ field: "status", op: "eq", value: "Canceled" }] };
const orderPages = () => [ORDERS.slice(0, 4), ORDERS.slice(4)];
const canceled = (text) => (text.includes("Canceled") ? "qualifies" : "fails");
const countFixture = () =>
  fixture({
    task: COUNT_TASK,
    contract: COUNT_CONTRACT,
    pages: orderPages(),
    text: "7 records found",
    spec: COUNT_SPEC,
    verdict: canceled,
  });

test("aggregate: two pages of orders, count of canceled computed over every row, event logged", async () => {
  const f = countFixture();
  await run(f);
  const note = f.note();
  const { semantic_constraints: _, ...asked } = COUNT_SPEC;
  assert.deepEqual(note.computed, {
    spec: asked,
    op: "count",
    value: 3,
    rows_total: 7,
    rows_used: 3,
    unresolved: [],
  });
  assert.equal(note.rows_read, 7);
  assert.equal(note.count_shown, 7);
  assert.equal(note.pages_read, 2);
  assert.equal(note.whole_list_read, true);
  // no condition left for reading the rows' words: the filters decide, and Drex screens no row
  assert.ok(!f.calls.drex.includes("rows"));
  // the spec is asked once, from the list's field names and three of its rows
  assert.equal(f.calls.aggregationSpec.length, 1);
  assert.ok(f.calls.aggregationSpec[0].headers.includes("status"));
  assert.equal(f.calls.aggregationSpec[0].sample.length, 3);
  assert.deepEqual(eventsNamed(f, "aggregate_spec"), [{ spec: COUNT_SPEC }]);
  assert.deepEqual(eventsNamed(f, "list_count"), [{ count: 7, rows: 4 }]);
  assert.deepEqual(eventsNamed(f, "aggregate"), [{ op: "count", value: 3, rows_total: 7, rows_used: 3 }]);
  const [done] = eventsNamed(f, "collection_done");
  assert.equal(done.rowsRead, 7);
  assert.equal(done.countShown, 7);
  assert.equal(done.computed, true);
});

test("a spec off its schema: a number filter value is read as its digits; any other misfit computes nothing", async () => {
  const f = fixture({
    task: "How many orders have a grand total of 50 or more?",
    contract: { ...COUNT_CONTRACT, constraints: ["grand total of 50 or more"] },
    pages: orderPages(),
    text: "7 records found",
    spec: { ...NO_SPEC, op: "count", filters: [{ field: "Grand Total (Base)", op: "gte", value: 50 }] },
  });
  await run(f);
  assert.equal(f.note().computed.value, 3); // $1,234.56, $99.00 and $75.10
  assert.deepEqual(eventsNamed(f, "aggregate_error"), []);
  // an op the schema doesn't have: no spec, the rows go to Drex's screen, the note is written without a computed value
  const odd = fixture({
    task: COUNT_TASK,
    contract: COUNT_CONTRACT,
    pages: orderPages(),
    text: "7 records found",
    spec: { ...COUNT_SPEC, op: "median" },
    verdict: canceled,
  });
  await run(odd);
  assert.deepEqual(eventsNamed(odd, "aggregate_error"), [
    { where: "aggregationSpec", message: "The aggregation spec doesn't fit its schema" },
  ]);
  assert.equal(odd.note().computed, undefined);
  assert.equal(odd.note().matches.length, 3);
  assert.ok(odd.calls.drex.includes("rows"));
});

test("listCoverage: paging goes on past two empty pages while rows read are under the count; reaching it only lets main's stops apply", async () => {
  const people = ["Amanda", "Ines", "Marcus", "Evelyn", "Grace", "Jane", "Bob", "Lily", "Sam", "Alex", "Ana", "Tom"];
  const reviews = [...people, "Kim", "Lee"].map((name) => row(`${name}: the bag is fine`));
  const constraint = "says the strap broke";
  const f = fixture({
    task: "How many reviews say the strap broke?",
    contract: { ...COUNT_CONTRACT, intent: "choose_qualified", constraints: [constraint], scope: "the bag's reviews" },
    // 7 pages of 2 rows under a count that reads 10: the count doesn't end the reading, main's stops do
    pages: [0, 2, 4, 6, 8, 10, 12].map((i) => reviews.slice(i, i + 2)),
    text: "10 reviews",
    spec: { ...NO_SPEC, op: "count", semantic_constraints: [constraint] },
    verdict: () => "fails",
  });
  await run(f);
  const note = f.note();
  // main stops after LITE_EMPTY_PAGES (2) pages with no match; past the count, its rule (pages read, no match) applies
  // at once on page 5
  assert.equal(note.pages_read, 5);
  assert.equal(note.rows_read, 10);
  assert.equal(note.count_shown, 10);
  assert.equal(note.whole_list_read, false); // ended by main's stop, not by reaching the count
  assert.equal(f.calls.act, 4);
});

test("listCoverage: reaching the stated count never ends a reading by itself: an enumeration whose count reads low goes on to its last page", async () => {
  const f = fixture({
    task: "List every order",
    contract: { ...COUNT_CONTRACT, constraints: [] },
    pages: [ORDERS.slice(0, 2), ORDERS.slice(2, 4), ORDERS.slice(4, 6)],
    text: "4 records found",
    verdict: () => "qualifies",
  });
  await run(f, ["listCoverage"]);
  const note = f.note();
  assert.equal(note.pages_read, 3);
  assert.equal(note.rows_read, 6);
  assert.equal(note.matches.length, 6);
  assert.equal(note.whole_list_read, true);
  assert.equal(f.calls.act, 2);
});

test("listCoverage: stops at the last page when the count is never reached", async () => {
  const rows = ORDERS.slice(0, 6);
  const f = fixture({
    task: "List every order",
    contract: { ...COUNT_CONTRACT, constraints: [] },
    pages: [rows.slice(0, 2), rows.slice(2, 4), rows.slice(4)],
    text: "50 records found",
    verdict: () => "qualifies",
  });
  await run(f, ["listCoverage"]);
  const note = f.note();
  assert.equal(note.pages_read, 3);
  assert.equal(note.rows_read, 6);
  assert.equal(note.count_shown, 50);
  assert.equal(note.whole_list_read, false); // 6 rows of the 50 the list states
  assert.equal(f.calls.act, 2); // no Next on page 3: no further move
});

test("listCoverage: the per-page select is set to its largest size once before reading", async () => {
  const products = Array.from({ length: 30 }, (_, i) => row(`Product ${String.fromCharCode(65 + (i % 26))}${i}`));
  const f = fixture({
    task: "List the names of all products in this category",
    contract: { ...COUNT_CONTRACT, constraints: [], scope: "the category" },
    pages: [products.slice(0, 12), products.slice(12, 24), products.slice(24)],
    text: (p, grown) => (grown ? "Items 1-30 of 30" : `Items ${12 * p + 1}-${Math.min(30, 12 * p + 12)} of 30`),
    sizer: { options: ["12", "24", "36"], selectedIndex: 0, rows: products },
    verdict: () => "qualifies",
  });
  await run(f, ["listCoverage"]);
  // a single native select: set by its option's index (the largest, 36, is index 2)
  assert.deepEqual(f.calls.selectOption, [[SIZER, 2]]);
  assert.deepEqual(eventsNamed(f, "page_size"), [{ from: 12, to: 36 }]);
  const note = f.note();
  assert.equal(note.rows_read, 30); // read from the grown page: all 30 on one page
  assert.equal(note.pages_read, 1);
  assert.equal(note.matches.length, 30);
  assert.equal(note.whole_list_read, true);
  assert.equal(f.calls.act, 0);
  // the count is read on each read of the first page
  assert.deepEqual(eventsNamed(f, "list_count"), [
    { count: 30, rows: 12 },
    { count: 30, rows: 30 },
  ]);
});

test("listCoverage: a per-page select that can't be set leaves the page as it is", async () => {
  const products = Array.from({ length: 30 }, (_, i) => row(`Product ${String.fromCharCode(65 + (i % 26))}${i}`));
  const f = fixture({
    task: "List the names of all products in this category",
    contract: { ...COUNT_CONTRACT, constraints: [], scope: "the category" },
    pages: [products.slice(0, 12), products.slice(12, 24), products.slice(24)],
    text: (p) => `Items ${12 * p + 1}-${Math.min(30, 12 * p + 12)} of 30`,
    sizer: { options: ["12", "24", "36"], selectedIndex: 0, rows: products },
    verdict: () => "qualifies",
  });
  (await f.host.currentTab()).selectOption = async () => {
    throw new Error("Node is detached from document");
  };
  await run(f, ["listCoverage"]);
  assert.deepEqual(eventsNamed(f, "aggregate_error"), [
    { where: "selectOption", message: "Node is detached from document" },
  ]);
  assert.deepEqual(eventsNamed(f, "page_size"), []);
  const note = f.note();
  assert.equal(note.pages_read, 3); // read page by page instead: 12, 12 and 6 rows
  assert.equal(note.rows_read, 30);
  assert.equal(note.whole_list_read, true);
});

test("listCoverage: a zero-match Drex screen is re-read once by the LLM", async () => {
  const breads = ["Sourdough Boule $5.49", "Baguette $2.49", "Loaf, Rye Caraway $4.99", "Ciabatta $3.19"];
  const f = fixture({
    task: "Find a rye bread in the bakery list",
    contract: { ...COUNT_CONTRACT, intent: "choose_qualified", constraints: ["rye bread"], scope: "the bakery list" },
    pages: [breads.map((b) => row(b))],
    verdict: () => "fails",
    // the model's JSON is not validated: a row number it was never shown counts for nothing
    screen: [
      { row: 2, verdict: "qualifies", quote: "Loaf, Rye Caraway" },
      { row: 9, verdict: "qualifies", quote: "Rye" },
    ],
  });
  await run(f, ["listCoverage"]);
  assert.equal(f.calls.screenRows.length, 1);
  assert.deepEqual(
    f.calls.screenRows[0].rows,
    breads.map((text, i) => ({ row: i, text })),
  );
  const note = f.note();
  assert.deepEqual(note.matches, [{ source: `${SITE}/orders?p=1`, row: "Loaf, Rye Caraway $4.99" }]);
  assert.deepEqual(eventsNamed(f, "screen_reread"), [{ rows: 4, matches: 1 }]);
});

test("filters that pass no row fall back to the LLM's re-screen, once: a filter worded unlike the cells ('Cancelled' for 'Canceled')", async () => {
  const f = fixture({
    task: "How many orders were cancelled?",
    contract: { ...COUNT_CONTRACT, constraints: ["status is Cancelled"] },
    pages: [ORDERS.slice(0, 4)],
    spec: { ...NO_SPEC, op: "count", filters: [{ field: "status", op: "eq", value: "Cancelled" }] },
    screen: [
      { row: 0, verdict: "qualifies", quote: "Canceled" },
      { row: 1, verdict: "fails", quote: "Complete" },
      { row: 2, verdict: "fails", quote: "Pending" },
      { row: 3, verdict: "qualifies", quote: "Canceled" },
    ],
  });
  await run(f);
  assert.ok(!f.calls.drex.includes("rows")); // the filters decided the rows: Drex screened none
  assert.equal(f.calls.screenRows.length, 1);
  const note = f.note();
  assert.deepEqual(
    note.matches.map((m) => m.row),
    [ORDERS[0].text, ORDERS[3].text],
  );
  // computed over the rows the re-screen chose, by meaning: the spec as asked, and how its filters were applied
  assert.equal(note.computed.value, 2);
  assert.deepEqual(note.computed.spec.filters, [{ field: "status", op: "eq", value: "Cancelled" }]);
  assert.deepEqual(note.computed.unresolved, ["filters applied by the re-screen"]);
  assert.deepEqual(eventsNamed(f, "screen_reread"), [{ rows: 4, matches: 2, fallback: true }]);
});

test("a call the switches add that fails costs only what it adds: the note is still written; a read cap goes on up", async () => {
  const breads = ["Sourdough Boule $5.49", "Baguette $2.49", "Loaf, Rye Caraway $4.99", "Ciabatta $3.19"];
  const bakery = (error) => {
    const f = fixture({
      task: "Find a rye bread in the bakery list",
      contract: { ...COUNT_CONTRACT, intent: "choose_qualified", constraints: ["rye bread"], scope: "the bakery list" },
      pages: [breads.map((b) => row(b))],
      verdict: () => "fails",
    });
    f.host.llm.screenRows = async () => {
      throw error;
    };
    return f;
  };
  const f = bakery(new Error("The model's reply could not be read"));
  await run(f, ["listCoverage"]);
  assert.deepEqual(f.note().matches, []);
  assert.equal(f.note().rows_checked, 4);
  assert.deepEqual(eventsNamed(f, "aggregate_error"), [
    { where: "screenRows", message: "The model's reply could not be read" },
  ]);
  assert.deepEqual(eventsNamed(f, "screen_reread"), []);
  // the collect step's read cap ends the step in collectCapped, as it would without the switch
  const capped = bakery(new ReadCap("The collect step used its 6 model reads."));
  await assert.rejects(run(capped, ["listCoverage"]), ReadCap);
  assert.equal(capped.host.notes.list, undefined);
});

test("aggregate with semantic constraints: Drex still screens the rows and the computation runs over the qualifying ones", async () => {
  const reviews = [
    ["Amanda", "The strap broke in a week"],
    ["Ines", "Roomy, and the zip is smooth"],
    ["Marcus", "Cheap stitching came apart"],
    ["Evelyn", "Love the colour"],
  ].map(([author, body]) =>
    row(`${author}: ${body}`, [
      ["Author", author],
      ["Review", body],
    ]),
  );
  const complaints = new Set([reviews[0].text, reviews[2].text]);
  const f = fixture({
    task: "List the names of the reviewers who complain about the quality",
    contract: { ...COUNT_CONTRACT, constraints: ["complains about quality"], scope: "the bag's reviews" },
    pages: [reviews],
    spec: { ...NO_SPEC, op: "list", output: "author", semantic_constraints: ["complains about quality"] },
    verdict: (text) => (complaints.has(text) ? "qualifies" : "fails"),
  });
  await run(f);
  assert.ok(f.calls.drex.includes("rows"));
  const { computed } = f.note();
  assert.deepEqual(computed.value, ["Amanda", "Marcus"]);
  assert.equal(computed.rows_total, 2);
  assert.equal(computed.rows_used, 2);
});

test("a spec computed over every row reads a list it chooses from to its stated count: its first match doesn't end the reading", async () => {
  const people = ["Amanda", "Ines", "Marcus", "Evelyn", "Grace", "Jane", "Bob", "Lily", "Sam", "Alex"];
  const broke = new Set(["Amanda", "Grace", "Sam"]);
  const reviews = people.map((name) => row(`${name}: ${broke.has(name) ? "the strap broke" : "the bag is fine"}`));
  const constraint = "says the strap broke";
  const f = fixture({
    task: "How many reviews say the strap broke?",
    contract: { ...COUNT_CONTRACT, intent: "choose_qualified", constraints: [constraint], scope: "the bag's reviews" },
    pages: [0, 2, 4, 6, 8].map((i) => reviews.slice(i, i + 2)),
    text: "10 reviews",
    spec: { ...NO_SPEC, op: "count", semantic_constraints: [constraint] },
    verdict: (text) => (text.includes("broke") ? "qualifies" : "fails"),
  });
  await run(f);
  const note = f.note();
  assert.equal(note.pages_read, 5); // main stops at its first page with a match: Amanda's, page 1
  assert.equal(note.computed.value, 3);
  assert.equal(note.whole_list_read, true);
});

// six orders, newest first, each with its detail to open; a request for the 4 most recent
const datedOrders = () =>
  ["3/11/23", "3/10/23", "3/9/23", "3/8/23", "3/7/23", "3/6/23"].map((date, i) => {
    const id = `00000018${5 - i}`;
    return row(
      `${id} ${date} $65.32 Complete`,
      [
        ["ID", id],
        ["Date", date],
        ["Order Total", "$65.32"],
        ["Status", "Complete"],
      ],
      { href: `${SITE}/order/${id}`, linkText: id },
    );
  });
const RECENT_FOUR = {
  intent: "objective_optimum",
  constraints: [],
  objective: "most recent",
  objective_field: "date",
  scope: "the order history",
  sort_direction: "desc",
  ranked_count: 4,
};
/** Runs the collect step with a fake chrome.tabs, which a detail tab's closing calls. */
async function runWithTabs(f) {
  const prior = globalThis.chrome;
  globalThis.chrome = { tabs: { remove: async () => {} } };
  try {
    await run(f);
  } finally {
    globalThis.chrome = prior;
  }
}

test("top on a list proven ordered opens only the first N details", async () => {
  const f = fixture({
    task: "What are the IDs of my 4 most recent orders?",
    contract: RECENT_FOUR,
    pages: [datedOrders()],
    spec: { ...NO_SPEC, op: "top", output: "id", limit: 4 },
  });
  await runWithTabs(f);
  assert.equal(f.calls.opened.length, 4);
  const note = f.note();
  assert.equal(note.matches.length, 4);
  assert.deepEqual(note.computed.value, ["000000185", "000000184", "000000183", "000000182"]);
  assert.match(note.order, /^the list runs by date desc; the matches are its first rows, in that order/);
});

test("a total over a field the list doesn't show, for a ranked request, becomes its top N: only those N details open", async () => {
  const orders = datedOrders();
  const f = fixture({
    task: "What is the total number of items sold in my 4 most recent orders?",
    contract: RECENT_FOUR,
    pages: [orders],
    // the spec's own order, rewritten to the list's once the list is proven newest first
    spec: { ...NO_SPEC, op: "sum", field: "", limit: 4, order: "desc" },
  });
  await runWithTabs(f);
  assert.equal(f.calls.opened.length, 4);
  const note = f.note();
  assert.equal(note.matches.length, 4);
  assert.equal(note.computed.op, "top");
  // the first four rows are read, their records for the final read to total from: the value itself is missing
  assert.deepEqual(note.computed.spec, {
    op: "top",
    field: "",
    filters: [],
    group_by: "",
    output: "text",
    order: "none",
    limit: 4,
  });
  assert.equal(note.computed.value, null);
  assert.deepEqual(note.computed.unresolved, ["sum over the items: read the 4 records"]);
  assert.ok(orders.slice(0, 4).every((o, i) => note.matches[i].row === o.text));
  const [logged] = eventsNamed(f, "aggregate_spec");
  assert.equal(logged.became, "top");
  assert.equal(logged.from, "sum");
  assert.equal(logged.spec.op, "top");
});

test("a top N stops once its qualifying rows reach N: a first row that fails doesn't count toward it", async () => {
  const items = ["Leather Wallet $99.00", "Leather Tote Bag $80.00", "Canvas Bag $40.00", "Straw Bag $20.00"].map(
    (text) => row(text),
  );
  const f = fixture({
    task: "What are the 2 most expensive bags?",
    contract: {
      intent: "objective_optimum",
      constraints: ["is a bag"],
      objective: "most expensive",
      objective_field: "price",
      scope: "the store's bags",
      sort_direction: "desc",
      ranked_count: 2,
    },
    pages: [items],
    spec: { ...NO_SPEC, op: "top", limit: 2, semantic_constraints: ["is a bag"] },
    verdict: (text) => (text.includes("Bag") ? "qualifies" : "fails"),
  });
  await run(f);
  assert.ok(f.calls.drex.includes("sorted")); // the order is proven by Drex reading the sort
  const note = f.note();
  assert.deepEqual(
    note.matches.map((m) => m.row),
    [items[1].text, items[2].text],
  );
  assert.equal(note.rows_checked, 3); // the fourth row is never judged
  assert.equal(note.ruled_out, 1);
  assert.equal(note.whole_list_read, true);
  assert.deepEqual(note.computed.value, [items[1].text, items[2].text]);
});

test("a single top item with a spec computed over every row: its first match doesn't end the reading", async () => {
  // orders by grand total, most first, over two pages: Lily Potter placed three of the six, two on page 2
  const orders = [
    ["000000129", "Jun 5, 2023", "Julia Williams", "$1,234.56", "Complete"],
    ["000000126", "Mar 9, 2023", "Lily Potter", "$99.00", "Canceled"],
    ["000000127", "Apr 2, 2023", "Grace Nguyen", "$80.00", "Complete"],
    ["000000124", "Jan 4, 2023", "Lily Potter", "$75.10", "Canceled"],
    ["000000125", "Feb 7, 2023", "Lily Potter", "$40.00", "Complete"],
    ["000000123", "Jan 2, 2023", "Sam Lee", "$18.00", "Complete"],
  ].map((cells) =>
    row(
      cells.join(" "),
      HEAD.map((h, i) => [h, cells[i]]),
    ),
  );
  const f = fixture({
    task: "Which customer placed the most orders?",
    contract: { ...BY_TOTAL_CONTRACT, constraints: [] },
    pages: [orders.slice(0, 3), orders.slice(3)],
    spec: { ...NO_SPEC, op: "argmax", group_by: "Bill-to Name" },
  });
  await run(f);
  assert.ok(f.calls.drex.includes("sorted")); // the list is still proven ordered
  const note = f.note();
  assert.equal(note.pages_read, 2);
  assert.equal(note.computed.value, "Lily Potter");
  assert.equal(note.computed.rows_total, 6);
  assert.equal(note.answer, undefined);
  assert.equal(eventsNamed(f, "collection_done")[0].firstHit, false);
  // the ranking is the final read's: the matches keep the list's order
  assert.equal(note.order, "the list runs by grand total desc; the matches are in that order");
});

test("a dated list read for a computation is judged in place: no detail opens, and its note keeps up to 40 matches", async () => {
  // twelve orders, newest first, each with its detail to open: ten canceled, four of them Lily Potter's, while Julia
  // Williams placed the most orders overall
  const orders = [
    ["Lily Potter", "Canceled"],
    ["Julia Williams", "Complete"],
    ["Lily Potter", "Canceled"],
    ["Sam Lee", "Canceled"],
    ["Julia Williams", "Canceled"],
    ["Lily Potter", "Canceled"],
    ["Julia Williams", "Complete"],
    ["Sam Lee", "Canceled"],
    ["Lily Potter", "Canceled"],
    ["Julia Williams", "Canceled"],
    ["Julia Williams", "Canceled"],
    ["Sam Lee", "Canceled"],
  ].map(([name, status], i) => {
    const id = `000000${192 - i}`;
    const date = `3/${12 - i}/23`;
    return row(
      `${id} ${date} ${name} ${status}`,
      [
        ["ID", id],
        ["Date", date],
        ["Bill-to Name", name],
        ["Status", status],
      ],
      { href: `${SITE}/order/${id}`, linkText: id },
    );
  });
  const f = fixture({
    task: "Which customer has the most cancellations?",
    contract: {
      intent: "objective_optimum",
      constraints: ["status is Canceled"],
      objective: "most recent",
      objective_field: "date",
      scope: "the orders",
      sort_direction: "desc",
      ranked_count: 1,
    },
    pages: [orders],
    spec: { ...NO_SPEC, op: "argmax", group_by: "Bill-to Name", filters: CANCELED },
  });
  await runWithTabs(f);
  assert.equal(f.calls.opened.length, 0);
  assert.ok(!f.calls.drex.includes("rows") && !f.calls.drex.includes("match")); // the filters judged every row
  const note = f.note();
  assert.equal(note.computed.value, "Lily Potter"); // Julia Williams, over every order
  assert.equal(note.computed.rows_total, 12);
  assert.equal(note.computed.rows_used, 10);
  assert.equal(note.ruled_out, 2);
  assert.equal(note.matches.length, 10); // an enumeration's note: more than LITE_MATCHES (8)
  assert.ok(note.matches.every((m) => m.record === ""));
  assert.equal(note.order, "the list runs by date desc; the matches are in that order");
});

test("a single top item's total keeps to that item: 'the total cost of my latest cancelled order' reads its first match", async () => {
  const statuses = ["Complete", "Canceled", "Complete", "Canceled", "Canceled", "Complete"];
  const totals = ["$10.00", "$20.00", "$30.00", "$40.00", "$50.00", "$60.00"];
  const orders = statuses.map((status, i) => {
    const id = `00000018${5 - i}`;
    const date = `3/${11 - i}/23`;
    return row(
      `${id} ${date} ${totals[i]} ${status}`,
      [
        ["ID", id],
        ["Date", date],
        ["Order Total", totals[i]],
        ["Status", status],
      ],
      { href: `${SITE}/order/${id}`, linkText: id },
    );
  });
  const f = fixture({
    task: "Tell me the total cost of my latest cancelled order?",
    contract: { ...RECENT_FOUR, ranked_count: 1, constraints: ["status is cancelled"] },
    pages: [orders],
    spec: { ...NO_SPEC, op: "sum", field: "Order Total", filters: CANCELED },
    detail: (url) => (/18[421]$/.test(url) ? "match" : "no_match"),
  });
  await runWithTabs(f);
  // main's dated read: the newest order's detail rules it out (Complete), the next one's is the first match
  assert.deepEqual(f.calls.opened, [`${SITE}/order/000000185`, `${SITE}/order/000000184`]);
  const note = f.note();
  assert.equal(note.answer.row, orders[1].text);
  assert.equal(note.computed.value, 20); // that one order's total, not every canceled order's (110)
  assert.equal(note.computed.rows_total, 1);
  assert.equal(note.order, "the list runs by date desc; the first match is the answer");
});

test("rows a computation needed that were left unconfirmed: a number is missing, a list keeps what was confirmed", async () => {
  // a count on a dated list read in place: Drex settles two rows and leaves four open, whose details aren't read
  const yogaMat = (text) => (/^00000018[45]/.test(text) ? "qualifies" : "needs_detail");
  const counted = fixture({
    task: "How many of my orders held a yoga mat?",
    contract: { ...RECENT_FOUR, ranked_count: 1, constraints: ["holds a yoga mat"] },
    pages: [datedOrders()],
    spec: { ...NO_SPEC, op: "count", semantic_constraints: ["holds a yoga mat"] },
    verdict: yogaMat,
  });
  await runWithTabs(counted);
  assert.equal(counted.calls.opened.length, 0);
  assert.equal(counted.note().matches.length, 6);
  assert.equal(counted.note().computed.value, null);
  assert.deepEqual(counted.note().computed.unresolved, ["4 rows need their detail and were not read"]);
  // a list read in place keeps the two confirmed values, with the same note (rows with no detail to open)
  const listed = fixture({
    task: "List the IDs of my orders that held a yoga mat",
    contract: { ...COUNT_CONTRACT, constraints: ["holds a yoga mat"] },
    pages: [datedOrders().map((o) => ({ ...o, href: "", linkText: "" }))],
    spec: { ...NO_SPEC, op: "list", output: "ID", semantic_constraints: ["holds a yoga mat"] },
    verdict: yogaMat,
  });
  await runWithTabs(listed);
  assert.equal(listed.calls.opened.length, 0);
  assert.deepEqual(listed.note().computed.value, ["000000185", "000000184"]);
  assert.deepEqual(listed.note().computed.unresolved, ["4 rows need their detail and were not read"]);
});

test("a computation by group over a dated list its filters narrowed: rows the screen can't settle are judged by the filters", async () => {
  // admin 290 as the live run read it: twenty canceled orders on one page, their dates in no one order (the grid is
  // filtered), a spec that restates the task as a condition, and a Drex screen that settles no row of it
  const names = ["Lily Potter", "Julia Williams", "Sam Lee", "Lily Potter", "Grace Nguyen"];
  const header = ["ID", "Purchase Date", "Bill-to Name", "Status"];
  const orders = Array.from({ length: 20 }, (_, i) => {
    const id = `0000003${String(i).padStart(2, "0")}`;
    const cells = [id, `${1 + ((i * 7) % 12)}/${1 + ((i * 5) % 27)}/22`, names[i % 5], "Canceled"];
    return row(
      cells.join(" "),
      header.map((h, k) => [h, cells[k]]),
      { href: `${SITE}/order/${id}`, linkText: id },
    );
  });
  const task = "SKUs in the most recent cancelled orders of the customer who has the most cancellations";
  const f = fixture({
    task,
    contract: {
      intent: "objective_optimum",
      constraints: ["order status is cancelled", "customer has the most cancellations in the order history"],
      objective: "most recent cancelled order of that customer",
      objective_field: "date",
      scope: "order history",
      sort_direction: "desc",
      ranked_count: 1,
    },
    pages: [orders],
    text: "20 records found",
    spec: {
      ...NO_SPEC,
      op: "argmax",
      group_by: "bill-to name",
      output: "id",
      filters: [{ field: "status", op: "eq", value: "Canceled" }],
      semantic_constraints: [task],
    },
    verdict: () => "needs_detail",
  });
  await runWithTabs(f);
  assert.deepEqual(eventsNamed(f, "collection_lite"), [{ ordered: false, page: `${SITE}/orders?p=1` }]);
  assert.equal(f.calls.opened.length, 0);
  const note = f.note();
  assert.equal(note.computed.value, "Lily Potter");
  assert.equal(note.computed.rows_total, 20);
  // the value is computed over the rows the note keeps as matches
  assert.equal(note.matches.length, note.computed.rows_total);
  assert.deepEqual(note.computed.unresolved, ["20 rows the screen couldn't settle were judged by the spec's filters"]);
});

test("a single top item's top spec still scans past a first row that fails, to the first qualifying one", async () => {
  const bags = ["Leather Wallet $99.00", "Leather Tote Bag $80.00", "Canvas Bag $40.00"].map((text) => row(text));
  const f = fixture({
    task: "What is the most expensive bag?",
    contract: {
      intent: "objective_optimum",
      constraints: ["is a bag"],
      objective: "most expensive",
      objective_field: "price",
      scope: "the store's bags",
      sort_direction: "desc",
      ranked_count: 1,
    },
    pages: [bags],
    spec: { ...NO_SPEC, op: "top", limit: 1, semantic_constraints: ["is a bag"] },
    verdict: (text) => (text.includes("Bag") ? "qualifies" : "fails"),
  });
  await run(f);
  const note = f.note();
  assert.equal(note.answer.row, bags[1].text);
  assert.deepEqual(note.computed.value, [bags[1].text]);
  assert.match(note.order, /the first match is the answer$/);
});

// orders by grand total, most first: two of the five canceled
const BY_TOTAL = [
  ["000000129", "Jun 5, 2023", "Julia Williams", "$1,234.56", "Complete"],
  ["000000126", "Mar 9, 2023", "Alex Martin", "$99.00", "Canceled"],
  ["000000127", "Apr 2, 2023", "Grace Nguyen", "$80.00", "Complete"],
  ["000000124", "Jan 4, 2023", "Lily Potter", "$75.10", "Canceled"],
  ["000000128", "May 1, 2023", "Jane Doe", "$40.00", "Complete"],
].map((cells) =>
  row(
    cells.join(" "),
    HEAD.map((h, i) => [h, cells[i]]),
  ),
);
const BY_TOTAL_CONTRACT = {
  intent: "objective_optimum",
  constraints: ["status is Canceled"],
  objective: "most expensive",
  objective_field: "grand total",
  scope: "the orders",
  sort_direction: "desc",
  ranked_count: 1,
};
const CANCELED = [{ field: "Status", op: "eq", value: "Canceled" }];

test("filters that decide every row: a list chosen from reads on to the row that passes them, with no Drex row screen", async () => {
  const f = fixture({
    task: "What is the grand total of the order billed to Lily Potter?",
    contract: { ...COUNT_CONTRACT, intent: "choose_qualified", constraints: ["bill-to name is Lily Potter"] },
    pages: orderPages(),
    text: "7 records found",
    spec: {
      ...NO_SPEC,
      op: "list",
      output: "Grand Total (Base)",
      filters: [{ field: "Bill-to Name", op: "eq", value: "Lily Potter" }],
    },
  });
  await run(f);
  assert.ok(!f.calls.drex.includes("rows"));
  const note = f.note();
  assert.equal(note.pages_read, 2);
  assert.deepEqual(
    note.matches.map((m) => m.row),
    [ORDERS[5].text],
  );
  assert.equal(note.ruled_out, 6);
  assert.deepEqual(note.computed.value, ["$75.10"]);
});

test("filters that decide every row: a single top item is the first row of the ordered list that passes them", async () => {
  const canceledOrders = (spec) =>
    fixture({
      task: "What is the ID of the most expensive canceled order?",
      contract: BY_TOTAL_CONTRACT,
      pages: [BY_TOTAL.slice(0, 3), BY_TOTAL.slice(3)],
      text: "5 records found",
      spec: { ...NO_SPEC, output: "ID", filters: CANCELED, ...spec },
    });
  // a top 1: the first row that passes the filters ends the scan, and it is the answer
  const f = canceledOrders({ op: "top", limit: 1 });
  await run(f);
  assert.equal(f.note().answer.row, BY_TOTAL[1].text);
  assert.deepEqual(f.note().computed.value, ["000000126"]);
  // an argmax with no group keeps to the single item too: the first row that passes the filters is the answer, and
  // the value agrees with it
  const g = canceledOrders({ op: "argmax", field: "Grand Total (Base)" });
  await run(g);
  const note = g.note();
  assert.equal(note.answer.row, BY_TOTAL[1].text);
  assert.deepEqual(
    note.matches.map((m) => m.row),
    [BY_TOTAL[1].text],
  );
  assert.equal(note.computed.value, "000000126");
});

test("filters that decide every row: a top N counts only the rows that pass them", async () => {
  const f = fixture({
    task: "What are the IDs of the 2 most expensive canceled orders?",
    contract: { ...BY_TOTAL_CONTRACT, ranked_count: 2 },
    pages: [BY_TOTAL.slice(0, 3), BY_TOTAL.slice(3)],
    text: "5 records found",
    spec: {
      ...NO_SPEC,
      op: "top",
      field: "Grand Total (Base)",
      output: "ID",
      order: "desc",
      limit: 2,
      filters: CANCELED,
    },
  });
  await run(f);
  const note = f.note();
  assert.deepEqual(
    note.matches.map((m) => m.row),
    [BY_TOTAL[1].text, BY_TOTAL[3].text],
  );
  assert.deepEqual(note.computed.value, ["000000126", "000000124"]);
  assert.equal(note.pages_read, 2);
  assert.equal(note.whole_list_read, true);
});

test("switches off: the note has no rows_read, count_shown or computed, and no aggregationSpec, records or screenRows call is made", async () => {
  const f = countFixture();
  await run(f, []);
  const note = f.note();
  assert.deepEqual(Object.keys(note), [
    "read_by",
    "contract",
    "order",
    "matches",
    "rows_checked",
    "ruled_out",
    "pages_read",
    "whole_list_read",
  ]);
  // the note main writes for this list, word for word
  assert.deepEqual(note, {
    read_by: "Drex judged each row against the task's conditions and screened the records it opened",
    contract: { intent: "enumerate_all", constraints: ["status is Canceled"], objective: "" },
    order: "not proven sorted: compare the matches",
    matches: [
      { source: `${SITE}/orders?p=1`, row: ORDERS[0].text, record: "" },
      { source: `${SITE}/orders?p=1`, row: ORDERS[3].text, record: "" },
      { source: `${SITE}/orders?p=2`, row: ORDERS[5].text, record: "" },
    ],
    rows_checked: 7,
    ruled_out: 4,
    pages_read: 2,
    whole_list_read: true,
  });
  assert.deepEqual(
    {
      aggregationSpec: f.calls.aggregationSpec.length,
      screenRows: f.calls.screenRows.length,
      records: f.calls.records,
      selectOption: f.calls.selectOption.length,
      selectValues: f.calls.selectValues.length,
    },
    { aggregationSpec: 0, screenRows: 0, records: 0, selectOption: 0, selectValues: 0 },
  );
  // the calls main makes for this list, and the events it logs
  assert.deepEqual(
    { items: f.calls.items, info: f.calls.info, look: f.calls.look, on: f.calls.on, act: f.calls.act },
    MAIN_CALLS,
  );
  assert.deepEqual(f.calls.drex, ["relevant", "rows", "rows"]);
  assert.deepEqual(
    f.events.map(([e]) => e),
    ["collection_contract", "collection_relevant", "collection_rows", "collection_rows", "collection_done"],
  );
  assert.deepEqual(eventsNamed(f, "collection_done"), [
    { lite: true, matches: 3, checked: 7, ruledOut: 4, pages: 2, firstHit: false, complete: true },
  ]);
});
const MAIN_CALLS = { items: 2, info: 2, look: 4, on: 8, act: 1 };

async function runWith(f, switches) {
  const prior = globalThis.chrome;
  globalThis.chrome = { tabs: { remove: async () => {} } };
  try {
    await run(f, switches);
  } finally {
    globalThis.chrome = prior;
  }
}

test("topNStop: the N most recent orders of a list proven in date order open only the first N details, with no spec", async () => {
  const f = fixture({
    task: "What are the IDs of my 4 most recent orders?",
    contract: RECENT_FOUR,
    pages: [datedOrders()],
  });
  await runWith(f, ["topNStop"]);
  assert.equal(f.calls.opened.length, 4);
  assert.equal(f.note().matches.length, 4);
  assert.deepEqual(f.calls.aggregationSpec, []); // the aggregate switch is off: no spec was asked
});

test("topNStop off: the same request reads the whole list as before", async () => {
  const f = fixture({
    task: "What are the IDs of my 4 most recent orders?",
    contract: RECENT_FOUR,
    pages: [datedOrders()],
  });
  await runWith(f, []);
  assert.equal(f.calls.opened.length, 6);
});

test("topNStop: a list not in date order is read whole", async () => {
  const shuffled = datedOrders().reverse();
  const f = fixture({
    task: "What are the IDs of my 4 most recent orders?",
    contract: RECENT_FOUR,
    pages: [shuffled],
  });
  await runWith(f, ["topNStop"]);
  assert.equal(f.calls.opened.length, 6);
});
