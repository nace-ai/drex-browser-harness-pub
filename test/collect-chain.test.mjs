// The collection dependency chain (strategy workstream 2): scope -> rows/fields -> computation -> the selected rows'
// identity -> what a later step opens. Each case is a deterministic contract for aggregate(): exact value, every tie,
// signed amounts, and the selected rows with their links.
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate, parseNumber, typeRecord } from "../src/records.ts";

const spec = (o) => ({
  op: "none",
  field: "",
  filters: [],
  group_by: "",
  output: "",
  order: "none",
  limit: 0,
  semantic_constraints: [],
  ...o,
});
const order = (i, date, email, total, status) =>
  typeRecord({
    index: i,
    text: `#${i} ${date} ${email} ${total} ${status}`,
    href: `http://shop.test/admin/sales/order/view/order_id/${i}/`,
    rating: null,
    cells: [
      ["ID", String(i)],
      ["Purchase Date", date],
      ["Customer Email", email],
      ["Grand Total", total],
      ["Status", status],
    ],
  });
// WebArena admin 290's shape: the customer with the most completed orders, then that customer's latest order
const ORDERS = [
  order(11, "Jan 3, 2023", "ann@x.com", "$50.00", "Complete"),
  order(12, "Mar 9, 2023", "bob@x.com", "$20.00", "Complete"),
  order(13, "Feb 1, 2023", "ann@x.com", "$15.00", "Complete"),
  order(14, "May 2, 2023", "ann@x.com", "$70.00", "Canceled"),
  order(15, "Apr 4, 2023", "cy@x.com", "$-5.00", "Complete"),
  order(16, "Jun 6, 2023", "bob@x.com", "$30.00", "Complete"),
];
const complete = [{ field: "status", op: "eq", value: "Complete" }];

test("chain 1: a grouped argmax keeps the winner's own rows, latest first, with their links", () => {
  // ann has 2 completed orders, bob 2: a tie; with the canceled order counted ann would win alone
  const all = aggregate(ORDERS, spec({ op: "argmax", group_by: "customer email" }));
  assert.equal(all.value, "ann@x.com");
  assert.deepEqual(
    all.selected.map((r) => r.href.match(/order_id\/(\d+)/)[1]),
    ["14", "13", "11"], // latest first: the order a "latest order" step opens is the first
  );
});

test("chain 2: a tie between groups is reported whole, never settled by the order first seen", () => {
  const r = aggregate(ORDERS, spec({ op: "argmax", group_by: "customer email", filters: complete }));
  assert.deepEqual(r.value, ["ann@x.com", "bob@x.com"]);
  assert.equal(r.ties, 2);
  assert.deepEqual(
    r.selected.map((s) => s.href.match(/order_id\/(\d+)/)[1]),
    ["16", "12", "13", "11"],
  );
});

test("chain 3: a row argmax names every row at the best value", () => {
  const rows = [
    order(1, "Jan 1, 2023", "a@x.com", "$9.00", "Complete"),
    order(2, "Jan 2, 2023", "b@x.com", "$9.00", "Complete"),
    order(3, "Jan 3, 2023", "c@x.com", "$4.00", "Complete"),
  ];
  const r = aggregate(rows, spec({ op: "argmax", field: "grand total", output: "customer email" }));
  assert.deepEqual(r.value, ["a@x.com", "b@x.com"]);
  assert.equal(r.ties, 2);
  assert.equal(r.selected.length, 2);
  // no tie: one value, no ties field
  const one = aggregate(rows, spec({ op: "argmin", field: "grand total", output: "customer email" }));
  assert.equal(one.value, "c@x.com");
  assert.equal(one.ties, undefined);
});

test("chain 4: negative amounts are negative; a hyphen in a code or range is not a sign", () => {
  assert.equal(parseNumber("-$12.50"), -12.5);
  assert.equal(parseNumber("Refund: −3.00"), -3);
  assert.equal(parseNumber("($1,200.00)"), -1200);
  assert.equal(parseNumber("MH-01"), 1);
  assert.equal(parseNumber("Items 1-12 of 36"), 1);
  assert.equal(parseNumber("$-5.00"), 5); // a sign after the currency symbol is not one we read
  const refund = typeRecord({ index: 1, text: "Refund -$40.00 Jan 1, 2023", href: "", rating: null, cells: [] });
  assert.equal(refund.numbers.amount, -40);
  const sum = aggregate(
    [refund, typeRecord({ index: 2, text: "Order $100.00", href: "", rating: null, cells: [] })],
    spec({ op: "sum", field: "amount" }),
  );
  assert.equal(sum.value, 60);
});

test("chain 5: a top N carries its rows' links in order", () => {
  const r = aggregate(ORDERS, spec({ op: "top", field: "purchase date", order: "desc", limit: 2, output: "id" }));
  assert.deepEqual(r.value, ["16", "14"]);
  assert.deepEqual(
    r.selected.map((s) => s.href.split("/").at(-2)),
    ["16", "14"],
  );
});

test("chain 6: a list longer than the cap says how many it left out", () => {
  const many = Array.from({ length: 130 }, (_, i) =>
    typeRecord({ index: i, text: `item ${i}`, href: "", rating: null, cells: [["Name", `item ${i}`]] }),
  );
  const r = aggregate(many, spec({ op: "list", output: "name" }));
  assert.equal(r.value.length, 100);
  assert.equal(r.more, 30);
});

test("chain 7: a computation that can't be made carries no selected rows", () => {
  const r = aggregate(ORDERS, spec({ op: "argmax", field: "no such field" }));
  assert.equal(r.value, null);
  assert.equal(r.selected, undefined);
  const none = aggregate(
    ORDERS,
    spec({ op: "argmax", group_by: "customer email", filters: [{ field: "status", op: "eq", value: "Pending" }] }),
  );
  assert.equal(none.value, null);
  assert.equal(none.selected, undefined);
});

test("chain 8: a row read twice (the same link and text, from a list that shifted between pages) counts once", () => {
  const dup = [...ORDERS, order(16, "Jun 6, 2023", "bob@x.com", "$30.00", "Complete")];
  const r = aggregate(dup, spec({ op: "argmax", group_by: "customer email", filters: complete }));
  assert.deepEqual(r.value, ["ann@x.com", "bob@x.com"]);
  assert.equal(aggregate(dup, spec({ op: "count" })).value, 6);
  // rows without links can't be told apart from real repeats: they all count
  const bare = (i) => typeRecord({ index: i, text: "same", href: "", rating: null, cells: [] });
  assert.equal(aggregate([bare(1), bare(2)], spec({ op: "count" })).value, 2);
});

test("chain 9: the links a later step may open are the note's selected rows and matches, nothing else", async () => {
  const L = await import("../src/logic.ts");
  const note = {
    matches: [
      { source: "http://shop.test/admin/customer/index/edit/id/7/", row: "ann" },
      { source: "list page", row: "x" },
    ],
    computed: {
      selected: [{ href: "http://shop.test/admin/sales/order/view/order_id/14/", text: "#14" }, { href: "" }],
    },
  };
  assert.deepEqual([...L.noteLinks(note)].sort(), [
    "http://shop.test/admin/customer/index/edit/id/7/",
    "http://shop.test/admin/sales/order/view/order_id/14/",
  ]);
  assert.equal(L.noteLinks(null).size, 0);
});

test("chain 10: a step that names a chosen row's number opens that row's link; an ambiguous number opens nothing", async () => {
  const L = await import("../src/logic.ts");
  const note = JSON.stringify({
    matches: [
      { source: "http://shop.test/admin/sales/order/view/order_id/136/", row: "000000136 Lily Potter Canceled" },
    ],
    computed: {
      selected: [
        {
          text: "000000088 Apr 13, 2023 Samantha Jones Canceled",
          href: "http://shop.test/admin/sales/order/view/order_id/88/",
        },
        {
          text: "000000081 Apr 4, 2023 Samantha Jones Canceled",
          href: "http://shop.test/admin/sales/order/view/order_id/81/",
        },
      ],
    },
  });
  const notes = { canceled_orders: note };
  assert.equal(
    L.namedRowLink(
      "Open Samantha Jones's most recent canceled order (000000088, Apr 13, 2023) and read its SKUs",
      notes,
    ),
    "http://shop.test/admin/sales/order/view/order_id/88/",
  );
  assert.equal(L.namedRowLink("Open order 000000136", notes), "http://shop.test/admin/sales/order/view/order_id/136/");
  assert.equal(L.namedRowLink("Open orders 000000088 and 000000081", notes), ""); // two rows: no single link
  assert.equal(L.namedRowLink("Open order 12", notes), ""); // a short number names nothing
  assert.equal(L.namedRowLink("Open order 000000999", notes), "");
});

test("chain 11: a total the task leaves a part out of is refused, not summed from a total field", async () => {
  const { specConflict } = await import("../src/records.ts");
  const sum = (field) => spec({ op: "sum", field });
  // WebArena shopping 331: Grand Total summed to 40.16 where the answer, without shipping, is 25.16
  const task = "Return the total amount I spent on shopping at One Stop Market in July 2022, excluding shipping.";
  assert.match(specConflict(task, sum("grand total")), /excluding shipping/);
  assert.match(specConflict(task, sum("order total")), /excluding shipping/);
  assert.match(specConflict("Total paid before tax in 2023", sum("")), /before tax/);
  // shopping 143: "without considering shipping and handling fees"
  assert.match(
    specConflict(
      "how much I spent on home decoration during January 29, 2023 without considering shipping and handling fees",
      sum("grand total"),
    ),
    /without considering shipping/,
  );
  assert.match(
    specConflict("total excluding the cost of shipping", sum("order total")),
    /excluding the cost of shipping/,
  );
  // a field that already leaves the part out, a count, or a task with no exclusion is fine
  assert.equal(specConflict(task, sum("subtotal")), "");
  assert.equal(specConflict(task, spec({ op: "count" })), "");
  assert.equal(specConflict("Return the total amount I spent in July 2022", sum("grand total")), "");
  assert.equal(specConflict("How many orders shipped without a tracking number", sum("grand total")), "");
});
