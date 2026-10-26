// The pure parts of the agent: the moves Drex chooses between, the state text it reads, and small checks.
// No chrome.* here, so node:test covers it (test/logic.test.mjs).
import { parseDate as dateMs } from "./records.ts";
import type {
  BatchStep,
  Box,
  CollectionContract,
  HistoryEntry,
  LocatedEl,
  MoveOption,
  MoveRecord,
  Options,
  PageEl,
  Plan,
  PointTarget,
  Screen,
  Site,
  Step,
  StepText,
  TabInfo,
} from "./types.ts";

export const DONE_P = 0.6; // "is this step done?" above this ends the step...
export const DONE_SURE = 0.85; // ...when it is this sure, or more sure than Drex's next move
export const DONE_P_WITH_MOVE = 0.6; // ...the same bar when Drex picks "step done" itself (0.4 let a DoorDash checkout
// step end at 58% without the delivery time ever being set)

/** Does this Drex answer end the step? A borderline "done" (DONE_P..DONE_SURE) loses to a real move Drex is more
 * confident about: on Google Flights' booking-options page the check said 62% done while Drex was 87.5% on
 * continuing to the airline, and the step ended there.
 * strict (no LLM plan): the check is the user's whole task, not a step's precise question, and a borderline "done"
 * never ends it unless Drex picks "step done" itself. DoorDash: 68% "finished" with the burger in the cart, while
 * Drex's move was Continue (51%) to checkout.
 * afterReveal: the last move only pointed at something (a hover opens a submenu, it chooses nothing), so only Drex's
 * own "step done" ends the step. MiniWoB click-menu: with Jinny's submenu open the check said 90% "Jinny>Lynett is
 * selected" (the task's own line reads "Select Jinny>Lynett") while Drex's move was to click Lynett (91%). */
export function isStepDone(
  doneP: number,
  choice: string | undefined,
  p: number,
  strict = false,
  afterReveal = false,
): boolean {
  if (choice === "step done") return doneP >= DONE_P_WITH_MOVE;
  if (afterReveal) return false;
  return doneP >= DONE_SURE || (!strict && doneP >= DONE_P && p <= doneP);
}
// How many moves a step may take comes from the plan (max_moves: a repeating step that handles every item of a list
// gets room for all of them); these only bound it. The LLM may take over about one move in ten.
export const DEFAULT_MOVES = 25;
export const MIN_MOVES = 5;
export const MAX_MOVES = 600;
export const HISTORY_MOVES = 12;
const NOTE_CHARS = 200; // the helper's reason for a move it made, as Drex's history shows it
const finite = (n: unknown): n is number => Number.isFinite(n);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

export function moveBudget(step: Pick<Step, "max_moves">): number {
  const n = Math.round(step.max_moves ?? 0);
  return n > 0 ? Math.min(Math.max(n, MIN_MOVES), MAX_MOVES) : DEFAULT_MOVES;
}

export function rescueBudget(budget: number): number {
  return Math.max(4, Math.ceil(budget / 10));
}

// With LLM planning off, the user's task as written is the plan: one browse step, no texts (Drex's "type into" moves
// get their text from the LLM when Drex picks them), and room for a whole task in one step.
export const DIRECT_MOVES = 100;

export function directPlan(task: string): Plan {
  return {
    summary: "",
    answer_from: "",
    direct: true,
    steps: [
      {
        kind: "browse",
        goal: task,
        open_url: "",
        use_tab: -1,
        done_when: `Does the screen show that the user's task is finished: "${task}"?`,
        rules: "",
        max_moves: DIRECT_MOVES,
        question: "",
        choices: [],
        texts: [],
        save_as: "",
      },
    ],
  };
}
const INLINE_TEXTS = 4; // up to this many typeable texts: "type X into E3" is a move of its own
const MAX_TAB_OPTIONS = 8;

// A click on one of these needs the user's OK first: it spends money, sends something, or deletes something.
export const RISKY =
  /\b(send|pay|pay now|buy|purchase|place (your )?order|checkout|check out|complete (purchase|booking|order)|publish|post|tweet|reply|delete|remove|transfer|subscribe|book now|reserve|confirm and pay|submit (order|payment))\b/i;

export function describe(e: Pick<PageEl, "text" | "context" | "state" | "where">): string {
  return `${e.text}${e.context ? ` (in "${e.context}")` : ""}${e.state || ""}` + (e.where ? ` (${e.where})` : "");
}

const PLACEHOLDER = /\{\{\s*([\w-]+)\s*\}\}/g;

/** Replaces {{name}} with the text a read step saved under that name. allowNotes false (a page on a site the task
 * didn't start on or name): texts that would carry notes are left out, so what was read on one site is never typed
 * into another one a page steered the agent to. */
export function resolveTexts(
  texts: (StepText | null | undefined)[] = [],
  notes: Record<string, string | undefined> = {},
  allowNotes = true,
): StepText[] {
  return texts
    .filter((t): t is StepText => !!(t?.name && t.text && (allowNotes || !t.text.match(PLACEHOLDER))))
    .map((t) => ({
      name: t.name,
      text: t.text.replace(PLACEHOLDER, (m, k: string) => (k in notes ? String(notes[k]) : m)),
    }));
}

/** The first JSON object inside a text that wraps it in a sentence (answerGuard), or "" when there is none. */
export function jsonObject(text: string): string {
  const start = text.indexOf("{");
  for (let end = text.lastIndexOf("}"); start >= 0 && end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === "object") return text.slice(start, end + 1);
    } catch {} // not this closing brace: try the one before it
  }
  return "";
}

/** A note a list reading saved as JSON (its matches, or the answer of a list proven ordered), parsed; null for any
 * other note. */
export function collectionNote(text: string | undefined): Record<string, unknown> | null {
  if (!text || !/^\s*\{/.test(text)) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    return Array.isArray(o.matches) || (!!o.answer && typeof o.answer === "object") ? o : null;
  } catch {
    return null;
  }
}

/** aggregate: every link a list reading's note holds: its computed result's selected rows and its matches' sources.
 * A link a later step opens must be one of these. */
export function noteLinks(note: Record<string, unknown> | null): Set<string> {
  const links = new Set<string>();
  if (!note) return links;
  const computed = note.computed as { selected?: { href?: unknown }[] } | undefined;
  for (const r of computed?.selected ?? []) if (typeof r.href === "string" && originOf(r.href)) links.add(r.href);
  for (const m of (note.matches as { source?: unknown }[] | undefined) ?? [])
    if (typeof m.source === "string" && originOf(m.source)) links.add(m.source);
  return links;
}

/** aggregate: the link of the one chosen row a step names by its number. A step that names a long number (an order or
 * record number, 5 digits or more) shown in exactly one row a reading chose (computed.selected) or matched goes to that
 * row's link; none when no row, or more than one, shows it. */
export function namedRowLink(goal: string, notes: Record<string, string | undefined>): string {
  const numbers = new Set(goal.match(/\b\d{5,}\b/g) ?? []);
  if (!numbers.size) return "";
  const rows: { text: string; href: string }[] = [];
  for (const text of Object.values(notes)) {
    const note = collectionNote(text);
    if (!note) continue;
    const computed = note.computed as { selected?: { text?: unknown; href?: unknown }[] } | undefined;
    for (const r of computed?.selected ?? [])
      if (typeof r.text === "string" && typeof r.href === "string") rows.push({ text: r.text, href: r.href });
    for (const m of (note.matches as { row?: unknown; source?: unknown }[] | undefined) ?? [])
      if (typeof m.row === "string" && typeof m.source === "string") rows.push({ text: m.row, href: m.source });
  }
  const links = new Set(
    rows
      .filter((r) => originOf(r.href) && [...numbers].some((n) => new RegExp(`\\b${n}\\b`).test(r.text)))
      .map((r) => r.href),
  );
  return links.size === 1 ? ([...links][0] ?? "") : "";
}

/** Whether any note is a list reading's JSON with an object under "computed" (aggregate: the count, total or ranking
 * the step calculated in code), so that the final read and the final answer get the rule for reporting it. One whose
 * value is null still counts: the rule is what says that value is missing. */
export function hasComputed(notes: unknown): boolean {
  if (!notes || typeof notes !== "object") return false;
  return Object.values(notes).some((note) => {
    if (typeof note !== "string") return false;
    try {
      const computed = (JSON.parse(note) as { computed?: unknown } | null)?.computed;
      return !!computed && typeof computed === "object" && !Array.isArray(computed);
    } catch {
      return false;
    }
  });
}

/** A per-page select's option: a whole number of rows, with "per page" after it or not ("36", "36 per page"). */
const PAGE_SIZE_OPTION = /^\s*(\d+)(?:\s*per\s+page)?\s*$/i;
/** What a per-page select is named or labelled ("Show", "Items per page", "Page size", "Display"). */
const PAGE_SIZE_NAME = /\b(?:per[\s-]page|page[\s-]?size|show|limiter|display)\b/i;
/** listCoverage: the page's per-page control, a native select whose name or label says per page / page size / show /
 * limiter / display and whose options are whole numbers with a largest of 12 or more, while a smaller one is chosen;
 * null when there is none. A largest over 1000 is no page size: a select of years (2022, 2023) picks what the list
 * holds, not how much of it a page shows. */
export function pageSizeControl(
  els: { node: number; name?: string; text: string; select?: boolean; options?: string[]; selectedIndex?: number }[],
): { node: number; max: number; current: number } | null {
  for (const el of els) {
    if (!el.select || !el.options?.length || !PAGE_SIZE_NAME.test(`${el.name ?? ""} ${el.text}`)) continue;
    const sizes = el.options.map((option) => PAGE_SIZE_OPTION.exec(option)?.[1]);
    if (sizes.some((size) => size === undefined)) continue;
    const numbers = sizes.map(Number);
    const max = Math.max(...numbers);
    const current = numbers[el.selectedIndex ?? 0];
    if (current === undefined || max < 12 || max > 1000 || current >= max) continue;
    return { node: el.node, max, current };
  }
  return null;
}

/** Words of a task that ask for a computation over a list's rows. */
const AGGREGATE_WORDS = /\b(?:how many|how much|total|sum|count|average|the most|the fewest|top \d+)\b/i;
/** aggregate: the contract or the task asks for a computation over rows: every row of the list (enumerate_all), the top
 * N of a ranking, or a count, total, average, most or fewest the task names. The task is read without its answer-format
 * paragraphs, whose words describe the answer's shape. */
export function wantsAggregate(contract: CollectionContract, task: string): boolean {
  return (
    contract.intent === "enumerate_all" ||
    (typeof contract.ranked_count === "number" && contract.ranked_count > 1) ||
    AGGREGATE_WORDS.test(taskForMoves(task))
  );
}

/** The notes a step uses that hold a list reading's JSON: named as {{name}} in its texts, goal, done_when or rules,
 * or by name in its goal, done_when or rules (a plan writes "the best one from fitting_storage_options"). */
export function collectionNoteRefs(
  step: Pick<Step, "goal" | "done_when" | "rules" | "texts">,
  notes: Record<string, string | undefined>,
): string[] {
  const words = [step.goal, step.done_when, step.rules].filter(Boolean).join("\n");
  const typed = (step.texts ?? []).map((t) => t.text).join("\n");
  return Object.keys(notes).filter((name) => {
    if (!collectionNote(notes[name])) return false;
    const placeholder = new RegExp(`\\{\\{\\s*${name.replace(/[^\w-]/g, "")}\\s*\\}\\}`);
    const named = name.length >= 4 && new RegExp(`(^|[^\\w])${name.replace(/[^\w-]/g, "")}([^\\w]|$)`).test(words);
    return placeholder.test(words) || placeholder.test(typed) || named;
  });
}

/** The notes a step would type ({{name}} in its texts) that hold a collect step's evidence (its JSON of sources, with
 * the coverage line after it): data to write out first, never text to type. noteResolve's list notes (matches) are not
 * among them. */
export function typedEvidenceNotes(step: Pick<Step, "texts">, notes: Record<string, string | undefined>): string[] {
  const typed = (step.texts ?? []).map((t) => t.text).join("\n");
  return Object.keys(notes).filter((name) => {
    if (!new RegExp(`\\{\\{\\s*${name.replace(/[^\w-]/g, "")}\\s*\\}\\}`).test(typed)) return false;
    const json = jsonObject(notes[name] ?? "");
    try {
      return !!json && Array.isArray((JSON.parse(json) as { sources?: unknown }).sources);
    } catch {
      return false;
    }
  });
}

/** The step with the notes it names filled in: {{name}} becomes value; a goal, done_when or rules that names the note
 * gets the value beside the name. Texts still holding one of these notes (no value) are dropped: a list reading's JSON
 * is never typed into a page. */
export function withNoteValue<S extends Pick<Step, "goal" | "done_when" | "rules" | "texts">>(
  step: S,
  names: string[],
  value: string,
): S {
  const clean = (n: string) => n.replace(/[^\w-]/g, "");
  const fill = (s: string | undefined) => {
    if (!s) return s ?? "";
    let out = s;
    for (const n of names) {
      if (value) out = out.replace(new RegExp(`\\{\\{\\s*${clean(n)}\\s*\\}\\}`, "g"), value);
      if (value && new RegExp(`(^|[^\\w])${clean(n)}([^\\w]|$)`).test(out) && !out.includes(value))
        out = out.replace(new RegExp(`(^|[^\\w])(${clean(n)})(?=[^\\w]|$)`), `$1$2 ("${value}")`);
    }
    return out;
  };
  const texts = (step.texts ?? [])
    .map((t) => ({ ...t, text: fill(t.text) }))
    .filter((t) => !names.some((n) => new RegExp(`\\{\\{\\s*${clean(n)}\\s*\\}\\}`).test(t.text)));
  return { ...step, goal: fill(step.goal), done_when: fill(step.done_when), rules: fill(step.rules), texts };
}

export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return /^(https?|file):$/.test(u.protocol) ? u.origin : "";
  } catch {
    return "";
  }
}

/** An address with no scheme, such as the site map's paths ("/admin/sales/order/") or "?page=2": what resolveAddress
 * resolves. Text with a space in it is prose, not an address, and so is anything that isn't text (an open_url is the
 * LLM's JSON: a number or null gets here as well). */
export function isRelativeAddress(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const address = url.trim();
  if (!address || /\s/.test(address)) return false;
  try {
    new URL(address);
    return false;
  } catch {
    return true;
  }
}

/** A step's open_url as a browser can open it. The site map prints a link of the page's own site as its path and query
 * ("/admin/sales/order/") and the planner copies that as it is: an address with no scheme resolves on base, the page
 * the agent is on, and never leaves that page's origin. A path with one leading "/" is the exact inverse of how the map
 * prints a link: base.origin + path. Any other relative form (a query, "x.html", "../x") resolves as a link on the page
 * would and must come out on the same origin. "//host/x", "/\host/x" and "\\host\x" name another site, and a link of
 * this site whose path starts with a double slash is printed the same way, so they come back as written. So do an
 * absolute URL and what webOnly must refuse (a non-web scheme, prose, a path with no web page to resolve it on). */
export function resolveAddress(url: string, base: string | null | undefined): string {
  if (!isRelativeAddress(url)) return url;
  try {
    const page = new URL(base ?? "");
    if (!/^https?:$/.test(page.protocol)) return url;
    const address = url.trim();
    const resolved = /^\/(?![/\\])/.test(address) ? new URL(page.origin + address) : new URL(address, page);
    return resolved.origin === page.origin ? resolved.href : url;
  } catch {
    return url;
  }
}

/** The first http(s) address written in a text (the task), without the punctuation after it, or "". */
export function firstUrl(text: string | null | undefined): string {
  const found = /\bhttps?:\/\/[^\s<>"'`]+/i.exec(text ?? "")?.[0] ?? "";
  return found.replace(/[.,;:!?)\]}]+$/, "");
}

/** Steps a replan brings (from the LLM, which read the page) may only open sites the run already trusts: the user's
 * open tabs and the URLs of the first plan. Any other open_url is dropped (the step continues in the current tab). */
export function guardSteps(steps: Step[], trusted: Set<string>): { steps: Step[]; dropped: string[] } {
  const dropped: string[] = [];
  const safe = steps.map((s) => {
    if (!s.open_url || trusted.has(originOf(s.open_url))) return s;
    dropped.push(s.open_url);
    return { ...s, open_url: "" };
  });
  return { steps: safe, dropped };
}

// --- the task's website: a search engine is a detour, and from a data centre a CAPTCHA (runs opened google.com
// instead of the site's own Research or Events menu, and were handed over at reCAPTCHA) ---
const SEARCH_HOSTS =
  /^(www\.)?(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|baidu\.com|yandex\.[a-z]+|ecosia\.org|search\.brave\.com|startpage\.com)$/i;
// a task that asks to use a search engine ("search Google for", "on Bing", "a web search"), not one that names a
// product or another service of the same company ("a Google Pixel", "Yahoo Finance", "on Google Maps")
const ENGINES = "(google|bing|duckduckgo|baidu|yandex|ecosia|startpage|brave search|yahoo search)";
const SEARCH_NAMES = new RegExp(
  `\\b(search engine|web search)\\b|\\b(search|on|using|via|with|through|in|from)\\s+${ENGINES}\\b(?!\\s*(maps|shopping|flights|hotels|finance|news|play|drive|docs|sheets|scholar|store|cloud|pixel|nest|trends|translate)\\b)|\\b(google|bing)\\s+(it|for)\\b`,
  "i",
);

/** A search engine's own search or result pages (google.com/search, /sorry, the home page), not the engine's other
 * services (google.com/maps or /shopping are websites of their own). */
export function isSearchEngine(url: string | null | undefined): boolean {
  try {
    const u = new URL(url ?? "");
    return (
      SEARCH_HOSTS.test(u.hostname) && /^\/(search|sorry|webhp|html|s|web)?\/?$|^\/(search|sorry)\//.test(u.pathname)
    );
  } catch {
    return false;
  }
}

/** The website the task is about: the page the user's tab shows when the run starts, unless that is a search engine,
 * no website at all, or the task itself names a search engine. null: no site to stay on. */
export function taskSite(task: string, url: string | null | undefined): string | null {
  if (!url || !/^https?:/.test(url) || isSearchEngine(url) || SEARCH_NAMES.test(task)) return null;
  return url;
}

/** With a task site, a step may not open a search engine: it continues on the current page (the site) instead. */
export function stayOnSite(steps: Step[], site: string | null): { steps: Step[]; dropped: string[] } {
  const dropped: string[] = [];
  if (!site) return { steps, dropped };
  const kept = steps.map((s) => {
    if (!s.open_url || !isSearchEngine(s.open_url)) return s;
    dropped.push(s.open_url);
    return { ...s, open_url: "", use_tab: -1 };
  });
  return { steps: kept, dropped };
}

/** deadUrls: a page that says it doesn't exist: its title, or the start of its text, says 404 or "page not found". */
const DEAD_PAGE =
  /\b404\b|page not found|page (?:does not|doesn['’]t) exist|no such page|the page you requested (?:was|could) not/i;
export function deadPage(info: { title?: string; text?: string }): boolean {
  return DEAD_PAGE.test(info.title ?? "") || DEAD_PAGE.test((info.text ?? "").slice(0, 600));
}

/** deadUrls: an address the planner made up: not one of the user's open tabs and not written in the task. Only these
 * are given up on a not-found page; an address the user gave is the user's to fix. */
export function guessedUrl(url: string, task: string, tabUrls: (string | undefined)[]): boolean {
  if (!url || !originOf(url)) return false;
  const bare = (u: string) => u.replace(/[#?].*$/, "").replace(/\/+$/, "");
  if (tabUrls.some((t) => t && bare(t) === bare(url))) return false;
  return !task.includes(bare(url));
}

/** sortCheck: the date order a step asks the list to be in: desc for newest/latest/most recent first, asc for
 * oldest/earliest first, null for a step that sorts by no date (or doesn't sort). */
export function wantedDateOrder(step: Pick<Step, "goal" | "done_when">): "asc" | "desc" | null {
  const t = `${step.goal ?? ""} ${step.done_when ?? ""}`;
  if (!/\b(sort|sorted|sorting|order(?:ed)? by|newest first|latest first|oldest first|descending|ascending)\b/i.test(t))
    return null;
  if (!/\b(date|time|newest|latest|most recent|recent|oldest|earliest|created|purchased|placed)\b/i.test(t))
    return null;
  if (/\b(newest|latest|most recent|recent first|descending|desc)\b/i.test(t)) return "desc";
  if (/\b(oldest|earliest|ascending|asc)\b/i.test(t)) return "asc";
  return null;
}

/** sortCheck: the order the list's rows show by their dates: the first date each row text holds, read top to bottom.
 * asc or desc when at least three rows show a date and the first and last differ, with the dates seen; else null. */
export function shownDateOrder(rows: string[]): { order: "asc" | "desc"; first: number; last: number } | null {
  const dates = rows.map((r) => dateMs(r)).filter((d): d is number => d !== null);
  const first = dates[0],
    last = dates.at(-1);
  if (dates.length < 3 || first === undefined || last === undefined || first === last) return null;
  return { order: first < last ? "asc" : "desc", first, last };
}

/** navMap: the site map lines the planner gets: every link the page shows (at most 50), then the hidden ones (inside
 * closed menus) whose menu path shares a word with the task (its first five letters, so "switch" finds "Switches"),
 * at most MAX_SITE_MAP lines in all. A storefront's 250 category links would otherwise grow every plan call by about
 * 5,000 tokens. */
const MAX_SITE_MAP = 80;
const MAX_SHOWN_LINKS = 50;
/** The words of a task that find its place in a site's menus: those of four letters or more, by their first five
 * letters, so "switch" finds "Switches". */
export function taskStems(task: string): Set<string> {
  return new Set(
    normalizeLiteral(task)
      .split(" ")
      .filter((w) => w.length >= 4)
      .map((w) => w.slice(0, 5)),
  );
}
/** A map line's menu path (the part before its " -> ") has a word that starts like one of the stems. */
function pathHasStem(line: string, stems: Set<string>): boolean {
  const path = line.slice(0, line.lastIndexOf(" -> "));
  return normalizeLiteral(path)
    .split(" ")
    .some((w) => w.length >= 4 && stems.has(w.slice(0, 5)));
}
export function siteMapFor(lines: string[], task: string): string[] {
  const stems = taskStems(task);
  const shown = lines.filter((l) => !l.endsWith("(in a closed menu)")).slice(0, MAX_SHOWN_LINKS);
  const hidden = lines.filter((l) => l.endsWith("(in a closed menu)") && pathHasStem(l, stems));
  return [...shown, ...hidden].slice(0, MAX_SITE_MAP);
}
/** navMap's gate wants a map at least this long: a shorter one is a nav bar, not a menu system worth giving the
 * planner (reddit's holds 19 links; Magento's admin 94, its storefront 250). */
const MIN_SITE_MAP_LINKS = 30;
/** navMap's gate: whether the planner gets the site map at all. Only when the map holds MIN_SITE_MAP_LINKS lines or
 * more and a hidden entry (one inside a closed menu) matches the task, by the stems siteMapFor uses: that is a route
 * the page doesn't show. A map of shown links alone only repeats what Drex sees on the page. */
export function siteMapWanted(lines: string[], task: string): boolean {
  if (lines.length < MIN_SITE_MAP_LINKS) return false;
  const stems = taskStems(task);
  return lines.some((l) => l.endsWith("(in a closed menu)") && pathHasStem(l, stems));
}

/** A replan's step that would reopen the site the run is on at its home page, or the very page it is on, continues on
 * the current page instead: a new tab there throws away the filters and sort already set (runs replanned back to a
 * fresh home page). Another page of the site still opens. */
// a language's home page ("/en", "/en-us", "/de_DE"); a two-letter category ("/tv", "/pc") is another page
const LOCALE_HOME =
  /^\/(en|fr|de|es|it|pt|nl|ja|zh|ko|ru|pl|sv|da|nb|no|fi|tr|ar|he|cs|el|hu|ro|th|vi|id|ms|hi)([-_][a-z]{2,4})?\/?$/i;
export function keepPage(steps: Step[], current: string): { steps: Step[]; dropped: string[] } {
  const dropped: string[] = [];
  let here: URL;
  try {
    here = new URL(current);
  } catch {
    return { steps, dropped };
  }
  const kept = steps.map((s) => {
    if (!s.open_url) return s;
    let to: URL;
    try {
      to = new URL(s.open_url);
    } catch {
      return s;
    }
    const sameSite = to.hostname.replace(/^www\./, "") === here.hostname.replace(/^www\./, "");
    const home = /^\/?(index\.\w+)?$/.test(to.pathname) || LOCALE_HOME.test(to.pathname);
    const samePage = to.pathname === here.pathname && to.search === here.search;
    if (!sameSite || !(home || samePage)) return s;
    dropped.push(s.open_url);
    return { ...s, open_url: "", use_tab: -1 };
  });
  return { steps: kept, dropped };
}

/** Distinctive bits of an answer to find on the page: amounts, numbers with units, long numbers and quoted names,
 * longest first (a year or a bare small number is everywhere, so it isn't one). */
export function answerTokens(answer: string | null | undefined, max = 10): string[] {
  const text = answer ?? "";
  const found = new Set<string>();
  const add = (t: string | undefined) => {
    const v = (t ?? "").replace(/\s+/g, " ").trim();
    if (v.length >= 3 && v.length <= 60) found.add(v);
  };
  for (const m of text.matchAll(/[$€£¥]\s?\d[\d,]*(?:\.\d+)?/g)) add(m[0]);
  for (const m of text.matchAll(
    /\b\d[\d,]*(?:\.\d+)?\s?(?:mg|mcg|ml|kg|g|lbs?|oz|%|°[CF]?|km|mi|miles|hours?|hrs?|minutes?|mins?|stars?|reviews?|results?|jobs?|listings?)\b/gi,
  ))
    add(m[0]);
  for (const m of text.matchAll(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{5,}\b/g)) add(m[0]);
  for (const m of text.matchAll(/["“‘']([^"”’']{4,60})["”’']/g)) add(m[1]);
  return [...found].sort((a, b) => b.length - a.length).slice(0, max);
}

/** Earlier notes as Drex's state shows them: each one short, all of them bounded, so the state doesn't grow per move. */
export function notesSummary(notes: Record<string, unknown> = {}, each = 200, total = 1200): string {
  let out = "";
  for (const [k, v] of Object.entries(notes)) {
    const line = `${k}: ${clip(String(v).split(/\s+/).join(" "), each)}\n`;
    if (out.length + line.length > total) return `${out}(more notes left out)`;
    out += line;
  }
  return out.trim() || "(none)";
}

export function preview(t: StepText): string {
  return t.text.length <= 60
    ? `'${t.text}'`
    : `${t.name} (${t.text.length} characters, starting '${t.text.slice(0, 40)}...')`;
}

function quote(s = ""): string {
  return s.length <= 60 ? `'${s}'` : `'${s.slice(0, 40)}...' (${s.length} characters)`;
}

// --- dates (datePicker) -----------------------------------------------------------------------------------------------
// A read-only date field (a date picker's input) is set to a date the step's texts or words name. The forms: ISO
// yyyy-mm-dd, US m/d/yyyy (month first, as MiniWoB and US sites write it), d Month yyyy and Month d, yyyy (a month in
// full or by its first three letters, "Sept" too).

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH_WORD =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const ORDINAL = "(?:st|nd|rd|th)?";
/** Each form, and which of its groups hold the year, the month and the day. */
const DATE_FORMS: { re: string; y: number; m: number; d: number }[] = [
  { re: "(\\d{4})-(\\d{1,2})-(\\d{1,2})", y: 1, m: 2, d: 3 },
  { re: "(\\d{1,2})/(\\d{1,2})/(\\d{4})", y: 3, m: 1, d: 2 },
  { re: `(\\d{1,2})${ORDINAL}\\s+(${MONTH_WORD}),?\\s+(\\d{4})`, y: 3, m: 2, d: 1 },
  { re: `(${MONTH_WORD})\\s+(\\d{1,2})${ORDINAL},?\\s+(\\d{4})`, y: 3, m: 1, d: 2 },
];

/** A field a date picker sets: a read-only text box or combobox (cdp.elements() names a read-only combobox input
 * "dropdown"; a <select> is not one). A read-only checkbox or grid is no date field. */
export function datePickerField(e: PageEl): boolean {
  return !!e.readOnly && !e.select && ["textbox", "combobox", "dropdown"].includes(e.role ?? "");
}

/** An element whose text a copy can carry: a text box or area (its value), or one that shows text of its own; never a
 * select, slider or check box, which have a name but no text to copy. */
export function copySource(e: PageEl): boolean {
  if (e.role === "textbox" || e.textarea) return true;
  return !!e.ownText && !e.select && !e.slider && !["checkbox", "radio", "switch", "slider"].includes(e.role ?? "");
}

/** A field text can be pasted into: one that takes typing (not a read-only date box). */
export function editableField(e: PageEl): boolean {
  return !e.readOnly && !e.select && (!!e.field || e.role === "textbox" || !!e.textarea);
}

/** The fields on screen a copy of source's text can go into (Tab.copyInto): every other editable one. */
export function pasteTargets<T extends PageEl>(els: T[], source: PageEl): T[] {
  return els.filter((e) => e.label !== source.label && editableField(e));
}

/** The elements a dragged one can be dropped onto (the drop sub-choice): every other element on screen with a box, but
 * no canvas and no picture. MiniWoB drag-items-grid: with only names to go by, Drex dropped onto the reward panel's
 * canvas in 3 of 8 runs, and the page scores the first drop. */
export function dropTargets<T extends PageEl>(els: T[], source: PageEl): T[] {
  return els.filter((e) => e.label !== source.label && !!e.box && !["canvas", "img"].includes(e.role ?? ""));
}

interface DragGrid {
  rows: number;
  columns: number;
  /** every row has the same number of cells, and the grid is all on screen: its size and middle mean something */
  regular: boolean;
  /** each member's cell, by label */
  cells: Map<string, { row: number; column: number }>;
}

const boxCentre = (b: Box): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

/** The grid the dragged element is a cell of, or null. Either the scan's grid of repeated controls (e.grid: same role
 * and name, each perhaps in a wrapper of its own), or the regular grid of three or more elements it shares a parent
 * with (BOX_FN's group), placed as the scan places repeated controls: rows by the centre's y, columns by x. A sortable
 * list's items have different names, so the scan gives them no grid of their own. */
function dragGrid(source: PageEl, els: PageEl[]): DragGrid | null {
  const g = source.grid;
  if (g) {
    const members = els.filter(
      (e) => e.grid && e.role === source.role && e.name === source.name && e.grid.total === g.total,
    );
    if (!members.some((e) => e.label === source.label)) members.push(source);
    const rows = Math.max(...members.map((e) => e.grid?.row ?? 0)),
      columns = Math.max(...members.map((e) => e.grid?.column ?? 0));
    const cells = new Map(members.map((e) => [e.label, { row: e.grid?.row ?? 0, column: e.grid?.column ?? 0 }]));
    return { rows, columns, regular: members.length === g.total && rows * columns === g.total, cells };
  }
  if (!source.group || !source.box) return null;
  const members = els
    .filter((e) => e.group === source.group && e.label !== source.label)
    .concat(source)
    .flatMap((e) => (e.box ? [{ e, b: e.box }] : []));
  if (members.length < 3) return null;
  const placed = members
    .map(({ e, b }) => {
      const [cx, cy] = boxCentre(b);
      return { e, cx, cy, w: b[2] - b[0], h: b[3] - b[1] };
    })
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  const rows: { cy: number; h: number; items: typeof placed }[] = [];
  for (const m of placed) {
    let row = rows.find((r) => Math.abs(r.cy - m.cy) <= Math.max(4, Math.min(r.h, m.h) * 0.4));
    if (!row) {
      row = { cy: m.cy, h: m.h, items: [] };
      rows.push(row);
    }
    row.items.push(m);
  }
  rows.sort((a, b) => a.cy - b.cy);
  for (const r of rows) r.items.sort((a, b) => a.cx - b.cx);
  const first = rows[0]?.items ?? [];
  const columns = first.length;
  // a regular grid: every row as long as the first, and each column's cells one above the other
  const aligned = rows.every(
    (r) =>
      r.items.length === columns &&
      r.items.every((m, c) => {
        const top = first[c];
        return !!top && Math.abs(m.cx - top.cx) <= Math.max(4, Math.min(m.w, top.w) * 0.4);
      }),
  );
  if (!aligned) return null;
  const cells = new Map<string, { row: number; column: number }>();
  rows.forEach((r, ri) => r.items.forEach((m, ci) => cells.set(m.e.label, { row: ri + 1, column: ci + 1 })));
  return { rows: rows.length, columns, regular: true, cells };
}

/** A cell's words: "row 2, column 2 of a 3×3 grid (the centre)"; only the row and column when the grid's size is not
 * known (some of it off screen). */
function cellWords(grid: DragGrid, label: string): string {
  const cell = grid.cells.get(label);
  if (!cell) return "";
  const at = `row ${cell.row}, column ${cell.column}`;
  if (!grid.regular) return at;
  const middle =
    grid.rows % 2 === 1 &&
    grid.columns % 2 === 1 &&
    cell.row === (grid.rows + 1) / 2 &&
    cell.column === (grid.columns + 1) / 2;
  return `${at} of a ${grid.rows}×${grid.columns} grid${middle ? " (the centre)" : ""}`;
}

/** Where a drop target is, from the dragged element: its cell when both are cells of one grid (dragGrid), otherwise
 * the dominant direction and the distance between the two boxes' centres ("to the right, 120 px", "below, 40 px").
 * Then what it is (describe), so names still tell targets apart. MiniWoB drag-items-grid ("Drag Jinny to the
 * center."): by name alone Drex picked the centre cell in 3 of 8 runs. */
export function dropTargetDescription(source: PageEl, target: PageEl, els: PageEl[]): string {
  const what = describe(target);
  const grid = dragGrid(source, els);
  const cell = grid ? cellWords(grid, target.label) : "";
  if (cell) return `${cell}: ${what}`;
  if (!source.box || !target.box) return what;
  const [sx, sy] = boxCentre(source.box),
    [tx, ty] = boxCentre(target.box);
  const dx = tx - sx,
    dy = ty - sy;
  const far = Math.round(Math.max(Math.abs(dx), Math.abs(dy)));
  const where = !far
    ? "at the same place"
    : Math.abs(dx) >= Math.abs(dy)
      ? `to the ${dx > 0 ? "right" : "left"}, ${far} px`
      : `${dy > 0 ? "below" : "above"}, ${far} px`;
  return `${where}: ${what}`;
}

/** The drop sub-choice's question: where the dragged element itself is, the anchor for its options' wording. */
export function dropInstructions(source: PageEl, els: PageEl[]): string {
  const grid = dragGrid(source, els);
  const cell = grid ? cellWords(grid, source.label) : "";
  if (cell)
    return `Drop it onto which element? The element you drag is at ${cell}. Each option starts with where that element is: its cell in that grid, or its direction and distance from the element you drag.`;
  const [x, y] = source.box ? boxCentre(source.box).map(Math.round) : [];
  const at = source.box ? ` The element you drag is centred at x ${x}, y ${y} on screen.` : "";
  return `Drop it onto which element?${at} Each option starts with that element's direction and distance from the element you drag.`;
}

export interface CalendarDate {
  y: number;
  m: number;
  d: number;
}

/** The date a form's match names; null for a day the month doesn't have (02/30/2016) or a 13th month. */
function dateOf(found: RegExpExecArray, form: (typeof DATE_FORMS)[number]): CalendarDate | null {
  const y = Number(found[form.y]),
    d = Number(found[form.d]);
  const month = found[form.m] ?? "";
  const m = /^\d+$/.test(month)
    ? Number(month)
    : MONTH_NAMES.findIndex((n) => n.startsWith(month.slice(0, 3).toLowerCase())) + 1;
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return { y, m, d };
}

/** The date a text is, in one of the forms above (the whole text, a closing full stop aside); null for any other
 * text. "04/08/2016" is April 8. */
export function parseDate(text: string): CalendarDate | null {
  const t = text.trim().replace(/\.$/, "");
  for (const form of DATE_FORMS) {
    const found = new RegExp(`^${form.re}$`, "i").exec(t);
    if (found) return dateOf(found, form);
  }
  return null;
}

/** The dates written in a text, in the order they appear. */
function datesIn(text = ""): { token: string; date: CalendarDate; at: number }[] {
  const out: { token: string; date: CalendarDate; at: number }[] = [];
  for (const form of DATE_FORMS)
    for (const found of text.matchAll(new RegExp(`(?<![\\w/-])${form.re}(?![\\w/-])`, "gi"))) {
      const date = dateOf(found, form);
      if (date) out.push({ token: found[0], date, at: found.index });
    }
  return out.sort((a, b) => a.at - b.at);
}

/** The date a step sets a date field to: its first text that is a date; else the one date its goal names, else its
 * done_when, else the task (the first of them that names any). One that names two different dates gives none: the
 * plan must say which (the same date twice, in any form, is one date). */
export function stepDate(step: Step, task: string): string | null {
  for (const t of step.texts ?? []) if (parseDate(t.text)) return t.text;
  for (const words of [step.goal, step.done_when, task]) {
    const found = datesIn(words);
    if (!found.length) continue;
    const distinct = new Set(found.map(({ date }) => `${date.y}-${date.m}-${date.d}`));
    return distinct.size === 1 ? (found[0]?.token ?? null) : null;
  }
  return null;
}

/** Every move Drex can make on this screen: {key: description} for Drex, {key: action} for the extension.
 * direct (no LLM plan): Drex has no texts of its own, so every field gets a "type into" move the LLM writes the text
 * for; and Drex can ask the LLM whether the task is finished. dragTo (the switch of that name) with dragHint (the step
 * or task speaks of dragging, dropping, moving or sorting): an element marked to be dragged gets a drag move, whose
 * drop target is Drex's next choice. datePicker (the switch of that name): a read-only text box or combobox (a date
 * picker's input: datePickerField) gets a "type" move for each text that is a date, and for each of dateTexts (the
 * date the step's words name when none of its texts is one: offered on those fields only). copyMove (the switch of that name) with copyHint (the step or task says copy, paste or duplicate):
 * an element with text to copy gets a copy move, whose field to paste into is Drex's next choice. */
/** longSelects: the options of a long list that the step or task names, as whole words (case and accents aside), at
 * most MAX_NAMED_OPTIONS; a longer option first, so "New York" wins over "York". */
const MAX_NAMED_OPTIONS = 8;
export function namedOptions(options: string[], wanted: string): Set<number> {
  const text = ` ${normalizeLiteral(wanted)} `;
  const hits = options
    .map((o, j) => ({ j, n: normalizeLiteral(o) }))
    .filter(({ n }) => n.length >= 2 && text.includes(` ${n} `))
    .sort((a, b) => b.n.length - a.n.length);
  return new Set(hits.slice(0, MAX_NAMED_OPTIONS).map((h) => h.j));
}

export function buildOptions({
  els = [],
  off = [],
  texts = [],
  tabs = [],
  direct = false,
  sliderValues = [],
  dragTo = false,
  dragHint = false,
  datePicker = false,
  dateTexts = [],
  copyMove = false,
  copyHint = false,
  wanted = "",
}: {
  els?: LocatedEl[];
  off?: LocatedEl[];
  texts?: StepText[];
  tabs?: TabInfo[];
  direct?: boolean;
  sliderValues?: number[];
  dragTo?: boolean;
  dragHint?: boolean;
  datePicker?: boolean;
  dateTexts?: StepText[];
  copyMove?: boolean;
  copyHint?: boolean;
  /** longSelects: what the step and task say (goal, done_when, texts, task): a long list offers the options it names */
  wanted?: string;
}): Options {
  const opts: Record<string, string> = {};
  const acts: Record<string, MoveOption> = {};
  const add = (k: string, desc: string, act: MoveOption) => {
    if (k in opts) return;
    opts[k] = desc;
    acts[k] = act;
  };
  const dates = datePicker ? [...texts, ...dateTexts].filter((t) => parseDate(t.text)) : [];
  for (const e of els) {
    if (e.role === "canvas") {
      add(
        `inspect ${e.label}`,
        `Inspect the visual objects inside ${describe(e)}; ask the helper for an exact meaningful target instead of clicking the canvas center`,
        { kind: "look", el: e },
      );
    } else if (e.slider) {
      const v = e.slider;
      const numbers = new Set([v.min, v.max]);
      for (const value of sliderValues) numbers.add(value);
      if (finite(v.value) && finite(v.step)) {
        numbers.add(v.value - v.step);
        numbers.add(v.value + v.step);
      }
      for (const t of texts) for (const m of t.text.matchAll(/-?\d+(?:\.\d+)?/g)) numbers.add(Number(m[0]));
      for (const value of numbers) {
        if (!finite(value) || (finite(v.min) && value < v.min) || (finite(v.max) && value > v.max) || value === v.value)
          continue;
        add(`set ${e.label} to ${value}`, `Set ${describe(e)} to ${value} (range ${v.min}..${v.max}, step ${v.step})`, {
          kind: "set_value",
          el: e,
          value,
        });
      }
      if (v.kind === "custom")
        for (const direction of [-1, 1]) {
          add(
            `adjust ${e.label} ${direction < 0 ? "down" : "up"}`,
            `Adjust ${describe(e)} one keyboard step ${direction < 0 ? "down" : "up"} and observe its value`,
            { kind: "adjust_slider", el: e, direction },
          );
        }
    } else if (e.select && e.options) {
      const named = e.longList ? namedOptions(e.options, wanted) : null;
      e.options.forEach((name, j) => {
        if (!name || (e.multiple ? e.selectedOptions?.includes(name) : j === e.selectedIndex)) return;
        if (named && !named.has(j)) return;
        add(`choose '${name.slice(0, 40)}' in ${e.label}`, `In ${describe(e)}, choose the option '${name}'`, {
          kind: "select",
          el: e,
          index: j,
          value: name,
        });
      });
    } else if (e.field) {
      // a single-line field or a form text area is replaced (Agent.typeInto); a document editor (a document, an email
      // body) is added to at its end
      const adds = e.multi && !e.textarea;
      const how = adds ? "at the end of" : "into";
      const note = adds ? " (adds to what it holds)" : " (replaces what it holds)";
      if (texts.length && texts.length <= INLINE_TEXTS) {
        for (const t of texts)
          add(`type ${t.name} into ${e.label}`, `Type ${preview(t)} ${how} ${describe(e)}${note}`, {
            kind: "type",
            el: e,
            text: t,
          });
      } else if (texts.length && !direct) {
        add(`type into ${e.label}`, `Type one of the texts ${how} ${describe(e)}${note}`, { kind: "type_pick", el: e });
      }
      if (direct)
        add(
          `type into ${e.label}`,
          `Type ${how} ${describe(e)}${note}; the text your task needs there is written for you`,
          { kind: "write", el: e },
        );
      add(`click ${e.label}`, `Click ${describe(e)}`, { kind: "click", el: e });
    } else {
      // a read-only field takes no typing: the move picks the date in what the field opens (Agent.perform)
      if (datePickerField(e))
        for (const t of dates)
          add(`type ${t.name} into ${e.label}`, `Set ${describe(e)} to ${preview(t)}, picked in its calendar`, {
            kind: "type",
            el: e,
            text: t,
          });
      if (e.submenu)
        add(
          `hover ${e.label}`,
          `Point at ${describe(e)} without clicking: opens its submenu, to choose an item in it`,
          {
            kind: "hover",
            el: e,
          },
        );
      add(`click ${e.label}`, `Click ${describe(e)}`, { kind: "click", el: e });
    }
    // only when the step speaks of dragging (a drag library marks every card or row of a board, list or file manager
    // draggable), only on screen, and only with something on screen to drop it onto (no canvas or picture: dropTargets)
    if (dragTo && dragHint && e.draggable && dropTargets(els, e).length)
      add(`drag ${e.label}`, `Drag ${describe(e)} and drop it onto another element (you choose which next)`, {
        kind: "drag_pick",
        el: e,
      });
    // only when the step speaks of copying, and a field other than the source is there to paste into
    if (copyMove && copyHint && copySource(e) && pasteTargets(els, e).length)
      add(`copy the text of ${e.label}`, `Copy the text of ${describe(e)} into a field (you choose which next)`, {
        kind: "copy_pick",
        el: e,
      });
  }
  for (const e of [...els, ...off])
    if (e.paginationURL) {
      add(
        `open page ${e.label}`,
        `Open ${e.paginationLabel || e.name || e.text} using its visible same-origin pagination link`,
        { kind: "navigate_page", el: e, url: e.paginationURL },
      );
    }
  for (const d of off) {
    if (d.field) add(`scroll to ${d.label}`, `Scroll to ${describe(d)}`, { kind: "scroll_to", el: d });
    else add(`click ${d.label}`, `Click ${describe(d)} (scrolls to it first)`, { kind: "scroll_click", el: d });
  }
  for (const t of texts)
    add(`type ${t.name} at the cursor`, `Type ${preview(t)} where the text cursor is now (no click first)`, {
      kind: "type_cursor",
      text: t,
    });
  if (direct)
    add(
      "type at the cursor",
      "Type where the text cursor is now (no click first); the text your task needs there is written for you",
      { kind: "write_cursor" },
    );
  const glob: Record<string, [string, MoveOption]> = {
    "scroll down": ["Scroll down to see more of this page", { kind: "scroll", down: true }],
    "scroll up": ["Scroll up", { kind: "scroll", down: false }],
    "press enter": ["Press Enter (submits the focused field or form)", { kind: "key", key: "Enter" }],
    "press escape": ["Press Escape (closes a popup, menu or dialog)", { kind: "key", key: "Escape" }],
    "press tab": ["Press Tab (moves to the next field)", { kind: "key", key: "Tab" }],
    back: ["Go back to the previous page (browser Back button)", { kind: "back" }],
    wait: ["The page is still loading or changing; wait a moment", { kind: "wait" }],
  };
  for (const [k, [desc, act]] of Object.entries(glob)) add(k, desc, act);
  tabs.slice(0, MAX_TAB_OPTIONS).forEach((t, i) =>
    add(`switch to tab ${i + 1}`, `Switch to the open tab '${(t.title || "").slice(0, 60)}' (${host(t.url)})`, {
      kind: "tab",
      tab: t,
    }),
  );
  if (direct) {
    // no plan: Drex judges the end alone, and stopping early was its weak spot, so a check by the LLM is one move away
    add(
      "step done",
      "The screen plainly shows the final result of the user's task (an order or booking confirmation, the sent message, the saved change): stop here",
      { kind: "step_done" },
    );
    add(
      "ask if finished",
      "Ask the helper (a language model) whether the user's task is finished: choose this instead of 'step done' whenever the task might be done but the screen does not plainly show its final result",
      { kind: "check_done" },
    );
  } else {
    add("step done", "This step's goal is reached on screen: move on to the next step", { kind: "step_done" });
  }
  add(
    "ask user",
    "Hand over to the user: a CAPTCHA or human check, a login, or a choice only the user can make is on screen",
    { kind: "ask_user" },
  );
  add(
    "look",
    "Ask the visual helper to inspect colors, counts, pictures or unlabeled objects and advise the next move",
    { kind: "look" },
  );
  add(
    "ask for help",
    direct
      ? "Hand this move to the helper (a language model): for anything you are unsure about or can't do yourself (what the task means on this page, which option fits it, a search that found nothing, something the task needs that this page doesn't offer, a spot with no tag, no move that makes progress)"
      : "Ask the helper (a language model) to take this one move: no move here makes progress, or the move needs something you can't do (click a spot with no tag, type text you were not given, rethink the plan)",
    { kind: "stuck" },
  );
  return { opts, acts };
}

/** The task without the paragraphs that only say how to write its final answer (a JSON format, its fields and
 * statuses): moves and list readings act on what the task asks for, and the final answer still gets the whole task. A
 * task that is all format keeps its first paragraph. */
const FORMAT_PARAGRAPH =
  /\bJSON\b|\banswer format\b|\bfinal answer\b|\bretrieved_data\b|\btask_type\b|\boutput (?:this|the|a|one)\b/i;
const MOVES_NOTE = "(How to write the final answer is left out here: a later step writes it.)";
export function taskForMoves(task: string): string {
  if (task.endsWith(MOVES_NOTE)) return task;
  const paragraphs = task.split(/\n\s*\n/);
  const kept = paragraphs.filter((p) => !FORMAT_PARAGRAPH.test(p));
  if (kept.length === paragraphs.length) return task;
  return `${(kept.length ? kept : paragraphs.slice(0, 1)).join("\n\n").trim()}\n${MOVES_NOTE}`;
}

/** A site's search box: typing into it is followed by Enter in the same move (the searchEnter cost switch). */
export function searchField(el: Pick<PageEl, "role" | "name" | "text" | "multi">): boolean {
  if (el.multi) return false;
  return (
    el.role === "searchbox" ||
    // "search" as a word: a form's "Research topic" or "Researcher" field is no search box, and Enter would submit it
    (["combobox", "textbox"].includes(String(el.role)) && /\bsearch\b/i.test(`${el.name ?? ""} ${el.text}`))
  );
}

/** Move options as Drex reads them, shorter: icon-font characters dropped, the text an element sits in ("in ...")
 * clipped to its first words, and of the off-screen elements (D1, D2, ...) only the first with each name, at most
 * MAX_OFFSCREEN (a grid's "Add to Wish List" twelve times over is one move away after a scroll anyway). */
const MAX_OFFSCREEN = 20;
export function compactOptions(opts: Record<string, string>, max = 40): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  let offscreen = 0;
  for (const [k, raw] of Object.entries(opts)) {
    const v = raw
      .replace(/[\ue000-\uf8ff]\s?/g, "")
      .replace(/\(in "([^"]*)"\)/g, (m, inner: string) => (inner.length > max ? `(in "${inner.slice(0, max)}...")` : m))
      .replace(
        /^Point at (.*) without clicking: opens its submenu, to choose an item in it$/,
        "Hover $1: opens its submenu",
      )
      .replace(/ \(scrolls to it first\)$/, "");
    if (/ D\d+$/.test(k)) {
      const name = v.replace(/ \(in "[^"]*"\)| \([\d.]+ screens? (?:up|down)\)/g, "");
      if (seen.has(name) || offscreen >= MAX_OFFSCREEN) continue;
      seen.add(name);
      offscreen++;
    }
    out[k] = v;
  }
  return out;
}

export function host(url: string | undefined): string {
  try {
    return new URL(url ?? "").host;
  } catch {
    return url || "";
  }
}

export function planLines(plan: Pick<Plan, "steps">, index: number): string {
  return plan.steps
    .map(
      (s, i) =>
        `${i + 1}. ${i < index ? "[done] " : i === index ? "[NOW] " : ""}${s.kind === "read" ? "(the LLM reads the page) " : ""}${s.goal}`,
    )
    .join("\n");
}

export function stateText({
  task,
  plan,
  index,
  texts,
  history: all,
  info,
  tagged = 1,
  moves = all.length,
  budget = 0,
  site = null,
  step: sub = null,
  loop = null,
  textOnly = false,
}: {
  task: string;
  plan: Pick<Plan, "steps" | "direct">;
  index: number;
  texts: StepText[];
  history: HistoryEntry[];
  info: { title: string; url: string };
  tagged?: number;
  moves?: number;
  budget?: number;
  site?: Site | null;
  step?: Step | null;
  loop?: { moves: string[] } | null;
  /** No screenshots come with this state: Drex reads the page from its tagged elements alone. */
  textOnly?: boolean;
}): string {
  const step = sub ?? plan.steps[index]; // a sub-step of a batch step (a bulk action, one item) has its own goal
  if (!step) throw new TypeError(`stateText: the plan has no step ${index}`);
  const history = all.filter((h) => !h.marker);
  // only repeats that changed nothing: a repeating step (open the next item, file it) repeats moves on purpose
  const dead = history
    .slice(-6)
    .filter((h) => !h.changed)
    .map((h) => h.what);
  const repeated = [...new Set(dead.filter((m, i) => dead.indexOf(m) !== i))];
  const warning = repeated.length
    ? `\nWARNING: you are repeating yourself (${repeated.join("; ")}). That has not moved the step forward; do something different.\n`
    : "";
  const textBlock = texts.length
    ? `TEXT YOU CAN TYPE (only these; the move options name them):\n${texts.map((t) => `- ${t.name}: ${preview(t)}`).join("\n")}\n`
    : "";
  return `You are Drex, a browser agent working in the user's own Chrome, signed in to their accounts. Each move you look at the screen and choose ONE move; the extension performs it with the real mouse and keyboard.

THE USER'S TASK: ${task}
${plan.direct ? "" : `\nTHE PLAN:\n${planLines(plan, index)}\n`}
YOUR STEP NOW: ${step.goal}
IT IS DONE WHEN: ${step.done_when || "the goal above is visibly reached"}
${plan.direct ? `${DIRECT_NOTE}\n` : ""}${step.rules ? `RULES FOR YOUR DECISIONS IN THIS STEP:\n${step.rules}\n` : ""}${textBlock}${site?.screen_tips ? `NOTES ABOUT ${site.name.toUpperCase()}: ${site.screen_tips}\n` : ""}
YOUR MOVES IN THIS STEP SO FAR (${moves}${budget ? ` of at most ${budget}` : ""}; the last ones, oldest first):
${
  history
    .slice(-HISTORY_MOVES)
    .map(
      (h, i) =>
        `${i + 1}. ${h.what}${h.effect ? ` -> ${h.effect}` : ""}${h.changed ? "" : " -> nothing changed on screen"}${h.note ? ` (the helper made this move: ${clip(h.note, NOTE_CHARS)})` : ""}`,
    )
    .join("\n") || "(none yet)"
}
${warning}${loop ? `\nLOOP: your last moves went round in a circle and came back to where they started: ${loop.moves.join(" -> ")}. Those moves are not offered for now. Do something different that moves YOUR STEP NOW forward; if nothing on this screen does, choose 'ask for help'.\n` : ""}
THE PAGE ON SCREEN: "${info.title}" at ${info.url}
${textOnly ? "You read the screen from its elements: every element you can use is tagged E1, E2, ... and the move options name them with their text. Elements tagged D1, D2, ... are off screen; their options say how far up or down." : "Image 1 is the screen now. Image 2 is the same screen with every element you can use boxed in blue and tagged E1, E2, ...; the move options use those tags. Elements tagged D1, D2, ... are off screen; their options say how far up or down."}${tagged ? "" : "\nNOTE: nothing on this screen could be tagged. If something must be clicked, choose 'ask for help' so the helper can click it for you."}`;
}

export const MOVE_Q =
  "What is the single best next move toward YOUR STEP NOW? Do not repeat a move that changed nothing. " +
  "Choose 'step done' only when the screen shows the step is finished, and 'ask user' only for a CAPTCHA, a login or a choice only the user can make.";

// No plan: nobody broke the task down or said what "finished" looks like, so Drex is told to lean on the helper
const DIRECT_NOTE =
  "NO PLAN: you work from the user's words alone. A helper (a language model) is one move away, and asking it costs far less than a wrong move or stopping too early. Choose 'ask for help' for anything you are unsure about or can't do yourself, and when a search finds nothing or something the task needs is not offered on this page: never guess at an unlabeled control, and never move on without part of the task. Before you stop, choose 'ask if finished' unless the screen plainly shows the final result of the task: items in a cart, a filled form or a list of results are usually not the end of an order, a booking or a request.";

export const MOVE_Q_DIRECT =
  "What is the single best next move toward the user's task? Do not repeat a move that changed nothing. " +
  "Choose 'step done' only when the screen plainly shows the task's final result; when it might be finished but you are not sure, choose 'ask if finished'. " +
  "Choose 'ask for help' when you are unsure what to do, and 'ask user' only for a CAPTCHA, a login or a choice only the user can make.";

// A control's label is short ("Send", "Delete draft", "Place your order"); a long name is content (an email row
// whose preview says "send any amount..."), and opening it is not risky.
export const RISKY_NAME_MAX = 40;

// The approval gate judges what a click does, not the words it happens to contain. A risky word that is part of a
// noun phrase names a field or a filter, not the act: "Check in / Check out Anytime" is a stay's date picker (Airbnb),
// "Checkout date" a field, "Remove filter: 2 stars" undoes a filter, "Date posted" sorts, "Check out our deals" is an
// advert. Such a name is not risky; the act itself ("Checkout", "Proceed to checkout", "Remove item") still is.
const NOT_THE_ACT = [
  /\bcheck[- ]?in\b.*\b(check[- ]?out|checkout)\b|\b(check[- ]?out|checkout)\b.*\bcheck[- ]?in\b/i,
  /\b(check[- ]?(in|out)|checkout)\s+(date|time|day)s?\b/i,
  // the verb right before what it removes ("Remove filter: 2 stars", "Clear all filters"): with words between ("Remove
  // item and clear filters") another act may hide in them
  /\b(remove|clear|reset)\s+(all\s+|the\s+|my\s+)?(filters?|selections?|refinements?|sort(ing)?)\b/i,
  /\b(date|time)\s+posted\b|\bpost(ed)?\s+(date|time)\b|\bposted\s+on\b/i,
  /\bcheck out (our|more|new|what)\b/i,
  // a search's own counts and chips: a counter's minus ("Remove guests", "Remove adults") and a chip that names its
  // value ("Remove location: Seattle", "Remove guests: 2"): the search changes, nothing is sent. One named record
  // ("Remove guest" or "Remove guest: Jane" from an event, "Remove tag: bug" on an issue, "Remove room" from a booking)
  // is a removal and still asks
  /\b(remove|clear)\s+(guests|adults|children|kids|infants|rooms|travell?ers|passengers)$/i,
  /\b(remove|clear)\s+(the\s+)?(guests|adults|children|kids|infants|rooms|travell?ers|passengers|locations?|keywords?|dates?)\s*:/i,
  // mail, not publishing: "Claim by post", "Post office", "postcode"
  /\bby\s+post\b|\bpost\s+(office|code)s?\b/i,
  // a column or field named after the act sorts or shows it: "Purchase Date", "Order Total", "Payment Status"
  /\b(purchase|order|payment|post|send|delete)\s+(date|time|id|number|no\.?|status|total|history|amount)s?\b/i,
];
// Controls that choose or type a value: picking an option, ticking a box or switching a tab sends, pays and deletes
// nothing by itself (the button that submits the choice is checked on its own). A switch is not among them: settings
// toggles often save at once.
const CHOOSING_ROLES = new Set([
  "checkbox",
  "radio",
  // not "option": custom action menus ("Delete", "Send") are often built as listbox options and act on the click
  "tab",
  "textbox",
  "searchbox",
  "combobox",
  "dropdown",
  "spinbutton",
  "slider",
  "menuitemradio",
  "menuitemcheckbox",
]);

/** Does this control's name say it sends, pays, posts, books, subscribes or deletes? A long name is content (an
 * email row), and a risky word inside a field's or a filter's name (NOT_THE_ACT) is not the act. Only that phrase is
 * excused: another act in the same name ("Reserve: check-in 3/3, checkout 3/5", "Delete and reset filters") is risky. */
export function riskyName(name: string | null | undefined): boolean {
  // an icon font's ligature ("delete_outline") reads as words
  const n = (name ?? "").replace(/[\s_]+/g, " ").trim();
  if (!n || n.length > RISKY_NAME_MAX) return false;
  const rest = NOT_THE_ACT.reduce((t, re) => t.replace(new RegExp(re.source, "gi"), " "), n);
  return RISKY.test(rest);
}

export function isRisky(act: MoveOption): boolean {
  if (act.kind !== "click" && act.kind !== "scroll_click") return false;
  if (act.el.role && CHOOSING_ROLES.has(act.el.role)) return false;
  // a menu item that opens a submenu ("Send" in a postal site's navigation) only shows more items; the item the
  // submenu then offers is checked on its own
  if (act.el.submenu) return false;
  return riskyName(act.el.name ?? act.el.text);
}

/** A double-click, a drag or a key chord has no control name to check against RISKY, so with approvals on it is asked
 * about like a risky click. A hover changes nothing. A click at a screen point is judged by what is under it instead
 * (pointRisk). A drag of one element onto another asks like a drag, unless it drags a slider (sliderValueDrag). */
export function isRiskyGesture(act: MoveOption): boolean {
  if (act.kind === "drag_to") {
    const { role, slider, name, text } = act.el;
    const n = name ?? text;
    return !((role === "slider" || !!slider) && !riskyName(n) && !SLIDE_TO_ACT.test(n));
  }
  return act.kind === "point" || (act.kind === "gesture" && act.gesture?.kind !== "hover");
}

const CONSENT_FRAME =
  /consent|cookie|privacy-?(manager|center|mgmt)|\bcmp\b|sourcepoint|onetrust|cookielaw|trustarc|truste\b|didomi|usercentrics|quantcast|cookiebot|consensu/i;

const CONSENT_CHOICE =
  /^(accept|allow|reject|deny|decline|refuse)( all)?( cookies)?$|^(required|necessary|essential|strictly necessary)( cookies)? only$|^only (required|necessary|essential)( cookies)?$|^(manage|cookie|privacy) (preferences|settings|choices)$|^save (my )?(choices|preferences|settings)$/i;

/** Why a click at a screen point needs approval, or "" when it doesn't. target is what Tab.pointTarget found under
 * the point with the mouse already there (so a control that shows on hover counts): the names of the element hit
 * and of its ancestors up to the control that takes the click, that control's role, whether it submits a form that
 * sends data, whether it sits in an embedded frame, and whether the page asks for card details or a password. With
 * no target (it couldn't be read) the click is unknown, and unknown is risky. */
export function pointRisk(target: PointTarget | null | undefined): string {
  if (!target) return "what is under the point could not be read";
  // a cookie or consent manager's frame (Sourcepoint, OneTrust, TrustArc...) only takes privacy choices: closing it or
  // declining is not a payment, a message or a deletion (a site's cookie dialog asked for approval)
  // judged by the frame's host and its own title, id and name: an address's path or query ("?cookie=1",
  // "/oauth2/consent") says nothing of whose frame it is
  const frameInfo = (target.frameInfo ?? "").replace(/(https?:)?\/\/([^/\s?#]+)\S*/gi, "$2");
  if (target.frame && !CONSENT_FRAME.test(frameInfo))
    return "the point is inside an embedded frame, whose controls can't be read";
  if (target.payment) return "this page asks for card details or a password";
  // a choosing control's own name may hold a risky word ("Subscribe to updates" on a checkbox); a named icon inside it
  // ("Delete sheet" on a tab) is not the choice
  const named = target.names.find(
    (n) =>
      riskyName(n) && !(target.role && CHOOSING_ROLES.has(target.role) && (target.own ?? target.names).includes(n)),
  );
  if (named) return `the control there is '${named}'`;
  if (target.marks.length) return `the control there is marked '${target.marks[0]}'`;
  // a nameless close in a cookie or consent banner, or a consent choice by its own words ("Required Only", "Accept
  // All": Porsche's Usercentrics dialog holds no other text), takes a privacy choice: no name or mark said more
  if ((target.consent || target.names.slice(0, 2).some((n) => CONSENT_CHOICE.test(n))) && !target.submits) return "";
  // a nameless icon with its own click handler (a photo tile's Delete that shows on hover, laid over the tile or beside
  // it): the tile's name says nothing of what the icon does
  if (target.overlay) return "the point is on an icon with no name, which takes the click itself";
  // a button with no name and no mark (an icon in hashed classes) could be anything, a Delete among them
  // a glyph or an emoji ("×", "🗑") is no name
  if (
    !target.names.some((n) => /[\p{L}\p{N}]/u.test(n) && !/^[x×✕✖]$/i.test(n)) &&
    ["button", "menuitem"].includes(target.role)
  )
    return "the control there is a button with no name";
  if (target.submits) return "the control there submits a form that sends data";
  return "";
}

/** A drag that starts on a slider's handle sets a value, as typing in a field does: nothing is sent or deleted. Not a
 * slide-to-act widget ("Slide to pay", "Swipe to confirm"), whose drag is the act, nor a slider CAPTCHA ("Slide to
 * verify"), which is never solved; nor a slider anywhere a point click would ask (a frame, a card form, a risky name). */
const SLIDE_TO_ACT = /\b(slide|swipe|drag)\b.*\bto\b|captcha|verif|robot|human|puzzle/i;
export function sliderValueDrag(start: PointTarget | null | undefined): boolean {
  if (start?.role !== "slider" || pointRisk(start)) return false;
  return !start.names.some((n) => riskyName(n) || SLIDE_TO_ACT.test(n));
}

/** Did the target of a move vanish or move while the readiness check ran? Only the target counts: other content on
 * the page (a carousel, a countdown) may change freely. */
export const TARGET_TOLERANCE = 8;
export function targetStale(
  el: Pick<PageEl, "role" | "name" | "box" | "node"> | null | undefined,
  now: { els?: PageEl[]; off?: PageEl[] } = { els: [], off: [] },
): boolean {
  if (!el?.node) return false;
  const all = [...(now.els ?? []), ...(now.off ?? [])];
  const near = (box: Box | undefined) =>
    !!el.box && !!box && el.box.every((v, i) => Math.abs(v - (box[i] ?? NaN)) <= TARGET_TOLERANCE);
  const same = all.find((e) => e.node === el.node);
  if (same) return !!el.box && !!same.box && !near(same.box);
  // a re-rendered control is a new node: the same role and label in the same place is still the target
  return !all.some((e) => e.role === el.role && (e.name || "") === (el.name || "") && near(e.box));
}

// --- loops: moves that change the screen but go round in a circle ------------------------------------------------
// stallReason catches moves that change nothing; a circle (open a picker, close it, open it again) changes the screen
// every time, so it is found from the screens instead: the same moves, taken from near-identical screens, again.

export const LOOP_SIMILAR = 0.85; // share of on-screen elements two screens have in common to count as the same screen
export const LOOP_SIMILAR_ONE = 0.95; // stricter for a single repeated move, which is often legit (paging, waiting)

/** A screen as loop detection sees it: its URL and the texts of its elements (not their states: a button that just
 * got focus is the same button). */
export function screenOf(info: { url: string }, els: Pick<PageEl, "text">[]): Screen {
  return { url: info.url, texts: [...new Set(els.map((e) => e.text))] };
}

/** Public semantic state; transient countdowns, focus and broad ancestor text are not identity. */
export function stableState(
  info: { url: string },
  els: Pick<PageEl, "role" | "name" | "state" | "slider" | "box">[],
): string {
  return JSON.stringify([
    info.url,
    els.map((e) => [
      e.role || "",
      e.name || "",
      (e.state || "").replace(/ \(focused\)/g, ""),
      e.slider?.value,
      e.box?.map((n) => Math.round(n / 4)),
    ]),
  ]);
}

export function actionIdentity(act: MoveActFields, text: string | null | undefined): string {
  return JSON.stringify([
    act.kind,
    act.el?.role,
    act.el?.name,
    act.el?.box?.map((n) => Math.round(n / 4)),
    text,
    act.value,
    act.direction,
    act.key,
    act.tab?.url,
    act.x,
    act.y,
    act.to?.node, // a drag onto another target is another move
  ]);
}

export function similarScreens(
  a: Screen | null | undefined,
  b: Screen | null | undefined,
  min = LOOP_SIMILAR,
): boolean {
  if (!a || !b) return false;
  if (a.url !== b.url) return false;
  const B = new Set(b.texts);
  const A = new Set(a.texts);
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  const union = A.size + B.size - shared;
  return union === 0 || shared / union >= min;
}

/** The circle the last moves went round, or null: the last k moves (k = 2..9; a search, sort and filter circle ran 7) repeat the k before them, from the
 * same screens; a single move needs three rounds. Only moves after the last loop marker count. */
export function findLoop(history: HistoryEntry[], maxPeriod = 9): { period: number; moves: string[] } | null {
  const since = history.findLastIndex((h) => h.marker);
  const h = history.slice(since + 1).filter((m): m is MoveRecord => !m.marker);
  for (let k = 1; k <= maxPeriod; k++) {
    const rounds = k === 1 ? 3 : 2;
    if (h.length < rounds * k) continue;
    const min = k === 1 ? LOOP_SIMILAR_ONE : LOOP_SIMILAR;
    const last = h.slice(-k);
    let same = true;
    for (let r = 1; r < rounds && same; r++) {
      const prev = h.slice(-(r + 1) * k, -r * k);
      same = last.every(
        (m, i) =>
          m.changed && prev[i]?.changed && m.what === prev[i].what && similarScreens(m.screen, prev[i].screen, min),
      );
    }
    if (same) return { period: k, moves: last.map((m) => m.what) };
  }
  return null;
}

/** How many moves in a row, at the end of the history (since the last loop marker), only scrolled the page. A run of
 * SCROLL_RUN is a loop even though every scroll changes the screen: runs scrolled a results page up and down until
 * the run's call limit instead of using a filter or the search. */
export const SCROLL_RUN = 4;
export function scrollRun(history: HistoryEntry[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!h || h.marker || !/^scrolled (down|up)$/.test(h.what)) break;
    n++;
  }
  return n;
}

interface MoveActFields {
  kind: string;
  el?: PageEl;
  value?: unknown;
  direction?: number;
  key?: string;
  tab?: TabInfo;
  x?: number;
  y?: number;
  to?: PageEl;
}
interface PageNotes {
  dialogs: string[];
  notes: string[];
  url: string;
}
const META = new Set(["step_done", "ask_user", "stuck", "check_done", "wait"]);

/** The options without the moves paused after a loop, unless that would leave no real move at all. */
export function withoutMoves({ opts, acts }: Options, paused: Set<string>): Options {
  if (!paused.size) return { opts, acts };
  const keep = Object.entries(acts).filter(([, a]) => !paused.has(whatOf(a, "text" in a ? a.text?.text : undefined)));
  if (!keep.some(([, a]) => !META.has(a.kind))) return { opts, acts };
  const kept = new Set(keep.map(([k]) => k));
  return {
    opts: Object.fromEntries(Object.entries(opts).filter(([k]) => kept.has(k))),
    acts: Object.fromEntries(keep),
  };
}

/** Why Drex looks stuck before this move, or "": it repeats a recent move that changed nothing, or the last
 * STALL_MOVES moves all changed nothing (alternating Tab and Enter on a page that ignores both, say). */
export const STALL_MOVES = 3;
export function stallReason(all: HistoryEntry[], what: string): string {
  const history = all.filter((h) => !h.marker);
  if (deadBefore(all, what)) return `Drex is about to repeat '${what}', which changed nothing earlier.`;
  const last = history.slice(-STALL_MOVES);
  if (last.length === STALL_MOVES && last.every((h) => !h.changed))
    return `Drex's last ${STALL_MOVES} moves changed nothing on screen.`;
  return "";
}

/** The same move was made among the last 6 and changed nothing: stallReason's first test, alone (a drag's pairs are
 * judged one by one with it). */
export function deadBefore(all: HistoryEntry[], what: string): boolean {
  return all
    .filter((h) => !h.marker)
    .slice(-6)
    .some((h) => h.what === what && !h.changed);
}

export function whatOf(act: MoveOption, text?: string): string {
  switch (act.kind) {
    case "navigate_page":
      return `opened pagination link ${act.el.paginationLabel || act.el.name} (${act.url})`;
    case "adjust_slider":
      return `adjusted ${act.el.text} ${act.direction < 0 ? "down" : "up"}`;
    case "click":
      return `clicked ${describe(act.el)}`;
    case "hover":
      return `pointed at ${describe(act.el)}`;
    case "scroll_click":
      return `scrolled to and clicked ${act.el.text}${act.el.context ? ` (in "${act.el.context}")` : ""}`;
    case "scroll_to":
      return `scrolled to ${act.el.text}${act.el.context ? ` (in "${act.el.context}")` : ""}`;
    case "type":
    case "type_pick":
      // a read-only field is set through its calendar, all in this one move (datePicker)
      if (datePickerField(act.el)) return `set ${act.el.label} to ${text ?? act.text?.text ?? ""}`;
      return `typed ${quote(text)} into ${act.el.text}`;
    case "type_cursor":
      return `typed ${quote(text)} at the cursor`;
    case "write":
      return `typed into ${act.el.text}`; // before the LLM wrote the text (or when it found none)
    case "write_cursor":
      return "typed at the cursor";
    case "set_value":
      return `set ${act.el.text} to ${act.value}`;
    case "look":
      return "asked the visual helper";
    case "select":
      return `chose '${act.value}' in ${act.el.text}`;
    case "scroll":
      return act.down ? "scrolled down" : "scrolled up";
    case "key":
      return `pressed ${act.key}`;
    case "back":
      return "went back";
    case "tab":
      return `switched to the tab '${act.tab.title}'`;
    case "point":
      return `clicked at (${Math.round(act.x)}, ${Math.round(act.y)})`;
    case "drag_pick":
      return `drag ${act.el.label} (${act.el.text})`; // before Drex chose where it goes
    case "copy_pick":
      return `copy the text of ${act.el.label} (${act.el.text})`; // before Drex chose the field
    case "copy_to":
      return `copied ${act.el.label} (${act.el.text}) into ${act.to.label} (${act.to.text})`;
    case "drag_to":
      return `dragged ${act.el.label} (${act.el.text}) onto ${act.to.label} (${act.to.text})`;
    default:
      return act.kind;
  }
}

// --- batch steps ------------------------------------------------------------------------------------------------------
// One question per item of a list, answered by Drex for many items per call; the extension then acts on each answer
// group (tick the items + one bulk action, or one item at a time).

export const MAX_QUESTIONS = 16; // Drex rejects more than 16 questions in one request (checked on prod 2026-10-18)
export const BATCH_SURE = 0.8; // an item decided below this is opened and decided again from its full content

export function chunks<T>(items: T[], size = MAX_QUESTIONS): T[][] {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function itemQuestions(
  step: BatchStep,
  items: { text: string }[],
): Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> {
  const criteria = Object.fromEntries(step.choices.map((c) => [c.name, c.description]));
  return Object.fromEntries(
    items.map((it, i) => [
      `I${i + 1}`,
      { type: "choice", instructions: `ITEM: "${it.text}"\n${step.question}`, criteria },
    ]),
  );
}

export function batchState({
  task,
  step,
  info,
  site = null,
  opened = false,
}: {
  task: string;
  step: BatchStep;
  info: { title: string; url: string };
  site?: Site | null;
  opened?: boolean;
}): string {
  const answers = step.choices
    .map((c) => `- ${c.name}: ${c.description} (then: ${c.action || "leave it as it is"})`)
    .join("\n");
  return `You are Drex, deciding about the items of a list in the user's own Chrome.

THE USER'S TASK: ${task}

THE QUESTION FOR EACH ITEM: ${step.question}
THE ANSWERS:
${answers}
${step.rules ? `RULES:\n${step.rules}\n` : ""}${site?.screen_tips ? `NOTES ABOUT ${site.name.toUpperCase()}: ${site.screen_tips}\n` : ""}
THE PAGE ON SCREEN: "${info.title}" at ${info.url}
${
  opened
    ? "Image 1 is the screen now: the item is open, so you can read all of it."
    : "Image 1 is the screen now. Each question quotes one item's text from the list; some items may be off screen."
}`;
}

export function batchSummary(step: BatchStep, results: Record<string, string[] | undefined>): string {
  return step.choices
    .flatMap((c) => {
      const r = results[c.name];
      return r?.length ? [`${c.name} (${r.length}): ${r.map((t) => t.slice(0, 80)).join("; ")}`] : [];
    })
    .join("\n");
}

// --- what a move did ------------------------------------------------------------------------------------------------
// A click's name says what was aimed at, not what happened: "clicked Wonton Soup" read as done when it had opened a
// customer review that mentioned the dish. The page's dialogs, notices (role alert/status, live regions) and address
// before and after each move say what it did, on any site.

function where(url: string | undefined): string {
  try {
    const u = new URL(url ?? "");
    return `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url || "";
  }
}

export function effectOf(before: PageNotes | null | undefined, after: PageNotes | null | undefined): string {
  if (!before || !after) return "";
  const out = [];
  for (const d of after.dialogs) if (!before.dialogs.includes(d)) out.push(`opened "${d}"`);
  for (const d of before.dialogs) if (!after.dialogs.includes(d)) out.push(`closed "${d}"`);
  for (const n of after.notes) if (!before.notes.includes(n)) out.push(`notice "${n}"`);
  if (where(after.url) !== where(before.url)) out.push(`went to ${where(after.url)}`);
  return out.join("; ").slice(0, 240);
}

/** A replan from the LLM replaces the current step only: the later steps (checkout, scheduling...) stay, so a fix for
 * one step can't drop the rest of the task. */
export function applyReplan(steps: Step[], index: number, newSteps: Step[]): Step[] {
  return [...steps.slice(0, index), ...newSteps, ...steps.slice(index + 1)];
}

/**
 * The top-level fields a task's answer object must have, when the task spells the object out ("Return exactly one JSON
 * object with exactly these four fields: {"task_type": ..., "status": ...}"); none when it only says "JSON". Only an
 * object the answer is asked to be counts: an example the task quotes ("the API returns a JSON object like {...}") or
 * the shape of each item of a list ("return a list, each a JSON object {...}") is not the answer's own shape.
 */
export function requiredFields(task: string): string[] {
  const shape = answerShape(task);
  const keys = shape ? [...shape.matchAll(/"([A-Za-z_][\w-]*)"\s*:/g)].flatMap((m) => (m[1] ? [m[1]] : [])) : [];
  return keys.length >= 2 ? [...new Set(keys)] : [];
}

/** The answer object a task spells out, between its braces: undefined when it only says JSON, or the object is each
 * item of a list (requiredFields). */
function answerShape(task: string): string | undefined {
  const m =
    /\b(return|answer|respond|reply|output)\b([^.{]{0,80})\bJSON object(?!s)([^{]{0,200})\{([^{}]{0,800})\}([^.{]{0,80})/i.exec(
      task,
    );
  // list wording around the object ("a list, each a JSON object {...}", "a JSON object per order: {...}", "a JSON
  // object {...} for each product")
  const around = `${m?.[2] ?? ""} ${m?.[3] ?? ""} ${m?.[5] ?? ""}`;
  return m && !/\b(list|array|each|every|per)\b/i.test(around) ? m[4] : undefined;
}

/** confirmedChanges: the failure values the status field of a task's answer object allows ("status": "SUCCESS" |
 * "NOT_FOUND_ERROR" | "DATA_VALIDATION_ERROR"...); none when the task spells out no object with a status. */
export function errorStatuses(task: string): string[] {
  const values = /"status"\s*:\s*((?:"[^"]*"\s*\|?\s*)+)/i.exec(answerShape(task) ?? "")?.[1] ?? "";
  return [...values.matchAll(/"([^"]*)"/g)].flatMap((m) =>
    m[1] && /error|fail|denied|not_found/i.test(m[1]) ? [m[1]] : [],
  );
}

// confirmedChanges: what makes a step one that changes something on the site. Its goal's first word is a mutation
// ("Post a comment", "Click Save"); a goal that starts by going somewhere or reading ("Open the merge requests page")
// changes something only when its done_when says so; any other goal by a mutation verb in it or its done_when. Words
// that are often nouns (post, comment, order, merge, register, sign up, log in) count only as first words; check
// counts only as "check out" (or "checkout").
const MUTATION_FIRST =
  /^(save|submit|add|create|update|delete|remove|post|reply|comment|upvote|downvote|vote|subscribe|unsubscribe|change|edit|rename|set|apply|enable|disable|toggle|select|choose|cancel|approve|reject|assign|merge|close|reopen|publish|send|buy|order|check\s*out|place|pay|register|sign up|log in|login)\b/i;
const NAVIGATION_FIRST =
  /^(open|go|navigate|visit|find|view|look|read|search|browse|list|locate|show|see|scroll|switch|return|back|identify|note|record|collect|count|compare|determine|report|extract|gather|get)\b/i;
const MUTATION_VERB =
  /\b(save|submit|add|create|update|delete|remove|reply|upvote|downvote|vote|subscribe|unsubscribe|change|edit|rename|set|apply|enable|disable|toggle|select|choose|cancel|approve|reject|assign|close|reopen|publish|send|buy|check\s*out|place|pay)(s|d|ed|ing)?\b/i;

/** confirmedChanges: a step meant to change something ("Save the rule"), whose clicks' site answers are the run's
 * changes. A step that opens or finds a page ("Open the merge requests page") makes none: the requests its clicks bring
 * (a GraphQL read, a shipping estimate) are not the task's change. */
export function isMutatingStep(step: Pick<Step, "goal" | "done_when">): boolean {
  const goal = (step.goal ?? "").trim();
  const doneWhen = (step.done_when ?? "").trim();
  // the first word after a leading "then", "now", "also" or "please", and a "click"
  const first = goal.replace(/^((then|now|also|please)\b[\s,]*)*/i, "").replace(/^click\b\s*/i, "");
  if (MUTATION_FIRST.test(first)) return true;
  if (NAVIGATION_FIRST.test(first)) return MUTATION_VERB.test(doneWhen);
  return MUTATION_VERB.test(goal) || MUTATION_VERB.test(doneWhen);
}

/** confirmedChanges: the plan's last mutating step, the last browse or fill step (a step of no known kind runs as a
 * browse step) that changes something (isMutatingStep), when a confirmed change was made for it (by its goal); null when
 * there is none or it has none. The last change the task asks for decides, whether or not the run got to it: an
 * add-to-cart confirmed before an order the run never placed is not the task's last change (ruling 14). A list's paging
 * (collect) and a batch's items are not the task's change. */
export function lastMutatingStep(
  plan: { steps: Pick<Step, "kind" | "goal" | "done_when">[] },
  confirmations: { step: string }[],
): number | null {
  const goals = new Set(confirmations.map((c) => c.step));
  for (let i = plan.steps.length - 1; i >= 0; i--) {
    const s = plan.steps[i];
    const browse = !["read", "look", "verify", "collect", "batch"].includes(String(s?.kind));
    if (s && browse && isMutatingStep(s)) return s.goal !== undefined && goals.has(s.goal) ? i : null;
  }
  return null;
}

/** confirmedChanges: the confirmed changes an answer's error status is asked about again for (Agent.changeRefusal):
 * those of the plan's last mutating step (lastMutatingStep), when no change was rejected after the last of them; none
 * otherwise. On a step that also sets something (isSettingStep: "Apply the Legal filter") a change counts only by a
 * form post that navigated or a PUT, PATCH or DELETE (`strong`) or a success notice: the POST a single-page app's
 * search sends is no change the task made (ruling 15). The record the final answer reads keeps them all. */
export function refusalChanges<C extends { step: string; notices: string[]; rejected: boolean; strong?: boolean }>(
  plan: { steps: Pick<Step, "kind" | "goal" | "done_when">[] },
  changes: C[],
): C[] {
  const setting = new Set(plan.steps.filter((s) => isSettingStep(s)).map((s) => s.goal));
  const counts = (c: C) => !c.rejected && (!setting.has(c.step) || !!c.strong || c.notices.length > 0);
  const at = lastMutatingStep(plan, changes.filter(counts));
  const goal = at === null ? undefined : plan.steps[at]?.goal;
  const cited = changes.filter((c) => counts(c) && c.step === goal);
  const last = cited.at(-1);
  return last && !changes.slice(changes.indexOf(last) + 1).some((c) => c.rejected) ? cited : [];
}

/**
 * An answer in the task's format: JSON, and when the task spells out its object, that one object with all its fields. A
 * bare list of the values, or the object inside a list, is the right data in the wrong shape: the grader reads neither
 * (WebArena reddit 27-31 sent `[{"username": ...}]` and `[{"task_type": ...}]`).
 */
export function inFormat(text: string, task: string): boolean {
  if (!/^[[{]/.test(text)) return false;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  const fields = requiredFields(task);
  if (!fields.length) return true;
  return !!value && typeof value === "object" && !Array.isArray(value) && fields.every((f) => Object.hasOwn(value, f));
}

// --- settingReadback: the values a setting step sets, as the page read-back looks for them ---------------------------
/** A setting's value as the read-back compares it, in the step and on the page alike: lower case, "&" as "and", every
 * punctuation mark or symbol a space ("Full-time" is "full time", "$25" is "25"), spacing collapsed. It uses nothing
 * from outside itself: the page script runs this same function (cdp.ts READBACK_FN). */
export function normalizeLiteral(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SETTING_VERB = /\b(sort|filter|select|choose|set|enter|type|pick|apply|check|toggle|switch|narrow)\b/i;
/** settingReadback: a browse or fill step (a step of no known kind runs as browse) that sets something on the page: a
 * filter, a sort, an option or a typed value, by a setting verb in its goal or done_when. "Open the Reviews tab" or
 * "Click See 12 Homes" sets nothing. */
export function isSettingStep(step: Pick<Step, "kind" | "goal" | "done_when">): boolean {
  const browse = !["read", "look", "verify", "collect", "batch"].includes(String(step.kind));
  return browse && (SETTING_VERB.test(step.goal ?? "") || SETTING_VERB.test(step.done_when ?? ""));
}

// a value in quotes: "...", “...” or '...'. A quote opens at a word start (the start of the text, white space or an
// opening bracket before it) and closes at a word end (no letter or digit after it); an apostrophe inside a word
// ("site's", "Women's") opens and closes nothing, and the quoted text may hold one.
const QUOTED = /(?<![^\s([{])(?:"([^"\n]+)"|“([^”\n]+)”|'((?:[^'\n]|(?<=\p{L})'(?=\p{L}))+)')(?![\p{L}\p{N}])/gu;
export const MAX_QUOTED_CHARS = 60;
export const MAX_QUOTED_WORDS = 8;
// what an agent's own move log says ("pointed at menuitem"): never a value on a page
const MOVE_LOG = /^(?:clicked|pointed at|scrolled to|adjusted|opened pagination link)\b/i;

/** Every string quoted in a text, whole: the revealEvidence read keeps a quoted sentence (the notice it must find). */
export function quotedStrings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(QUOTED)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\s+/g, " ").trim();
    if (v) out.push(v);
  }
  return out;
}

/** The values quoted in a setting step's text: a value is short (at most 60 characters and 8 words) and holds no
 * sentence end (a full sentence in quotes is a message or an instruction, not a value), and is no line of the agent's
 * own move log. */
export function quotedValues(text: string): string[] {
  return quotedStrings(text).filter(
    (v) =>
      v.length <= MAX_QUOTED_CHARS &&
      v.split(" ").length <= MAX_QUOTED_WORDS &&
      !/[.!?](?:\s|$)/.test(v) &&
      !MOVE_LOG.test(v),
  );
}

// a number with a unit or currency next to it: a currency sign before it ($25), a unit or measure word right after it
// (12 pairs, 2-bedroom, 50%, 3 nights: a generic list, so "the top 3 results" or "See 12 Homes" holds no value), or a
// thousands separator or a decimal point in it (4,000, 3.5)
const UNIT_NUMBER =
  /[$€£¥]\s?\d+(?:,\d{3})*(?:\.\d+)?|\b\d+(?:,\d{3})*(?:\.\d+)?(?:\s|-)?(?:%|°|(?:percent|km\/h|kmh|km|mi|miles?|mph|m|cm|mm|ft|feet|in(?:ch(?:es)?)?|kg|g|lbs?|oz|l|ml|gal|h|hrs?|hours?|min|mins|minutes?|sec|s|days?|nights?|weeks?|months?|years?|yrs?|stars?|bed(?:room)?s?|baths?|bathrooms?|br|ba|pairs?|pcs?|pieces?|packs?|guests?|adults?|children|kids?|people|persons?|seats?|rooms?|gb|tb|mb|mp|mah|w|kw|v|x)\b)|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d+\b/gi;
const NOTE_REF = /\{\{\s*[\w-]+\s*\}\}/;
export const MAX_SETTING_LITERALS = 6;

/** settingReadback: the values a setting step means the page to show applied: its texts, the values quoted in its goal
 * and done_when, and the numbers with a unit or currency there, in that order, none twice once normalised, at most
 * MAX_SETTING_LITERALS. Not a value: the name of a control clicked in the step (that was an action), a text that still
 * names a note ({{note1}}), the whole task quoted, or a number that is part of a value kept or a control clicked. */
export function settingLiterals(
  step: Pick<Step, "texts" | "goal" | "done_when">,
  clickedNames: string[],
  task: string,
): string[] {
  const clicked = clickedNames.map(normalizeLiteral).filter(Boolean);
  const whole = normalizeLiteral(task);
  const kept: string[] = [];
  const seen: string[] = [];
  const within = (part: string, of: string) => ` ${of} `.includes(` ${part} `);
  const add = (raw: string | undefined, number = false) => {
    const value = (raw ?? "").replace(/\s+/g, " ").trim();
    const n = normalizeLiteral(value);
    if (!n || NOTE_REF.test(value) || n === whole || seen.includes(n) || clicked.includes(n)) return;
    if (number && [...seen, ...clicked].some((v) => within(n, v))) return;
    seen.push(n);
    kept.push(value);
  };
  const said = [step.goal ?? "", step.done_when ?? ""];
  for (const t of step.texts ?? []) add(t.text);
  // a quoted value is a value, not the instruction: one that is (most of) the goal or done_when sentence is dropped
  // (the sentence it is quoted in, whole, or a slice of four words or more that is more than half of it)
  const instruction = (v: string, from: string) => {
    const n = normalizeLiteral(v);
    const x = normalizeLiteral(from);
    return x === n || (n.split(" ").length >= 4 && x.includes(n) && n.length * 2 > x.length);
  };
  for (const s of said) for (const v of quotedValues(s)) if (!instruction(v, s)) add(v);
  // a number inside a quoted value is that value's, not one of its own
  for (const s of said) for (const m of s.replace(QUOTED, " ").matchAll(UNIT_NUMBER)) add(m[0], true);
  return kept.slice(0, MAX_SETTING_LITERALS);
}

/** settingReadback: the value a move sets, if it sets one: the text it typed, the option it selected, or the name of
 * the checkbox, radio, option, switch or tab it clicked. A button or link clicked names an action, not a value. */
const VALUE_ROLES = new Set([
  "checkbox",
  "radio",
  "option",
  "menuitemcheckbox",
  "menuitemradio",
  "switch",
  "tab",
  "treeitem",
]);
export function chosenValue(act: MoveOption, text: string | null | undefined): string {
  if (["type", "type_pick", "type_cursor", "write"].includes(act.kind)) return (text ?? act.text?.text ?? "").trim();
  if (act.kind === "select") return act.value.trim();
  if ((act.kind === "click" || act.kind === "scroll_click") && VALUE_ROLES.has(String(act.el.role)))
    return (act.el.name || act.el.text).trim();
  return "";
}

/** settingReadback: the step's values (settingLiterals) that a move in the step set (chosenValue): a value counts when
 * one holds the other as whole words ("Remote" and the checkbox "Remote (12)", "2" and the typed "2 adults"). */
export function chosenLiterals(literals: string[], chosen: string[]): string[] {
  const set = chosen.map(normalizeLiteral).filter(Boolean);
  const within = (a: string, b: string) => ` ${b} `.includes(` ${a} `);
  return literals.filter((l) => {
    const n = normalizeLiteral(l);
    return !!n && set.some((v) => within(n, v) || within(v, n));
  });
}

// --- revealEvidence: the facts the end of a run shows on screen -------------------------------------------------------
export const MAX_REVEAL_LITERALS = 8;

/** revealEvidence: what the end of a run looks for on the page, first to last: the values the final read's evidence
 * quotes, its numbers with a unit or currency (settingLiterals' rule), then its answerTokens amounts and numbers (its
 * quoted names come from the quote rule above, which reads an apostrophe as no quote); none twice once normalised, at
 * most MAX_REVEAL_LITERALS. Evidence naming none of those leaves the answer's own tokens (answerTokens), as before. No
 * capitalised names: the reveal diagnostic found them on screen already, where they only stop the scroll. */
export function revealLiterals(evidence: string | null | undefined, answer: string | null | undefined): string[] {
  const text = evidence ?? "";
  const kept: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    const value = (raw ?? "").replace(/\s+/g, " ").trim();
    const n = normalizeLiteral(value);
    if (n.length < 2 || seen.has(n)) return;
    seen.add(n);
    kept.push(value);
  };
  for (const v of quotedStrings(text)) add(v);
  for (const m of text.matchAll(UNIT_NUMBER)) add(m[0]);
  for (const t of answerTokens(text)) if (/\d/.test(t)) add(t);
  return kept.length ? kept.slice(0, MAX_REVEAL_LITERALS) : answerTokens(answer);
}
