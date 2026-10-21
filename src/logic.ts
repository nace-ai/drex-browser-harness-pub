// The pure parts of the agent: the moves Drex chooses between, the state text it reads, and small checks.
// No chrome.* here, so node:test covers it (test/logic.test.mjs).
import type {
  BatchStep,
  Box,
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

/** Every move Drex can make on this screen: {key: description} for Drex, {key: action} for the extension.
 * direct (no LLM plan): Drex has no texts of its own, so every field gets a "type into" move the LLM writes the text
 * for; and Drex can ask the LLM whether the task is finished. */
export function buildOptions({
  els = [],
  off = [],
  texts = [],
  tabs = [],
  direct = false,
  sliderValues = [],
}: {
  els?: LocatedEl[];
  off?: LocatedEl[];
  texts?: StepText[];
  tabs?: TabInfo[];
  direct?: boolean;
  sliderValues?: number[];
}): Options {
  const opts: Record<string, string> = {};
  const acts: Record<string, MoveOption> = {};
  const add = (k: string, desc: string, act: MoveOption) => {
    if (k in opts) return;
    opts[k] = desc;
    acts[k] = act;
  };
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
      e.options.forEach((name, j) => {
        if (j === e.selectedIndex || !name) return;
        add(`choose '${name.slice(0, 40)}' in ${e.label}`, `In ${describe(e)}, choose the option '${name}'`, {
          kind: "select",
          el: e,
          index: j,
          value: name,
        });
      });
    } else if (e.field) {
      // a single-line field is replaced; a multi-line editor (document, email body, text area) is added to at its end
      const how = e.multi ? "at the end of" : "into";
      const note = e.multi ? " (adds to what it holds)" : " (replaces what it holds)";
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
  // a search's own counts and chips ("Remove guests", "Remove location: Seattle"): the search changes, nothing is sent
  /\b(remove|clear)\s+(a\s+|the\s+|one\s+)?(guests?|adults?|child(ren)?|kids?|infants?|rooms?|travell?ers?|passengers?|locations?|keywords?|tags?|dates?)\b/i,
  // mail, not publishing: "Claim by post", "Post office", "postcode"
  /\bby\s+post\b|\bpost\s+(office|code)s?\b/i,
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
 * (pointRisk). */
export function isRiskyGesture(act: MoveOption): boolean {
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

/** The circle the last moves went round, or null: the last k moves (k = 2..4) repeat the k before them, from the
 * same screens; a single move needs three rounds. Only moves after the last loop marker count. */
export function findLoop(history: HistoryEntry[], maxPeriod = 4): { period: number; moves: string[] } | null {
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
  const recent = history.slice(-6);
  if (recent.some((h) => h.what === what && !h.changed))
    return `Drex is about to repeat '${what}', which changed nothing earlier.`;
  const last = history.slice(-STALL_MOVES);
  if (last.length === STALL_MOVES && last.every((h) => !h.changed))
    return `Drex's last ${STALL_MOVES} moves changed nothing on screen.`;
  return "";
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
 * object with exactly these four fields: {"task_type": ..., "status": ...}"); none when it only says "JSON".
 */
export function requiredFields(task: string): string[] {
  const shape = /JSON object[^{]{0,200}\{([^{}]{0,800})\}/i.exec(task)?.[1];
  const keys = shape ? [...shape.matchAll(/"([A-Za-z_][\w-]*)"\s*:/g)].flatMap((m) => (m[1] ? [m[1]] : [])) : [];
  return keys.length >= 2 ? [...new Set(keys)] : [];
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
  return !!value && typeof value === "object" && !Array.isArray(value) && fields.every((f) => f in value);
}
