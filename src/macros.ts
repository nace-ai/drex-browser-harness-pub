import * as L from "./logic.ts";
import { pick } from "./drex.ts";
import { focusedEvidence } from "./focused.ts";
import { costOn, drexImages } from "./cost.ts";
import { accOn } from "./accuracy.ts";
import {
  screenDetail,
  extractBatch,
  orderedFirstProof,
  orderedVerdicts,
  orderContradicted,
  dateRanking,
  datesOrdered,
  laterPage,
  drexRelevant,
  drexRowVerdicts,
  drexSorted,
  listNarrowed,
  lastStamp,
  type RowStamp,
} from "./cheap-collection.ts";
import type { Tab } from "./cdp.ts";
import type {
  FieldValue,
  BatchItem,
  BatchRecord,
  CollectJson,
  CollectionMemory,
  LocatedEl,
  Looked,
  MacroHost,
  MoveOption,
  OnScreenEl,
  Options,
  Outcome,
  PageEl,
  Step,
} from "./types.ts";

interface PageLink {
  href: string;
  text: string;
}
interface NavMeta {
  href: string;
  rel: string;
  role: string | null;
  controls: string | null;
  expanded: boolean;
  pagination: boolean;
  tag: string;
}
interface DetailMeta {
  href: string;
  context: string;
}
/** A detail button the page shows with no address: the row it sits in is its identity. */
interface DetailControl {
  source_id: string;
  label: string;
  text: string;
  row_context: string;
  el: LocatedEl;
}
interface Row {
  text: string;
  links: PageLink[];
  controls?: { source_id: string; label: string; text: string; row_context: string }[];
}

// Collect steps are read-only. They follow only links shown on the page, on the page's own site, with none of these
// words inside any word of their label or address (a substring check: "unsubscribe", "signout", "/archive" and
// "approved" all count; "log out", "mark-as-read" and "order again" too). A false positive only leaves a link unread.
const FACT_CHARS = 1500; // one fact in a collection's notes
const ORDERED_DETAILS = 12; // a sorted list's rows whose details are read on one page before it is read the ordinary way
// a list of records ordered by their own dates (orders, messages) shows no item in its rows: every row's detail is read,
// one Drex screening each, so a page of 20-30 records stays in the scan
const DATED_DETAILS = 30;
const LINKS = `function () { return Array.from(this.matches('a[href]') ? [this] : this.querySelectorAll('a[href]')).filter(a => { const r = a.getBoundingClientRect(), s = getComputedStyle(a); return r.width && r.height && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0' && !a.closest('[aria-hidden=true]'); }).map(a => ({href:a.href,text:(a.innerText || a.getAttribute('aria-label') || '').trim()})); }`;
export const MUTATION_WORDS = [
  "reorder",
  "buy",
  "purchase",
  "checkout",
  "delete",
  "remove",
  "send",
  "submit",
  "publish",
  "save",
  "cancel",
  "subscribe",
  "cart",
  "logout",
  "logoff",
  "signout",
  "archive",
  "approve",
  "accept",
  "decline",
  "reject",
  "pay",
  "transfer",
  "trash",
  "spam",
  "block",
  "report",
  "vote",
  "follow",
  "confirm",
  "destroy",
  "revoke",
  "disable",
  "enable",
  "invite",
  "share",
  "claim",
  "dispute",
  "ticket",
  "return",
  "refund",
];
// short words that are other words' parts ("address", "posts"): only as whole words
const MUTATION_EXACT = ["add", "post", "like", "mark"];
// words written as two (log out, add to, mark as read, order again)
const MUTATION_PAIRS = [
  "logout",
  "logoff",
  "signout",
  "addto",
  "markas",
  "markread",
  "markunread",
  "orderagain",
  "buynow",
];
export function mutating(text: string | null | undefined): boolean {
  let flat = text || "";
  try {
    flat = decodeURIComponent(flat);
  } catch {}
  const words = flat
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((w) => MUTATION_EXACT.includes(w) || MUTATION_WORDS.some((m) => w.includes(m)))) return true;
  return words.slice(1).some((w, i) => MUTATION_PAIRS.includes(String(words[i]) + w));
}
export function safeLink(link: { href: string; text?: string }, origin: string): boolean {
  try {
    const u = new URL(link.href);
    return u.origin === origin && /^https?:$/.test(u.protocol) && !mutating(`${link.text} ${u.pathname} ${u.search}`);
  } catch {
    return false;
  }
}
/** Detail links Drex could see as elements of the page: a link that is drawn but not exposed as a control (or hidden
 * from it) is not followed. */
function shownLinks(scr: Looked, links: PageLink[]): PageLink[] {
  const names = new Set(
    [...scr.els, ...(scr.off ?? [])].filter((e) => e.role === "link" && e.name).map((e) => e.name?.trim()),
  );
  const shown = (text: string) => {
    const flat = text.split(/\s+/).join(" ");
    if (names.has(flat.slice(0, 120))) return true;
    // scanOn: an element's name can be cut shorter than the link's text (a long product title): the same link when one
    // starts with the other, over 40 characters at least
    return (
      accOn("scanOn") &&
      flat.length >= 40 &&
      [...names].some((n) => !!n && n.length >= 40 && (flat.startsWith(n.replace(/…$/, "")) || n.startsWith(flat)))
    );
  };
  return links.filter((l) => l.text && shown(l.text));
}
async function navigationOptions(
  tab: Tab,
  scr: Looked,
): Promise<{ all: Options; options: Record<string, string>; paging: Set<string> }> {
  const paging = new Set<string>(); // the options that go to another page of the list, not reveal part of this one
  const all = L.buildOptions({ els: scr.els, off: scr.off, texts: [] });
  const classified = await Promise.all(
    Object.entries(all.opts).map(async ([key, description]) => {
      const a = all.acts[key];
      if (!a) throw new Error(`No move for option ${key}`);
      if (a.kind === "scroll") return a.down ? [key, description] : null;
      if (
        a.kind === "navigate_page" &&
        safeLink({ href: a.url, text: a.el.paginationLabel || a.el.name }, new URL(scr.info.url).origin)
      ) {
        paging.add(key);
        return [key, description];
      }
      if ((a.kind !== "click" && a.kind !== "scroll_click") || L.isRisky(a)) return null;
      if (a.el.field || a.el.select || ["combobox", "textbox", "searchbox"].includes(String(a.el.role))) return null;
      const text = a.el.name || a.el.text;
      if (mutating(text)) return null;
      const meta = await (tab
        .on(
          a.el.node,
          `function () {
      const link = this.matches('a[href]') ? this : this.closest('a[href]');
      const parent = this.closest('[aria-label*="pagination" i], [aria-label*="pages" i], .pagination, .pages, .toolbar, [role="navigation"]');
      return { href: link ? link.href : '', rel: link ? link.rel : '', role: this.getAttribute('role'),
        controls: this.getAttribute('aria-controls'), expanded: this.hasAttribute('aria-expanded'),
        pagination: !!parent, tag: this.tagName };
    }`,
        )
        .catch(() => null) as Promise<NavMeta | null>);
      if (!meta) return null;
      const here = new URL(scr.info.url);
      let target = null;
      if (meta.href) {
        if (!safeLink({ href: meta.href, text }, here.origin)) return null;
        target = new URL(meta.href);
      }
      const sameDocument =
        !target ||
        (target.origin === here.origin && target.pathname === here.pathname && target.search === here.search);
      const reveal =
        sameDocument &&
        (a.el.role === "tab" ||
          meta.role === "tab" ||
          meta.controls ||
          meta.expanded ||
          (target?.hash && target.href !== here.href));
      const pagingName = /\b(next|previous|older|newer)\b|\bpage\s*\d+\b/i.test(text);
      const pages =
        (!!target || meta.pagination) &&
        (/\b(next|prev)\b/i.test(meta.rel || "") ||
          pagingName ||
          (meta.pagination && /^(?:page\s*)?\d+$|^[>»←→<]+$/i.test(text.trim())));
      // Item review/details links change documents and are opened only as selected row details.
      if (pages && !reveal) paging.add(key);
      return reveal || pages ? [key, description] : null;
    }),
  );
  const options = Object.fromEntries(classified.filter(Boolean) as [string, string][]);
  return { all, options, paging };
}
// A no-href control opens a record's details only when its whole label says so ("View", "Details", "View order"):
// "Open a claim", "Open dispute" or "Open return" start something in a signed-in account and are never clicked.
const DETAIL_LABEL =
  /^(?:view|details?|view details?|view order|view item|order details|item details|see details|more details|show details)$/i;
export function detailLabel(name: string | null | undefined): boolean {
  const label = (name || "")
    .replace(/\s*\((?:in|for)\b.*\)\s*$/i, "") // the row context the element list appends
    .replace(/\s+(?:for|of)\s+.+$/i, "") // "View details for order 1001"
    .replace(/\s*#?\d[\w-]*\s*$/, "") // "View order #1001"
    .replace(/\s+/g, " ")
    .trim();
  return DETAIL_LABEL.test(label) && !mutating(name);
}
// No-href detail controls must be both shown and explicitly read-only, with a public row identity.
async function detailControls(tab: Tab, scr: Looked, url: string): Promise<DetailControl[]> {
  const out: DetailControl[] = [];
  for (const el of [...scr.els, ...(scr.off ?? [])]) {
    if (
      !["button", "link"].includes(String(el.role)) ||
      el.disabled ||
      !el.name ||
      !detailLabel(el.name) ||
      L.isRisky({ kind: "click", el })
    )
      continue;
    const meta = await (tab
      .on(
        el.node,
        `function () {
      const a = this.closest('a[href]');
      const row = this.closest('tr,[role=row],li,article,[role=listitem]');
      return {href:a?.href || '', context:row?.innerText?.replace(/\\s+/g,' ').trim() || ''};
    }`,
      )
      .catch(() => null) as Promise<DetailMeta | null>);
    if (!meta || meta.href || !meta.context || meta.context === (el.name || el.text)) continue;
    const source_id = JSON.stringify([url, meta.context, el.name || el.text]);
    out.push({ source_id, label: el.label, text: el.name || el.text, row_context: meta.context, el });
  }
  // Two indistinguishable controls are not a safe stable record identity.
  return out.filter((c) => out.filter((d) => d.source_id === c.source_id).length === 1);
}
async function withControl(
  this: MacroHost,
  control: DetailControl,
  sourceURL: string,
  step: Step,
  work: (tab: Tab) => Promise<Outcome | undefined>,
): Promise<Outcome | undefined> {
  const tab = await this.currentTab(),
    fresh = await this.look(tab);
  const current = (await detailControls(tab, fresh, sourceURL)).find((c) => c.source_id === control.source_id);
  if (!current)
    return { replan: [{ ...step, open_url: "", use_tab: -1 }], why: "Detail control changed; inspect current list" };
  const action: MoveOption = {
    kind: (current.el.label as string | undefined)?.startsWith("D") ? "scroll_click" : "click",
    el: current.el,
  };
  // the same move path as every click: approval and the readiness check apply if it were ever risky; a macro move,
  // not the LLM's
  const outcome = await this.act(tab, action, null, fresh, [], "macro", 1, "Open shown read-only record details", {
    step,
  });
  if (outcome?.replan || outcome?.fail || outcome?.blocked || outcome?.dispatched !== true)
    return (
      outcome ?? {
        replan: [{ ...step, kind: "read", goal: "Inspect uncertain detail navigation before any retry" }],
        why: "Unknown detail action outcome",
      }
    );
  try {
    const info = await tab.info(50000);
    if (new URL(info.url).origin !== new URL(sourceURL).origin)
      return {
        replan: [{ ...step, kind: "read", goal: "Inspect unexpected navigation; do not extract cross-origin detail" }],
        why: "Detail left source origin",
      };
    return await work(tab);
  } finally {
    this.check();
    await tab.navigate(sourceURL);
    await tab.settle();
    this.afterShot = null;
  }
}

async function withDetail(
  this: MacroHost,
  href: string,
  work: (tab: Tab) => Promise<Outcome | undefined>,
): Promise<Outcome | undefined> {
  const previous = {
    id: this.agentTabId,
    own: this.ownTab,
    next: this.newTabId,
    activePlanTab: this.activePlanTab,
    bindings: new Map(this.tabBindings),
  };
  let created;
  try {
    created = await this.openDetailTab(href);
    this.agentTabId = created.id;
    this.activePlanTab = -1;
    this.ownTab = true;
    this.newTabId = null;
    const detail = await this.currentTab();
    await detail.settle();
    this.afterShot = null;
    return await work(detail);
  } finally {
    if (created) {
      await this.tabs
        .get(created.id)
        ?.detach()
        .catch(() => undefined);
      this.tabs.delete(created.id);
      await chrome.tabs.remove(created.id).catch(() => undefined);
    }
    this.agentTabId = previous.id;
    this.ownTab = previous.own;
    this.newTabId = previous.next;
    this.activePlanTab = previous.activePlanTab;
    this.tabBindings = previous.bindings;
    this.afterShot = null;
  }
}

export async function collect(this: MacroHost, step: Step): Promise<Outcome> {
  const name = step.save_as || `collection${this.index + 1}`;
  let held = this.collectionTaskContract;
  if (held?.task !== this.task) {
    const result = await this.llmCall("collect", () => this.llm.collectionContract({ task: this.task }));
    if (!(["enumerate_all", "objective_optimum", "choose_qualified"] as unknown[]).includes(result.json.intent))
      throw new Error("Invalid collection contract");
    held = this.collectionTaskContract = { task: this.task, contract: result.json };
  }
  const contract = held.contract;
  this.log("collection_contract", { contract });
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- the LLM may send constraints: false or 0; they mean none, as `||` always read them
  const memoryKey = JSON.stringify([this.task, { ...contract, constraints: [...(contract.constraints || [])].sort() }]);
  const answered = this.collectionMemory?.get(memoryKey);
  // a later collect step of the same plan, or a replan, asking the same question again gets the answer this run already
  // found in a list proven ordered, without reading the list again
  if (answered?.firstQualified && answered.epoch === (this.collectionMutationEpoch ?? 0)) {
    this.notes[name] = answered.firstQualified;
    this.log("collection_done", { orderedMatch: true, remembered: true });
    return {};
  }
  const preparationTab = await this.currentTab();
  const preparationScreen = await this.look(preparationTab);
  const preparationInfo = await preparationTab.info(30000);
  // the same list in the same state (address, sort and filter controls) is prepared once a run: a replan that comes
  // back to it doesn't pay for the same check again, and a change of scope (a new address, another sort) is a new one
  const cheap = Boolean(this.runOptions?.efficiency?.cheapCollection);
  // a ranking by date over a list of records ("when did I last order X") is proven by the rows' own dates, from the
  // list's first page: no model has to find a sort control the list doesn't have, and the rows needing their details
  // (an order row names no item) doesn't make the list unready
  const datedRows = cheap && dateRanking(contract) ? (await preparationTab.items()).map((i) => ({ text: i.text })) : [];
  const dateProof =
    contract.ranked_count === 1 && // rows' dates answer at the first match only a request for the single newest
    datedRows.length > 0 &&
    !laterPage(preparationInfo.url) &&
    !listNarrowed([...preparationScreen.els, ...(preparationScreen.off ?? [])]) &&
    datesOrdered(datedRows, String(contract.sort_direction));
  const preparationKey = JSON.stringify([
    this.task,
    contract,
    preparationInfo.url.replace(/#.*$/, ""),
    scopeControls([...preparationScreen.els, ...(preparationScreen.off ?? [])]),
  ]);
  // a check made at another position of the list (a #page=2 fragment, a list scrolled down, a page 2 loaded in place
  // with nothing else changed) can't vouch for where its ordering starts: the list is checked again there
  const position = JSON.stringify([
    preparationInfo.url.replace(/^[^#]*/, ""),
    preparationInfo.text,
    // a page that can't say (it is navigating) gives no position: the check is then reused only where none was given
    await Promise.resolve()
      .then(() => preparationTab.eval("({x:scrollX,y:scrollY})"))
      .catch(() => null),
  ]);
  this.collectionPreparations ??= new Map();
  const known = this.collectionPreparations.get(preparationKey);
  const knownPreparation = known?.at === position ? known.preparation : undefined;
  const preparation = dateProof
    ? {
        ready: true,
        evidence: `Every row shows a date and the dates run ${String(contract.sort_direction)} from the list's first page`,
        sort_available: false,
        observed_sort_direction: String(contract.sort_direction),
        whole_list_on_page: false,
        steps: [],
        ordering: {
          field: String(contract.objective_field),
          direction: String(contract.sort_direction),
          starts_at_beginning: true,
          covers_requested_scope: true,
          evidence: datedRows.slice(0, 2).map((r) => r.text.slice(0, 80)),
          proof: "row dates",
        },
      }
    : (knownPreparation ??
      (
        await this.llmCall("collect", () =>
          this.llm.collectionPreparation({
            task: this.task,
            contract,
            info: preparationInfo,
            image: preparationScreen.img1,
            candidates: preparationScreen.els.map((e) => ({
              label: e.label,
              text: L.describe(e),
              role: e.role,
              options: e.options,
            })),
          }),
        )
      ).json);
  // a sort is forced only where it saves walking pages: a list that is all on the page is read for its optimum (on
  // filters.html a Price chip that doesn't sort sent "cheapest of three flights" round in circles)
  const wrongSort =
    !dateProof &&
    contract.intent === "objective_optimum" &&
    preparation.sort_available &&
    preparation.whole_list_on_page !== true &&
    (!contract.sort_direction ||
      contract.sort_direction === "none" ||
      preparation.observed_sort_direction !== contract.sort_direction);
  this.log("collection_preparation", { ...preparation, wrongSort, ...(knownPreparation ? { cached: true } : {}) });
  // only a list found ready is kept: a check that asked for repairs is made again after them, since a repair (a column
  // header that sorts in place, a filter typed into the page) may leave the address and controls as they were
  // a proof from the rows' dates is made again each time from the rows themselves, never cached
  if (dateProof) {
    /* not cached */
  } else if (preparation.ready && !wrongSort)
    this.collectionPreparations.set(preparationKey, { preparation, at: position });
  else this.collectionPreparations.delete(preparationKey);
  if (!preparation.ready || wrongSort) {
    this.collectionPreparationAttempts = (this.collectionPreparationAttempts ?? 0) + 1;
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- the LLM may send steps: "" or false; "" and false mean none, as `||` always read them
    const repairs = (preparation.steps || [])
      .filter((s) => s.kind === "browse")
      .slice(0, 3)
      .map((s) => ({
        ...s,
        // a repair only brings the list on screen: the collect step that follows reads its records (opening them one by
        // one in a browse step is what the collection exists to replace)
        goal: `${s.goal} Stop once the list is on screen; don't open its records: the collect step after this reads them.`,
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a max_moves of 0 means unset: it gets the default, not the floor
        max_moves: Math.min(Math.max(s.max_moves || 8, 1), 12),
      }));
    if (repairs.length && this.collectionPreparationAttempts <= 3) {
      return {
        replan: [...repairs, { ...step, open_url: "", use_tab: -1 }],
        why: `Prepare collection before enumeration: ${String(preparation.evidence)}`,
      };
    }
    this.notes.collection_preparation = `Preparation is advisory. Continue read-only traversal and manually check original constraints. Do not infer coverage or optimum from a sample or incorrect sort. ${String(preparation.evidence)}`;
    this.log("collection_fallback", { evidence: preparation.evidence, wrongSort });
  }
  const contractCoverage =
    contract.intent === "choose_qualified"
      ? "A qualified candidate has explicit constraint facts, supported comparison rationale and verified detail; all catalog results are not required"
      : "All requested records or an explicit valid ranking/filtering proof cover the original task scope";
  const effectiveStep = {
    ...step,
    goal: `Collect evidence for original-task contract: ${JSON.stringify(contract)}`,
    done_when: contractCoverage,
    question: `What evidence satisfies this original-task collection contract: ${JSON.stringify(contract)}?`,
  };
  this.collectionMemory ??= new Map();
  const epoch = this.collectionMutationEpoch ?? 0;
  let found = this.collectionMemory.get(memoryKey);
  if (found && found.epoch !== epoch) {
    this.notes[name + "_historical"] = JSON.stringify({
      warning: "Historical collection evidence before a potential data mutation; recheck current facts and coverage",
      sources: [...found.sources].map(([url, facts]) => ({ url, facts: [...facts] })),
    });
    found = undefined;
  }
  const memory: CollectionMemory = found ?? {
    epoch,
    sources: new Map(),
    completedDetails: new Set(),
    verifiedSelections: new Map(),
  };
  if (!found) this.collectionMemory.set(memoryKey, memory);
  const evidenceText = () =>
    JSON.stringify({
      instruction:
        "Source URLs identify evidence locations, not record counts: a list can contain many records. Deduplicate records by their public identities; repeated observations of the same detail are not extra records. These are earlier observations; current screen wins on conflicts. Completed details do not establish total collection coverage.",
      sources: [...memory.sources].map(([source_id, facts]) => ({ source_id, facts: [...facts] })),
    });
  // notes keep short facts; a detail page's raw text stays in memory only (one copy per source, the latest), for the
  // batch extraction and an interrupted run's evidence, never in the notes every later LLM call carries
  const rawSources = (memory.raw ??= new Map());
  const remember = (url: string, fact: unknown) => {
    let facts = memory.sources.get(url);
    if (!facts) memory.sources.set(url, (facts = new Set()));
    facts.add(String(fact).slice(0, FACT_CHARS));
    this.notes[name] = evidenceText();
  };
  const keepRaw = (id: string, raw: BatchRecord) => rawSources.set(id, raw);
  const orderingEstablished = dateProof || (cheap && orderedFirstProof(contract, preparation, preparationInfo));
  let lastDate: RowStamp | null = null; // the last row date of the page before, for a list ordered by its rows' dates
  let orderedMatch = false as boolean; // set in the closures below
  let orderedScan = orderingEstablished;
  let orderedHit: {
    page: string;
    row: string;
    quote: string;
    detail?: string;
    links?: string[];
    facts?: unknown;
  } | null = null;
  let earlierResolved = true;
  let cheapDetailsComplete = true as boolean;
  const pending: BatchRecord[] = [];
  // A batch the model formats wrongly (a missing source, a quote not on the page) is asked for once more when the
  // budget allows; otherwise the step fails with the reason, which the run's recovery caps then handle.
  const flushBatch = async (): Promise<Outcome | null> => {
    if (!pending.length) return null;
    const records = pending.splice(0);
    let extracted: BatchItem[];
    for (let attempt = 0; ; attempt++) {
      try {
        extracted = await extractBatch(this, records, contract);
        break;
      } catch (caught) {
        const error = caught as Error & { batchFormat?: boolean };
        if (!error.batchFormat) throw error;
        this.log("collection_batch_invalid", { attempt, error: error.message });
        let affordable = attempt === 0;
        if (affordable)
          try {
            this.runBudget?.check();
          } catch {
            affordable = false;
          }
        if (!affordable) return { fail: `The extracted records didn't match their sources: ${error.message}` };
      }
    }
    for (const item of extracted) {
      const id = item.source_id || item.source_url || ""; // validateBatch made source_url a record's address
      remember(id, "BATCH EXTRACTED: " + JSON.stringify(item));
      if (item.complete) memory.completedDetails.add(id);
      if (item.match === "unknown" || !item.complete) {
        earlierResolved = false;
        cheapDetailsComplete = false;
      }
      if (orderingEstablished && earlierResolved && item.match === "match") {
        orderedMatch = true;
        // the record's extracted facts go in the qualified note itself: the answer the collection leaves is that note alone
        remember(
          id,
          "FIRST QUALIFIED IN VERIFIED ORDER: " +
            JSON.stringify({ facts: item.facts, ordering: preparation.ordering }) +
            "; Earlier records resolved by model screening; raw sources retained. This is collection evidence, not task SUCCESS.",
        );
        break;
      }
    }
    return null;
  };
  let selectedVerified = false as boolean;
  const visitedPages = new Set();
  const visitedDetails = new Set();
  let complete = false;
  for (let page = 0; page < 40; page++) {
    this.check();
    const tab = await this.currentTab();
    const scr = await this.look(tab);
    const info = await tab.info(50000);
    const position = await tab.eval("({x:scrollX,y:scrollY})");
    const fingerprint = JSON.stringify([info.url, info.text, position, scr.els.map((e) => [e.text, e.box, e.state])]);
    if (visitedPages.has(fingerprint)) break;
    visitedPages.add(fingerprint);
    const origin = new URL(info.url).origin;
    const rows: Row[] = [];
    for (const item of await tab.items()) {
      const links = shownLinks(
        scr,
        (((await tab.on(item.node, LINKS).catch(() => [])) as PageLink[] | null) ?? []).filter((l) =>
          safeLink(l, origin),
        ),
      );
      rows.push({ text: item.text, links });
    }
    const itemRows = rows.length;
    const controls = await detailControls(tab, scr, info.url);
    const flatText = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
    for (const c of controls) {
      const control = { source_id: c.source_id, label: c.label, text: c.text, row_context: c.row_context };
      // a button that opens a row's details belongs to that row (the order whose "View Order" it is), not a new record
      const own = rows.slice(0, itemRows).find((row) => {
        // a row's own text is cut to its first 300 characters; the button's row context is not
        const text = flatText(row.text);
        const context = flatText(c.row_context);
        return !row.links.length && (context === text || (row.text.length >= 300 && context.startsWith(text)));
      });
      if (own) {
        (own.controls ??= []).push(control);
        continue;
      }
      rows.push({
        text: c.row_context,
        links: [],
        controls: [control],
      });
    }
    const { all, options, paging } = await navigationOptions(tab, scr);
    const readPage = (ordered: boolean) =>
      this.llmCall("collect", () =>
        this.llm.collect({
          task: this.task,
          step: effectiveStep,
          contract,
          scope: "collection",
          notes: { ...this.notes, [name]: evidenceText() },
          info,
          image: scr.img1,
          rows,
          options,
          ordered: ordered
            ? { field: String(contract.objective_field), direction: String(contract.sort_direction) }
            : null,
        }),
      );
    // the collectDrex cost switch: on a list proven ordered, Drex judges the rows instead of an LLM reading of the
    // page (a list ordered by its rows' dates shows no items in its rows: each goes to its detail); the LLM reads the
    // page only when the rows don't settle it
    const drexRows =
      cheap &&
      orderedScan &&
      costOn("collectDrex") &&
      !orderContradicted(rows, String(contract.objective_field), String(contract.sort_direction));
    let r: { json: CollectJson } = drexRows
      ? {
          json: {
            evidence: `The list's ${itemRows} rows on ${info.url}, judged in order against the conditions.`,
            complete: false,
            details: [],
            next: "",
            ...(dateProof ? {} : { ordered_rows: (await drexRowVerdicts(this, contract, rows)) ?? [] }),
          },
        }
      : await readPage(orderedScan);
    if (!drexRows) remember(info.url, r.json.evidence);
    // a row's details: its links, then its own detail buttons
    const rowDetails = (row: Row) => [...row.links.map((l) => l.href), ...(row.controls ?? []).map((c) => c.source_id)];
    const allowed = new Set([
      ...rows.flatMap((row) => row.links.map((l) => l.href)),
      ...controls.map((c) => c.source_id),
    ]);
    // A list verified sorted by the objective is answered by its first row that meets every constraint. The rows are
    // judged in their order from their own text; a row whose text can't settle a constraint has its detail page read
    // (an extraction whose facts quote that page). The scan stops at the first qualifying row. Anything it can't settle
    // (verdicts that skip a row or quote words it doesn't have, a detail it can't follow or that leaves a constraint
    // open) ends the shortcut, and the list is read the ordinary way from here.
    let pageSettled = false;
    // the list's own rows, and the rows made for "View" buttons (listed after them all), each checked in its own
    // order: the buttons may be what carries the prices when the list found is something else, such as a sidebar
    const listed = rows.filter((row) => !row.controls);
    const contradicted = (group: Row[]) =>
      orderContradicted(group, String(contract.objective_field), String(contract.sort_direction));
    if (orderedScan && (contradicted(listed) || contradicted(rows.filter((row) => row.controls)))) {
      orderedScan = false; // the rows' own prices run against the claimed order: no first-row answer from this list
      earlierResolved = false; // nor from the ordinary read's first-match shortcut
      this.log("collection_ordered_scan", {
        page: info.url,
        unresolved: "the rows' prices contradict the claimed order",
      });
    }
    // checked on every page the order still answers from, the ordinary walk's first match included
    if (
      dateProof &&
      (orderedScan || earlierResolved) &&
      !datesOrdered(rows.slice(0, itemRows), String(contract.sort_direction), lastDate)
    ) {
      orderedScan = false; // this page's dates don't carry on the order the first page showed
      earlierResolved = false; // nor a first match from the ordinary walk of it
      this.log("collection_ordered_scan", {
        page: info.url,
        unresolved: "the rows' dates break the list's date order",
      });
    }
    const qualifiedFact = (hit: NonNullable<typeof orderedHit>) =>
      "FIRST QUALIFIED IN VERIFIED ORDER: " +
      JSON.stringify({ ...hit, ordering: preparation.ordering }) +
      "; every earlier row was ruled out by its own text or detail; this row is the requested optimum.";
    if (orderedScan) {
      // a list ordered by its rows' dates is judged only through its own rows: a detail button's row after them holds
      // no date of the proven order, so a verdict on it is never the first qualified record
      const judged = orderedVerdicts(rows, r.json.ordered_rows)?.filter((v) => !dateProof || v.row < itemRows) ?? null;
      // a list that stopped at a row needing its detail leaves the rows after it unjudged: each of them is read through
      // its detail too, never assumed to fail, so the first qualifying row is still the first in the order
      const verdicts =
        judged?.at(-1)?.verdict === "needs_detail"
          ? [
              ...judged,
              // only the list's own rows: a detail button outside them is no record of the proven order
              ...rows
                .slice(judged.length, itemRows || rows.length)
                .map((_, i) => ({ row: judged.length + i, verdict: "needs_detail" as const, quote: "" })),
            ]
          : // rows ordered by their own dates that the reading didn't judge in order are each read through their details
            (judged ??
            (dateProof
              ? rows.slice(0, itemRows).map((_, i) => ({ row: i, verdict: "needs_detail" as const, quote: "" }))
              : null));
      let unresolved = verdicts ? "" : "the row verdicts don't take the rows in order, each with its own words";
      let opened = 0;
      for (const v of verdicts ?? []) {
        if (v.verdict === "fails") continue;
        const row = rows[v.row];
        if (!row) break; // orderedVerdicts gives only rows that exist
        if (v.verdict === "qualifies") {
          orderedHit = { page: info.url, row: row.text, quote: v.quote, links: row.links.map((l) => l.href) };
          break;
        }
        const [best] = [...row.links].sort((a, b) => b.text.length - a.text.length);
        const rowControl = best ? undefined : controls.find((c) => c.source_id === row.controls?.[0]?.source_id);
        // a row's detail opens through its link, or through its read-only detail button where it has no link
        const link = best ?? (rowControl ? { href: rowControl.source_id, text: rowControl.text } : undefined);
        const limit = dateProof ? DATED_DETAILS : ORDERED_DETAILS;
        if (!link || opened >= limit) {
          unresolved = link
            ? `more than ${limit} rows on this page need their details`
            : `row ${v.row} needs its detail and shows no link or detail button that can be followed read-only`;
          // the ordinary walk can't open that row either: a later match there must not count as the first qualified
          if (!link) earlierResolved = false;
          break;
        }
        // a detail this collection already ruled out (before a replan brought it back here) is not read again
        if (memory.ruledOut?.has(link.href)) continue;
        opened++;
        visitedDetails.add(link.href);
        // Drex screens the detail first (a confident, fully shown mismatch rules the row out for the price of one
        // classification); a match or anything uncertain goes to the extraction, whose facts must quote the page
        let item: BatchItem | undefined;
        let excluded = false as boolean; // set in the closure below
        let drexMatch = "" as string; // the record's text when Drex's screening, sure and fully read, called it a match
        let leftSite = false as boolean;
        try {
          const readDetail = async (detailTab: Tab): Promise<Outcome | undefined> => {
            this.check();
            const ds = await this.look(detailTab);
            const di = await detailTab.info(50000);
            leftSite = new URL(di.url).origin !== origin;
            if (leftSite) return undefined; // a detail that left the site is not read
            const truncated = di.chars > di.text.length;
            const screened = await screenDetail(this, {
              contract,
              info: { ...di, truncated },
              screen: ds,
              options: {},
            });
            keepRaw(link.href, { source_id: link.href, ...screened.raw });
            // a record page read whole (its text not cut) that Drex reads as complete and sure (p >= 0.9) not to hold
            // the item is ruled out; its 0.9 bar on the coverage reading itself is for pages with hidden sections
            const reading = screened.reading;
            const whole = !reading.truncated && reading.coverage === "complete";
            // a record whose whole text was read (none cut) that Drex is very sure (p >= 0.97) doesn't hold the item is
            // ruled out even when its glance at the screenshot doubts coverage: the text, not the picture, holds the record
            // A coverage reading sure (p >= 0.9) that the record is incomplete (items collapsed or not loaded, which the
            // text doesn't hold either) is more than a doubt: that record stays open
            const sure =
              !reading.truncated &&
              reading.match === "no_match" &&
              reading.p >= 0.97 &&
              !(reading.coverage === "incomplete" && reading.coverageP >= 0.9);
            if (
              screened.decision === "no_match" ||
              (whole && reading.match === "no_match" && reading.p >= 0.9) ||
              sure
            ) {
              excluded = true;
              return undefined;
            }
            if (screened.decision === "match" && reading.p >= 0.95) drexMatch = screened.raw.text;
            // the ranking is the list's order, not a condition of one record: the extraction judges only the record; a
            // badly formatted extraction is asked for once more
            for (let attempt = 0; attempt < 2 && !item; attempt++) {
              if (attempt)
                try {
                  this.runBudget?.check(); // the second ask only while the run can still afford it
                } catch {
                  break; // the record stays unsettled
                }
              try {
                [item] = await extractBatch(
                  this,
                  [{ ...screened.raw, coverage_incomplete: !whole, source_id: link.href }],
                  {
                    ...contract,
                    ranking:
                      "Established by the list's verified order, not by this record: judge only whether this record meets the item constraints.",
                  },
                );
              } catch (caught) {
                if (!(caught as Error & { batchFormat?: boolean }).batchFormat) throw caught;
                this.log("collection_batch_invalid", { attempt, error: (caught as Error).message });
              }
            }
            return undefined;
          };
          const viaControl = rowControl
            ? await withControl.call(this, rowControl, info.url, step, readDetail)
            : await withDetail.call(this, link.href, readDetail);
          if (viaControl?.replan || viaControl?.fail) return viaControl;
        } catch (caught) {
          if (!(caught as Error & { batchFormat?: boolean }).batchFormat) throw caught;
        }
        if (excluded) {
          remember(
            link.href,
            "MODEL EXCLUSION (not deterministic proof): detail screened as not meeting the constraints",
          );
          memory.completedDetails.add(link.href);
          (memory.ruledOut ??= new Set()).add(link.href);
          continue;
        }
        if (item) remember(link.href, "BATCH EXTRACTED: " + JSON.stringify(item));
        if (item?.complete && item.match === "match") {
          memory.completedDetails.add(link.href);
          orderedHit = { page: info.url, row: row.text, quote: v.quote, detail: link.href, facts: item.facts };
          break;
        }
        if (item?.complete && item.match === "no_match") {
          memory.completedDetails.add(link.href);
          (memory.ruledOut ??= new Set()).add(link.href);
          continue;
        }
        // Drex's sure match on a fully read record stands when the extraction couldn't settle it (no valid answer, or
        // unknown): the record's own text goes with it, so later steps read the item from it
        if (drexMatch && item?.match !== "no_match") {
          const record = { field: "record text (Drex matched it; the extraction didn't confirm)", value: "" };
          const hit = { page: info.url, row: row.text, quote: v.quote, detail: link.href, facts: [record] };
          // the record's text is cut to what the note holds, so the note itself is never cut short of its claim
          record.value = drexMatch.replace(/\s+/g, " ").trim();
          for (let over = qualifiedFact(hit).length - FACT_CHARS; over > 0 && record.value;) {
            record.value = record.value.slice(0, -over);
            over = qualifiedFact(hit).length - FACT_CHARS;
          }
          orderedHit = hit;
          break;
        }
        unresolved = `row ${v.row}'s detail doesn't settle every constraint`;
        // the ordinary read opens it again with its reveal options (a tab, an expander), which may settle it; one that
        // left the site stays skipped, recorded as unread so no coverage claim passes over its row. The ordered rank is
        // lost all the same, so no later row is first
        if (leftSite) {
          remember(link.href, "DETAIL LEFT SOURCE ORIGIN: not read; this row's constraints remain unresolved");
          cheapDetailsComplete = false;
        } else visitedDetails.delete(link.href);
        earlierResolved = false;
        break;
      }
      // a row left unjudged (a "View" button's row after the list's own, outside a proof by the list's dates) is unread
      if (verdicts && !orderedHit && !unresolved && verdicts.length < (dateProof ? itemRows : rows.length))
        unresolved = `the rows after row ${verdicts.length - 1} were not judged`;
      this.log("collection_ordered_scan", {
        page: info.url,
        rows: rows.length,
        judged: verdicts?.length ?? 0,
        details: opened,
        first_qualified: orderedHit ?? null,
        unresolved: unresolved || null,
        ...(verdicts
          ? {}
          : { verdicts: (r.json.ordered_rows ?? []).slice(0, 4), first_rows: rows.slice(0, 2).map((x) => x.text) }),
      });
      if (orderedHit) {
        orderedMatch = true;
        remember(orderedHit.detail ?? info.url, qualifiedFact(orderedHit));
      } else if (unresolved) orderedScan = false;
      pageSettled = !unresolved;
    }
    if (drexRows && !pageSettled) {
      // the rows didn't settle the page: it is read the ordinary way
      r = await readPage(false);
      remember(info.url, r.json.evidence);
    }
    if (dateProof) lastDate = lastStamp(rows.slice(0, itemRows), lastDate);
    const selection = contract.intent === "choose_qualified" ? r.json.selection : null;
    const selectedHref = selection?.href;
    const eligible =
      selection?.constraints_satisfied === true &&
      (selection.facts?.length ?? 0) > 0 &&
      selection.comparison?.trim() &&
      selectedHref !== undefined &&
      allowed.has(selectedHref);
    // a missing list only matters where the old code read it: cheap collection with a proven order and nothing shown never does
    const details = r.json.details ?? (cheap && orderingEstablished && !allowed.size ? [] : undefined);
    if (details == null) throw new Error("Collection reading lacks its details list");
    let detailURLs = eligible ? [...new Set([selectedHref, ...details])] : details;
    if (cheap && orderingEstablished) {
      // in the rows' own order: a row's link or its own detail button, then the rows made for other buttons
      const publicOrder = [...new Set(rows.flatMap(rowDetails))];
      // A model-selected subset or reordered details cannot prove first-match rank, nor can a list with a row that has
      // no link or button to open: the first match among the rows that have one may come after it.
      if (
        publicOrder.length !== new Set(detailURLs).size ||
        publicOrder.some((url) => !detailURLs.includes(url)) ||
        listed.some((row) => !row.links.length)
      )
        earlierResolved = false;
      detailURLs = publicOrder.filter((url) => detailURLs.includes(url));
    }
    if (pageSettled) detailURLs = []; // the ordered scan settled every row it needed: nothing else to open here
    // a list ordered by its rows' dates ranks only its own rows: a detail button outside them, walked after them all,
    // holds no date of that order, so a match there is never the first qualified record
    const datedOwn = dateProof ? new Set(rows.slice(0, itemRows).flatMap(rowDetails)) : null;
    for (const href of detailURLs) {
      if (!allowed.has(href) || visitedDetails.has(href)) continue;
      const cachedSelection = memory.verifiedSelections.get(href);
      if (eligible && href === selectedHref && cachedSelection === JSON.stringify(selection)) {
        selectedVerified = true;
        break;
      }
      if (contract.intent !== "choose_qualified" && memory.completedDetails.has(href)) {
        if (cheap) earlierResolved = false; // Cached coverage is not a fresh ordered match classification.
        continue;
      }
      this.check();
      if (datedOwn && !datedOwn.has(href)) earlierResolved = false;
      visitedDetails.add(href);
      const control = controls.find((c) => c.source_id === href);
      const visitDetail = async (detailTab: Tab): Promise<Outcome | undefined> => {
        const detailSeen = new Set();
        for (;;) {
          this.check();
          const ds = await this.look(detailTab);
          const di = await detailTab.info(50000);
          if (new URL(di.url).origin !== origin)
            return {
              replan: [
                {
                  ...step,
                  kind: "read",
                  open_url: "",
                  use_tab: -1,
                  goal: "Inspect unexpected detail navigation; do not extract cross-origin contents",
                },
              ],
              why: "Detail left source origin",
            };
          keepRaw(href, { source_id: href, url: di.url, text: di.text });
          const detailPosition = cheap ? await detailTab.eval("({x:scrollX,y:scrollY})") : null;
          const dk = JSON.stringify([di.url, di.text, detailPosition, ds.els.map((e) => [e.text, e.box, e.state])]);
          if (detailSeen.has(dk)) {
            if (cheap && !eligible) {
              earlierResolved = false;
              pending.push({ source_id: href, url: di.url, text: di.text, coverage_incomplete: true });
              remember(href, "REPEATED DETAIL STATE: coverage remains unresolved; not a complete negative");
            }
            break;
          }
          detailSeen.add(dk);
          const navigation = await navigationOptions(detailTab, ds);
          if (cheap && !eligible) {
            const screened = await screenDetail(this, {
              contract,
              info: { ...di, truncated: di.chars > di.text.length },
              screen: ds,
              options: navigation.options,
            });
            keepRaw(href, { source_id: href, ...screened.raw });
            if (screened.decision === "no_match") {
              remember(href, "MODEL EXCLUSION (not deterministic proof): confidence=" + String(screened.confidence));
              memory.completedDetails.add(href);
              break;
            }
            if (!screened.needsReveal) {
              pending.push({ ...screened.raw, source_id: href });
              // Flush an ordered candidate before inspecting later records; otherwise batch records.
              if (orderingEstablished || pending.length >= 8) {
                const failed = await flushBatch();
                if (failed) return failed;
              }
              break;
            }
            const revealAction = navigation.all.acts[String(screened.next)];
            if (revealAction) {
              const outcome = await this.act(
                detailTab,
                revealAction,
                null,
                ds,
                [],
                "drex",
                1,
                "reveal needed read-only detail before extraction",
                { step },
              );
              if (outcome?.replan || outcome?.fail) return outcome;
              if (outcome?.blocked || outcome?.dispatched === false || outcome?.stepDone) break;
              continue;
            }
            earlierResolved = false;
          }
          const detail = await this.llmCall("collect", () =>
            this.llm.collect({
              task: this.task,
              scope: "one_detail",
              step: {
                ...effectiveStep,
                goal: `Extract requested fields from this ONE detail, not whole collection: ${effectiveStep.goal}`,
              },
              notes: { gathered: evidenceText() },
              info: di,
              image: ds.img1,
              rows: [],
              options: navigation.options,
            }),
          );
          remember(
            href,
            "DETAIL: " + String(detail.json.evidence) + "; DETAIL COVERAGE COMPLETE: " + String(detail.json.complete),
          );
          if (detail.json.complete) memory.completedDetails.add(href);
          this.log("collection", {
            page: info.url,
            detail: href,
            evidence: detail.json.evidence,
            complete: detail.json.complete,
          });
          if (eligible && href === selectedHref) {
            const verified = await this.llmCall("verify", () =>
              this.llm.read({
                task: this.task,
                planText: "",
                purpose: "verify",
                step: {
                  kind: "verify",
                  goal: `Verify this chosen detail satisfies every original-task constraint: ${JSON.stringify(contract.constraints)}. Validate listed candidate facts against this detail. Comparison rationale must be supported, but no unrequested global ranking is needed.`,
                },
                notes: { candidate: JSON.stringify(selection), gathered: evidenceText() },
                info: di,
                image: ds.img1,
                candidates: ds.els.map((e) => ({ label: e.label, text: L.describe(e) })),
                observations: [],
              }),
            );
            if (verified.json.complete) {
              selectedVerified = true;
              remember(
                href,
                "QUALIFIED SELECTION: " +
                  JSON.stringify(selection) +
                  "; DETAIL VERIFIED: " +
                  String(verified.json.evidence),
              );
              memory.verifiedSelections.set(href, JSON.stringify(selection));
            }
          }
          if (selectedVerified || detail.json.complete || !navigation.options[String(detail.json.next)]) break;
          const decision = await this.drexCall(
            `Read-only detail: ${step.goal}\nMissing data: ${String(detail.json.evidence)}\nHelper recommends ${String(detail.json.next)}`,
            {
              move: {
                type: "choice",
                instructions: "Reveal requested hidden detail content using a safe navigation control",
                criteria: navigation.options,
              },
            },
            drexImages(this.task, ds, ds.img1, ds.img2),
          );
          this.totals.drexMoves++;
          const action = navigation.all.acts[String(pick(decision, "move").choice)];
          if (!action) break;
          const outcome = await this.act(
            detailTab,
            action,
            null,
            ds,
            [],
            "drex",
            1,
            "reveal read-only detail content",
            { step },
          );
          if (outcome?.replan || outcome?.fail) return outcome;
          if (outcome?.blocked || outcome?.dispatched === false || outcome?.stepDone) break;
        }
        return undefined;
      };
      const detailOutcome = control
        ? await withControl.call(this, control, info.url, step, visitDetail)
        : await withDetail.call(this, href, visitDetail);
      if (detailOutcome?.replan || detailOutcome?.fail) return detailOutcome;
      if (selectedVerified || orderedMatch) break;
    }
    if (cheap) {
      const failed = await flushBatch();
      if (failed) return failed;
    }
    this.notes[name] = evidenceText();
    this.log("collection", {
      page: info.url,
      rows: rows.length,
      details: visitedDetails.size,
      complete: r.json.complete,
    });
    // a settled page of a list proven ordered goes on to its next page even when the reading named none: the order, not
    // the model, says the rest of the list still has to be read
    const forcedNext =
      orderedScan && pageSettled && !(r.json.next && options[r.json.next])
        ? Object.keys(options).find((key) => {
            if (!paging.has(key)) return false; // a carousel's "Next slide" is no next page of the list
            const act = all.acts[key];
            const el = act ? elOf(act) : undefined;
            const label = (el?.paginationLabel || el?.name || el?.text || "").trim();
            // "»" or ">>" is often the last page, a jump past rows (as for the continuation below)
            return /^(?:page\s+)?next\b|^[>›→]$/i.test(label);
          })
        : undefined;
    const requestedDetailsComplete = detailURLs.every((id) => allowed.has(id) && memory.completedDetails.has(id));
    if (
      orderedMatch ||
      selectedVerified ||
      // a reading that calls the list complete doesn't end it while the proven order still has a next page to read
      (!forcedNext &&
        contract.intent !== "choose_qualified" &&
        r.json.complete &&
        !r.json.next &&
        requestedDetailsComplete &&
        (!cheap || cheapDetailsComplete))
    ) {
      complete = true;
      break;
    }
    if (!forcedNext && (!r.json.next || !options[r.json.next])) break;
    // Returning from details invalidates backend node IDs: resolve the same public action afresh.
    const fresh = await this.look(tab);
    const freshOptions = L.buildOptions({ els: fresh.els, off: fresh.off, texts: [] });
    const safe: Record<string, string> = {};
    const actions: Record<string, MoveOption> = {};
    for (const key of Object.keys(options)) {
      const old = all.acts[key];
      if (!old) throw new Error(`No move for option ${key}`);
      const oldEl = elOf(old);
      const candidate = Object.values(freshOptions.acts).find(
        (a) =>
          a.kind === old.kind &&
          (oldEl ? elOf(a)?.text === oldEl.text && elOf(a)?.context === oldEl.context : downOf(a) === downOf(old)),
      );
      if (candidate) {
        safe[key] = String(options[key]);
        actions[key] = candidate;
      }
    }
    if (!Object.keys(safe).length) break;
    const forced = forcedNext ? actions[forcedNext] : undefined;
    if (forced) {
      this.log("collection_next_page", { page: info.url, next: safe[forcedNext ?? ""] ?? "" });
      const moved = await this.act(tab, forced, null, fresh, [], "macro", 1, "next page of a list proven ordered", {
        step,
      });
      if (moved?.replan || moved?.fail) return moved;
      if (moved?.blocked || moved?.dispatched === false || moved?.stepDone) break;
      continue;
    }
    safe["stop collection"] = "No further requested data can be revealed by these safe controls";
    const choice = await this.drexCall(
      `Read-only collection: ${step.goal}\nEvidence: ${String(r.json.evidence)}\nHelper recommends ${String(r.json.next)}. Select the next safe navigation action.`,
      {
        move: {
          type: "choice",
          instructions:
            "Choose the continuation that reveals remaining requested records; never repeat already exhausted content.",
          criteria: safe,
        },
      },
      drexImages(this.task, fresh, fresh.img1, fresh.img2),
    );
    this.totals.drexMoves++;
    const candidate = actions[String(pick(choice, "move").choice)];
    if (!candidate) break;
    const outcome = await this.act(
      tab,
      candidate,
      null,
      fresh,
      [],
      "drex",
      pick(choice, "move").p,
      "read-only collection continuation",
      { step },
    );
    if (outcome?.replan || outcome?.fail) return outcome;
    if (outcome?.blocked || outcome?.dispatched === false || outcome?.stepDone) break;
    // A sorted list stays in its order only through a scroll or its next-page control: a page number, "»" or another
    // jump may skip rows, so no later row can be its first qualifying one.
    const movedEl = elOf(candidate);
    const movedLabel = (movedEl?.paginationLabel || movedEl?.name || movedEl?.text || "").trim();
    if (candidate.kind !== "scroll" && !/\bnext\b/i.test(movedLabel) && !/^[>›→]$/.test(movedLabel)) {
      orderedScan = false;
      earlierResolved = false;
    }
  }
  memory.coverageComplete = complete;
  this.notes[name] = evidenceText() + `\nCOLLECTION COVERAGE COMPLETE: ${complete}`;
  if (orderedMatch) {
    // the answer leads the notes on its own: a long list of ruled-out records in front of it was cut away when a final
    // answer had to compact its notes (337 found the order, then answered that it hadn't)
    const qualified = [...memory.sources].flatMap(([source_id, facts]) =>
      [...facts].filter((f) => f.startsWith("FIRST QUALIFIED")).map((fact) => ({ source_id, fact })),
    );
    memory.firstQualified = JSON.stringify({
      answer: qualified.at(-1) ?? null,
      earlier_records_ruled_out: memory.ruledOut?.size ?? 0,
      coverage:
        "The list is proven ordered by the objective from its first record; every earlier record was ruled out, so this record is the requested one. It was judged to be the item the task names by meaning, not by literal wording.",
    });
    this.notes[name] = memory.firstQualified;
    // the first qualifying record of a list verified sorted the requested way IS the optimum: a further check of the
    // whole collection would only ask for pages the order already makes unnecessary
    this.log("collection_done", { orderedMatch: true });
    return {};
  }
  if (contract.intent === "choose_qualified" && !selectedVerified)
    this.notes.collection_missing =
      "No qualified detail established yet; find another supported candidate or more detail evidence.";
  // A final evidence-aware verifier decides whether partial data is sufficient or more navigation is needed.
  return this.read(
    {
      ...effectiveStep,
      kind: "verify",
      save_as: `${name}_verification`,
      goal: `Check collection evidence covers the ORIGINAL task contract: ${JSON.stringify(contract)}. For choose_qualified, require selected candidate facts, comparison rationale and verified detail, not every catalog result. For enumerate_all/objective_optimum require requested coverage/ranking proof. Preserve gathered facts; if incomplete, give a navigation/collect continuation.`,
    },
    { requeue: step },
  );
}

/** The controls that set a list's scope and order (dropdowns, checkboxes, radios, tabs) with what they show now. */
function scopeControls(els: PageEl[]): unknown[] {
  return els
    .filter((e) => !!e.select || ["combobox", "listbox", "checkbox", "radio", "switch", "tab"].includes(String(e.role)))
    .map((e) => [e.role, e.name ?? "", e.text, e.checked ?? null, e.selectedIndex ?? null, e.state ?? ""]);
}

const elOf = (a: MoveOption): PageEl | undefined => ("el" in a ? a.el : undefined);
const downOf = (a: MoveOption): boolean | undefined => ("down" in a ? a.down : undefined);

function fieldIdentity(e: PageEl) {
  let context = e.context || "";
  context = context.replace(/\((?:not )?(?:checked|selected|focused)\)/gi, "").trim();
  if (e.slider?.value != null && context.startsWith(`${e.slider.value};`))
    context = context.slice(String(e.slider.value).length + 1).trim();
  return {
    label: e.label,
    name: e.name || "",
    role: e.role,
    context,
    grid: e.grid,
    position: e.box,
    options: e.options,
    slider: e.slider
      ? { min: e.slider.min, max: e.slider.max, step: e.slider.step, orientation: e.slider.orientation }
      : undefined,
  };
}

function sameFieldIdentity(a: PageEl, b: PageEl): boolean {
  const x = fieldIdentity(a),
    y = fieldIdentity(b);
  return (
    x.role === y.role &&
    x.name === y.name &&
    (!!x.name || a.text === b.text) &&
    x.context === y.context &&
    JSON.stringify(x.grid ?? null) === JSON.stringify(y.grid ?? null) &&
    !!a.field === !!b.field &&
    !!a.select === !!b.select &&
    !!a.slider === !!b.slider
  );
}

export async function fill(this: MacroHost, step: Step): Promise<Outcome> {
  const tab = await this.currentTab();
  const scr = await this.look(tab);
  const toggles = new Set<string | undefined>(["checkbox", "radio", "switch"]);
  const fields = scr.els.filter((e) => !!e.field || !!e.select || !!e.slider || toggles.has(e.role));
  const info = await tab.info(30000);
  this.log("fill_fields", { fields: fields.map((e) => L.describe(e).slice(0, 80)) });
  const focus = scr.shot ? await focusedEvidence(scr.shot, scr.els) : null;
  const notesHere = this.trusted?.has(L.originOf(info.url)) ? this.notes : {};
  const r = await this.llmCall("fill", () =>
    this.llm.fill({
      task: this.task,
      step,
      notes: notesHere,
      info,
      image: scr.img1,
      focus,
      fields: fields.map(fieldIdentity),
    }),
  );
  if (!Array.isArray(r.json.unresolved)) return { fail: "Desired-state response lacks unresolved-field declaration" };
  if (r.json.unresolved.length) {
    const why = `Desired form state unresolved: ${JSON.stringify(r.json.unresolved)}`;
    this.fillObjections ??= new Map();
    const objectionKey = JSON.stringify([this.task, info.url, fields.map(fieldIdentity), r.json.unresolved]);
    const repeats = (this.fillObjections.get(objectionKey) ?? 0) + 1;
    this.fillObjections.set(objectionKey, repeats);
    // the same form step unresolved again (in any words): the controls the filler can't match (a toggle, an unlabeled
    // box, a unit picker) go to ordinary moves instead of another plan around the same fill. Runs whose toggle or
    // unlabeled boxes the filler never matched ended "Gave up after 6 new plans".
    const stepKey = JSON.stringify(["fill step", this.task, step.recoveryGoal || step.goal]);
    const misses = (this.fillObjections.get(stepKey) ?? 0) + 1;
    this.fillObjections.set(stepKey, misses);
    // an objection about outcomes (a submission, a confirmation: not fields at all) is read for, below, not set by moves
    const outcomes = r.json.unresolved.every((u) =>
      /not (an )?editable|submi|confirm|outcome|already/i.test(`${u.label ?? ""} ${u.reason ?? ""}`),
    );
    if (misses >= 2 && !outcomes) {
      const open = r.json.unresolved.map((u) => String(u.label)).join(", ");
      return {
        replan: [
          {
            ...step,
            kind: "browse",
            goal: `${step.recoveryGoal || step.goal} Set each requested value with ordinary moves on the page: click the toggle, radio or checkbox, choose the option, type into the box. This includes ${open}, which the form filler could not match to a field. Keep values already set; do not submit.`,
            open_url: "",
            use_tab: -1,
            save_as: "",
            done_when: step.done_when || "Every requested value shows on the form.",
            max_moves: Math.max(step.max_moves ?? 0, 20),
          },
        ],
        why,
      };
    }
    if (repeats > 1)
      return {
        replan: [
          {
            ...step,
            kind: "read",
            goal: "Inspect current page facts and prior form effects; distinguish existing editable fields from submission outcomes. Do not repeat the same unresolved fill or prior submission.",
            open_url: "",
            use_tab: -1,
          },
        ],
        why,
      };

    return {
      replan: [
        {
          ...step,
          kind: "browse",
          goal: `Inspect the public form/reference to resolve missing desired-state evidence without submitting. ${why}`,
          open_url: "",
          use_tab: -1,
          save_as: "",
          done_when: "Missing desired-state evidence is known and recorded",
        },
        { ...step, open_url: "", use_tab: -1 },
      ],
      why,
    };
  }
  if (!Array.isArray(r.json.fields)) return { fail: "Desired-state assignments missing" };
  const assigned = new Set<string | undefined>();
  // an assignment with no label is the schema's filler for an unused slot ("Fill unused fields with ''"), not a field:
  // it was failing whole fill steps as "Unknown or duplicate desired field: " (book-flight, enter-time)
  const assignments = r.json.fields.filter((f) => typeof f.label === "string" && f.label.trim() !== "");
  for (const assignment of assignments) {
    if (!fields.some((e) => e.label === assignment.label) || assigned.has(assignment.label))
      return { fail: `Unknown or duplicate desired field: ${String(assignment.label)}` };
    if (
      typeof assignment.desired_value !== "string" ||
      !(["instruction", "evidence_note", "visual_reference"] as unknown[]).includes(assignment.source_kind) ||
      !assignment.source_evidence?.trim()
    )
      return { fail: "Desired field value has no explicit source evidence" };
    if (assignment.source_kind === "evidence_note" && notesHere !== this.notes)
      return {
        fail: `Notes are not typed into ${L.host(info.url)}: the task did not start on or name that site`,
        terminal: true,
      };
    assigned.add(assignment.label);
  }
  const results: Record<string, unknown>[] = [];
  const resultName = step.save_as || `form${this.index + 1}`;
  const persist = () => {
    this.notes[resultName] = JSON.stringify(results);
  };
  const recover = (why: string): Outcome => ({
    replan: [
      {
        ...step,
        kind: "verify",
        open_url: "",
        use_tab: -1,
        goal: `Inspect the CURRENT page after partially completed form actions. ${why}. Use recorded assignments as history, verify current values or resulting effects before deciding any remaining work. Attempted actions may have been blocked; only dispatched=true or executed-action observations prove dispatch. Verify effects before retrying, and never repeat a confirmed mutation just because its old field disappeared.`,
        done_when: "Original requested fields or their resulting effect are supported by current public evidence",
        question: "",
        save_as: `${resultName}_verification`,
      },
    ],
    why,
  });
  for (const assignment of assignments) {
    const original = fields.find((e) => e.label === assignment.label);
    if (!original) return { fail: `Unknown form field: ${String(assignment.label)}` };
    const current = await this.look(tab);
    if (current.info.url !== info.url) return recover("Form page changed before dispatch; inspect current effects");
    const candidates = current.els.filter((e) => sameFieldIdentity(e, original));
    const [el] = candidates;
    if (candidates.length !== 1 || !el)
      return recover(
        `Form field now has ${candidates.length} unambiguous identity matches; do not choose a reused node or first duplicate`,
      );
    const value = assignment.desired_value;
    if (
      typeof value !== "string" ||
      !(["instruction", "evidence_note", "visual_reference"] as unknown[]).includes(assignment.source_kind) ||
      !assignment.source_evidence?.trim()
    ) {
      return { fail: "Desired field value has no explicit source evidence" };
    }
    const provenance = { source_kind: assignment.source_kind, source_evidence: assignment.source_evidence };
    let act: MoveOption;
    if (toggles.has(el.role)) {
      if (!["true", "false"].includes(value)) return { fail: `Boolean required for ${el.text}` };
      const previous = await tab.fieldValue(el.node);
      if (previous.checked === (value === "true")) {
        results.push({ field: original.text, ...provenance, requested: value, observed: previous.checked, ok: true });
        persist();
        continue;
      }
      if (el.role === "radio" && value === "false")
        return { fail: "Clear radio by selecting the requested alternative, not toggling the selected radio" };
      act = { kind: "click", el };
    } else if (el.slider) act = { kind: "set_value", el, value: Number(value) };
    else if (el.select) {
      if (!el.options) throw new Error(`Form select has no options: ${el.text}`);
      const index = el.options.indexOf(value);
      if (index < 0) return { fail: `Form option unavailable: ${value}` };
      act = { kind: "select", el, index, value };
    } else act = { kind: "type", el };
    const dispatch = await this.act(tab, act, value, current, [], "macro", 1, "fill and verify; no submission", {
      step,
    });
    // The action may navigate or rerender. Persist its attempted state before any read can fail.
    const entry = {
      field: original.text,
      ...provenance,
      requested: value,
      observed: null,
      ok: false,
      attempted: true,
      dispatched: dispatch?.dispatched === true,
      verification_pending: true,
    };
    results.push(entry);
    persist();
    if (dispatch?.replan || dispatch?.fail) return dispatch;
    if (dispatch?.stepDone) return {};
    if (dispatch?.blocked || dispatch?.dispatched === false)
      return recover("Action was not dispatched; inspect the current form before retrying");
    let fresh: Looked, observed: FieldValue, matchedField: OnScreenEl;
    try {
      fresh = await this.look(tab);
      const fieldsNow = fresh.els.filter((e) => !!e.field || !!e.select || !!e.slider || toggles.has(e.role));
      const matches = fieldsNow.filter((e) => sameFieldIdentity(e, el));
      const [only] = matches;
      if (matches.length !== 1 || !only)
        return recover(
          `Previously addressed field now has ${matches.length} unambiguous matches; inspect the resulting page instead of replaying actions`,
        );
      matchedField = only;
      observed = await tab.fieldValue(matchedField.node);
    } catch (caught) {
      const error = caught as Error;
      if (
        !/No node with given id|Node with given id does not belong|Could not find node|Cannot find context|Execution context was destroyed|Inspected target navigated/i.test(
          error.message,
        )
      )
        throw error;
      return recover(`Page changed during field verification: ${error.message}`);
    }
    const selectedLabel =
      el.select && observed.selectedIndex !== undefined ? matchedField.options?.[observed.selectedIndex] : undefined;
    const ok = toggles.has(el.role)
      ? observed.checked === (value === "true")
      : el.select
        ? selectedLabel === value
        : el.slider
          ? Number(observed.value) === Number(value)
          : String(observed.value) === value;
    Object.assign(entry, {
      observed: toggles.has(el.role) ? observed.checked : el.select ? selectedLabel : observed.value,
      ok,
      verification_pending: false,
    });
    persist();
    if (fresh.info.url !== current.info.url)
      return recover(
        "A field action navigated to a different page; inspect persisted values/effects before filling any further fields",
      );
    if (!ok)
      return {
        replan: [
          {
            ...step,
            kind: "read",
            goal: "Inspect current field mismatch before proposing a correction; do not repeat a prior submission",
            open_url: "",
            use_tab: -1,
          },
        ],
        why: `Form value verification failed: ${JSON.stringify(results.at(-1))}`,
      };
  }
  this.notes[step.save_as || `form${this.index + 1}`] = JSON.stringify(results);
  this.log("form", { fields: results, submitted: false });
  return this.read(
    {
      ...step,
      kind: "verify",
      save_as: `${step.save_as || `form${this.index + 1}`}_verification`,
      done_when:
        "Requested field values and selections match their desired-state evidence; submission is not required by this field check",
      question: "Are the requested field values and selections correct before submission?",
      goal: `Verify all requested form values are set, including checkbox/radio choices and required fields. Do not submit yet. ${step.goal}`,
    },
    { requeue: step },
  );
}

// --- collectLite (a cost switch): a list read by Drex alone --------------------------------------------------------
const LITE_PAGES = 6; // pages of a list read at most
const LITE_DETAILS = 12; // detail pages opened at most (a list of dated records: LITE_DATED)
const LITE_DATED = 30;
const LITE_FACT = 800; // a matching record's text kept in the note
const LITE_ROW = 300; // and its row's
const LITE_MATCHES = 8; // matches kept in the note
const LITE_EMPTY_PAGES = 2; // an unsorted list that shows no match on this many pages is read no further
// enumerate_all (count or list every match): the whole list is the answer, so neither early stop applies; it reads up
// to this many pages and keeps this many matches, each shorter (an order history of 37 orders on 4 pages was answered
// "none" after 2 pages, and a 'max of all' from the first 24 matches)
const LITE_ENUM_PAGES = 12;
const LITE_ENUM_MATCHES = 40;
const LITE_ENUM_FACT = 300;
const LITE_UNSETTLED = 3; // scanOn: rows nothing settled that an ordered scan passes before it stops at one
const LITE_DATED_FACT = 1200; // noteResolve: a dated record's own text kept with its match (an order's items)

/** A record page's own text, from where it names its row's identifier (an order's number on the order's page) rather
 * than from the site's menus at the top of the page. */
export function recordFrom(text: string, rowText: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const id = rowText.split(/\s+/).find((w) => /\d{3,}/.test(w) && !/[/$]/.test(w));
  const at = id ? flat.indexOf(id) : -1;
  return flat.slice(Math.max(0, at), Math.max(0, at) + max);
}
/** The collectLite cost switch: the collect step without LLM readings. The list's rows are read off the page; Drex
 * judges each row against the task's conditions (16 rows to a call), opens a row whose text can't settle it and
 * screens its detail page; a list sorted the requested way (proven by its rows' dates, or by Drex reading its sort
 * controls) stops at its first qualifying row, otherwise up to LITE_PAGES pages are read. The note keeps the matching
 * rows and records for the final answer to choose from. Only the task's collection contract (one short LLM call, kept
 * for the run) is asked of the LLM. A page with no list rows goes to the ordinary collect. */
export async function collectLite(this: MacroHost, step: Step): Promise<Outcome> {
  const name = step.save_as || `collection${this.index + 1}`;
  let held = this.collectionTaskContract;
  if (held?.task !== this.task) {
    const result = await this.llmCall("collect", () => this.llm.collectionContract({ task: this.task }));
    if (!(["enumerate_all", "objective_optimum", "choose_qualified"] as unknown[]).includes(result.json.intent))
      throw new Error("Invalid collection contract");
    held = this.collectionTaskContract = { task: this.task, contract: result.json };
  }
  const contract = held.contract;
  // the liteOptimumOnly cost switch: only a ranking ("the cheapest", "the last order") is read by Drex alone; choosing
  // the best fit or listing everything goes to the ordinary collect, whose LLM compares (the contract is kept)
  if (costOn("liteOptimumOnly") && contract.intent !== "objective_optimum") return collect.call(this, step);
  this.log("collection_contract", { contract, lite: true });
  // the first qualifying row of an ordered list answers only a request for the single top item (ranked_count 1): a
  // top-N request or another rank is read for its matches instead
  const optimum =
    contract.intent === "objective_optimum" &&
    contract.ranked_count === 1 &&
    ["asc", "desc"].includes(String(contract.sort_direction));
  const byDate = dateRanking(contract);
  const matches: { source: string; row: string; record?: string }[] = [];
  let checked = 0,
    ruledOut = 0,
    opened = 0,
    pages = 0,
    ordered = false,
    firstHit = false,
    lastDate: RowStamp | null = null,
    complete = false,
    unsettled = 0, // scanOn: rows of an ordered list nothing settled, passed on the way to a confirmed one
    settled = false; // scanOn: the scan ended on a confirmed row
  // scanOn: in an ordered list a row nothing settles is kept, and the scan goes on to a confirmed row (up to
  // LITE_UNSETTLED such rows): the first row of a price-sorted list can be another kind of item its title doesn't rule
  // out (286: a $1.33 hard disk taken as the cheapest SSD)
  const passUnsettled = () => accOn("scanOn") && ++unsettled <= LITE_UNSETTLED;
  const seenPages = new Set<string>();
  const enumerate = contract.intent === "enumerate_all";
  for (let page = 0; page < (enumerate ? LITE_ENUM_PAGES : LITE_PAGES); page++) {
    this.check();
    const tab = await this.currentTab();
    const scr = await this.look(tab);
    const info = await tab.info(50000);
    if (seenPages.has(info.url + "\n" + info.text.slice(0, 2000))) break;
    seenPages.add(info.url + "\n" + info.text.slice(0, 2000));
    const origin = new URL(info.url).origin;
    const rows: Row[] = [];
    for (const item of await tab.items()) {
      const links = shownLinks(
        scr,
        (((await tab.on(item.node, LINKS).catch(() => [])) as PageLink[] | null) ?? []).filter((l) =>
          safeLink(l, origin),
        ),
      );
      rows.push({ text: item.text, links });
    }
    const itemRows = rows.length;
    const controls = await detailControls(tab, scr, info.url);
    const flatText = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
    for (const c of controls) {
      const control = { source_id: c.source_id, label: c.label, text: c.text, row_context: c.row_context };
      const own = rows
        .slice(0, itemRows)
        .find((row) => !row.links.length && flatText(row.text) === flatText(c.row_context));
      if (own) (own.controls ??= []).push(control);
    }
    if (!rows.length) {
      if (page === 0) {
        this.log("collection_lite", { fallback: "no list rows on the page", page: info.url });
        return collect.call(this, step);
      }
      break;
    }
    pages++;
    // the list must be the one the task is about (a plan can start the collection on the home page): once, the
    // collection goes to it first
    if (
      page === 0 &&
      (this.collectionPreparationAttempts ?? 0) < 2 &&
      (await drexRelevant(this, contract, info)) < 0.5
    ) {
      this.collectionPreparationAttempts = (this.collectionPreparationAttempts ?? 0) + 1;
      return {
        replan: [
          {
            ...step,
            kind: "browse",
            goal: `Open the list this task has to read through: ${String(contract.scope)}. Stop once it is on screen; don't open its records.`,
            done_when: `The list (${String(contract.scope)}) is on screen.`,
            max_moves: 10,
            save_as: "",
            open_url: "",
            use_tab: -1,
          },
          { ...step, open_url: "", use_tab: -1 },
        ],
        why: `The page is not the list the task is about (${String(contract.scope)})`,
      };
    }
    // the order: a list of dated records proves it by its rows' dates; another ranking by Drex reading the sort
    if (page === 0 && optimum) {
      ordered = byDate
        ? !laterPage(info.url) &&
          !listNarrowed([...scr.els, ...(scr.off ?? [])]) &&
          datesOrdered(rows.slice(0, itemRows), String(contract.sort_direction))
        : !laterPage(info.url) &&
          !orderContradicted(rows, String(contract.objective_field), String(contract.sort_direction)) &&
          (await drexSorted(this, contract, info, scopeControls([...scr.els, ...(scr.off ?? [])])));
      if (!ordered && !byDate && (this.collectionPreparationAttempts ?? 0) < 3) {
        // one try at sorting the list the requested way, then the collection runs again on the sorted list
        this.collectionPreparationAttempts = (this.collectionPreparationAttempts ?? 0) + 1;
        const how = contract.sort_direction === "asc" ? "lowest" : "highest";
        return {
          replan: [
            {
              ...step,
              kind: "browse",
              goal: `Sort this list by ${String(contract.objective_field)}, ${how} first, using the page's own sort controls. Stop once it is sorted; don't open any item.`,
              done_when: `The list is sorted by ${String(contract.objective_field)}, ${how} first.`,
              max_moves: 8,
              save_as: "",
              open_url: "",
              use_tab: -1,
            },
            { ...step, open_url: "", use_tab: -1 },
          ],
          why: `The list isn't sorted by ${String(contract.objective_field)}, ${how} first`,
        };
      }
      this.log("collection_lite", { ordered, page: info.url });
    }
    if (
      ordered &&
      byDate &&
      page > 0 &&
      !datesOrdered(rows.slice(0, itemRows), String(contract.sort_direction), lastDate)
    )
      ordered = false;
    if (byDate) lastDate = lastStamp(rows.slice(0, itemRows), lastDate);
    // a list of dated records shows no item in its rows: each goes to its detail
    const verdicts = byDate
      ? rows.map((_, i) => ({ row: i, verdict: "needs_detail" as const, quote: "" }))
      : ((await drexRowVerdicts(this, contract, rows, ordered)) ?? []);
    for (const v of verdicts) {
      const row = rows[v.row];
      if (!row) break;
      checked++;
      if (v.verdict === "fails") {
        ruledOut++;
        continue;
      }
      const source = [...row.links].sort((a, b) => b.text.length - a.text.length)[0]?.href ?? info.url;
      if (v.verdict === "qualifies") {
        matches.push({ source, row: row.text.slice(0, LITE_ROW) });
        if (ordered && optimum) {
          firstHit = true;
          settled = true;
          break;
        }
        continue;
      }
      // needs_detail: the record's own page settles it (Drex screens it), within the run's detail allowance
      const [best] = [...row.links].sort((a, b) => b.text.length - a.text.length);
      const rowControl = best ? undefined : controls.find((c) => c.source_id === row.controls?.[0]?.source_id);
      if ((!best && !rowControl) || opened >= (byDate ? LITE_DATED : LITE_DETAILS)) {
        matches.push({ source, row: `${row.text.slice(0, LITE_ROW)} (not confirmed: its detail wasn't read)` });
        // in a sorted list a row nothing settles ends the scan: the answer is it or a row after it, for the final
        // answer to judge
        if (ordered && optimum && !passUnsettled()) {
          firstHit = true;
          break;
        }
        continue;
      }
      opened++;
      let decision = "need_more_information",
        record = "";
      const readDetail = async (detailTab: Tab): Promise<Outcome | undefined> => {
        this.check();
        const ds = await this.look(detailTab);
        const di = await detailTab.info(50000);
        if (new URL(di.url).origin !== origin) return undefined;
        const screened = await screenDetail(this, {
          contract,
          info: { ...di, truncated: di.chars > di.text.length },
          screen: ds,
          options: {},
        });
        decision =
          screened.reading.match === "no_match" && screened.reading.p >= 0.9 ? "no_match" : screened.reading.match;
        record = di.text;
        return undefined;
      };
      const went = rowControl
        ? await withControl.call(this, rowControl, info.url, step, readDetail)
        : await withDetail.call(this, best?.href ?? "", readDetail);
      if (went?.replan || went?.fail) return went;
      if (decision === "no_match") {
        ruledOut++;
        continue;
      }
      matches.push({
        source: best?.href ?? rowControl?.source_id ?? source,
        row: row.text.slice(0, LITE_ROW),
        // a record of a list ordered by its rows' dates: its row has the date, and Drex found the item in it
        record: byDate
          ? (decision === "match" ? "holds the item the task names" : "may hold the item (Drex not sure)") +
            // noteResolve: the record's own lines go with it, so a later step can name the item it holds
            (accOn("noteResolve") ? `: ${recordFrom(record, row.text, LITE_DATED_FACT)}` : "")
          : (decision === "match" ? "" : "(Drex not sure it matches) ") +
            record.replace(/\s+/g, " ").slice(0, LITE_FACT),
      });
      if (ordered && optimum && (decision === "match" || (!byDate && !passUnsettled()))) {
        firstHit = true;
        settled = decision === "match";
        break;
      }
    }
    if (firstHit || (contract.intent === "choose_qualified" && matches.length)) {
      complete = true;
      break;
    }
    if (!enumerate && !ordered && !matches.length && pages >= LITE_EMPTY_PAGES) break;
    if (!enumerate && matches.length >= LITE_MATCHES * 2) break;
    // the next page: its Next control, made as a macro move
    const fresh = await this.look(tab);
    const { all, options } = await navigationOptions(tab, fresh);
    const next = Object.keys(options).find((key) => {
      const act = all.acts[key];
      const el = act ? elOf(act) : undefined;
      const label = (el?.paginationLabel ?? el?.name ?? el?.text ?? "").trim();
      return /^(?:page\s+)?next\b|^[>»›]+$/i.test(label.replace(/[-]/g, "").trim());
    });
    const act = next ? all.acts[next] : undefined;
    if (!act) {
      complete = true;
      break;
    }
    const moved = await this.act(tab, act, null, fresh, [], "macro", 1, "next page of the list", { step });
    if (moved?.replan || moved?.fail) return moved;
    if (moved?.blocked || moved?.dispatched === false) break;
  }
  // scanOn: an ordered scan that passed unsettled rows and found no confirmed one answers with the first of them, as it
  // did before
  const passed = accOn("scanOn") && ordered && optimum && unsettled > 0;
  if (passed && !firstHit && matches.length) firstHit = true;
  const note = {
    read_by: "Drex judged each row against the task's conditions and screened the records it opened",
    contract: { intent: contract.intent, constraints: contract.constraints, objective: contract.objective },
    order: ordered
      ? passed
        ? `the list runs by ${String(contract.objective_field)} ${String(contract.sort_direction)}; the matches are in the list's order: the first one that meets every condition is the answer (a match its detail didn't confirm counts only if its own text shows every condition met)`
        : `the list runs by ${String(contract.objective_field)} ${String(contract.sort_direction)}; the first match is the answer`
      : "not proven sorted: compare the matches",
    ...(firstHit ? { answer: passed && !settled ? matches[0] : matches.at(-1) } : {}),
    matches: passed
      ? matches.slice(-LITE_MATCHES)
      : firstHit
        ? matches.slice(-1)
        : enumerate
          ? matches
              .slice(0, LITE_ENUM_MATCHES)
              .map((m) => ({ ...m, record: (m.record ?? "").slice(0, LITE_ENUM_FACT) }))
          : matches.slice(0, LITE_MATCHES),
    rows_checked: checked,
    ruled_out: ruledOut,
    pages_read: pages,
    whole_list_read: complete,
  };
  this.notes[name] = JSON.stringify(note);
  this.log("collection_done", { lite: true, matches: matches.length, checked, ruledOut, pages, firstHit, complete });
  return {};
}
