import { test } from "node:test";
import assert from "node:assert/strict";
import { LLM } from "../src/llm.ts";
import { streamed } from "./stream-fake.mjs";
const { collect } = await import(process.env.MACROS_SOURCE || "../src/macros.ts");
import {
  screenDetail,
  validateBatch,
  orderedFirstProof,
  orderedVerdicts,
  orderContradicted,
} from "../src/cheap-collection.ts";
const list = "http://owned.test/records";
const proofText = "Date descending. Page 1. All records.";
const contract = {
  intent: "objective_optimum",
  constraints: ["Target item"],
  objective: "latest",
  objective_field: "date",
  sort_direction: "desc",
  ranked_count: 1,
};
const preparation = {
  ready: true,
  sort_available: true,
  observed_sort_direction: "desc",
  steps: [],
  ordering: {
    field: "date",
    direction: "desc",
    starts_at_beginning: true,
    covers_requested_scope: true,
    evidence: ["Date descending.", "Page 1.", "All records."],
  },
};
function fixture(texts, kind = "enumerate_all") {
  let opened = [],
    batchCalls = 0,
    detailCalls = 0,
    href = "";
  const links = texts.map((_, i) => ({ href: list + "/" + i, text: "Record " + i }));
  const a = {
    task: "Find requested Target record",
    runOptions: { efficiency: { cheapCollection: true } },
    notes: {},
    index: 0,
    tabs: new Map(),
    agentTabId: 2,
    tabBindings: new Map(),
    totals: { drexMoves: 0 },
    check() {},
    log() {},
    llmCall: async (_p, fn) => fn(),
    llm: {
      collectionContract: async () => ({
        json: { ...contract, intent: kind },
      }),
      collectionPreparation: async () => ({ json: preparation }),
      collect: async (args) => {
        if (args.scope === "one_detail") {
          detailCalls++;
          throw Error("Unexpected per-detail Haiku");
        }
        return { json: { evidence: "Public list", complete: false, details: links.map((l) => l.href), next: "" } };
      },
      collectBatch: async ({ records }) => {
        batchCalls++;
        return {
          json: {
            records: records.map((r) => ({
              source_url: r.url,
              source_id: r.source_id,
              match: r.text.includes("Target") ? "match" : "no_match",
              complete: true,
              facts: [{ field: "observed", value: r.text, quote: r.text }],
            })),
          },
        };
      },
    },
    openDetailTab: async (href) => chrome.tabs.create({ url: href }),
    currentTab: async () => ({
      id: a.agentTabId,
      settle: async () => {},
      info: async () => ({
        url: a.agentTabId === 3 ? href : list,
        text: a.agentTabId === 3 ? texts[Number(href.split("/").at(-1))] : proofText,
      }),
      eval: async (expression) => (expression.includes("scrollHeight") ? true : { x: 0, y: 0 }),
      items: async () => [{ node: 7, text: "Records" }],
      on: async () => links,
    }),
    look: async (tab) => ({
      info: { url: tab.id === 3 ? href : list },
      els: links.map((l, i) => ({ role: "link", name: l.text, text: l.text, label: "E" + i, node: 10 + i })),
      off: [],
      img1: "raw",
      img2: "marked",
    }),
    drexCall: async (state) => {
      const payload = JSON.parse(state);
      const decision = payload.current_public_record.text.includes("Target") ? "match" : "no_match";
      return {
        answers: {
          match: { choice: decision, probabilities: { [decision]: 0.99 } },
          coverage: { choice: "complete", probabilities: { complete: 0.99 } },
        },
      };
    },
    read: async () => ({ replan: [{ kind: "read", goal: "Final official answer remains separate" }] }),
  };
  return {
    a,
    chrome: {
      tabs: {
        create: async (args) => {
          href = args.url;
          opened.push(href);
          return { id: 3 };
        },
        remove: async () => {},
      },
    },
    stats: () => ({ opened, batchCalls, detailCalls }),
  };
}
test("37 nonmatching public records and one match use one Haiku batch, keep rejected raw sources out of notes, never claim task success", async () => {
  const f = fixture([
    ...Array.from({ length: 37 }, (_, i) => "Other record " + i + " total 17.25"),
    "Target total 42.75",
  ]);
  const prior = globalThis.chrome;
  globalThis.chrome = f.chrome;
  try {
    const result = await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "records" });
    assert.equal(f.stats().opened.length, 38);
    assert.equal(f.stats().batchCalls, 1);
    assert.equal(f.stats().detailCalls, 0);
    assert.equal(f.a.totals.drexMoves, 0); // screening is a classification call, not a move
    const memory = [...f.a.collectionMemory.values()][0];
    assert.equal(memory.raw.size, 38);
    assert.match(JSON.stringify([...memory.raw.values()]), /Other record 36 total 17.25/);
    assert.doesNotMatch(f.a.notes.records, /Other record 36 total 17.25/);
    assert.match(f.a.notes.records, /Target total 42.75/);
    assert.match(f.a.notes.records, /MODEL EXCLUSION/);
    assert.ok(result.replan);
  } finally {
    globalThis.chrome = prior;
  }
});
test("only proven ordered objective stops at first confirmed match; aggregates still scan later records", async () => {
  for (const kind of ["objective_optimum", "enumerate_all"]) {
    const f = fixture(["Other", "Target first", "Target later"], kind);
    const prior = globalThis.chrome;
    globalThis.chrome = f.chrome;
    try {
      await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "records" });
      assert.equal(f.stats().opened.length, kind === "objective_optimum" ? 2 : 3);
      assert.equal(f.stats().batchCalls, 1);
    } finally {
      globalThis.chrome = prior;
    }
  }
});
test("wrong field, missing first page or unsupported proof quotes forbid early exit", () => {
  assert.equal(orderedFirstProof(contract, preparation, { text: proofText }), true);
  for (const change of [
    { field: "price" },
    { starts_at_beginning: false },
    { evidence: ["Not actually on page"] },
    { covers_requested_scope: false },
  ]) {
    assert.equal(
      orderedFirstProof(
        contract,
        { ...preparation, ordering: { ...preparation.ordering, ...change } },
        { text: proofText },
      ),
      false,
    );
  }
  assert.equal(orderedFirstProof({ ...contract, intent: "enumerate_all" }, preparation, { text: proofText }), false);
  // a top-3 or a second-cheapest request isn't answered by the first qualifying row
  for (const ranked_count of [3, 0, undefined])
    assert.equal(orderedFirstProof({ ...contract, ranked_count }, preparation, { text: proofText }), false);
});
test("a confident negative cannot skip hidden content or incomplete detail coverage", async () => {
  let coverage = "incomplete";
  const agent = {
    task: "Target",
    totals: { drexMoves: 0 },
    log() {},
    drexCall: async () => ({
      answers: {
        match: { choice: "no_match", probabilities: { no_match: 0.99 } },
        coverage: { choice: coverage, probabilities: { [coverage]: 0.99 } },
      },
    }),
  };
  const args = {
    contract,
    info: { url: list, text: "Partial detail" },
    screen: { img1: "raw", img2: "marked" },
    options: { "click E1": "Reveal section" },
  };
  assert.equal((await screenDetail(agent, args)).decision, "need_more_information");
  coverage = "incomplete";
  assert.equal((await screenDetail(agent, { ...args, options: {} })).decision, "need_more_information");
});
test("batch values require exact source quote, known unique URL and every source accounted", () => {
  const records = [{ url: list + "/1", text: "Price 17.25" }];
  const valid = {
    records: [
      {
        source_url: list + "/1",
        complete: true,
        match: "match",
        facts: [{ field: "price", value: "17.25", quote: "Price 17.25" }],
      },
    ],
  };
  assert.equal(validateBatch(records, valid)[0].facts[0].value, "17.25");
  for (const change of [
    { source_url: list + "/2" },
    { facts: [{ field: "price", value: "19.25", quote: "Price 17.25" }] },
    { facts: [{ field: "price", value: "19.25", quote: "Price 19.25" }] },
  ])
    assert.throws(() => validateBatch(records, { records: [{ ...valid.records[0], ...change }] }));
  assert.throws(() => validateBatch(records, { records: [] }));
});
test("Max reveals needed content before one extraction batch; repeated unchanged state stays uncertain", async () => {
  for (const progresses of [true, false]) {
    const texts = ["Target summary"];
    const f = fixture(texts);
    const prior = globalThis.chrome;
    globalThis.chrome = f.chrome;
    let actions = 0;
    const normal = f.a.drexCall;
    f.a.drexCall = async (state) => {
      const p = JSON.parse(state);
      if (p.current_public_record.text === "Target summary")
        return {
          answers: {
            match: { choice: "need_more_information", probabilities: { need_more_information: 0.99 } },
            coverage: { choice: "incomplete", probabilities: { incomplete: 0.99 } },
            reveal: { choice: "scroll down", probabilities: { "scroll down": 0.99 } },
          },
        };
      return normal(state);
    };
    f.a.act = async () => {
      actions++;
      if (progresses) texts[0] = "Target full price 17.25";
    };
    let batchSources;
    f.a.llm.collectBatch = async ({ records }) => {
      batchSources = records;
      return {
        json: {
          records: records.map((r) => ({
            source_url: r.url,
            source_id: r.source_id,
            complete: !r.coverage_incomplete,
            match: r.coverage_incomplete ? "unknown" : "match",
            facts: [{ field: "observed", value: r.text, quote: r.text }],
          })),
        },
      };
    };
    try {
      await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "records" });
      assert.equal(actions, 1);
      assert.equal(f.stats().detailCalls, 0);
      assert.equal(batchSources.length, 1);
      assert.equal(batchSources[0].coverage_incomplete, !progresses);
      if (!progresses) {
        assert.match(f.a.notes.records, /REPEATED DETAIL STATE/);
        assert.match(
          JSON.parse(f.a.notes.records.split("\nCOLLECTION")[0])
            .sources.flatMap((s) => s.facts)
            .join("\n"),
          /"match":"unknown"/,
        );
        assert.match(f.a.notes.records, /COLLECTION COVERAGE COMPLETE: false/);
      }
    } finally {
      globalThis.chrome = prior;
    }
  }
});

test("a long detail page never grows the notes: raw text stays in memory, notes keep short facts", async () => {
  const pad = " filler".repeat(8000); // ~56k characters per detail page
  const f = fixture(["Other record A total 1.00" + pad, "Target record B total 2.00" + pad]);
  const prior = globalThis.chrome;
  globalThis.chrome = f.chrome;
  try {
    await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "records" });
    const memory = [...f.a.collectionMemory.values()][0];
    assert.ok([...memory.raw.values()].every((r) => r.text.length > 50000));
    assert.ok(f.a.notes.records.length < 8000, `notes grew to ${f.a.notes.records.length}`);
    assert.ok([...memory.sources.values()].every((facts) => [...facts].every((fact) => fact.length <= 1500)));
  } finally {
    globalThis.chrome = prior;
  }
});
test("a badly formatted batch is asked for once more, then fails the step with the reason instead of erroring", async () => {
  for (const goodSecond of [true, false]) {
    const f = fixture(["Target record total 2.00"]);
    const prior = globalThis.chrome;
    globalThis.chrome = f.chrome;
    let batches = 0;
    const good = f.a.llm.collectBatch;
    f.a.llm.collectBatch = async (args) => (++batches === 1 || !goodSecond ? { json: { records: [] } } : good(args));
    try {
      const out = await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "records" });
      assert.equal(batches, 2);
      if (goodSecond) assert.equal(out.fail, undefined);
      else {
        assert.match(out.fail, /didn't match their sources/);
        assert.notEqual(out.terminal, true);
      }
    } finally {
      globalThis.chrome = prior;
    }
  }
});

// A store list sorted by price, lowest first: each row is a product card with its own link.
const sortedURL = "http://owned.test/search?q=ssd&product_list_order=price&product_list_dir=asc";
const ssdContract = {
  intent: "objective_optimum",
  constraints: ["product type: SSD", "capacity at least 1TB"],
  objective: "least expensive",
  objective_field: "price",
  scope: "store listings",
  sort_direction: "asc",
  ranked_count: 1,
};
const sortedPreparation = {
  ready: true,
  evidence: "Sorted by price ascending",
  sort_available: true,
  observed_sort_direction: "asc",
  whole_list_on_page: false,
  steps: [],
  ordering: {
    field: "price",
    direction: "asc",
    starts_at_beginning: true,
    covers_requested_scope: true,
    evidence: ["product_list_dir=asc", "Sort By Price"],
  },
};
function sortedList(cards, verdicts, details = {}, listDetails = []) {
  const stats = { opened: [], batches: 0, collects: 0, preparations: 0, verifies: 0, screens: 0 };
  let href = "",
    url = sortedURL,
    scroll = { x: 0, y: 0 };
  const links = cards.map((text, i) => ({ href: `http://owned.test/p/${i}.html`, text: text.split(" $")[0] }));
  const a = {
    task: "View the least expensive SSD with at least 1TB",
    runOptions: { efficiency: { cheapCollection: true } },
    notes: {},
    index: 0,
    tabs: new Map(),
    agentTabId: 2,
    tabBindings: new Map(),
    totals: { drexMoves: 0 },
    check() {},
    log() {},
    llmCall: async (_p, fn) => fn(),
    llm: {
      collectionContract: async () => ({ json: ssdContract }),
      collectionPreparation: async () => {
        stats.preparations++;
        return { json: sortedPreparation };
      },
      collect: async (args) => {
        stats.collects++;
        assert.deepEqual(args.ordered, { field: "price", direction: "asc" });
        return {
          json: {
            evidence: "Page 1 of results",
            complete: false,
            details: listDetails,
            next: "",
            ordered_rows: verdicts,
          },
        };
      },
      collectBatch: async ({ records }) => {
        stats.batches++;
        return {
          json: {
            records: records.map((r) => ({
              source_url: r.url,
              source_id: r.source_id,
              complete: true,
              match: /1TB|2TB/.test(r.text) ? "match" : "no_match",
              facts: [{ field: "capacity", value: r.text, quote: r.text }],
            })),
          },
        };
      },
    },
    openDetailTab: async (to) => {
      href = to;
      stats.opened.push(to);
      return { id: 3 };
    },
    currentTab: async () => ({
      id: a.agentTabId,
      settle: async () => {},
      detach: async () => {},
      info: async () =>
        a.agentTabId === 3
          ? { url: href, text: details[href] ?? "", chars: (details[href] ?? "").length }
          : { url, text: "Sort By Price. Items 1-4 of 900. " + cards.join(" "), chars: 9000 },
      eval: async () => scroll,
      items: async () => cards.map((text, i) => ({ node: 100 + i, text })),
      on: async (node) => (node >= 100 ? [links[node - 100]] : null),
    }),
    look: async () => ({
      info: { url },
      els: links.map((l, i) => ({ role: "link", name: l.text, text: l.text, label: "E" + i, node: 10 + i })),
      off: [],
      img1: "raw",
      img2: "marked",
    }),
    drexCall: async (state) => {
      stats.screens++;
      const decision = /1TB|2TB/.test(JSON.parse(state).current_public_record.text) ? "match" : "no_match";
      return {
        answers: {
          match: { choice: decision, probabilities: { [decision]: 0.99 } },
          coverage: { choice: "complete", probabilities: { complete: 0.99 } },
        },
      };
    },
    read: async () => {
      stats.verifies++;
      return { replan: [{ kind: "read", goal: "Check the whole collection" }] };
    },
  };
  return { a, stats, moveTo: (to) => (url = to), scrollTo: (x, y) => (scroll = { x, y }) };
}
async function withChrome(work) {
  const prior = globalThis.chrome;
  globalThis.chrome = { tabs: { remove: async () => {} } };
  try {
    return await work();
  } finally {
    globalThis.chrome = prior;
  }
}
test("a list verified sorted by the objective stops at its first row that meets every constraint", async () => {
  const cards = [
    "Wireless earbuds $0.99",
    "Seagate 2TB HDD $20.00",
    "Portable SSD 2TB $35.99",
    "Samsung SSD 1TB $60.00",
  ];
  const f = sortedList(cards, [
    { row: 0, verdict: "fails", quote: "Wireless earbuds" },
    { row: 1, verdict: "fails", quote: "HDD" },
    { row: 2, verdict: "qualifies", quote: "Portable SSD 2TB" },
  ]);
  const out = await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
  assert.deepEqual(out, {});
  assert.deepEqual(f.stats, { opened: [], batches: 0, collects: 1, preparations: 1, verifies: 0, screens: 0 });
  assert.match(f.a.notes.ssd, /FIRST QUALIFIED IN VERIFIED ORDER/);
  assert.match(f.a.notes.ssd, /Portable SSD 2TB \$35.99/);
  assert.doesNotMatch(f.a.notes.ssd, /Samsung SSD 1TB \$60.00"/);
});
test("a sorted list followed by a page jump instead of its next page proves no first row after the jump", async () => {
  for (const [label, first] of [
    ["3", false],
    ["»", false],
    ["Next", true],
  ]) {
    const cards = ["Wireless earbuds $0.99", "Seagate 2TB HDD $20.00", "Portable SSD 2TB $35.99"];
    const f = sortedList(cards, [
      { row: 0, verdict: "fails", quote: "Wireless earbuds" },
      { row: 1, verdict: "fails", quote: "HDD" },
      { row: 2, verdict: "fails", quote: "Portable SSD" },
    ]);
    const pager = { role: "link", name: label, text: label, label: "E9", node: 50 };
    pager.paginationURL = "http://owned.test/list?p=3";
    pager.paginationLabel = label === "3" ? "Page 3" : label;
    const look = f.a.look;
    f.a.look = async (...args) => {
      const seen = await look(...args);
      return { ...seen, els: [...seen.els, pager] };
    };
    let page = 1;
    const collectPage = f.a.llm.collect;
    f.a.llm.collect = async (args) => {
      if (page === 1) {
        const r = await collectPage(args);
        return { json: { ...r.json, next: "open page E9" } };
      }
      assert.equal(!!args.ordered, first, label); // after a jump the rows are no longer read as the sorted list
      const verdicts = [{ row: 0, verdict: "qualifies", quote: "Wireless earbuds" }];
      return { json: { evidence: "Page 3", complete: false, details: [], next: "", ordered_rows: verdicts } };
    };
    const screen = f.a.drexCall;
    f.a.drexCall = async (state, schema, images) =>
      schema?.move
        ? { answers: { move: { choice: "open page E9", probabilities: { "open page E9": 0.99 } } } }
        : screen(state, schema, images);
    f.a.act = async () => {
      page = 2;
      f.moveTo(pager.paginationURL);
      return { dispatched: true };
    };
    await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
    assert.equal(/FIRST QUALIFIED IN VERIFIED ORDER/.test(f.a.notes.ssd), first, label);
    assert.equal(f.stats.verifies, first ? 0 : 1, label);
  }
});
test("a sorted row that doesn't show a constraint is settled by its detail page before the scan goes on", async () => {
  const cards = ["Wireless earbuds $0.99", "Portable SSD $19.99", "Portable SSD $35.99", "Samsung SSD 1TB $60.00"];
  const f = sortedList(
    cards,
    [
      { row: 0, verdict: "fails", quote: "earbuds" },
      { row: 1, verdict: "needs_detail", quote: "Portable SSD" },
      { row: 2, verdict: "needs_detail", quote: "Portable SSD" },
      { row: 3, verdict: "qualifies", quote: "SSD 1TB" },
    ],
    { "http://owned.test/p/1.html": "Portable SSD 512GB", "http://owned.test/p/2.html": "Portable SSD capacity 2TB" },
  );
  await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
  assert.deepEqual(f.stats.opened, ["http://owned.test/p/1.html", "http://owned.test/p/2.html"]);
  assert.equal(f.stats.screens, 2); // Drex screens each detail
  assert.equal(f.stats.batches, 1); // only the match is extracted, with quotes from its page
  const sources = [...[...f.a.collectionMemory.values()][0].sources.values()].flatMap((facts) => [...facts]);
  assert.match(sources.join("\n"), /MODEL EXCLUSION/);
  assert.match(f.a.notes.ssd, /"earlier_records_ruled_out":1/); // the notes lead with the answer, not the exclusions
  assert.equal(f.stats.verifies, 0);
  assert.match(f.a.notes.ssd, /FIRST QUALIFIED IN VERIFIED ORDER[^\n]*p\/2\.html/);
});
test("verdicts that skip a row or quote words the row doesn't have prove nothing: the list is read the ordinary way", async () => {
  for (const verdicts of [
    [
      { row: 0, verdict: "fails", quote: "Wireless earbuds" },
      { row: 2, verdict: "qualifies", quote: "Portable SSD 2TB" },
    ],
    [
      { row: 0, verdict: "fails", quote: "Wireless earbuds" },
      { row: 1, verdict: "qualifies", quote: "Samsung SSD 4TB" },
    ],
    undefined,
  ]) {
    const f = sortedList(["Wireless earbuds $0.99", "Seagate 2TB HDD $20.00", "Portable SSD 2TB $35.99"], verdicts);
    const out = await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
    assert.ok(out.replan); // the ordinary end: the whole-collection check
    assert.equal(f.stats.verifies, 1);
    assert.doesNotMatch(f.a.notes.ssd, /FIRST QUALIFIED/);
  }
});
test("once the ordered scan gives up, the ordinary read claims no first match: it ends with the whole-collection check", async () => {
  const href = (i) => `http://owned.test/p/${i}.html`;
  // the rows' prices run against the claimed ascending order
  const contradicted = sortedList(
    ["Samsung SSD 2TB $90.00", "Portable SSD 1TB $60.00", "Crucial SSD 1TB $40.00"],
    [{ row: 0, verdict: "qualifies", quote: "Samsung SSD 2TB" }],
    { [href(0)]: "Samsung SSD 2TB", [href(1)]: "Portable SSD 1TB", [href(2)]: "Crucial SSD 1TB" },
    [href(0), href(1), href(2)],
  );
  // row 0's detail, opened by the scan, doesn't settle it (its extraction is incomplete); row 1 matches
  const unsettled = sortedList(
    ["Portable SSD $19.99", "Portable SSD 2TB $35.99"],
    [{ row: 0, verdict: "needs_detail", quote: "Portable SSD" }],
    { [href(0)]: "Portable SSD 1TB maybe", [href(1)]: "Portable SSD 2TB" },
    [href(0), href(1)],
  );
  // Drex isn't sure of row 0 either (a sure Drex match would settle it when the extraction can't)
  const screen = unsettled.a.drexCall;
  unsettled.a.drexCall = async (state) => {
    const r = await screen(state);
    if (/maybe/.test(JSON.parse(state).current_public_record.text))
      r.answers.match = { choice: "match", probabilities: { match: 0.6 } };
    return r;
  };
  const extract = unsettled.a.llm.collectBatch;
  unsettled.a.llm.collectBatch = async (args) => {
    const r = await extract(args);
    for (const record of r.json.records)
      if (record.source_id === href(0)) Object.assign(record, { complete: false, match: "unknown" });
    return r;
  };
  for (const f of [contradicted, unsettled]) {
    const out = await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
    assert.ok(out.replan);
    assert.equal(f.stats.verifies, 1);
    assert.doesNotMatch(f.a.notes.ssd, /FIRST QUALIFIED/);
  }
  // the ordinary read opens the unsettled detail again, where its reveal options may show what the scan's screen missed
  assert.equal(unsettled.stats.opened.filter((url) => url === href(0)).length, 2);
});
test("a detail the ordered scan left open and the ordinary read settles still makes no later row first", async () => {
  const href = (i) => `http://owned.test/p/${i}.html`;
  for (const second of ["no_match", "match"]) {
    const f = sortedList(
      ["Portable SSD $19.99", "Portable SSD 2TB $35.99"],
      [{ row: 0, verdict: "needs_detail", quote: "Portable SSD" }],
      { [href(0)]: "Portable SSD 1TB maybe", [href(1)]: "Portable SSD 2TB" },
      [href(0), href(1)],
    );
    // Drex isn't sure of row 0 either (a sure Drex match would settle it when the extraction can't)
    const screen = f.a.drexCall;
    f.a.drexCall = async (state) => {
      const r = await screen(state);
      if (/maybe/.test(JSON.parse(state).current_public_record.text))
        r.answers.match = { choice: "match", probabilities: { match: 0.6 } };
      return r;
    };
    // the scan's extraction of row 0's detail leaves it open; the ordinary read's settles it
    let reads = 0;
    const extract = f.a.llm.collectBatch;
    f.a.llm.collectBatch = async (args) => {
      const r = await extract(args);
      for (const record of r.json.records)
        if (record.source_id === href(0))
          Object.assign(record, reads++ ? { complete: true, match: second } : { complete: false, match: "unknown" });
      return r;
    };
    const out = await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
    assert.equal(reads, 2);
    assert.ok(out.replan);
    assert.equal(f.stats.verifies, 1);
    assert.doesNotMatch(f.a.notes.ssd, /FIRST QUALIFIED/);
  }
});
test("a detail the ordered scan found off the site is not opened again by the ordinary read", async () => {
  const href = (i) => `http://owned.test/p/${i}.html`;
  // the page reading lists the off-site row among its details, or leaves it out of them; either way it claims it is
  // complete, so only the skipped row's record stands between it and a full-coverage claim
  for (const listed of [[href(0), href(1)], [href(1)]]) {
    const f = sortedList(
      ["Portable SSD $19.99", "Portable SSD 2TB $35.99"],
      [{ row: 0, verdict: "needs_detail", quote: "Portable SSD" }],
      { [href(1)]: "Portable SSD 2TB" },
      listed,
    );
    const read = f.a.llm.collect;
    f.a.llm.collect = async (args) => {
      const r = await read(args);
      return { ...r, json: { ...r.json, complete: true } };
    };
    const open = f.a.openDetailTab;
    f.a.openDetailTab = async (to) => open(to === href(0) ? "http://elsewhere.test/p/0.html" : to);
    const out = await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
    assert.deepEqual(f.stats.opened, ["http://elsewhere.test/p/0.html", href(1)]);
    assert.notEqual(out.why, "Detail left source origin");
    assert.equal(out.replan?.[0].goal, "Check the whole collection");
    assert.equal(f.stats.verifies, 1);
    // the skipped row stays on record as unread, and the collection claims no full coverage over it
    const notes = JSON.parse(f.a.notes.ssd.split("\nCOLLECTION COVERAGE COMPLETE")[0]);
    const row0 = notes.sources.find((s) => s.source_id === href(0));
    assert.ok(row0, "the off-site row is on record");
    assert.match(row0.facts.join(" "), /DETAIL LEFT SOURCE ORIGIN: not read/);
    assert.match(f.a.notes.ssd, /COLLECTION COVERAGE COMPLETE: false/);
    assert.doesNotMatch(f.a.notes.ssd, /FIRST QUALIFIED/);
  }
});
test("a list of only View buttons whose prices run against the claimed order claims no first match", async () => {
  const cards = ["Samsung SSD 2TB $90.00", "Portable SSD 1TB $60.00", "Crucial SSD 1TB $40.00"];
  const f = sortedList(cards, [{ row: 0, verdict: "qualifies", quote: "Samsung SSD 2TB" }]);
  // no row group: each card is a row only through its read-only "View details" button
  const currentTab = f.a.currentTab;
  f.a.currentTab = async () => {
    const tab = await currentTab();
    return {
      ...tab,
      items: async () => [],
      on: async (node) => (node >= 200 ? { href: "", context: cards[node - 200] } : tab.on(node)),
    };
  };
  const look = f.a.look;
  f.a.look = async (tab) => ({
    ...(await look(tab)),
    els: cards.map((_, i) => ({
      role: "button",
      name: "View details",
      text: "View details",
      label: "B" + i,
      node: 200 + i,
    })),
  });
  const out = await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
  assert.ok(out.replan);
  assert.equal(f.stats.verifies, 1);
  assert.doesNotMatch(f.a.notes.ssd, /FIRST QUALIFIED/);
});
test("View-button cards whose prices run against the claimed order claim no first match beside another list", async () => {
  const cards = ["Samsung SSD 2TB $90.00", "Portable SSD 1TB $60.00", "Crucial SSD 1TB $40.00"];
  const sidebar = ["Laptops", "Monitors", "Storage", "Printers", "Cameras", "Phones"];
  const verdicts = [
    ...sidebar.map((text, row) => ({ row, verdict: "fails", quote: text })),
    { row: sidebar.length, verdict: "qualifies", quote: "Samsung SSD 2TB" },
  ];
  const f = sortedList(cards, verdicts);
  // the row group found is a category sidebar without prices; the cards are rows only through "View details" buttons
  const currentTab = f.a.currentTab;
  f.a.currentTab = async () => {
    const tab = await currentTab();
    return {
      ...tab,
      items: async () => sidebar.map((text, i) => ({ node: 300 + i, text })),
      on: async (node) =>
        node >= 300
          ? [{ href: `http://owned.test/c/${node - 300}.html`, text: sidebar[node - 300] }]
          : node >= 200
            ? { href: "", context: cards[node - 200] }
            : tab.on(node),
    };
  };
  const look = f.a.look;
  f.a.look = async (tab) => ({
    ...(await look(tab)),
    els: [
      ...sidebar.map((name, i) => ({ role: "link", name, text: name, label: "S" + i, node: 300 + i })),
      ...cards.map((_, i) => ({
        role: "button",
        name: "View details",
        text: "View details",
        label: "B" + i,
        node: 200 + i,
      })),
    ],
  });
  await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
  assert.doesNotMatch(f.a.notes.ssd ?? "", /FIRST QUALIFIED/);
});
test("a sorted list with a row that has no link to open claims no first match from the rows after it", async () => {
  const href = (i) => `http://owned.test/p/${i}.html`;
  // the verdicts prove nothing, so the list is read the ordinary way; row 0, the cheapest, can't be opened
  const f = sortedList(
    ["Portable SSD 2TB $10.00", "Samsung SSD 1TB $20.00", "Crucial SSD 2TB $30.00"],
    undefined,
    { [href(1)]: "Samsung SSD 1TB", [href(2)]: "Crucial SSD 2TB" },
    [href(1), href(2)],
  );
  const currentTab = f.a.currentTab;
  f.a.currentTab = async () => {
    const tab = await currentTab();
    return { ...tab, on: async (node) => (node === 100 ? [] : tab.on(node)) };
  };
  const out = await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
  assert.ok(out.replan);
  assert.equal(f.stats.verifies, 1);
  assert.doesNotMatch(f.a.notes.ssd, /FIRST QUALIFIED/);
});
test("verdict lists are valid only in row order from the first, each quoting its own row", () => {
  const rows = [{ text: "Wireless  earbuds $0.99" }, { text: "Portable SSD 2TB $35.99" }, { text: "SSD 1TB" }];
  assert.deepEqual(
    orderedVerdicts(rows, [
      { row: 0, verdict: "fails", quote: "wireless earbuds" },
      { row: 1, verdict: "qualifies", quote: "SSD 2TB" },
    ]).map((v) => v.verdict),
    ["fails", "qualifies"],
  );
  assert.equal(orderedVerdicts(rows, [{ row: 0, verdict: "fails", quote: "earbuds" }]), null); // stops early with no qualifying row
  assert.equal(
    orderedVerdicts(rows, [
      { row: 0, verdict: "fails", quote: "earbuds" },
      { row: 1, verdict: "needs_detail", quote: "Portable SSD" },
    ]).length,
    2,
  ); // or at a row its detail must settle
  assert.equal(orderedVerdicts(rows, [{ row: 1, verdict: "qualifies", quote: "SSD 2TB" }]), null); // skips row 0
  // the row's words in another order still quote it
  assert.deepEqual(
    orderedVerdicts(rows, [
      { row: 0, verdict: "fails", quote: "earbuds, wireless" },
      { row: 1, verdict: "qualifies", quote: "2TB Portable SSD" },
    ]).map((v) => v.row),
    [0, 1],
  );
  // numbered from 1 is a list that skipped row 0, even when its quotes fit the rows before them
  const alike = [
    { text: "Samsung 870 EVO SSD 500GB" },
    { text: "Samsung 870 EVO SSD 2TB" },
    { text: "Crucial SSD 4TB" },
  ];
  assert.equal(
    orderedVerdicts(alike, [
      { row: 1, verdict: "fails", quote: "SSD" },
      { row: 2, verdict: "qualifies", quote: "SSD" },
    ]),
    null,
  );
  assert.equal(orderedVerdicts(alike, [{ row: 1, verdict: "qualifies", quote: "Samsung 870 EVO SSD" }]), null);
  // a row the model skipped: its next verdict, numbered for the row after, isn't taken for the skipped row's
  assert.equal(
    orderedVerdicts(rows, [
      { row: 0, verdict: "fails", quote: "earbuds" },
      { row: 2, verdict: "qualifies", quote: "SSD" },
    ]),
    null,
  );
  assert.equal(orderedVerdicts(rows, [{ row: 0, verdict: "fails", quote: "wired earbuds" }]), null);
  assert.equal(orderedVerdicts(rows, [{ row: 0, verdict: "maybe", quote: "earbuds" }]), null);
  assert.equal(orderedVerdicts(rows, [{ row: 0, verdict: "qualifies", quote: "" }]), null);
  assert.equal(orderedVerdicts(rows, "all fail"), null);
});
test("a list's preparation is checked once per list state: a replan back to it reuses it, a new address doesn't", async () => {
  const cards = ["Portable SSD 2TB $35.99"];
  const f = sortedList(cards, [{ row: 0, verdict: "qualifies", quote: "Portable SSD 2TB" }]);
  await withChrome(async () => {
    const again = async () => {
      f.a.collectionMemory = undefined; // not the answer this run already found: the preparation itself is what's checked
      await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" });
    };
    await again();
    await again();
    assert.equal(f.stats.preparations, 1);
    f.moveTo(sortedURL + "&cat=11");
    await again();
    assert.equal(f.stats.preparations, 2);
    // the same list scrolled elsewhere: where its ordering starts is checked again, not taken from the first check
    f.scrollTo(0, 900);
    await again();
    assert.equal(f.stats.preparations, 3);
    // page 2 loaded in place: the same address, controls and position, other rows
    f.scrollTo(0, 0);
    await again();
    assert.equal(f.stats.preparations, 4);
    cards.splice(0, 1, "Portable SSD 4TB $89.99");
    await again();
    assert.equal(f.stats.preparations, 5);
  });
});
test("a preparation that asked for repairs is checked again after them, even where the list's address and controls stay", async () => {
  const f = sortedList(["Portable SSD 2TB $35.99"], [{ row: 0, verdict: "qualifies", quote: "Portable SSD 2TB" }]);
  const unready = {
    ...sortedPreparation,
    ready: false,
    steps: [{ kind: "browse", goal: "Sort by price ascending with the Price column header" }],
  };
  f.a.llm.collectionPreparation = async () => ({ json: f.stats.preparations++ ? sortedPreparation : unready });
  await withChrome(async () => {
    const first = await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" });
    assert.ok(first.replan);
    // the header sorted the list in place: same address, same controls, same position
    const second = await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" });
    assert.equal(f.stats.preparations, 2);
    assert.deepEqual(second, {});
    assert.match(f.a.notes.ssd, /FIRST QUALIFIED IN VERIFIED ORDER/);
  });
});
test("an ordered list reading numbers the rows and asks for a verdict on each; contract and preparation name the field", async () => {
  const llm = streamed(new LLM({ key: "fixture" }));
  llm.client.messages.countTokens = async () => ({ input_tokens: 100 });
  const bodies = [];
  llm.client.messages.create = async (body) => {
    bodies.push(body);
    return {
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20 },
      content: [{ type: "text", text: JSON.stringify({ evidence: "", complete: false, details: [], next: "" }) }],
    };
  };
  const image = "data:image/png;base64,aW1hZ2U=";
  const info = { url: sortedURL, title: "Search", text: "Sort By Price", truncated: false, chars: 13 };
  const rows = [{ text: "Wireless earbuds $0.99" }, { text: "Portable SSD 2TB $35.99" }];
  await llm.collect({
    task: "t",
    notes: {},
    info,
    image,
    rows,
    options: {},
    contract: ssdContract,
    ordered: { field: "price", direction: "asc" },
  });
  await llm.collect({ task: "t", notes: {}, info, image, rows, options: {}, contract: ssdContract });
  await llm.collectionPreparation({ task: "t", contract: ssdContract, info, image, candidates: [] });
  await llm.collectionContract({ task: "t" });
  const [ordered, plain, preparation] = bodies.map((b) => b.output_config.format.schema.properties);
  // the first-row answer hangs on ranked_count: the model is always asked for it
  const contractSchema = bodies[3].output_config.format.schema;
  assert.equal(contractSchema.properties.ranked_count.type, "integer");
  assert.ok(contractSchema.required.includes("ranked_count"));
  assert.deepEqual(ordered.ordered_rows.items.properties.verdict.enum, ["fails", "qualifies", "needs_detail"]);
  assert.match(JSON.stringify(bodies[0].messages), /\\+"row\\+":1,/);
  assert.equal(plain.ordered_rows, undefined);
  assert.doesNotMatch(JSON.stringify(bodies[1].messages), /\\+"row\\+":1,/);
  assert.deepEqual(preparation.ordering.properties.field.enum, ["none", "other", "price"]);
});
test("a sort is proven by one quote found in the page text or address, with spacing and case evened out", () => {
  const page = { text: "Sort By\nPosition\nProduct Name\nPrice\nSet  Descending Direction", url: sortedURL };
  const ordering = (evidence) => ({ ...sortedPreparation, ordering: { ...sortedPreparation.ordering, evidence } });
  assert.equal(orderedFirstProof(ssdContract, ordering(["Sort By Price", "set descending direction"]), page), true);
  assert.equal(orderedFirstProof(ssdContract, ordering(["product_list_dir=asc"]), page), true);
  assert.equal(orderedFirstProof(ssdContract, ordering(["Sort By Price", "Lowest first"]), page), false);
  assert.equal(orderedFirstProof(ssdContract, ordering([]), page), false);
});
test("a price order the rows' own prices contradict is no order", () => {
  const rows = (...prices) => prices.map((p) => ({ text: `Item $${p} Add to Cart` }));
  assert.equal(orderContradicted(rows("1.00", "2.50", "2.50", "1,200.00"), "price", "asc"), false);
  assert.equal(orderContradicted(rows("1,799.95", "1,499.95", "550.00"), "price", "asc"), true);
  assert.equal(orderContradicted(rows("1,799.95", "1,499.95", "550.00"), "price", "desc"), false);
  assert.equal(orderContradicted(rows("9.00", "1.00"), "price", "asc"), true); // two rows are enough to tell
  assert.equal(orderContradicted(rows("1.00", "9.00"), "price", "asc"), false);
  assert.equal(orderContradicted(rows("9.00"), "price", "asc"), false); // one row is not
  assert.equal(orderContradicted(rows("3.00", "2.00", "1.00"), "release date", "asc"), false); // not a price
  // one step against the order is no longer let through unexplained: a $20 first row before a $10 one is no answer
  assert.equal(orderContradicted(rows("20", "10", "30", "40", "50", "60"), "price", "asc"), true);
  assert.equal(orderContradicted(rows("60", "50", "40", "70", "20", "10"), "price", "desc"), true);
  // a struck-out old price explains the step when its row also shows the sale price that keeps the order
  const sale = [{ text: "Item $20.00 $8.00" }, ...rows("10", "30", "40", "50", "60")];
  assert.equal(orderContradicted(sale, "price", "asc"), false);
  const saleDesc = [...rows("60", "50"), { text: "Item $70.00 $45.00" }, ...rows("30", "20", "10")];
  assert.equal(orderContradicted(saleDesc, "price", "desc"), false);
});
test("a detail the sorted scan ruled out is not read again when a replan brings the collection back", async () => {
  const cards = ["Portable SSD $19.99", "Portable SSD $35.99"];
  const f = sortedList(
    cards,
    [
      { row: 0, verdict: "needs_detail", quote: "Portable SSD" },
      { row: 1, verdict: "needs_detail", quote: "Portable SSD" },
    ],
    { "http://owned.test/p/0.html": "Portable SSD 512GB", "http://owned.test/p/1.html": "Portable SSD capacity 2TB" },
  );
  await withChrome(async () => {
    await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" });
    // a replan that loses the answer (a page change cleared it) reads the list again, but not the ruled-out detail
    const memory = [...f.a.collectionMemory.values()][0];
    memory.firstQualified = undefined;
    await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" });
    const before = f.stats.collects;
    // with the answer kept, the same question again reads nothing
    await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd_again" });
    assert.equal(f.stats.collects, before);
    assert.match(f.a.notes.ssd_again, /FIRST QUALIFIED IN VERIFIED ORDER[^\n]*p\/1\.html/);
  });
  assert.deepEqual(f.stats.opened, [
    "http://owned.test/p/0.html",
    "http://owned.test/p/1.html",
    "http://owned.test/p/1.html",
  ]);
});
test("rows left unjudged after one that needs its detail are each read through their details, in order", async () => {
  const f = sortedList(
    ["Order 1 $1.00", "Order 2 $2.00", "Order 3 $3.00"],
    [{ row: 0, verdict: "needs_detail", quote: "Order 1" }],
    { "http://owned.test/p/0.html": "Kosher meal", "http://owned.test/p/1.html": "SSD 2TB" },
  );
  await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
  assert.deepEqual(f.stats.opened, ["http://owned.test/p/0.html", "http://owned.test/p/1.html"]);
  assert.match(f.a.notes.ssd, /FIRST QUALIFIED IN VERIFIED ORDER[^\n]*p\/1\.html/);
});
test("in a sorted scan, a whole record page Drex is sure doesn't hold the item is ruled out without an extraction", async () => {
  const f = sortedList(["Order 1 $1.00", "Order 2 $2.00"], [{ row: 0, verdict: "needs_detail", quote: "Order 1" }], {
    "http://owned.test/p/0.html": "Kosher meal",
    "http://owned.test/p/1.html": "SSD 2TB",
  });
  f.a.drexCall = async (state) => {
    const decision = /2TB/.test(JSON.parse(state).current_public_record.text) ? "match" : "no_match";
    return {
      answers: {
        match: { choice: decision, probabilities: { [decision]: 0.96 } },
        coverage: { choice: "complete", probabilities: { complete: 0.8 } }, // complete, but under screenDetail's 0.9
      },
    };
  };
  await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
  assert.equal(f.stats.batches, 1); // only the match is extracted
  assert.match(f.a.notes.ssd, /FIRST QUALIFIED IN VERIFIED ORDER[^\n]*p\/1\.html/);
});
test("row dates: US, ISO and month-name forms; an order proven only by every row's date, page after page", async () => {
  const { rowDate, rowStamp, datesOrdered, lastStamp, laterPage, dateRanking } =
    await import("../src/cheap-collection.ts");
  assert.equal(rowDate("000000170 5/17/23 $365.42 Canceled"), 20230517);
  assert.equal(rowDate("Placed 2022-12-12 by Emma"), 20221212);
  assert.equal(rowDate("Order Date: December 12, 2022"), 20221212);
  assert.equal(rowDate("12 Dec 2022"), 20221212);
  assert.equal(rowDate("SSD 2TB $35.99"), null);
  assert.deepEqual(rowStamp("5/17/23 9:05 PM $1"), { day: 20230517, second: (21 * 60 + 5) * 60 });
  assert.deepEqual(rowStamp("May 17, 2023 at 12:30 am"), { day: 20230517, second: 30 * 60 });
  assert.deepEqual(rowStamp("2023-05-17T09:00:00Z"), { day: 20230517, second: 9 * 3600, zoned: true });
  // an ISO time keeps its seconds and is moved to UTC by its offset, its date with it
  assert.deepEqual(rowStamp("2023-05-17T09:00:59"), { day: 20230517, second: 9 * 3600 + 59 });
  assert.deepEqual(rowStamp("2023-05-17T10:00:00+02:00"), { day: 20230517, second: 8 * 3600, zoned: true });
  assert.deepEqual(rowStamp("2023-05-17T01:30:00.250+0300"), {
    day: 20230516,
    second: 22.5 * 3600 + 0.25,
    zoned: true,
  });
  assert.deepEqual(rowStamp("2023-05-17T09:00:59.5"), { day: 20230517, second: 9 * 3600 + 59.5 });
  assert.deepEqual(rowStamp("5/17/23 $9.05"), { day: 20230517, second: null });
  assert.deepEqual(rowStamp("5/17/23 12:00 PM"), { day: 20230517, second: 12 * 3600 });
  assert.deepEqual(rowStamp("2023-12-31T23:30:00-01:00"), { day: 20240101, second: 30 * 60, zoned: true });
  assert.deepEqual(rowStamp("2023-05-17 09:00:00+02:00"), { day: 20230517, second: 7 * 3600, zoned: true });
  // no time of day that can't be one; one followed by a range's end or an offset, after a time that isn't ISO, is unread
  for (const text of ["5/17/23 13:00 PM", "5/17/23 9:61"])
    assert.deepEqual(rowStamp(text), { day: 20230517, second: null }, text);
  for (const text of [
    "5/17/23 9:00-13:00",
    "5/17/23 09:00Z",
    "May 17, 2023 at 9:00 +02:00",
    "2023-05-17 09:00-17:00",
    "2023-05-17T09:00-23:00",
  ])
    assert.deepEqual(rowStamp(text), { day: 20230517, second: null, unread: true }, text);
  const rows = (...t) => t.map((text) => ({ text }));
  const day = (d) => ({ day: d, second: null });
  assert.equal(datesOrdered(rows("5/17/23", "5/2/23", "5/2/23", "3/11/23"), "desc"), true);
  // the same day's rows that show their times run the requested way by them too
  assert.equal(datesOrdered(rows("5/17/23 17:00", "5/17/23 09:00", "5/2/23"), "desc"), true);
  assert.equal(datesOrdered(rows("5/17/23 09:00", "5/17/23 17:00", "5/2/23"), "desc"), false);
  assert.equal(datesOrdered(rows("5/2/23 9:00 AM", "5/2/23 5:00 PM"), "asc"), true);
  // a row of the same day showing no time doesn't hide the times around it running the wrong way, on a page or across
  assert.equal(datesOrdered(rows("2023-05-17T09:00:00", "2023-05-17", "2023-05-17T17:00:00"), "desc"), false);
  assert.equal(datesOrdered(rows("2023-05-17T17:00:00", "2023-05-17", "2023-05-17T09:00:00"), "desc"), true);
  assert.equal(datesOrdered(rows("5/17/23 09:00", "5/17/23", "5/16/23 17:00"), "desc"), true);
  const end = lastStamp(rows("5/17/23 09:00", "5/17/23"));
  assert.deepEqual(end, { day: 20230517, second: 9 * 3600 });
  assert.equal(datesOrdered(rows("5/17/23 17:00"), "desc", end), false);
  assert.equal(datesOrdered(rows("5/17/23 08:00"), "desc", end), true);
  assert.deepEqual(lastStamp(rows("5/17/23", "no date"), { day: 20230517, second: 3600 }), {
    day: 20230517,
    second: 3600,
  });
  assert.deepEqual(lastStamp(rows("no date"), day(20230517)), day(20230517));
  // a UTC time isn't carried into a local row
  assert.deepEqual(lastStamp(rows("2023-05-17T09:00Z", "2023-05-17")), day(20230517));
  // seconds count, and a time with a UTC offset is compared in UTC, never with one that shows no offset
  assert.equal(datesOrdered(rows("2023-05-17T09:00:01Z", "2023-05-17T09:00:59Z"), "desc"), false);
  assert.equal(datesOrdered(rows("2023-05-17T09:00:59Z", "2023-05-17T09:00:01Z"), "desc"), true);
  // and so does a fraction of a second, for two rows within the same second
  assert.equal(datesOrdered(rows("2023-05-17T09:00:00.100Z", "2023-05-17T09:00:00.900Z"), "desc"), false);
  assert.equal(datesOrdered(rows("2023-05-17T09:00:00.900Z", "2023-05-17T09:00:00.100Z"), "desc"), true);
  assert.equal(datesOrdered(rows("2023-05-17T11:00:00.100+02:00", "2023-05-17T09:00:00.900Z"), "desc"), false);
  assert.equal(datesOrdered(rows("2023-05-17T09:00:00.100", "2023-05-17T09:00:00.900"), "asc"), true);
  assert.equal(datesOrdered(rows("2023-05-17T10:00:00+02:00", "2023-05-17T09:00:00Z"), "desc"), false);
  assert.equal(datesOrdered(rows("2023-05-17T09:00:00Z", "2023-05-17T10:00:00+02:00"), "desc"), true);
  assert.equal(datesOrdered(rows("2023-05-18T09:00:00Z", "2023-05-17T09:00:00"), "desc"), false);
  assert.equal(datesOrdered(rows("3/1/23 09:00"), "desc", { day: 20230301, second: 600 * 60 }), true);
  assert.equal(datesOrdered(rows("3/1/23 11:00"), "desc", { day: 20230301, second: 600 * 60 }), false);
  assert.equal(datesOrdered(rows("5/17/23", "6/2/23"), "desc"), false);
  // a delivery window's end is no UTC offset: the first window can't be moved to the next day to come out on top, and
  // windows of one day, or a time written with an offset that isn't ISO, don't show how that day's rows run
  assert.equal(datesOrdered(rows("5/17/23 20:00-06:00", "5/18/23 00:30-01:00"), "desc"), false);
  assert.equal(datesOrdered(rows("5/17/23 9:00-13:00", "5/17/23 14:00-18:00"), "desc"), false);
  assert.equal(datesOrdered(rows("5/17/23 09:00 Z", "5/17/23 17:00 Z"), "desc"), false);
  assert.equal(datesOrdered(rows("5/17/23 14:00", "5/17/23", "5/17/23 9:00-13:00"), "desc"), false);
  assert.equal(datesOrdered(rows("5/18/23 9:00-13:00", "5/17/23 14:00-18:00"), "desc"), true);
  // nor do the days of such times when an offset would move one of them across midnight: in UTC these run up
  assert.deepEqual(rowStamp("5/18/23 00:30+02:00"), { day: 20230518, second: null, unread: true, offsetDay: 20230517 });
  assert.equal(datesOrdered(rows("5/18/23 00:30+02:00", "5/17/23 23:30Z"), "desc"), false);
  assert.equal(datesOrdered(rows("5/17/23 23:30-02:00", "5/18/23 00:30Z"), "asc"), false);
  assert.equal(datesOrdered(rows("5/18/23 9:00", "5/17/23 23:30-02:00"), "desc"), false);
  assert.equal(datesOrdered(rows("5/18/23 00:30+02:00", "5/16/23 23:30Z"), "desc"), true);
  assert.equal(datesOrdered(rows("2023-05-17 09:00:00+02:00", "2023-05-17 17:00:00+02:00"), "desc"), false);
  // nor is one after a space-separated ISO time without seconds: these rows run up, not down
  assert.equal(datesOrdered(rows("2023-05-17 09:00-12:00", "2023-05-17 10:00-10:30"), "desc"), false);
  assert.equal(datesOrdered(rows("2023-05-17 22:00-08:00", "2023-05-18 01:00-02:00"), "desc"), false);
  assert.deepEqual(rowStamp("2023-05-17 09:00:00-05:00"), { day: 20230517, second: 14 * 3600, zoned: true });
  assert.equal(datesOrdered(rows("5/17/23", "no date"), "desc"), false);
  assert.equal(datesOrdered(rows("5/17/23"), "desc"), false);
  assert.equal(datesOrdered(rows("3/1/23", "2/1/23"), "desc", day(20230401)), true);
  assert.equal(datesOrdered(rows("3/1/23", "2/1/23"), "desc", day(20230201)), false);
  assert.equal(datesOrdered(rows("2/1/23"), "desc", day(20230301)), true); // a later page's one row carries on
  assert.equal(datesOrdered(rows("4/1/23"), "desc", day(20230301)), false);
  assert.equal(datesOrdered([], "desc", day(20230301)), false);
  assert.equal(laterPage("http://shop.test/sales/order/history/?p=2"), true);
  assert.equal(laterPage("http://shop.test/sales/order/history/?p=1&limit=20"), false);
  assert.equal(laterPage("http://shop.test/mail?start=0"), false);
  assert.equal(dateRanking({ intent: "objective_optimum", objective_field: "date", sort_direction: "desc" }), true);
  assert.equal(dateRanking({ intent: "objective_optimum", objective_field: "price", sort_direction: "asc" }), false);
  assert.equal(
    dateRanking({ intent: "objective_optimum", objective_field: "order date", sort_direction: "desc" }),
    true,
  );
  assert.equal(dateRanking({ intent: "objective_optimum", objective_field: "recent", sort_direction: "desc" }), true);
  for (const field of [
    "order_date",
    "created_at",
    "last ordered",
    "most recent order",
    "date placed",
    "last order date",
    "recently purchased",
    "most recently ordered",
    "date of purchase",
    "date/time",
    "transaction date",
    "message date",
    "date added",
    "release date",
    "createdAt",
    "oldest first",
    "newest first",
    "time",
  ])
    assert.equal(dateRanking({ intent: "objective_optimum", objective_field: field, sort_direction: "desc" }), true);
  // a duration or count that names a time isn't a record's date
  for (const field of [
    "delivery time",
    "runtime",
    "times purchased",
    "update count",
    "lifetime",
    "order",
    "most",
    "of at",
    "time of delivery",
    "processing time",
    "date count",
    "number of dates",
    "last name",
    "last 30 days",
    "",
    // another thing's date than the record's own, which the rows' first dates don't order, or no date at all
    "delivery date",
    "ship date",
    // a row's first date is its created or placed date, not when it was last changed
    "updated_at",
    "last updated",
    "date modified",
    "date of birth",
    "date range",
    "latest price",
    "most recent rating",
    "latest delivery time",
    "first name",
    "most at",
    // "most" ranks by a recency, never by an amount of time
    "most time",
    "most date",
  ])
    assert.equal(dateRanking({ intent: "objective_optimum", objective_field: field, sort_direction: "desc" }), false);
});
test("in a sorted scan, a record whose whole text Drex is very sure doesn't hold the item is ruled out despite a doubtful coverage glance", async () => {
  const f = sortedList(["Order 1 $1.00", "Order 2 $2.00"], [{ row: 0, verdict: "needs_detail", quote: "Order 1" }], {
    "http://owned.test/p/0.html": "Laptop",
    "http://owned.test/p/1.html": "SSD 2TB",
  });
  f.a.drexCall = async (state) => {
    const decision = /2TB/.test(JSON.parse(state).current_public_record.text) ? "match" : "no_match";
    return {
      answers: {
        match: { choice: decision, probabilities: { [decision]: decision === "match" ? 0.96 : 0.99 } },
        coverage: {
          choice: decision === "match" ? "complete" : "incomplete",
          probabilities: { complete: 0.95, incomplete: 0.59 },
        },
      },
    };
  };
  await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
  assert.equal(f.stats.batches, 1); // only the match is extracted
  assert.match(f.a.notes.ssd, /FIRST QUALIFIED IN VERIFIED ORDER[^\n]*p\/1\.html/);
  assert.match(f.a.notes.ssd, /capacity/); // the answer note carries the record's extracted facts
});
test("a record Drex's coverage reading is sure is incomplete stays open: no later record is called the first", async () => {
  const f = sortedList(["Order 1 $1.00", "Order 2 $2.00"], [{ row: 0, verdict: "needs_detail", quote: "Order 1" }], {
    "http://owned.test/p/0.html": "Laptop",
    "http://owned.test/p/1.html": "SSD 2TB",
  });
  f.a.drexCall = async (state) => {
    const decision = /2TB/.test(JSON.parse(state).current_public_record.text) ? "match" : "no_match";
    return {
      answers: {
        match: { choice: decision, probabilities: { [decision]: decision === "match" ? 0.96 : 0.99 } },
        coverage: {
          choice: decision === "match" ? "complete" : "incomplete",
          probabilities: decision === "match" ? { complete: 0.95 } : { incomplete: 0.95 },
        },
      },
    };
  };
  await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
  // the open record is never ruled out on Drex's word, so the order can't name a later one as the first
  assert.doesNotMatch(f.a.notes.ssd, /FIRST QUALIFIED/);
});
test("a list shown narrowed or past its start proves no date order from its rows", async () => {
  const { listNarrowed } = await import("../src/cheap-collection.ts");
  assert.equal(listNarrowed([{ role: "link", name: "Order #1" }]), false);
  assert.equal(
    listNarrowed([{ role: "link", paginationURL: "http://shop.test/h?p=1", paginationLabel: "Previous" }]),
    true,
  );
  assert.equal(
    listNarrowed([{ role: "link", paginationURL: "http://shop.test/h?p=3", paginationLabel: "Next" }]),
    false,
  );
  assert.equal(
    listNarrowed([{ role: "link", paginationURL: "http://shop.test/h?p=1", paginationLabel: "Page Previous" }]),
    true,
  );
  assert.equal(
    listNarrowed([{ role: "link", paginationURL: "http://shop.test/h?p=10", paginationLabel: "Page 10" }]),
    false,
  );
  // a list paged in place: its Previous button has no address, and is enabled only past the first page
  assert.equal(listNarrowed([{ role: "button", name: "Previous" }]), true);
  assert.equal(listNarrowed([{ role: "button", name: "‹ Prev page" }]), true);
  assert.equal(listNarrowed([{ role: "button", name: "Previous", state: " (disabled)" }]), false);
  assert.equal(listNarrowed([{ role: "link", name: "Previous orders" }]), false);
  assert.equal(listNarrowed([{ role: "checkbox", checked: true }]), true);
  assert.equal(listNarrowed([{ select: true, selectedIndex: 2, options: ["All", "Pending", "Complete"] }]), true);
  assert.equal(listNarrowed([{ select: true, selectedIndex: 1, options: ["10", "20", "50"] }]), false); // a page size
});
test("in a sorted scan, Drex's sure match stands with the record's text when the extraction can't answer validly twice", async () => {
  const f = sortedList(["Order 1 $1.00", "Order 2 $2.00"], [{ row: 0, verdict: "needs_detail", quote: "Order 1" }], {
    "http://owned.test/p/0.html": "Laptop",
    "http://owned.test/p/1.html": "Jiffy Corn Muffin Mix SSD 2TB",
  });
  let batches = 0;
  f.a.llm.collectBatch = async () => {
    batches++;
    return { json: { records: [] } }; // never addresses its source
  };
  const out = await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
  assert.deepEqual(out, {});
  assert.equal(batches, 2);
  assert.match(f.a.notes.ssd, /Drex matched it[^\n]*Jiffy Corn Muffin Mix/);
  assert.match(f.a.notes.ssd, /this row is the requested optimum/); // the note is whole, not cut short of its claim
});
test("in a sorted scan, Drex's unsure match does not stand when the extraction can't answer", async () => {
  const f = sortedList(["Order 1 $1.00", "Order 2 $2.00"], [{ row: 0, verdict: "needs_detail", quote: "Order 1" }], {
    "http://owned.test/p/0.html": "Laptop",
    "http://owned.test/p/1.html": "Jiffy Corn Muffin Mix SSD 2TB " + "order line ".repeat(400),
  });
  f.a.llm.collectBatch = async () => ({ json: { records: [] } });
  f.a.drexCall = async (state) => {
    const jiffy = /Jiffy/.test(JSON.parse(state).current_public_record.text);
    return {
      answers: {
        match: jiffy
          ? { choice: "match", probabilities: { match: 0.6, no_match: 0.4 } }
          : { choice: "no_match", probabilities: { no_match: 0.99 } },
        coverage: { choice: "complete", probabilities: { complete: 0.99 } },
      },
    };
  };
  await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" })).catch(() => {});
  assert.doesNotMatch(f.a.notes.ssd ?? "", /Drex matched it/);
});
test("a row the sorted scan opened but couldn't settle keeps a later match from counting as the first qualified", async () => {
  const f = sortedList(["Order 1 $1.00", "Order 2 $2.00"], [{ row: 0, verdict: "needs_detail", quote: "Order 1" }], {
    "http://owned.test/p/0.html": "Order with hidden items",
    "http://owned.test/p/1.html": "SSD 2TB",
  });
  // the reading asks for every row's detail, in order, so the ordinary walk alone would keep the first-match proof
  f.a.llm.collect = async () => ({
    json: {
      evidence: "Orders",
      complete: false,
      next: "",
      details: ["http://owned.test/p/0.html", "http://owned.test/p/1.html"],
      ordered_rows: [{ row: 0, verdict: "needs_detail", quote: "Order 1" }],
    },
  });
  f.a.llm.collectBatch = async ({ records }) => ({
    json: {
      records: records.map((r) => {
        const settled = /2TB/.test(r.text);
        return {
          source_url: r.url,
          source_id: r.source_id,
          complete: settled,
          match: settled ? "match" : "unknown",
          facts: settled ? [{ field: "capacity", value: "2TB", quote: "2TB" }] : [],
        };
      }),
    },
  });
  f.a.drexCall = async (state) => {
    const sure = /2TB/.test(JSON.parse(state).current_public_record.text);
    return {
      answers: {
        match: { choice: "match", probabilities: { match: sure ? 0.99 : 0.6 } },
        coverage: { choice: "complete", probabilities: { complete: 0.99 } },
      },
    };
  };
  await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
  // the scan opens row 0, which it can't settle; the ordinary walk opens it again with its reveal options, then row 1
  assert.deepEqual(f.stats.opened, [
    "http://owned.test/p/0.html",
    "http://owned.test/p/0.html",
    "http://owned.test/p/1.html",
  ]);
  assert.doesNotMatch(f.a.notes.ssd ?? "", /FIRST QUALIFIED IN VERIFIED ORDER/);
});
test("a row the sorted scan can't open keeps a later match from counting as the first qualified", async () => {
  const f = sortedList(["Order 1 $1.00", "Order 2 $2.00"], [{ row: 0, verdict: "needs_detail", quote: "Order 1" }], {
    "http://owned.test/p/1.html": "SSD 2TB",
  });
  const current = f.a.currentTab;
  f.a.currentTab = async () => {
    const tab = await current();
    const on = tab.on;
    return { ...tab, on: async (node) => (node === 100 ? [] : on(node)) }; // the first row shows no link
  };
  f.a.llm.collect = async () => ({
    json: {
      evidence: "Orders",
      complete: false,
      next: "",
      details: ["http://owned.test/p/1.html"],
      ordered_rows: [{ row: 0, verdict: "needs_detail", quote: "Order 1" }],
    },
  });
  await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
  assert.deepEqual(f.stats.opened, ["http://owned.test/p/1.html"]);
  assert.doesNotMatch(f.a.notes.ssd ?? "", /FIRST QUALIFIED IN VERIFIED ORDER/);
});
test("a list whose rows' prices contradict its claimed order gives no first qualified from the ordinary walk", async () => {
  const f = sortedList(["Laptop $1,799.95", "SSD 2TB $1,499.95", "Mouse $550.00"], null, {
    "http://owned.test/p/0.html": "Laptop",
    "http://owned.test/p/1.html": "SSD 2TB",
    "http://owned.test/p/2.html": "Mouse",
  });
  f.a.llm.collect = async () => ({
    json: {
      evidence: "Results",
      complete: false,
      next: "",
      details: [0, 1, 2].map((i) => `http://owned.test/p/${i}.html`),
    },
  });
  await withChrome(() => collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "ssd" }));
  assert.ok(f.stats.opened.includes("http://owned.test/p/1.html"));
  assert.doesNotMatch(f.a.notes.ssd ?? "", /FIRST QUALIFIED IN VERIFIED ORDER/);
});
