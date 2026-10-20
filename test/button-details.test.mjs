import { test } from "node:test";
import assert from "node:assert/strict";
const { collect } = await import(process.env.MACROS_SOURCE || "../src/macros.ts");
const url = "http://owned.test/orders";
function fixture(count = 37) {
  let selected = null,
    clicks = 0,
    batches = 0;
  const records = Array.from({ length: count }, (_, i) => ({
    context: "Order " + (1000 + i) + " Jan 2023",
    text: "Record " + (1000 + i) + " amount " + (i + 1) + ".00",
  }));
  const controls = records.map((r, i) => ({
    label: "E" + i,
    node: i + 1,
    role: "button",
    name: "View Order",
    text: "View Order",
    box: [0, i * 20, 100, 20],
  }));
  const tab = {
    id: 2,
    settle: async () => {},
    navigate: async (target) => {
      assert.equal(target, url);
      selected = null;
    },
    info: async () => ({ url, text: selected === null ? "Orders Jan 2023" : records[selected].text }),
    eval: async () => ({ x: 0, y: 0 }),
    items: async () => [],
    on: async (node) => ({ href: "", context: records[node - 1].context }),
  };
  const a = {
    task: "Sum January orders",
    index: 0,
    notes: {},
    runOptions: { efficiency: { cheapCollection: true } },
    totals: { drexMoves: 0 },
    check() {},
    log() {},
    currentTab: async () => tab,
    look: async () => ({ info: { url }, els: selected === null ? controls : [], off: [], img1: "raw", img2: "tagged" }),
    llmCall: async (_p, fn) => fn(),
    act: async (_t, action) => {
      clicks++;
      selected = action.el.node - 1;
      return { dispatched: true };
    },
    drexCall: async () => ({
      answers: {
        match: { choice: "match", probabilities: { match: 1 } },
        coverage: { choice: "complete", probabilities: { complete: 1 } },
      },
    }),
    llm: {
      collectionContract: async () => ({ json: { intent: "enumerate_all", constraints: [], scope: "January" } }),
      collectionPreparation: async () => ({ json: { ready: true, steps: [], sort_available: false } }),
      collect: async ({ rows }) => ({
        json: {
          evidence: "Visible records",
          complete: true,
          next: "",
          details: rows.flatMap((r) => (r.controls || []).map((c) => c.source_id)),
        },
      }),
      collectBatch: async ({ records }) => {
        batches++;
        return {
          json: {
            records: records.map((r) => ({
              source_id: r.source_id,
              source_url: r.url,
              match: "match",
              complete: true,
              facts: [{ field: "record", value: r.text, quote: r.text }],
            })),
          },
        };
      },
    },
    read: async () => ({ verified: true }),
  };
  return { a, stats: () => ({ clicks, batches, selected }) };
}
test("37 identical no-href View Order buttons retain distinct row identities at one AJAX URL across replans", async () => {
  const f = fixture();
  await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "orders" });
  assert.equal(f.stats().clicks, 37);
  assert.equal(f.stats().batches, 5);
  assert.equal(f.stats().selected, null);
  const memory = [...f.a.collectionMemory.values()][0];
  assert.equal(memory.completedDetails.size, 37);
  const details = [...memory.sources].filter(([id]) => id.startsWith("["));
  assert.equal(details.length, 37);
  assert.equal(memory.raw.size, 37); // raw detail text stays in memory, one copy per record
  assert.ok(details.every(([, facts]) => [...facts].every((f) => !f.includes("RAW PUBLIC DETAIL"))));
  await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "orders_again" });
  assert.equal(f.stats().clicks, 37, "Replan must not reopen completed controls");
});
test("interruption during screening preserves last raw record before a paid batch or another yield", async () => {
  const f = fixture(1);
  f.a.drexCall = async () => {
    throw Error("budget stop");
  };
  await assert.rejects(collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "orders" }), /budget stop/);
  assert.match(JSON.stringify([...[...f.a.collectionMemory.values()][0].raw.values()]), /Record 1000 amount 1.00/);
  assert.equal(f.stats().selected, null, "Restore list after interrupted read");
});
test("unknown dispatch never extracts or repeats a detail action", async () => {
  const f = fixture(1);
  f.a.act = async () => undefined;
  const out = await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "orders" });
  assert.ok(out.replan);
  assert.equal(f.a.totals.drexMoves, 0);
  assert.equal(f.stats().batches, 0);
});

test("shared URL records require matching source IDs and exact observed source URLs in extraction", async () => {
  const { validateBatch } = await import("../src/cheap-collection.ts");
  const records = [
    { url, source_id: "first", text: "Amount 1" },
    { url, source_id: "second", text: "Amount 2" },
  ];
  const items = records.map((r) => ({
    source_url: url,
    source_id: r.source_id,
    complete: true,
    match: "match",
    facts: [{ field: "amount", value: r.text, quote: r.text }],
  }));
  assert.equal(validateBatch(records, { records: items }).length, 2);
  assert.throws(() => validateBatch(records, { records: [items[0], items[0]] }));
  assert.throws(() =>
    validateBatch(records, { records: [items[0], { ...items[1], source_url: "http://foreign.test" }] }),
  );
});
test("a detail-button click is a macro move, not one of the LLM moves", async () => {
  const f = fixture(1);
  const whos = [];
  const act = f.a.act;
  f.a.act = async (...args) => {
    whos.push(args[5]);
    return act(...args);
  };
  await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "orders" });
  assert.deepEqual(whos, ["macro"]);
});
async function datedHistory(contract = {}, shownEls = []) {
  const dates = ["5/17/23", "5/2/23", "3/11/23", "12/12/22", "11/20/22"];
  const items = ["HP laptop", "Shea conditioner", "Coffee pods", "Bread Batard Olive", "Olive oil bread"];
  const f = fixture(dates.length);
  const rows = dates.map((d, i) => `Order 00000${170 - i} ${d} $${i + 10}.00 Complete View Order`);
  const tab = await f.a.currentTab();
  const on = tab.on;
  tab.items = async () => rows.map((text, i) => ({ node: 100 + i, text }));
  tab.on = async (node) => (node >= 100 ? [] : { ...(await on(node)), context: rows[node - 1] });
  const info = tab.info;
  tab.info = async () => {
    const shown = await info();
    const i = shown.text.match(/^Record (\d+)/)?.[1];
    return i ? { ...shown, text: `Order detail. Items ordered: ${items[Number(i) - 1000]}` } : shown;
  };
  const screened = [];
  f.a.drexCall = async (state) => {
    const text = JSON.parse(state).current_public_record.text;
    screened.push(text);
    const choice = /Olive/.test(text) ? "match" : "no_match";
    return {
      answers: {
        match: { choice, probabilities: { [choice]: 0.97 } },
        coverage: { choice: "complete", probabilities: { complete: 0.95 } },
      },
    };
  };
  let preparations = 0;
  f.a.llm.collectionContract = async () => ({
    json: {
      intent: "objective_optimum",
      constraints: ["item is olive bread"],
      objective: "most recent order date",
      objective_field: "date",
      sort_direction: "desc",
      ranked_count: 1,
      scope: "order history",
      ...contract,
    },
  });
  f.a.llm.collectionPreparation = async () => {
    preparations++;
    return { json: { ready: false, steps: [{ kind: "browse", goal: "Open each order" }], sort_available: false } };
  };
  f.a.llm.collect = async ({ rows: seen, ordered }) => {
    assert.deepEqual(ordered, { field: "date", direction: "desc" });
    assert.equal(seen.length, rows.length); // each button joined its own row: no extra records
    return { json: { evidence: "Orders, newest first", complete: false, next: "", details: [] } }; // no row verdicts
  };
  const look = f.a.look;
  f.a.look = async () => {
    const shown = await look();
    return { ...shown, els: [...shown.els, ...shownEls] };
  };
  return { f, preparations: () => preparations };
}
test("a date-ordered record list walks its rows' detail buttons newest first and stops at the first that holds the item", async () => {
  const { f, preparations } = await datedHistory();
  const out = await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "orders" });
  assert.deepEqual(out, {});
  assert.equal(preparations(), 0); // the rows' dates prove the order; no model is asked whether the list is ready
  assert.equal(f.stats().clicks, 4);
  assert.equal(f.stats().batches, 1); // only the match is extracted
  assert.match(f.a.notes.orders, /FIRST QUALIFIED IN VERIFIED ORDER[^\n]*12\/12\/22/);
  assert.equal(f.stats().selected, null);
});
for (const [why, contract, shown] of [
  ["a request for the top 3", { ranked_count: 3 }, []],
  ["a request without a count", { ranked_count: undefined }, []],
  [
    "a list shown past its start",
    {},
    [
      {
        label: "E9",
        role: "link",
        name: "Page Previous",
        paginationURL: url + "?p=1",
        paginationLabel: "Page Previous",
      },
    ],
  ],
  ["a list shown filtered", {}, [{ label: "E8", role: "checkbox", name: "Complete", checked: true }]],
])
  test(`the rows' dates prove no order for ${why}: the list's readiness is checked`, async () => {
    const { f, preparations } = await datedHistory(contract, shown);
    await collect.call(f.a, { kind: "collect", goal: f.a.task, save_as: "orders" });
    assert.equal(preparations(), 1);
    assert.deepEqual(f.stats(), { clicks: 0, batches: 0, selected: null }); // no row is walked as if in order
  });
for (const complete of [false, true])
  test(`a date-ordered list goes on to its next page by itself when its reading names none${complete ? " even calling itself complete" : ""}, and answers a repeat at once`, async () => {
    const { a, stats } = pagedOrders(complete, "Next");
    assert.deepEqual(await collect.call(a, { kind: "collect", goal: a.task, save_as: "orders" }), {});
    assert.deepEqual(stats, { collects: 2, screens: 5, clicks: 5, pages: 1 });
    assert.match(a.notes.orders, /^\{"answer":\{[^\n]*FIRST QUALIFIED IN VERIFIED ORDER[^\n]*12\/12\/22/);
    assert.deepEqual(await collect.call(a, { kind: "collect", goal: a.task, save_as: "again" }), {});
    assert.equal(stats.collects, 2); // the same question again is answered from what this run found
    assert.equal(a.notes.again, a.notes.orders);
  });
test("a date-ordered list goes on through a 'Next' that carries no pager label of its own", async () => {
  // a page reading leaves pagination_label empty, not missing, on what it didn't take for a pager link
  const { a, stats } = pagedOrders(true, "Next", "");
  assert.deepEqual(await collect.call(a, { kind: "collect", goal: a.task, save_as: "orders" }), {});
  assert.equal(stats.pages, 1);
  assert.match(a.notes.orders, /FIRST QUALIFIED IN VERIFIED ORDER[^\n]*12\/12\/22/);
});
for (const label of ["»", ">>", "Last"])
  test(`a date-ordered list isn't pushed on through a '${label}' jump that may skip pages`, async () => {
    const { a, stats } = pagedOrders(true, label);
    await collect.call(a, { kind: "collect", goal: a.task, save_as: "orders" });
    assert.deepEqual(stats, { collects: 1, screens: 3, clicks: 3, pages: 0 });
    assert.doesNotMatch(a.notes.orders, /FIRST QUALIFIED/);
  });
for (const [later, ordered] of [
  ["5/17/23 08:00", true],
  ["5/17/23 17:00", false],
])
  test(`a date-ordered list's next page carries on from the last time its day showed, past a row with none: ${later} ${ordered ? "follows" : "doesn't"}`, async () => {
    const { a, stats } = pagedOrders(true, "Next", "Next", [
      ["5/18/23", "5/17/23 09:00", "5/17/23"],
      [later, "12/12/22", "11/1/22"],
    ]);
    let wholeChecks = 0;
    a.read = async () => (wholeChecks++, {}); // a list its dates don't prove ordered is checked whole
    await collect.call(a, { kind: "collect", goal: a.task, save_as: "orders" });
    assert.equal(stats.pages, 1);
    assert.equal(wholeChecks, ordered ? 0 : 1);
    if (ordered) assert.match(a.notes.orders, /FIRST QUALIFIED IN VERIFIED ORDER[^\n]*12\/12\/22/);
    else assert.doesNotMatch(a.notes.orders ?? "", /FIRST QUALIFIED/);
  });
function pagedOrders(
  complete,
  nextLabel,
  pagerLabel = nextLabel,
  pages = [
    ["5/17/23", "5/2/23", "3/11/23"],
    ["12/20/22", "12/12/22", "11/1/22"],
  ],
) {
  {
    const base = "http://owned.test/orders";
    const items = ["Laptop", "Conditioner", "Coffee", "Tea", "Bread Batard Olive", "Olive bread"];
    let page = 0,
      detail = null;
    const at = () => (page ? base + "?p=2" : base);
    const rowsOf = (p) => pages[p].map((d, i) => `Order ${p * 3 + i} ${d} View Order`);
    const next = {
      label: "E9",
      name: nextLabel,
      text: `link '${nextLabel}'`,
      role: "link",
      box: [0, 300, 40, 20],
      paginationURL: base + "?p=2",
      paginationLabel: pagerLabel,
    };
    const tab = {
      id: 2,
      settle: async () => {},
      navigate: async (to) => {
        detail = null;
        page = to.includes("p=2") ? 1 : 0;
      },
      info: async () =>
        detail === null
          ? { url: at(), text: rowsOf(page).join(" ") }
          : { url: base + "/view/" + detail, text: "Items ordered: " + items[detail] },
      eval: async () => ({ x: 0, y: 0 }),
      items: async () => (detail === null ? rowsOf(page).map((text, i) => ({ node: 100 + i, text })) : []),
      on: async (node) => (node >= 100 ? [] : { href: "", context: rowsOf(page)[node - 1] }),
    };
    const controls = () =>
      [0, 1, 2].map((i) => ({ label: "E" + i, node: i + 1, role: "button", name: "View Order", text: "View Order" }));
    const stats = { collects: 0, screens: 0, clicks: 0, pages: 0 };
    const a = {
      task: "When did I last order olive bread?",
      index: 0,
      notes: {},
      runOptions: { efficiency: { cheapCollection: true } },
      totals: { drexMoves: 0 },
      check() {},
      log() {},
      currentTab: async () => tab,
      look: async () => ({
        info: { url: at() },
        els: detail === null ? [...controls(), ...(page === 0 ? [next] : [])] : [],
        off: [],
        img1: "raw",
        img2: "tagged",
      }),
      llmCall: async (_p, fn) => fn(),
      act: async (_t, action) => {
        if (action.kind === "navigate_page") {
          stats.pages++;
          page = 1;
        } else {
          stats.clicks++;
          detail = page * 3 + action.el.node - 1;
        }
        return { dispatched: true };
      },
      drexCall: async (state) => {
        stats.screens++;
        const choice = /Olive/.test(JSON.parse(state).current_public_record.text) ? "match" : "no_match";
        return {
          answers: {
            match: { choice, probabilities: { [choice]: 0.97 } },
            coverage: { choice: "complete", probabilities: { complete: 0.95 } },
          },
        };
      },
      llm: {
        collectionContract: async () => ({
          json: {
            intent: "objective_optimum",
            constraints: ["item is olive bread"],
            objective: "most recent order date",
            objective_field: "date",
            sort_direction: "desc",
            ranked_count: 1,
          },
        }),
        collectionPreparation: async () => assert.fail("the rows' dates prove the order"),
        collect: async () => {
          stats.collects++;
          return { json: { evidence: "Orders", complete, next: "", details: [] } };
        },
        collectBatch: async ({ records }) => ({
          json: {
            records: records.map((r) => ({
              source_id: r.source_id,
              source_url: r.url,
              match: "match",
              complete: true,
              facts: [{ field: "item", value: "Bread Batard Olive", quote: "Bread Batard Olive" }],
            })),
          },
        }),
      },
      read: async () => {
        assert.notEqual(nextLabel, "Next", "an ordered match needs no check of the whole collection");
        return {};
      },
    };
    return { a, stats };
  }
}
test("a settled date-ordered list called complete isn't pushed through a carousel's 'Next slide'", async () => {
  const base = "http://owned.test/orders";
  const rows = ["5/17/23", "5/2/23", "3/11/23"].map((d, i) => `Order ${i} ${d} View Order`);
  let detail = null;
  const slide = { label: "E9", node: 50, role: "button", name: "Next slide", text: "button 'Next slide'" };
  const tab = {
    id: 2,
    settle: async () => {},
    navigate: async () => {
      detail = null;
    },
    info: async () =>
      detail === null ? { url: base, text: rows.join(" ") } : { url: base + "/view/" + detail, text: "Items: Laptop" },
    eval: async () => ({ x: 0, y: 0 }),
    items: async () => (detail === null ? rows.map((text, i) => ({ node: 100 + i, text })) : []),
    // the slide button changes part of this page (aria-controls): a reveal, not another page of the list
    on: async (node) =>
      node === 50
        ? { href: "", role: "button", controls: "slides", expanded: false, pagination: false, tag: "BUTTON" }
        : node >= 100
          ? []
          : { href: "", context: rows[node - 1] },
  };
  const controls = [0, 1, 2].map((i) => ({
    label: "E" + i,
    node: i + 1,
    role: "button",
    name: "View Order",
    text: "View Order",
  }));
  const stats = { collects: 0, clicks: 0, slides: 0 };
  const a = {
    task: "When did I last order olive bread?",
    index: 0,
    notes: {},
    runOptions: { efficiency: { cheapCollection: true } },
    totals: { drexMoves: 0 },
    check() {},
    log() {},
    currentTab: async () => tab,
    look: async () => ({
      info: { url: base },
      els: detail === null ? [...controls, slide] : [],
      off: [],
      img1: "raw",
      img2: "tagged",
    }),
    llmCall: async (_p, fn) => fn(),
    act: async (_t, action) => {
      if (action.el?.node === 50) stats.slides++;
      else {
        stats.clicks++;
        detail = action.el.node - 1;
      }
      return { dispatched: true };
    },
    drexCall: async () => ({
      answers: {
        match: { choice: "no_match", probabilities: { no_match: 0.99 } },
        coverage: { choice: "complete", probabilities: { complete: 0.99 } },
      },
    }),
    llm: {
      collectionContract: async () => ({
        json: {
          intent: "objective_optimum",
          constraints: ["item is olive bread"],
          objective: "most recent order date",
          objective_field: "date",
          sort_direction: "desc",
          ranked_count: 1,
        },
      }),
      collectionPreparation: async () => assert.fail("the rows' dates prove the order"),
      collect: async () => {
        stats.collects++;
        return { json: { evidence: "Orders", complete: true, next: "", details: [] } };
      },
      collectBatch: async () => assert.fail("every order is ruled out by its screening"),
    },
    read: async () => ({}),
  };
  await collect.call(a, { kind: "collect", goal: a.task, save_as: "orders" });
  assert.deepEqual(stats, { collects: 1, clicks: 3, slides: 0 });
  assert.match(a.notes.orders, /COLLECTION COVERAGE COMPLETE: true/);
});
test("a detail button outside a date-ordered list's rows is never its first qualified record", async () => {
  const rows = ["5/17/23", "5/2/23", "3/11/23"].map((d, i) => `Order ${i} ${d} View Order`);
  const contexts = [...rows, "Sidebar reorder suggestion View Order"];
  const items = ["Laptop", "Coffee", "Tea", "Olive bread"];
  let detail = null;
  const tab = {
    id: 2,
    settle: async () => {},
    navigate: async () => {
      detail = null;
    },
    info: async () =>
      detail === null
        ? { url, text: rows.join(" ") }
        : { url: url + "/view/" + detail, text: "Items ordered: " + items[detail] },
    eval: async () => ({ x: 0, y: 0 }),
    items: async () => (detail === null ? rows.map((text, i) => ({ node: 100 + i, text })) : []),
    on: async (node) => (node >= 100 ? [] : { href: "", context: contexts[node - 1] }),
  };
  const controls = contexts.map((_, i) => ({
    label: "E" + i,
    node: i + 1,
    role: "button",
    name: "View Order",
    text: "View Order",
  }));
  const next = { label: "E9", role: "link", name: "Next", paginationURL: url + "?p=2", paginationLabel: "Next" };
  const a = {
    task: "When did I last order olive bread?",
    index: 0,
    notes: {},
    runOptions: { efficiency: { cheapCollection: true } },
    totals: { drexMoves: 0 },
    check() {},
    log() {},
    currentTab: async () => tab,
    look: async () => ({ info: { url }, els: detail === null ? [...controls, next] : [], off: [], img1: "raw" }),
    llmCall: async (_p, fn) => fn(),
    act: async (_t, action) => {
      detail = action.el.node - 1;
      return { dispatched: true };
    },
    drexCall: async (state) => {
      const choice = /Olive/.test(JSON.parse(state).current_public_record.text) ? "match" : "no_match";
      return {
        answers: {
          match: { choice, probabilities: { [choice]: 0.97 } },
          coverage: { choice: "complete", probabilities: { complete: 0.95 } },
        },
      };
    },
    llm: {
      collectionContract: async () => ({
        json: {
          intent: "objective_optimum",
          constraints: ["item is olive bread"],
          objective: "most recent",
          objective_field: "date",
          sort_direction: "desc",
          ranked_count: 1,
        },
      }),
      collectionPreparation: async () => assert.fail("the rows' dates prove the order"),
      // the reading judges the sidebar's button row too, after the list's own rows
      collect: async ({ rows: seen }) => ({
        json: {
          evidence: "Orders",
          complete: false,
          next: "",
          details: [],
          ordered_rows: seen.map((r, i) => ({ row: i, verdict: "needs_detail", quote: r.text.slice(0, 20) })),
        },
      }),
      collectBatch: async ({ records }) => ({
        json: {
          records: records.map((r) => ({
            source_id: r.source_id,
            source_url: r.url,
            match: "match",
            complete: true,
            facts: [{ field: "item", value: "Olive bread", quote: "Olive bread" }],
          })),
        },
      }),
    },
    read: async () => ({}),
  };
  await collect.call(a, { kind: "collect", goal: a.task, save_as: "orders" });
  assert.doesNotMatch(a.notes.orders ?? "", /FIRST QUALIFIED/);
});
test("past the dated scan's detail cap, the ordinary walk never takes a button outside the list as first qualified", async () => {
  // more rows than the ordered scan opens, so the ordinary walk reads the rest, the sidebar's button last
  const rows = Array.from({ length: 32 }, (_, i) => {
    const d = new Date(Date.UTC(2023, 11, 31) - i * 86400000).toISOString().slice(0, 10);
    return `Order ${i} ${d} View Order`;
  });
  const contexts = [...rows, "Sidebar reorder suggestion View Order"];
  const items = [...rows.map(() => "Coffee"), "Olive bread"];
  let detail = null;
  const tab = {
    id: 2,
    settle: async () => {},
    navigate: async () => {
      detail = null;
    },
    info: async () =>
      detail === null
        ? { url, text: rows.join(" ") }
        : { url: url + "/view/" + detail, text: "Items ordered: " + items[detail] },
    eval: async () => ({ x: 0, y: 0 }),
    items: async () => (detail === null ? rows.map((text, i) => ({ node: 1000 + i, text })) : []),
    on: async (node) => (node >= 1000 ? [] : { href: "", context: contexts[node - 1] }),
  };
  const controls = contexts.map((_, i) => ({
    label: "E" + i,
    node: i + 1,
    role: "button",
    name: "View Order",
    text: "View Order",
  }));
  const a = {
    task: "When did I last order olive bread?",
    index: 0,
    notes: {},
    runOptions: { efficiency: { cheapCollection: true } },
    totals: { drexMoves: 0 },
    check() {},
    log() {},
    currentTab: async () => tab,
    look: async () => ({ info: { url }, els: detail === null ? controls : [], off: [], img1: "raw" }),
    llmCall: async (_p, fn) => fn(),
    act: async (_t, action) => {
      detail = action.el.node - 1;
      return { dispatched: true };
    },
    drexCall: async (state) => {
      const choice = /Olive/.test(JSON.parse(state).current_public_record.text) ? "match" : "no_match";
      return {
        answers: {
          match: { choice, probabilities: { [choice]: 0.97 } },
          coverage: { choice: "complete", probabilities: { complete: 0.95 } },
        },
      };
    },
    llm: {
      collectionContract: async () => ({
        json: {
          intent: "objective_optimum",
          constraints: ["item is olive bread"],
          objective: "most recent",
          objective_field: "date",
          sort_direction: "desc",
          ranked_count: 1,
        },
      }),
      collectionPreparation: async () => assert.fail("the rows' dates prove the order"),
      collect: async ({ rows: seen }) => ({
        json: {
          evidence: "Orders",
          complete: false,
          next: "",
          details: seen.flatMap((r) => [...r.links.map((l) => l.href), ...(r.controls ?? []).map((c) => c.source_id)]),
          ordered_rows: seen.map((r, i) => ({ row: i, verdict: "needs_detail", quote: r.text.slice(0, 20) })),
        },
      }),
      collectBatch: async ({ records }) => ({
        json: {
          records: records.map((r) => ({
            source_id: r.source_id,
            source_url: r.url,
            match: "match",
            complete: true,
            facts: [{ field: "item", value: "Olive bread", quote: "Olive bread" }],
          })),
        },
      }),
    },
    read: async () => ({}),
  };
  await collect.call(a, { kind: "collect", goal: a.task, save_as: "orders" });
  assert.doesNotMatch(a.notes.orders ?? "", /FIRST QUALIFIED/);
});
