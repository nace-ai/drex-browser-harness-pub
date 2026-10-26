// A list's rows typed on the host, so that a count, total or ranking over every row read is computed in code rather
// than left to the final read. Pure: no chrome.*, no page, no model, so node:test covers it (test/records.test.mjs).
import type { AggregateFilter, AggregateResult, AggregateSpec, FilterOp, ListRecord, RawRecord } from "./types.ts";

/** A header as a field key: lower-case, single spaces, nothing but letters, digits, spaces, "-", "(" and ")". */
const headerKey = (header: string): string =>
  header
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s()-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
/** A value as it is compared, grouped or told apart from another: lower-case, single spaces. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
const words = (key: string): string[] => key.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const NUMBER = /\d[\d,]*(?:\.\d+)?/;
/** A minus sign that makes the number after it negative: at the start or after a space, "(" or ":", right before the
 * number or its currency sign ("-$12.50", "Refund: −12.50"). A hyphen inside a word or a range is none ("1-12",
 * "MH-01"), and an accounting amount in brackets ("($12.50)") is negative too. */
const MINUS = /(?:^|[\s(:])[-\u2212]\s?[$€£¥]?\s?$/;
const BRACKETED = /\(\s?[$€£¥]?\s?$/;
function signOf(text: string, at: number, end: number): number {
  const before = text.slice(0, at);
  return MINUS.test(before) || (BRACKETED.test(before) && /^\s?\)/.test(text.slice(end))) ? -1 : 1;
}
/** The first number a text shows, and where, with its sign (signOf). */
function firstNumber(text: string): { at: number; value: number } | null {
  const m = NUMBER.exec(text);
  return m
    ? { at: m.index, value: signOf(text, m.index, m.index + m[0].length) * Number(m[0].replace(/,/g, "")) }
    : null;
}
/** The first number a text shows ("$1,234.56" is 1234.56, "Ordered 1 Invoiced 1" is 1, "80%" is 80), or null. */
export function parseNumber(text: string): number | null {
  return firstNumber(text)?.value ?? null;
}

const MONTH =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthOf = (name: string | undefined): number => MONTHS.indexOf((name ?? "").slice(0, 3).toLowerCase()) + 1;
const fullYear = (y: number): number => (y < 100 ? 2000 + y : y);
/** The ways a list writes a calendar date, each read as [year, month, day]. */
const DATE_FORMS: [RegExp, (m: RegExpExecArray) => [number, number, number]][] = [
  // an ISO date may run straight on into its time ("2023-06-05T10:14")
  [/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\b|(?=T\d))/g, (m) => [Number(m[1]), Number(m[2]), Number(m[3])]],
  // a numeric date with slashes is read month first, as US stores write it
  [/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g, (m) => [fullYear(Number(m[3])), Number(m[1]), Number(m[2])]],
  [
    new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"),
    (m) => [Number(m[3]), monthOf(m[1]), Number(m[2])],
  ],
  [
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH},?\\s+(\\d{4})\\b`, "gi"),
    (m) => [Number(m[3]), monthOf(m[2]), Number(m[1])],
  ],
];
/** A time of day written right after a date ("Jun 5, 2023 10:14:22 AM", "2023-06-05T10:14", "6/5/23 at 9:05 pm"). */
const TIME_AFTER = /^(?:T|,?\s+(?:at\s+)?)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:\s*([ap])\.?m\.?(?![a-z]))?/i;
interface DateToken {
  at: number;
  token: string;
  ms: number;
}
/** The first calendar date a text shows, with the time of day written right after it: where it starts, its words, and
 * its milliseconds read as UTC, so that no machine's time zone moves it. */
function dateToken(text: string): DateToken | null {
  let best: DateToken | null = null;
  for (const [form, parts] of DATE_FORMS) {
    for (const m of text.matchAll(form)) {
      if (best && m.index >= best.at) break;
      const [y, mo, d] = parts(m);
      const day = new Date(Date.UTC(y, mo - 1, d));
      // a date the calendar doesn't have (month 13, February 30) is no date
      if (y < 1970 || y > 2100 || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) continue;
      let token = m[0],
        ms = day.getTime();
      const t = TIME_AFTER.exec(text.slice(m.index + m[0].length));
      if (t) {
        const h = Number(t[1]),
          min = Number(t[2]),
          sec = Number(t[3] ?? 0),
          half = (t[4] ?? "").toLowerCase();
        if (min < 60 && sec < 60 && (half ? h >= 1 && h <= 12 : h <= 23)) {
          ms += ((half ? (h % 12) + (half === "p" ? 12 : 0) : h) * 3600 + min * 60 + sec) * 1000;
          token += t[0];
        }
      }
      best = { at: m.index, token, ms };
      break;
    }
  }
  return best;
}
/** The first calendar date a text shows ("Jun 5, 2023", "6/5/23", "2023-06-05"), with a time of day written right after
 * it, in milliseconds since the epoch; null when it shows none. */
export function parseDate(text: string): number | null {
  return dateToken(text)?.ms ?? null;
}

/** Ratings that say their stars outright, tried after a percentage and in this order: "4.5 out of 5 stars" also shows
 * "5 stars". */
const STAR_FORMS = [
  /(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*5\b/,
  /(\d+(?:\.\d+)?)[\s-]*stars?\b/,
  /\brat(?:ing|ed)\s*:?\s*(\d+(?:\.\d+)?)/,
  /^([0-5](?:\.\d+)?)$/,
];
const fiveAtMost = (stars: number): number => Math.min(5, Math.max(0, stars));
/** A rating as stars out of five: a percentage gives a star per 20 ("80%" is 4); "4 stars", "4/5", "4 out of 5",
 * "Rating 4" and a bare 4 are 4. */
export function parseStars(text: string | null): number | null {
  if (text === null) return null;
  const t = flat(text);
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(t);
  if (pct) return fiveAtMost(Math.round(Number(pct[1]) / 20));
  for (const form of STAR_FORMS) {
    const stars = form.exec(t)?.[1];
    if (stars !== undefined) return fiveAtMost(Number(stars));
  }
  return null;
}

/** Labels a cell may start with that say what it holds rather than hold it ("Review by Amanda" is Amanda). */
const LABEL = /^(?:review(?:ed)?\s+by|posted\s+by|written\s+by|submitted\s+by|by)\b[\s:]*(?=\S)/i;
const AMOUNT = /[$€£¥]\s?(\d[\d,]*(?:\.\d+)?)/;
const STAR_HEADER = /\b(?:rating|stars?)\b/;
/** Types a row: each header's cell as a field, with its first number; stars from the rating, else from a rating or
 * stars cell; and the virtual fields text, amount (the first price in the text), date (the first date in the text,
 * else in a cell) and stars. A header named text, amount or date keeps its own cell over the virtual field; stars
 * always come from the rating. */
export function typeRecord(raw: RawRecord): ListRecord {
  const fields: Record<string, string> = {};
  const numbers: Record<string, number> = {};
  for (const [i, [header, cell]] of raw.cells.entries()) {
    const key = headerKey(header) || `col${i + 1}`;
    if (Object.hasOwn(fields, key)) continue; // a header seen twice keeps its first cell
    const value = cell.replace(/\s+/g, " ").trim().replace(LABEL, "");
    fields[key] = value;
    // a number inside a date ("Jun 5, 2023", "1/2/23") is no number of the cell's: summed, compared or ranked, it
    // would be a day of the month
    const n = firstNumber(value),
      date = dateToken(value);
    if (n && !(date && n.at >= date.at && n.at < date.at + date.token.length)) numbers[key] = n.value;
  }
  let stars = parseStars(raw.rating);
  for (const [header, cell] of raw.cells) {
    if (stars === null && STAR_HEADER.test(headerKey(header))) stars = parseStars(cell);
  }
  if (!Object.hasOwn(fields, "text")) fields.text = raw.text;
  if (!Object.hasOwn(fields, "date")) {
    for (const source of [raw.text, ...raw.cells.map(([, cell]) => cell)]) {
      const date = dateToken(source);
      if (!date) continue;
      fields.date = date.token;
      break;
    }
  }
  const amount = AMOUNT.exec(raw.text);
  if (amount && !Object.hasOwn(numbers, "amount"))
    numbers.amount =
      signOf(raw.text, amount.index, amount.index + amount[0].length) * Number((amount[1] ?? "").replace(/,/g, ""));
  // stars are the rating read as stars: a stars cell's plain number ("80%" read as 80) gives way to them
  if (stars !== null) numbers.stars = stars;
  return { index: raw.index, text: raw.text, href: raw.href, fields, numbers, stars };
}

/** Every field key the records have, in the order first seen, the virtual text, amount, date and stars included. */
export function fieldNames(records: ListRecord[]): string[] {
  const names = new Set<string>();
  for (const r of records) for (const key of [...Object.keys(r.fields), ...Object.keys(r.numbers)]) names.add(key);
  return [...names];
}

/** Names of one field, each list tried in its order when a name in it matches no field itself. */
const SYNONYMS = [
  ["price", "grand total", "total", "cost", "amount", "subtotal"],
  ["date", "purchase date", "created", "purchased", "time", "when"],
  ["name", "customer", "bill-to name", "customer name", "author", "reviewer", "user", "posted by"],
  ["qty", "quantity", "items", "ordered"],
  ["status", "state"],
  ["rating", "stars", "star", "score"],
];
/** The words of part appear in whole, in a row: whole words only, so "id" is in "order id" but not in "paid". */
const within = (part: string[], whole: string[]): boolean =>
  part.length > 0 && whole.some((_, i) => part.every((word, j) => whole[i + j] === word));
/** The field a key names: itself, else the first field whose words hold it or are held in it. */
function lookup(key: string, names: string[]): string | null {
  if (names.includes(key)) return key;
  const wanted = words(key);
  return names.find((name) => within(wanted, words(name)) || within(words(name), wanted)) ?? null;
}
/** What a name may resolve to among some records: their field names, and whether any of them has stars. */
interface Fields {
  names: string[];
  starred: boolean;
}
const fieldsOf = (records: ListRecord[]): Fields => ({
  names: fieldNames(records),
  starred: records.some((r) => r.stars !== null),
});
/** Names a request for a star rating goes by. */
const STAR_NAMES = ["rating", "stars", "star"];
function resolveIn(name: string, { names, starred }: Fields): string | null {
  const key = headerKey(name);
  if (!key) return null;
  // a rating is the stars whenever a row has them: a rating cell's own number reads "80%" as 80
  if (starred && STAR_NAMES.includes(key)) return "stars";
  const found = lookup(key, names);
  if (found !== null) return found;
  for (const synonyms of SYNONYMS) {
    if (!synonyms.includes(key)) continue;
    for (const synonym of synonyms) {
      const hit = lookup(synonym, names);
      if (hit !== null) return hit;
    }
  }
  return null;
}
/** The records' field a name means: the virtual stars for rating or stars whenever a record has stars; else the field
 * of that name, else the first whose words hold the name or are held in it ("total" is "grand total (base)"), else the
 * first a synonym names ("customer" is "bill-to name"); null when none fits. */
export function resolveField(name: string, records: ListRecord[]): string | null {
  return resolveIn(name, fieldsOf(records));
}

/** A record's field as text: its cell, else its number; undefined when the record doesn't have it. */
function valueOf(r: ListRecord, key: string): string | undefined {
  if (Object.hasOwn(r.fields, key)) return r.fields[key];
  const n = numberOf(r, key);
  return n === undefined ? undefined : String(n);
}
const numberOf = (r: ListRecord, key: string): number | undefined =>
  Object.hasOwn(r.numbers, key) ? r.numbers[key] : undefined;

const DAY = 86_400_000;
const dayOf = (text: string): number | null => {
  const ms = parseDate(text);
  return ms === null ? null : Math.floor(ms / DAY);
};
/** A between value's two ends, written from..to, "from - to" or "from to to"; null when it doesn't hold two. */
function ends(value: string): [string, string] | null {
  const [from, to, ...rest] = value.trim().split(/\s*\.\.\s*|\s+[-–]\s+|\s+to\s+/i);
  return from && to && !rest.length ? [from, to] : null;
}
/** A filter ready to apply: its field resolved, and the ends it compares with (a between's two, else its value twice). */
interface Condition {
  field: string;
  op: FilterOp;
  value: string;
  from: string;
  to: string;
}
/** A value that is a number on its own, with at most a currency sign, commas, a % or a # ("2", "$1,234.56", "80%",
 * "#129"). Only such a value matches by number for eq and neq: a code like "24-MB01" shares its first number with
 * "24-MB04". */
const BARE_NUMBER = /^#?\s*[$€£¥]?\s*\d[\d,]*(?:\.\d+)?\s*[%$€£¥]?$/;
function holds(x: number, op: FilterOp, from: number, to: number): boolean {
  switch (op) {
    case "eq":
      return x === from;
    case "neq":
      return x !== from;
    case "gte":
      return x >= from;
    case "lte":
      return x <= from;
    case "between":
      return x >= Math.min(from, to) && x <= Math.max(from, to);
    case "contains":
      return false; // text only
  }
}
/** Whether a record meets a condition: by calendar day when both sides are dates (a date's own digits read as a number:
 * "2023-03-01" would be 2023); else by the record's number when the value has one, for eq and neq only when the value
 * is a bare number; else, for eq and neq, as text with case and spacing aside. A record that doesn't show the field
 * meets no condition on it. */
function meets(r: ListRecord, c: Condition): boolean {
  const shown = valueOf(r, c.field);
  if (!shown) return false;
  if (c.op === "contains") return flat(shown).includes(flat(c.value));
  const day = dayOf(shown),
    dayFrom = dayOf(c.from),
    dayTo = dayOf(c.to);
  if (day !== null && dayFrom !== null && dayTo !== null) return holds(day, c.op, dayFrom, dayTo);
  const n = numberOf(r, c.field),
    nFrom = parseNumber(c.from),
    nTo = parseNumber(c.to);
  const byNumber = (c.op !== "eq" && c.op !== "neq") || BARE_NUMBER.test(c.value.trim());
  if (byNumber && n !== undefined && nFrom !== null && nTo !== null) return holds(n, c.op, nFrom, nTo);
  if (c.op === "eq") return flat(shown) === flat(c.value);
  if (c.op === "neq") return flat(shown) !== flat(c.value);
  return false; // gte, lte or between with no date or number to compare
}

/** A spec's filters as conditions over records with these fields: each field resolved, a between's two ends split. A
 * filter that can't be applied (its field resolves to none, or a between lacks two ends) is left out, with the reason
 * in unresolved. */
function conditionsOf(filters: AggregateFilter[], fields: Fields, unresolved: string[]): Condition[] {
  const conditions: Condition[] = [];
  for (const { field: name, op, value } of filters) {
    const field = resolveIn(name, fields);
    if (field === null) unresolved.push(name || "no filter field named");
    const span: [string, string] | null = op === "between" ? ends(value) : [value, value];
    if (!span) unresolved.push(`between needs two ends: ${JSON.stringify(value)}`);
    if (field !== null && span) conditions.push({ field, op, value, from: span[0], to: span[1] });
  }
  return conditions;
}
/** The test a spec's filters make of one row, as aggregate applies them, their fields resolved among these records: a
 * row passes when it meets every filter (every row passes when there is none); null when a filter can't be applied. */
export function rowFilter(records: ListRecord[], spec: AggregateSpec): ((r: ListRecord) => boolean) | null {
  const conditions = conditionsOf(spec.filters, fieldsOf(records), []);
  if (conditions.length < spec.filters.length) return null;
  return (r) => conditions.every((c) => meets(r, c));
}

/** Each row's key for ranking by a field: its date when at least as many rows show a date there as a number, else its
 * number, else (when text may rank) its place in alphabetical order. A row with no key is left out. */
function rankKeys(rows: ListRecord[], field: string, text: boolean): { row: ListRecord; key: number }[] {
  const dated = rows.flatMap((row) => {
    const key = parseDate(valueOf(row, field) ?? "");
    return key === null ? [] : [{ row, key }];
  });
  const counted = rows.flatMap((row) => {
    const key = numberOf(row, field);
    return key === undefined ? [] : [{ row, key }];
  });
  if (dated.length && dated.length >= counted.length) return dated;
  if (counted.length || !text) return counted;
  const shown = rows.flatMap((row) => {
    const value = valueOf(row, field);
    return value ? [{ row, value: flat(value) }] : [];
  });
  const alphabet = [...new Set(shown.map((s) => s.value))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return shown.map(({ row, value }) => ({ row, key: alphabet.indexOf(value) }));
}
/** Decimal places a number is written with (1234.56 has 2). */
function places(n: number): number {
  const written = String(n);
  return written.includes("e") ? 10 : (written.split(".")[1] ?? "").length;
}
function compute(op: "sum" | "avg" | "min" | "max", values: number[]): number {
  if (op === "min") return values.reduce((a, b) => Math.min(a, b));
  if (op === "max") return values.reduce((a, b) => Math.max(a, b));
  // the sum is rounded to the inputs' own decimals, so float noise (10.1 + 20.2 is 30.299999999999997) never shows
  const decimals = values.reduce((most, n) => Math.max(most, places(n)), 0);
  const sum = Number(values.reduce((a, b) => a + b, 0).toFixed(Math.min(10, decimals)));
  return op === "sum" ? sum : Number((sum / values.length).toFixed(10));
}

/** The selected rows a result carries (top, argmax, argmin), at most, and the list values it gives, at most. */
const MAX_SELECTED = 10;
const MAX_LIST = 100;
/** A selected row as the note shows it: its text, its link, and its date when it has one. */
function identity(r: ListRecord): { text: string; href: string; date?: string } {
  return {
    text: r.text.replace(/\s+/g, " ").trim().slice(0, 200),
    href: r.href,
    ...(r.fields.date ? { date: r.fields.date } : {}),
  };
}
/** Rows latest first when at least half of them show a date (a customer's orders: the latest is the one a task asks
 * about), else as they came. */
function latestFirst(rows: ListRecord[]): ListRecord[] {
  const keyed = rows.map((row, i) => ({ row, i, at: parseDate(row.fields.date ?? "") }));
  if (keyed.filter((k) => k.at !== null).length * 2 < rows.length) return rows;
  return keyed.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || a.i - b.i).map((k) => k.row);
}

/** Computes a spec over records: the filters first, then the op over the rows left. With a group_by, groups counts the
 * rows per value of that field, most first; count is then the number of groups, and argmax or argmin names the group
 * with the most or fewest rows. The value is null, with the reason in unresolved, when a filter can't be applied (its
 * field resolves to none, or a between lacks two ends), when a field the op needs resolves to none, when no row meets
 * the filters, or when no row has a value to compute with: a computation that can't be made is missing, never 0. A row
 * read twice (the same link and text) counts once. */
export function aggregate(read: ListRecord[], spec: AggregateSpec): AggregateResult {
  // a row read twice (a list that shifted between pages, a page read again) counts once: same link, same text
  const once = new Set<string>();
  const records = read.filter((r) => {
    if (!r.href) return true;
    const key = `${r.href}\n${flat(r.text)}`;
    if (once.has(key)) return false;
    once.add(key);
    return true;
  });
  const fields = fieldsOf(records);
  const unresolved: string[] = [];
  let groups: { key: string; value: number }[] | undefined;
  let selected: ListRecord[] = [];
  let ties = 0;
  let more = 0;
  const done = (value: AggregateResult["value"], used: number): AggregateResult => ({
    op: spec.op,
    value,
    rows_total: records.length,
    rows_used: used,
    ...(groups ? { groups } : {}),
    ...(value !== null && selected.length ? { selected: selected.slice(0, MAX_SELECTED).map(identity) } : {}),
    ...(value !== null && ties > 1 ? { ties } : {}),
    ...(value !== null && more ? { more } : {}),
    unresolved,
  });
  const missing = (why: string): AggregateResult => {
    unresolved.push(why);
    return done(null, 0);
  };
  const resolve = (name: string, role: string): string | null => {
    const field = resolveIn(name, fields);
    if (field === null) unresolved.push(name || `no ${role} named`);
    return field;
  };
  const conditions = conditionsOf(spec.filters, fields, unresolved);
  // a filter that can't be applied leaves the value missing: skipped, it would count or sum the rows it was meant to
  // drop; read as one point, a between without two ends would count the rows equal to it
  if (conditions.length < spec.filters.length) return done(null, 0);
  let rows = records;
  for (const c of conditions) rows = rows.filter((r) => meets(r, c));
  if (!rows.length) return missing(records.length ? "no row met the filters" : "no row was read");
  const by = spec.group_by ? resolve(spec.group_by, "group") : null;
  let grouped = 0; // the rows that show a value for the group_by field
  if (by !== null) {
    const counts = new Map<string, { key: string; value: number }>();
    for (const r of rows) {
      const key = valueOf(r, by);
      if (!key) continue;
      grouped++;
      const group = counts.get(flat(key));
      if (group) group.value++;
      else counts.set(flat(key), { key, value: 1 });
    }
    // the sort is stable: groups with as many rows stay in the order first seen
    groups = [...counts.values()].sort((a, b) => b.value - a.value);
  }
  // the rows' output field as text, or their own text when the spec names none or names one no record has
  const output = (): ((r: ListRecord) => string | undefined) => {
    const field = spec.output ? resolve(spec.output, "output") : null;
    return (r) => (field === null ? r.text : valueOf(r, field));
  };
  switch (spec.op) {
    case "none":
      return missing("the spec asks for no computation");
    case "count":
      if (!spec.group_by) return done(rows.length, rows.length);
      // with a group_by, how many distinct values the rows show ("how many customers"); the groups list them
      if (!groups) return done(null, 0); // the group_by resolves to no field, named in unresolved
      if (!groups.length) return missing(`no row has a value for ${spec.group_by}`);
      return done(groups.length, grouped);
    case "sum":
    case "avg":
    case "min":
    case "max": {
      const field = resolve(spec.field, "field");
      if (field === null) return done(null, 0);
      const values = rows.map((r) => numberOf(r, field)).filter((n) => n !== undefined);
      if (!values.length) return missing(`no row has a number for ${spec.field}`);
      return done(compute(spec.op, values), values.length);
    }
    case "list": {
      const shown = output();
      const seen = new Set<string>();
      const values: string[] = [];
      let used = 0;
      for (const r of rows) {
        const value = shown(r);
        if (!value) continue;
        used++;
        if (seen.has(flat(value))) continue;
        seen.add(flat(value));
        values.push(value);
      }
      if (!values.length) return missing(`no row has a value for ${spec.output || "text"}`);
      const wanted = spec.limit > 0 ? values.slice(0, spec.limit) : values;
      more = Math.max(0, wanted.length - MAX_LIST);
      return done(wanted.slice(0, MAX_LIST), used);
    }
    case "top": {
      // order none: the list is already in the requested order, so its first rows as they came
      let ranked = rows;
      if (spec.order !== "none") {
        const field = resolve(spec.field, "field");
        if (field === null) return done(null, 0);
        const keyed = rankKeys(rows, field, true);
        if (!keyed.length) return missing(`no row has a value for ${spec.field}`);
        const sign = spec.order === "desc" ? -1 : 1;
        ranked = keyed.sort((a, b) => sign * (a.key - b.key)).map((k) => k.row);
      }
      const shown = output();
      selected = ranked.slice(0, spec.limit > 0 ? spec.limit : 1);
      return done(
        selected.map((r) => shown(r) || r.text),
        ranked.length,
      );
    }
    case "argmax":
    case "argmin": {
      if (spec.group_by) {
        if (!groups) return done(null, 0); // the group_by resolves to no field, named in unresolved
        const best = spec.op === "argmax" ? groups[0]?.value : groups.at(-1)?.value;
        if (best === undefined) return missing(`no row has a value for ${spec.group_by}`);
        // every group with the most (or fewest) rows: a tie is reported whole, never settled by the order first seen
        const winners = groups.filter((g) => g.value === best);
        ties = winners.length;
        const keys = new Set(winners.map((g) => flat(g.key)));
        // the winning groups' own rows, latest first when they show dates: the entity's records a later step opens
        selected = latestFirst(rows.filter((r) => keys.has(flat(valueOf(r, by ?? "") ?? ""))));
        return done(winners.length > 1 ? winners.map((g) => g.key) : (winners[0]?.key ?? null), grouped);
      }
      const field = resolve(spec.field, "field");
      if (field === null) return done(null, 0);
      const keyed = rankKeys(rows, field, false);
      if (!keyed.length) return missing(`no row has a number for ${spec.field}`);
      const sign = spec.op === "argmax" ? 1 : -1;
      const best = keyed.reduce((a, b) => (sign * (b.key - a.key) > 0 ? b : a)).key;
      // every row at the best value: a tie is reported whole, never settled by the list's order
      selected = keyed.filter((k) => k.key === best).map((k) => k.row);
      ties = selected.length;
      const shown = output();
      const values = [...new Set(selected.map((r) => shown(r) || r.text))];
      return done(values.length > 1 ? values : (values[0] ?? null), keyed.length);
    }
  }
}

/** A task that leaves a part out of an amount ("excluding shipping", "before tax", "without the discount", "not
 * including fees"): a total of the rows' total field would include it. */
const EXCLUDES_PART =
  /\b(?:excluding|exclude[sd]?|not including|not counting|without|minus|less|net of|before)(?:\s+(?:considering|counting|including|the|any|cost|costs|of)){0,3}\s+(?:shipping|delivery|tax(?:es)?|vat|discounts?|fees?|handling|tips?|refunds?|coupons?)\b/i;
/** A field named as an amount that may include such a part ("Grand Total", "Order Total", "Total", "Amount"). */
const TOTAL_FIELD = /\b(?:grand total|order total|total|amount|paid|charged)\b/i;
/** A spec the host refuses for its task: a sum, mean, least or most of a total field when the task leaves a part of
 * that total out ("total spent, excluding shipping" summed over Grand Total gave 40.16 for 25.16). The reason, or "". */
export function specConflict(task: string, spec: AggregateSpec): string {
  if (!["sum", "avg", "min", "max"].includes(spec.op)) return "";
  const part = EXCLUDES_PART.exec(task);
  if (!part) return "";
  const field = spec.field || "amount";
  return TOTAL_FIELD.test(field) || field === "amount"
    ? `the task says "${part[0]}", and ${field} is a total that may include it`
    : "";
}

/** Where a list states its own size, tried in this order: "73 records found", "Items 1-12 of 36", "Showing 1–10 of 123
 * results". A cart's "3 items in your cart", "Showing 1 per page" and "Page 1 of 5" never match: they count something
 * else. */
const COUNT_FORMS = [
  /(\d[\d,]*)\s+(?:records?|results?|items?|products?|reviews?|orders?|entries|matches|posts?|comments?)\s+(?:found|total|in total)\b/i,
  /\b(?:items?|results?|records?|reviews?|showing)\s+\d[\d,]*\s*(?:-|–|to)\s*\d[\d,]*\s+(?:of|out of)\s+(\d[\d,]*)/i,
  /\bof\s+(\d[\d,]*)\s+(?:results?|items?|products?|records?|reviews?|entries|total)\b/i,
];
/** A review list's size as its tab or heading states it ("Reviews 12", "12 Reviews"), read only when every such mention
 * in the text names the same number: a product grid shows one on each card ("3 Reviews", "12 Reviews"), the card's own
 * count, not the list's. */
const REVIEW_COUNTS = [/\breviews?\s+(\d[\d,]*)\b/gi, /\b(\d[\d,]*)\s+reviews?\b/gi];
/** The number of rows a list says it holds, read from the page text, or null when the text states none. */
export function collectionCount(text: string): number | null {
  for (const form of COUNT_FORMS) {
    const count = form.exec(text)?.[1];
    if (count !== undefined) return Number(count.replace(/,/g, ""));
  }
  const reviews = new Set(
    REVIEW_COUNTS.flatMap((form) => [...text.matchAll(form)].map((m) => Number((m[1] ?? "").replace(/,/g, "")))),
  );
  return reviews.size === 1 ? ([...reviews][0] ?? null) : null;
}
