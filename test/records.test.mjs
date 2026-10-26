import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregate,
  collectionCount,
  fieldNames,
  parseNumber,
  parseStars,
  resolveField,
  rowFilter,
  typeRecord,
} from "../src/records.ts";

const order = (i, date, name, total, status, qty = "") =>
  typeRecord({
    index: i,
    text: `${i} ${date} ${name} $${total} ${status}`,
    href: `/order/${i}`,
    rating: null,
    cells: [
      ["ID", String(i)],
      ["Purchase Date", date],
      ["Bill-to Name", name],
      ["Grand Total (Base)", `$${total}`],
      ["Status", status],
      ...(qty ? [["Qty", `Ordered ${qty}`]] : []),
    ],
  });
const ORDERS = [
  order(5, "Jun 5, 2023", "Julia Williams", "1,234.56", "Canceled", "2"),
  order(4, "May 1, 2023", "Jane Doe", "40.00", "Complete", "3"),
  order(3, "Apr 2, 2023", "Julia Williams", "12.00", "Canceled", "1"),
  order(2, "Mar 3, 2023", "Bob Lee", "99.99", "Canceled", "4"),
  order(1, "Feb 4, 2023", "Julia Williams", "5.00", "Complete", "6"),
];
const review = (i, author, pct) =>
  typeRecord({
    index: i,
    text: `${author} ${pct} Great case`,
    href: "",
    rating: pct,
    cells: [
      ["author", `Review by ${author}`],
      ["date", "1/2/23"],
    ],
  });
const REVIEWS = [
  review(0, "MH", "100%"),
  review(1, "Amanda", "80%"),
  review(2, "Evelyn Kurver", "20%"),
  review(3, "N Randall", "40%"),
];
const spec = (over) => ({
  op: "none",
  field: "",
  filters: [],
  group_by: "",
  output: "",
  order: "none",
  limit: 0,
  semantic_constraints: [],
  ...over,
});

test("typeRecord: fields by header, numbers from cells, stars from the rating, virtual amount and date", () => {
  const r = ORDERS[0];
  assert.equal(r.fields["bill-to name"], "Julia Williams");
  assert.equal(r.numbers["grand total (base)"], 1234.56);
  assert.equal(r.numbers.qty, 2);
  assert.equal(r.numbers.amount, 1234.56);
  assert.equal(r.fields.date, "Jun 5, 2023");
  assert.equal(REVIEWS[1].stars, 4);
  assert.equal(REVIEWS[1].numbers.stars, 4);
  assert.equal(REVIEWS[1].fields.author, "Amanda"); // "Review by" is a label, not the name
  assert.deepEqual(fieldNames(ORDERS).slice(0, 5), [
    "id",
    "purchase date",
    "bill-to name",
    "grand total (base)",
    "status",
  ]);
});

test("parse helpers", () => {
  assert.equal(parseNumber("$1,234.56"), 1234.56);
  assert.equal(parseNumber("Ordered 1 Invoiced 1"), 1);
  assert.equal(parseNumber("none"), null);
  assert.equal(parseStars("80%"), 4);
  assert.equal(parseStars("4 stars"), 4);
  assert.equal(parseStars("4/5"), 4);
  assert.equal(parseStars(null), null);
});

test("resolveField: exact header, then a containing one, then synonyms; null when nothing fits", () => {
  assert.equal(resolveField("Status", ORDERS), "status");
  assert.equal(resolveField("total", ORDERS), "grand total (base)");
  assert.equal(resolveField("customer", ORDERS), "bill-to name");
  assert.equal(resolveField("name", REVIEWS), "author");
  assert.equal(resolveField("sku", ORDERS), null);
});

test("resolveField: rating and stars name the virtual stars whenever a row has stars, else the synonym table", () => {
  assert.equal(resolveField("rating", REVIEWS), "stars");
  // a rating cell's own number reads "80%" as 80; the stars read it as 4
  const rated = [typeRecord({ index: 0, text: "Amanda 80%", href: "", rating: "80%", cells: [["Rating", "80%"]] })];
  assert.equal(resolveField("rating", rated), "stars");
  const unrated = [typeRecord({ index: 0, text: "Case n/a", href: "", rating: null, cells: [["Rating", "n/a"]] })];
  assert.equal(unrated[0].stars, null);
  assert.equal(resolveField("rating", unrated), "rating");
  assert.equal(resolveField("stars", unrated), "rating");
});

test("aggregate: count with a filter, sum, argmax over a group, top-N by date, list by stars", () => {
  assert.deepEqual(
    aggregate(ORDERS, spec({ op: "count", filters: [{ field: "status", op: "eq", value: "canceled" }] })),
    { op: "count", value: 3, rows_total: 5, rows_used: 3, unresolved: [] },
  );
  assert.equal(aggregate(ORDERS, spec({ op: "sum", field: "qty" })).value, 16);
  const most = aggregate(
    ORDERS,
    spec({ op: "argmax", group_by: "customer", filters: [{ field: "status", op: "eq", value: "Canceled" }] }),
  );
  assert.equal(most.value, "Julia Williams");
  assert.deepEqual(most.groups, [
    { key: "Julia Williams", value: 2 },
    { key: "Bob Lee", value: 1 },
  ]);
  const top = aggregate(ORDERS, spec({ op: "top", field: "date", order: "desc", limit: 4, output: "id" }));
  assert.deepEqual(top.value, ["5", "4", "3", "2"]);
  // order none on a list already in the requested order: the first N rows as they came
  assert.deepEqual(
    aggregate([...ORDERS].reverse(), spec({ op: "top", field: "date", order: "none", limit: 2, output: "id" })).value,
    ["1", "2"],
  );
  assert.deepEqual(
    aggregate(REVIEWS, spec({ op: "list", output: "name", filters: [{ field: "stars", op: "gte", value: "4" }] }))
      .value,
    ["MH", "Amanda"],
  );
  assert.deepEqual(
    aggregate(REVIEWS, spec({ op: "list", output: "name", filters: [{ field: "stars", op: "lte", value: "2" }] }))
      .value,
    ["Evelyn Kurver", "N Randall"],
  );
  assert.equal(
    aggregate(
      ORDERS,
      spec({
        op: "sum",
        field: "amount",
        filters: [{ field: "date", op: "between", value: "2023-03-01..2023-05-31" }],
      }),
    ).value,
    151.99,
  );
});

test("aggregate: an unresolved field or a filter that leaves no row gives null, never 0", () => {
  const r = aggregate(ORDERS, spec({ op: "sum", field: "sku" }));
  assert.equal(r.value, null);
  assert.deepEqual(r.unresolved, ["sku"]);
  const none = aggregate(ORDERS, spec({ op: "count", filters: [{ field: "status", op: "eq", value: "Refunded" }] }));
  assert.equal(none.value, null);
  assert.equal(none.rows_used, 0);
  assert.match(none.unresolved[0], /no row/);
  // a filter on a field no header resolves: skipped, it would count every row
  const unfiltered = aggregate(ORDERS, spec({ op: "count", filters: [{ field: "sku", op: "eq", value: "x" }] }));
  assert.equal(unfiltered.value, null);
  assert.deepEqual(unfiltered.unresolved, ["sku"]);
  assert.equal(unfiltered.rows_used, 0);
});

test("aggregate: between takes two ends, from..to, from - to or from to to; a value without two gives null", () => {
  const between = (field, value) => spec({ op: "count", filters: [{ field, op: "between", value }] });
  assert.equal(aggregate(ORDERS, between("date", "2023-03-01 to 2023-05-31")).value, 3);
  assert.equal(aggregate(ORDERS, between("qty", "2 - 4")).value, 3);
  // read as one point, these would count the rows equal to it: a confident number for a range nobody gave
  for (const value of ["10-20", "..20", "2023-03-01"]) {
    const r = aggregate(ORDERS, between("qty", value));
    assert.equal(r.value, null);
    assert.equal(r.rows_used, 0);
    assert.deepEqual(r.unresolved, [`between needs two ends: "${value}"`]);
  }
});

test("aggregate: eq and neq compare a code as text, and as a number only when the value is a bare number", () => {
  const product = (i, sku, price) =>
    typeRecord({
      index: i,
      text: `${sku} $${price}`,
      href: "",
      rating: null,
      cells: [
        ["SKU", sku],
        ["Price", `$${price}`],
      ],
    });
  const CATALOG = [
    product(0, "24-MB01", "34.00"),
    product(1, "24-MB04", "32.00"),
    product(2, "24-MB03", "38.00"),
    product(3, "24-MB05", "45.00"),
    product(4, "24-MB06", "45.00"),
  ];
  const sku = (op, value) => spec({ op: "count", filters: [{ field: "sku", op, value }] });
  assert.equal(aggregate(CATALOG, sku("eq", "24-MB01")).value, 1); // its first number, 24, is every row's
  assert.equal(aggregate(CATALOG, sku("neq", "24-mb01")).value, 4);
  assert.equal(
    aggregate(CATALOG, spec({ op: "count", filters: [{ field: "price", op: "eq", value: "$45" }] })).value,
    2,
  );
  const qty = aggregate(ORDERS, spec({ op: "list", output: "id", filters: [{ field: "qty", op: "eq", value: "2" }] }));
  assert.deepEqual(qty.value, ["5"]); // the row whose qty reads "Ordered 2"
});

test("aggregate: count with a group_by counts the distinct groups and lists them, most rows first", () => {
  const customers = aggregate(ORDERS, spec({ op: "count", group_by: "customer" }));
  assert.equal(customers.value, 3);
  assert.deepEqual(customers.groups, [
    { key: "Julia Williams", value: 3 },
    { key: "Jane Doe", value: 1 },
    { key: "Bob Lee", value: 1 },
  ]);
  // a group_by no field resolves: the row count would answer "how many customers" with the number of orders
  const unknown = aggregate(ORDERS, spec({ op: "count", group_by: "sku" }));
  assert.equal(unknown.value, null);
  assert.deepEqual(unknown.unresolved, ["sku"]);
});

test("rowFilter: a row passes when it meets every filter as aggregate applies them; null when one can't be applied", () => {
  const indexes = (filters) => ORDERS.filter(rowFilter(ORDERS, spec({ op: "count", filters }))).map((r) => r.index);
  assert.deepEqual(indexes([{ field: "Status", op: "eq", value: "Canceled" }]), [5, 3, 2]);
  // fields resolved as aggregate resolves them: a synonym ("customer" is the bill-to name), a word of a header
  assert.deepEqual(
    indexes([
      { field: "customer", op: "eq", value: "Julia Williams" },
      { field: "total", op: "gte", value: "10" },
    ]),
    [5, 3],
  );
  assert.deepEqual(indexes([]), [5, 4, 3, 2, 1]); // no filter: every row passes
  // a field no header resolves, or a between without two ends: the filters can't decide the rows
  assert.equal(rowFilter(ORDERS, spec({ op: "count", filters: [{ field: "warehouse", op: "eq", value: "A" }] })), null);
  assert.equal(
    rowFilter(ORDERS, spec({ op: "count", filters: [{ field: "date", op: "between", value: "Mar 1, 2023" }] })),
    null,
  );
});

test("collectionCount: review mentions count only when they all name one number; a product grid's cards count nothing", () => {
  assert.equal(collectionCount("Reviews 12 Customer Reviews"), 12);
  assert.equal(collectionCount("Tee $24.00 3 Reviews Add to Cart Hat 12 Reviews Add to Cart"), null);
  assert.equal(collectionCount("12 Reviews for this product 12 Reviews"), 12);
});

test("collectionCount reads the list's own count and nothing else", () => {
  assert.equal(collectionCount("Orders 73 records found Search by keyword"), 73);
  assert.equal(collectionCount("Items 1 to 20 of 36 total"), 36);
  assert.equal(collectionCount("Items 1-12 of 36 Sort By Position"), 36);
  assert.equal(collectionCount("Showing 1–10 of 123 results"), 123);
  assert.equal(collectionCount("Details More Information Reviews 12 Customer Reviews"), 12);
  assert.equal(collectionCount("12 Reviews for this product"), 12);
  assert.equal(collectionCount("You have 3 items in your cart. Page 1 of 5"), null);
  assert.equal(collectionCount("Showing 1 per page"), null);
  assert.equal(collectionCount(""), null);
});
