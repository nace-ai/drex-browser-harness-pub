// One run of a task. The LLM turns the task into a short plan; Drex Max makes every move of each browse step (one
// call per move: the screen, the screen with tagged elements, and every possible move as a choice); the LLM writes
// the text of read steps and takes over single moves when Drex is unsure. Every call's time and cost is counted.
import { Tab, abortReason } from "./cdp.ts";
import { pick, yes } from "./drex.ts";
import * as L from "./logic.ts";
import { dataUrl, drawMarks, thumb, toShot } from "./shots.ts";
import SITES from "./sites.json";
import { siteFor, sitesForTask } from "./sites.ts";
import { collect, collectLite, fill, safeLink } from "./macros.ts";
import { publicMetadata } from "./candidates.ts";
import { focusedEvidence } from "./focused.ts";
import { revealAnswer, type Reveal } from "./evidence.ts";
import { RunBudget, RunLimit } from "./run-budget.ts";
import { describeError } from "./errors.ts";
import { runCostCap } from "./models.ts";
import { costOn, costValue, drexImages, moveOptions, movesTask } from "./cost.ts";
import { accOn } from "./accuracy.ts";
import type { Drex } from "./drex.ts";
import type { LLM } from "./llm.ts";
import type {
  Accounted,
  BatchStep,
  Box,
  CollectionContract,
  CollectionMemory,
  DrexReply,
  Emit,
  EndReport,
  EndScreen,
  HistoryEntry,
  LocatedEl,
  Looked,
  MacroHost,
  MoveOption,
  Notes,
  OffScreenEl,
  OnScreenEl,
  Outcome,
  PageEl,
  PageElements,
  PageInfo,
  PageItem,
  PartialEvidence,
  PlanJson,
  PlanLike,
  PointTarget,
  PreparationJson,
  PublicMetadata,
  Questions,
  RunEvent,
  RunLimits,
  RunOptions,
  RunResult,
  RunStatus,
  Step,
  StepChoice,
  StepText,
  TabInfo,
  Totals,
  UserAnswer,
  Who,
} from "./types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BLANK_GRACE_MS = 1500; // how long a blank tab a click opened may take to start loading its page
const LANDING_WAIT_MS = 15000; // how long a planned URL may take to redirect to its site (sheets.new: several hops)
// why a table was not typed (Tab.type): what Drex reads in its history for that move
const ONE_LINE_TABLE =
  "Not typed: the cursor is in a one-line box (a search or name box), not in the sheet or document the table goes into. Close that box (Escape) or put the cursor where the table goes, then type it again.";
/** What is under a screen point (Tab.pointTarget), or null when it can't be read: an unknown target is risky. */
async function readPoint(tab: Tab, x: number, y: number, opts?: { hover?: boolean }): Promise<PointTarget | null> {
  try {
    return await tab.pointTarget(x, y, opts);
  } catch {
    return null;
  }
}
const START_PAGE = "https://www.google.com/";
/** Tabs the agent opens are http(s) only, as Tab.navigate's: chrome.tabs bypasses the runner's page routing, so a
 * planned file:// (or chrome://, data:) URL would otherwise let the debugger read local files. */
function webOnly(url: string): void {
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {}
  if (!/^https?:$/.test(protocol)) throw new Error(`Refusing to open a ${protocol || "malformed"} URL`);
}
const MAX_RECOVERIES = 6; // replans and recovery steps in one run; after that a failing step ends the run
const MAX_INCOMPLETE_CHECKS = 3; // reads/verifies in a row that found their answer missing; after that the run ends
const VERIFY_TEXT = 6000; // page text a Drex check of a planned verify step reads (the verifyDrex cost switch)
const VERIFY_SURE = 0.85; // and how sure it must be that the check passes to skip the LLM
const OBSERVATION_TEXT = 500; // page text kept per observed move (the LLM's evidence of what each move did)
const OBSERVATION_CONTROLS = 30; // controls kept per observed move
const MAX_OBSERVATIONS = 24;
const OBS_LITE = 4; // the obsLite cost switch: moves an LLM check reads,
const OBS_LITE_CONTROLS = 8; // controls kept from each side of a move,
const OBS_LITE_TEXT = 200; // and page text
const MAX_NOTICES = 10; // notices ("Item added!") kept in the notes
const EXTRA_MOVES = 10; // granted once per step when the LLM says to keep going after the step ran out of moves
const TAB_BUSY_RETRIES = 25;
const MAX_PAGES = 100; // batch steps: pages of a list to go through at most (a 1,650-email inbox is ~33 pages)
const PAGE_WAIT_MS = 8000; // a list's next page can take seconds to arrive (Gmail fetches it)
const LIST_REFRESH_MS = 4000; // after a bulk action, how long to wait for the list to refresh
const BULK_MOVES = 8; // moves for one bulk action on the ticked items (toolbar, menu, confirm dialog)
const ITEM_MOVES = 6; // moves for one item's action when the list has no checkboxes
const PAUSE_MOVES = 6; // a loop's moves are left out of Drex's options for this many moves
const META_KINDS = ["step_done", "stuck", "check_done", "ask_user", "look"]; // options that are not moves on the page
// no plan: what the LLM is told when it checks whether the user's task is finished
// no plan: what the LLM is told when Drex is about to make a click that can't be undone (Place order, Pay, Send...)
const RISKY_CHECK =
  "That click can't be undone. Check the screen against the user's task first: does it hold everything the task asks for (each item, the amounts, the date and time, the address or the people)? If it does, choose that same move. If something is missing or wrong (including anything in it the task did not ask for), choose the move that fixes it (open the cart or the order summary to see it, go back to the store, change the time, remove the extra item). If this screen doesn't show enough to tell, choose the move that shows more (expand the summary).";
const FINISH_CHECK =
  "Choose finished only if everything the user's task asks for is done on screen: an order or a booking counts once it is placed and confirmed, a message once it is sent, a change once it is saved. If something is left, choose the move that does it next.";

/** The plan a run works through: a plan from the LLM always has steps by then (run() checks). */
interface RunPlan {
  summary?: string;
  steps: Step[];
  answer_from?: string;
  direct?: boolean;
}
type WindowTab = TabInfo & { active: boolean };
interface AfterShot {
  tabId: number;
  jpeg: string;
  elements: PageElements | null;
}
interface Decided {
  item: PageItem;
  choice: string | undefined;
  p: number | undefined;
}
/** What the LLM's take-over gives back: a move (with the text the LLM typed, which the step may offer again), or a
 * replan, a hand-over, a failure, the task finished (no plan) or the step done (with one), or nothing. */
type Rescue =
  | {
      act?: undefined;
      text?: undefined;
      learned?: undefined;
      origin?: undefined;
      replan?: Step[];
      why?: string;
      ask?: string;
      fail?: string;
      terminal?: boolean;
      done?: string;
    }
  | {
      act: MoveOption;
      text: string | undefined;
      why: string | undefined;
      learned?: string;
      origin?: string;
      replan?: undefined;
      ask?: undefined;
      fail?: undefined;
      done?: undefined;
    };
interface AgentOptions {
  drex: Drex;
  llm: LLM;
  emit: Emit;
  windowId?: number | null;
  background?: boolean;
  plan?: PlanLike | null;
  approvals?: boolean;
  unattended?: boolean;
  cursor?: boolean;
  planning?: boolean;
  report?: { expect?: string } | null;
  runOptions?: RunOptions;
}

/** Chrome refuses tab edits for a moment while the tab strip is busy ("Tabs cannot be edited right now (user may be
 * dragging a tab)"), e.g. right after a click on it; such calls are retried for a few seconds. */
async function tabsCall<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= TAB_BUSY_RETRIES || !/cannot be edited right now|dragging/i.test((e as Error).message)) throw e;
      await sleep(150);
    }
  }
}

export const attachable = (url: string | undefined): boolean =>
  /^(https?|file):/.test(url || "") &&
  !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/.test(url ?? "");

/** A value the code reads without checking it (a field of the LLM's answer, the move for an option, a probability
 * from Drex): a missing one ends the run here with an Error, where reading it threw a TypeError. */
function need<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`${what} is missing`);
  return value;
}
/** A plan the run can work through; one without steps ends the run where reading them threw. */
const hasSteps = (plan: PlanJson): plan is RunPlan => plan.steps !== undefined;
const hasChoices = (step: Step): step is BatchStep => Array.isArray(step.choices) && step.choices.length > 0;
/** A tab Chrome created: it always has an id, which Chrome's types leave optional. */
const hasId = (t: chrome.tabs.Tab): t is chrome.tabs.Tab & { id: number } => t.id !== undefined;

/** Text that is a JSON object or array: an answer in a machine-read format, which prose appended to it would break. */
function structured(text: string): boolean {
  if (!/^[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** A JSON array of several items: an answer's list, which is never cut down to its first item (answerGuard). */
const listOfMany = (text: string) =>
  structured(text) && text.startsWith("[") && (JSON.parse(text) as unknown[]).length > 1;

class Stopped extends Error {}
class Handover extends Error {} // a coding agent's run needs the person: it ends and says why instead of waiting
/** A collect step used its model reads (MAX_COLLECT_CALLS): it ends with what it read. */
export class ReadCap extends Error {}
// Model calls one collect step may make (its contract and list check included, so about four list or detail reads).
// Without a cap, runs read result lists item by item, a call each, until the run's call cap, where the site's own
// filters would have shown the answer; past this the step ends with what it read and the plan goes on.
export const MAX_COLLECT_CALLS = 6;

/** The elements as the LLM's checks see them (read, verify, readiness). */
const controlsOf = (els: PageEl[] | null | undefined) =>
  (els ?? []).slice(0, OBSERVATION_CONTROLS).map((e) => L.describe(e).slice(0, 160));
const candidatesOf = (els: PageEl[]) =>
  els.map((e) => ({
    label: e.label,
    text: L.describe(e),
    role: e.role,
    checked: e.checked,
    indeterminate: e.indeterminate,
    grid: e.grid,
  }));

export class Agent implements MacroHost {
  declare windowId: number | undefined;
  declare wantReport: { expect?: string } | null;
  declare runOptions: RunOptions & { limits: RunLimits; efficiency: Record<string, boolean | undefined> };
  declare runBudget: RunBudget;
  declare objections: Map<string, number>;
  declare planning: boolean;
  declare cursor: boolean;
  declare approvals: boolean;
  declare unattended: boolean;
  declare fixedPlan: PlanLike | null;
  declare drex: Drex;
  declare llm: LLM;
  declare emit: Emit;
  declare background: boolean;
  declare stopped: string | false;
  /** Fires on Stop: the run stops waiting for whatever it was waiting for, and the tabs stop waiting for Chrome. */
  declare abort: AbortController;
  declare tabs: Map<number, Tab>;
  declare totals: Totals;
  declare allowedClicks: Set<string | undefined>;
  declare gesturesAllowed: boolean;
  declare trusted: Set<string>;
  declare namedUrls: Set<string>;
  declare landing: { tabId: number; origin: string; from: string | undefined } | null;
  declare recoveries: number;
  declare incompleteChecks: number;
  declare batchApproved: boolean;
  declare record: RunEvent[];
  declare visits: Map<string, number>;
  declare actionMemory: Map<string, Map<string, number>>;
  declare noProgress: Map<string, number>;
  declare observations: Record<string, unknown>[];
  declare tabBindings: Map<number, number | undefined>;
  declare activePlanTab: number | null;
  declare acting: boolean;
  declare onCreated: (t: chrome.tabs.Tab) => void;
  declare onDetach: (src: chrome.debugger.Debuggee, reason: string) => void;
  // set by run(), and by the tabs and moves on the way
  declare task: string;
  declare t0: number;
  declare startTabs: WindowTab[];
  /** the website the task is about (the user's tab at the start), which the run stays on; null when there is none */
  declare site: string | null;
  /** model calls of the collect step running now (null outside one): capped at MAX_COLLECT_CALLS */
  declare collectCalls: number | null;
  declare agentTabId: number | null | undefined;
  declare ownTab: boolean;
  declare newTabId: number | null | undefined;
  declare afterShot: AfterShot | null;
  declare plan: RunPlan;
  declare notes: Notes;
  declare index: number;
  declare groupId: number | undefined;
  declare pendingAsk: ((ok: UserAnswer) => void) | null | undefined;
  declare endReport: EndReport | null;
  declare fillObjections: Map<string, number>;
  declare collectionTaskContract: { task: string; contract: CollectionContract } | null;
  declare collectionPreparationAttempts: number;
  declare collectionPreparations?: Map<string, { preparation: PreparationJson; at: string }>;
  declare collectionMemory?: Map<string, CollectionMemory>;
  declare collectionMutationEpoch?: number;
  /** noteResolve: what a step got from the list notes it uses, by step and notes (a replan asks no second time). */
  declare noteResolutions?: Map<string, { why: string; value: string }>;
  /** answerGuard: the final read found the task complete but wrote no answer; its evidence, for the final answer. */
  declare finalCheckEvidence?: string;

  constructor({
    drex,
    llm,
    emit,
    windowId = null,
    background = true,
    plan = null,
    approvals = true,
    unattended = false,
    cursor = true,
    planning = true,
    report = null,
    runOptions = {},
  }: AgentOptions) {
    // the window the run works in (the panel's, or the one you used last); the agent runs in the service worker,
    // which has no window of its own
    this.windowId = windowId ?? undefined;
    // a caller such as a coding agent: {expect} gets the end screen, the page errors seen and Drex's check of `expect`
    this.wantReport = report;
    this.runOptions = {
      ...runOptions,
      limits: {
        maxHaikuCalls: 40,
        // the cap cost switch sets a lower cost cap for a run (dollars), so a failing run stops cheaply
        maxCostUsd: costOn("cap") ? costValue("cap", 0.006) : runCostCap(llm.model),
        maxSeconds: 600,
        ...runOptions.limits,
      },
      efficiency: { contextBudget: true, promptCache: true, cheapCollection: true, ...runOptions.efficiency },
    };
    this.runBudget = new RunBudget(this.runOptions.limits);
    llm.runBudget = drex.runBudget = this.runBudget;
    llm.runOptions = this.runOptions;
    this.objections = new Map();
    this.planning = planning; // false: no plan and no replans from the LLM; Drex works on the task as written
    this.cursor = cursor; // the visible cursor and click ring in the agent's tab, and the target marker in the live view
    this.approvals = approvals; // false: risky clicks and bulk actions go ahead without asking (hand-overs still wait)
    // true: a benchmark runner drives the run and nobody answers a hand-over, so the run answers instead of asking
    this.unattended = unattended;
    this.fixedPlan = plan; // a plan given in advance (e2e tests replay a real run's plan); no planning call then
    this.drex = drex;
    this.llm = llm;
    this.emit = emit;
    this.background = background; // work in a tab behind the user's tabs (falls back to the front if Chrome won't paint it)
    this.stopped = false;
    this.abort = new AbortController();
    this.tabs = new Map(); // tab id -> Tab with the debugger attached
    this.totals = {
      drexUsd: 0,
      llmUsd: 0,
      drexCalls: 0,
      llmCalls: 0,
      drexMoves: 0,
      llmMoves: 0,
      drexItems: 0,
      seconds: 0,
      waitSeconds: 0,
    };
    this.allowedClicks = new Set(); // risky controls you allowed for the rest of the task
    this.gesturesAllowed = false; // you allowed point clicks and gestures for the rest of the task
    this.trusted = new Set(); // origins of the user's open tabs and the first plan's URLs: replans may only open these
    this.namedUrls = new Set(); // the first plan's URLs (the planner saw only the task)
    this.landing = null; // one of them just opened: the site its own redirect lands on (trustLanding)
    this.site = null;
    this.collectCalls = null;
    this.recoveries = 0; // replans and recovery steps so far (MAX_RECOVERIES)
    this.incompleteChecks = 0; // reads/verifies in a row that found their answer missing (MAX_INCOMPLETE_CHECKS)
    this.batchApproved = false; // inside a bulk action you already approved for its items
    this.record = [];
    this.visits = new Map();
    this.actionMemory = new Map();
    this.noProgress = new Map();
    this.observations = [];
    this.tabBindings = new Map();
    this.activePlanTab = null;
    this.acting = false; // a move is being made: a tab that appears now was opened by it
    this.onCreated = (t) => {
      // a link opened with "noopener" (DoorDash's store cards) gets the window's ACTIVE tab as its opener, which in
      // background mode is the user's tab, not the agent's: a tab that appears in the agent's window during a move is
      // taken as the move's own
      if (t.openerTabId === this.agentTabId || (this.acting && t.windowId === this.windowId)) this.newTabId = t.id;
    };
    this.onDetach = (src, reason) => {
      if (reason === "canceled_by_user") this.stop("You closed Chrome's debugging bar, which stops the agent.");
      if (src.tabId !== undefined) this.tabs.delete(src.tabId);
    };
  }

  stop(why = "Stopped by you."): void {
    if (this.stopped) return;
    this.stopped = why;
    this.runBudget.stop(); // a model call still in flight doesn't send its retries
    this.abort.abort(new Stopped(why));
    if (this.pendingAsk) this.pendingAsk(false);
  }

  /** work, unless the run is stopped first: a call that never returns (a page that stopped answering, a model call that
   * hangs) must not keep Stop from working. What work does after that is ignored; its next check() throws. */
  untilStopped<T>(work: Promise<T>): Promise<T> {
    const signal = this.abort.signal;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        reject(abortReason(signal));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      work.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }

  check(): void {
    if (this.stopped) throw new Stopped(this.stopped);
    this.runBudget.check();
  }

  log(type: string, data: Record<string, unknown> = {}): void {
    const e = { type, t: +((performance.now() - this.t0) / 1000).toFixed(2), ...data };
    this.record.push(e);
    this.emit(type, e);
  }

  tick(): void {
    this.totals.seconds = (performance.now() - this.t0) / 1000;
    this.emit("totals", { ...this.totals });
  }

  // --- the run ------------------------------------------------------------------------------------------------------
  async run(task: string): Promise<RunResult> {
    this.task = task;
    this.t0 = performance.now();
    this.runBudget = new RunBudget(this.runOptions.limits);
    this.llm.runBudget = this.drex.runBudget = this.runBudget;
    // a planned run owes the task its answer however it ends: one bounded request is kept back for it from the start
    if (this.planning && !this.fixedPlan && typeof this.llm.finalAnswerHold === "function")
      this.runBudget.hold(this.llm.finalAnswerHold());
    this.objections.clear();
    this.llm.contracts = new Map(); // a collection contract remembered from another run doesn't apply to this one
    this.fillObjections = new Map();
    this.collectionMemory = new Map();
    this.collectionTaskContract = null;
    this.collectionMutationEpoch = 0;
    this.collectionPreparationAttempts = 0;
    this.collectionPreparations = new Map();
    this.noteResolutions = new Map();
    this.finalCheckEvidence = "";
    chrome.tabs.onCreated.addListener(this.onCreated);
    chrome.debugger.onDetach.addListener(this.onDetach);
    let status: RunStatus = "done";
    let message = "";
    let lastAnswer: string | null = null;
    try {
      this.windowId ??= (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
      this.startTabs = await this.windowTabs();
      this.tabBindings = new Map(this.startTabs.map((t, i) => [i, t.id]));
      const active = this.startTabs.find((t) => t.active);
      this.agentTabId = active ? active.id : null;
      this.activePlanTab = this.startTabs.findIndex((t) => t.id === this.agentTabId);
      this.ownTab = false;
      const sites = sitesForTask(
        SITES,
        task,
        this.startTabs.map((t) => t.url),
      );
      const plan: PlanLike = this.fixedPlan
        ? structuredClone(this.fixedPlan)
        : !this.planning
          ? L.directPlan(task)
          : (
              await this.untilStopped(
                this.llmCall("plan", () =>
                  this.llm.plan({ task, tabs: this.startTabs, today: new Date().toDateString(), sites }),
                ),
              )
            ).json;
      this.log("plan", { plan: structuredClone(plan) });
      if (!hasSteps(plan)) throw new Error("The plan has no steps.");
      // the run stays on the task's website: a step that would open a search engine continues on the site instead
      this.site = L.taskSite(task, active?.url);
      const onSite = L.stayOnSite(plan.steps, this.site);
      if (onSite.dropped.length) {
        plan.steps = onSite.steps;
        this.log("blocked", {
          what: `open ${onSite.dropped.join(", ")}`,
          reason: "the task's website has its own navigation and search; a search engine is a detour",
        });
      }
      this.plan = plan;
      // the sites this run may open by itself: where the user is, and what the planner (which saw only the task) named
      for (const u of [...this.startTabs.map((t) => t.url), ...this.plan.steps.map((s) => s.open_url), START_PAGE]) {
        const o = L.originOf(u ?? "");
        if (o) this.trusted.add(o);
      }
      this.namedUrls = new Set(this.plan.steps.map((s) => s.open_url).filter((u): u is string => !!u));
      // A planned run ends with an evidence-backed answer to the whole task. Not with LLM planning off (the LLM only
      // types and checks) or with a fixed plan (a replay of a real run's plan).
      const last = this.plan.steps.at(-1);
      if (
        this.planning &&
        !this.fixedPlan &&
        (!this.plan.answer_from || last?.kind !== "read" || last.save_as !== this.plan.answer_from)
      ) {
        const save_as = "final_task_answer";
        this.plan.steps.push({
          kind: "read",
          finalCheck: true,
          goal: "Verify the user's whole task against visible facts and gathered evidence, then give its final answer in exactly the format the user requested. Do not claim success if conditions remain unmet.",
          open_url: "",
          use_tab: -1,
          done_when: "",
          rules: "",
          max_moves: 0,
          question: "",
          choices: [],
          texts: [],
          save_as,
        });
        this.plan.answer_from = save_as;
        this.log("plan", { plan: structuredClone(this.plan), why: "final evidence-backed answer required" });
      }
      this.notes = {};
      for (this.index = 0; this.index < this.plan.steps.length;) {
        this.check();
        const step = this.plan.steps[this.index];
        this.log("step", { index: this.index, status: "running" });
        if (step == null) throw new Error(`The plan's step ${this.index + 1} is missing.`);
        if (this.planning && ["browse", "fill", "batch"].includes(String(step.kind)) && this.writeEvidenceFirst(step))
          continue;
        // noteResolve: a step that acts on a list's notes gets the value it needs from them, not their JSON
        if (accOn("noteResolve") && this.planning && ["browse", "fill", "batch"].includes(String(step.kind)))
          await this.untilStopped(this.resolveNotes(step));
        await this.untilStopped(this.prepare(step));
        const res = await this.untilStopped(
          (["read", "look", "verify"] as unknown[]).includes(step.kind)
            ? this.read(step)
            : step.kind === "collect"
              ? this.collectCapped(step)
              : step.kind === "fill"
                ? fill.call(this, step)
                : step.kind === "batch"
                  ? this.batch(step)
                  : this.browse(step),
        );
        if (res.partial) {
          status = "partial";
          message = res.partial;
          this.log("step", { index: this.index, status: "partial" });
          break;
        }
        if ((res.replan || (res.fail && !res.terminal && this.planning)) && this.recoveries >= MAX_RECOVERIES) {
          status = "failed";
          message = `Gave up after ${MAX_RECOVERIES} new plans: ${res.why || res.fail || "the step kept failing"}`;
          this.log("step", { index: this.index, status: "failed" });
          break;
        }
        if (res.replan && !this.planning) {
          // LLM planning is off: nothing replans the user's task (the sources below don't offer it; this is the backstop)
          status = "failed";
          message = res.why || "The step could not be finished as written.";
          this.log("step", { index: this.index, status: "failed" });
          break;
        }
        if (res.replan) {
          this.recoveries++;
          const remaining = this.plan.steps.slice(this.index + 1);
          const key = (s: Step) => JSON.stringify([s.kind, s.goal, s.save_as || ""]);
          const future = new Set(remaining.map(key));
          const seen = new Set<string>();
          const repairs = res.replan.filter((s) => {
            const k = key(s);
            if (future.has(k) || seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          // a replan works on from the page the run is on: reopening the same site's home page or the same page in a new
          // tab would throw away its filters and sort (and leave the reviewer looking at a fresh page)
          const here = this.agentTabId
            ? await this.currentTab()
                .then((t) => t.info(0))
                .then((i) => i.url)
                .catch(() => "")
            : "";
          const kept = L.keepPage(repairs, here);
          if (kept.dropped.length)
            this.log("tab", { what: `stayed on the current page instead of reopening ${kept.dropped.join(", ")}` });
          const onSite = L.stayOnSite(kept.steps, this.site);
          const guarded = L.guardSteps(onSite.steps, this.trusted);
          guarded.dropped.push(...onSite.dropped);
          if (guarded.dropped.length)
            this.log("blocked", {
              what: `open ${guarded.dropped.join(", ")}`,
              reason: "a replan may only open sites the task started on or named",
            });
          this.plan.steps = L.applyReplan(this.plan.steps, this.index, guarded.steps);
          this.log("plan", { plan: structuredClone(this.plan), replanned: true, why: res.why });
          continue;
        }
        if (res.fail && !res.terminal && this.planning) {
          this.recoveries++;
          this.notes.recovery = res.fail;
          this.plan.steps = L.applyReplan(this.plan.steps, this.index, this.recoverySteps(step, res.fail));
          this.log("plan", { plan: structuredClone(this.plan), replanned: true, why: res.fail });
          continue;
        }
        if (res.fail) {
          status = "failed";
          message = res.fail;
          this.log("step", { index: this.index, status: "failed" });
          break;
        }
        this.log("step", { index: this.index, status: "done" });
        this.index++;
        this.incompleteChecks = 0; // the cap counts misses within one step's work
      }
      // the answer stays on screen for whoever checks the run: nuisance pop-ups closed, the answer scrolled into view
      if (status === "done") await this.untilStopped(this.showEvidence()).catch(() => undefined);
    } catch (e) {
      // after Stop, whatever the step was waiting for fails too (the debugger is gone): the run was still stopped
      status =
        this.stopped || e instanceof Stopped
          ? "stopped"
          : e instanceof Handover
            ? "needs_user"
            : e instanceof RunLimit || (e as { code?: unknown }).code === "run_budget_exhausted"
              ? "partial"
              : "error";
      message = this.stopped || (e as Error).message;
      if (status === "error") console.error(e);
    } finally {
      // a run that ended before its final answer (a limit, a failed or given-up step, an error) still answers the task
      // in its format, from what it collected, with the request kept back for it; a stopped run gets none
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the plan and notes are unset when the run fails in planning
      const written = this.plan?.answer_from ? this.notes?.[this.plan.answer_from]?.trim() : undefined;
      // an answer in prose when the task asked for JSON is no answer to it (WebArena 325's final read wrote "Final
      // navigation result: ... verified."): it is written again in the format, from the same evidence; a file's name
      // ("package.json") asks for no format
      const answeredInFormat = !!written && (!/(?<!\.)\bJSON\b/i.test(this.task) || L.inFormat(written, this.task));
      // a hand-over isn't the run's end: its answer says what the person is needed for. An unattended run has no one to
      // hand over to: its attempt still ends with an answer in the task's format, whose reason is the hand-over message
      if (!answeredInFormat && !this.stopped && status !== "stopped" && (status !== "needs_user" || this.unattended))
        lastAnswer = await this.untilStopped(this.terminalAnswer(status, message, written)).catch((e: unknown) => {
          this.log("final_answer", { error: (e as Error).message });
          // Stop while the answer was being written stops the run: its status says so, not the limit it ended on
          if (this.stopped || e instanceof Stopped) {
            status = "stopped";
            message = this.stopped || (e as Error).message;
          }
          return null;
        });
      // the report is taken while the debugger is still attached; a stopped run gets none
      const report =
        this.wantReport && !this.stopped && this.agentTabId
          ? await this.report(this.wantReport.expect).catch((e: unknown) => ({ error: (e as Error).message }))
          : null;
      chrome.tabs.onCreated.removeListener(this.onCreated);
      chrome.debugger.onDetach.removeListener(this.onDetach);
      for (const t of this.tabs.values()) await t.detach();
      this.endReport = report && { ...report, problems: [...this.tabs.values()].flatMap((t) => t.problems) };
      this.tick();
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- notes is unset when the run fails before its first step (in planning): the type is what the steps see
    const notes = this.notes || {};
    const answer =
      lastAnswer ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the plan is unset when the run fails before planning is done
      (this.plan?.answer_from && notes[this.plan.answer_from]) ||
      (status !== "done" ? this.partialAnswer(message) : "");
    const budget = this.runBudget.snapshot();
    const evidence = this.partialEvidence();
    this.log("finish", { status, message, answer, notes, evidence, budget, totals: { ...this.totals } });
    return {
      status,
      message,
      answer,
      notes,
      evidence,
      budget,
      totals: this.totals,
      record: this.record,
      report: this.endReport,
    };
  }

  /** The agent's tab as the run left it, and how sure Drex is that `expect` (a statement about it) holds. */
  async report(expect: string | undefined): Promise<EndScreen> {
    const tab = await this.currentTab();
    await tab.settle();
    const s = await this.look(tab);
    const info = await tab.info(6000);
    const out: EndScreen = { url: info.url, title: info.title, screenshot: s.img1 };
    if (expect) {
      const state = `A web page that a browser agent left open after the task below.\nTASK: ${this.task}\nPAGE: ${info.title} (${info.url})\nPAGE TEXT:\n${info.text}`;
      const q: Questions = {
        holds: {
          type: "noul",
          instructions: `Is this true of the page now: ${expect} Answer from Image 1, the screen now, and the page text.`,
        },
      };
      out.expect = { statement: expect, p: yes(await this.drexCall(state, q, [s.img1]), "holds") };
    }
    return out;
  }

  partialEvidence(): PartialEvidence {
    const collections = [...(this.collectionMemory ?? new Map<string, never>()).values()].map(
      (memory: Partial<CollectionMemory>) => ({
        historical: memory.epoch !== (this.collectionMutationEpoch ?? 0),
        sources: [...(memory.sources ?? new Map<string, never>())].map(([source_id, facts]) => ({
          source_id,
          facts: [...facts],
        })),
        coverageComplete: memory.coverageComplete === true,
        completedDetails: [...(memory.completedDetails ?? [])],
        // the raw public text read from each detail page (kept out of the notes the LLM sees)
        rawSources: [...(memory.raw ?? new Map<string, never>()).values()].map((r) => ({
          ...r,
          text: (r.text || "").slice(0, 20000),
        })),
        verifiedSelections: [...(memory.verifiedSelections ?? new Map<string, never>())],
        coverage: "Recorded facts and completed details do not establish complete collection coverage.",
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- notes is unset before run() starts the steps (a snapshot taken then)
    return { notes: this.notes || {}, collections };
  }

  /** The task's answer for a run that ended without its final read, written with the request run() kept back for it:
   * null when nothing was kept back (planning off, a fixed plan, limits too small) or the run's cost is uncertain. */
  async terminalAnswer(status: RunStatus, reason: string, unformatted?: string): Promise<string | null> {
    if (!this.runBudget.release()) return null;
    let page: { url: string; title: string; text: string } | null = null;
    try {
      if (this.agentTabId) {
        const info = await (await this.currentTab()).info(4000);
        page = { url: info.url, title: info.title, text: info.text };
      }
    } catch {} // the tab is gone: the answer comes from the notes alone
    const confirmed =
      accOn("answerGuard") && status === "done" && !unformatted && this.finalCheckEvidence
        ? `The run's planned final check found the task complete on the page it ended on, and wrote no answer text: ${this.finalCheckEvidence.slice(0, 1500)}. Write the final answer from that check and the notes.`
        : "";
    const ask = (why: string) =>
      this.llmCall("final_answer", () =>
        this.llm.finalAnswer({
          task: this.task,
          reason: why,
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- notes is unset when the run fails before its first step
          notes: this.notes ?? {},
          observations: this.recentObservations(8),
          page,
        }),
      );
    const r = await ask(
      confirmed ||
        (unformatted
          ? `The run's final answer is not in the format the task asks for; write it in that format: ${unformatted}`
          : `${status}: ${reason}`),
    );
    let text = (r.json.answer ?? "").trim();
    this.log("final_answer", { supported: r.json.supported, evidence: r.json.evidence, answer: text, page: page?.url });
    // answerGuard: a task that asks for JSON gets JSON: the object inside a sentence is taken as it is; prose is
    // written again once, in the format
    if (accOn("answerGuard") && text && /(?<!\.)\bJSON\b/i.test(this.task) && !L.inFormat(text, this.task)) {
      // a list of several items is never cut down to its first one; a list of one (`[{...}]`) is the object it wraps
      const inner = listOfMany(text) ? "" : L.jsonObject(text);
      if (inner && L.inFormat(inner, this.task)) text = inner;
      else {
        const fields = L.requiredFields(this.task);
        const shape = fields.length
          ? `one JSON object with exactly the fields ${fields.join(", ")}, not a list`
          : "the JSON object alone, nothing around it";
        const again = await ask(
          `Your answer was not in the format the task asks for (${shape}); write the same answer in that format: ${text.slice(0, 1500)}`,
        ).catch(() => null);
        const retried = (again?.json.answer ?? "").trim();
        // a retry that wrote the list again keeps the whole list, as before the fields were checked
        const fixed = L.inFormat(retried, this.task) || listOfMany(retried) ? retried : L.jsonObject(retried);
        // a retry that failed keeps the object found in the prose, as before the fields were checked
        if (fixed) text = fixed;
        else if (inner) text = inner;
        if (again) this.log("final_answer", { supported: again.json.supported, answer: retried, retry: "format" });
      }
    }
    return text || null;
  }

  partialAnswer(reason: string): string {
    return JSON.stringify({ complete: false, reason, observed_evidence: this.partialEvidence() });
  }

  /** Public current-run snapshot; no model call is needed to preserve facts at interruption. */
  snapshot(reason = "Run interrupted before completion"): Omit<RunResult, "report"> & { task: string } {
    this.tick();
    return {
      task: this.task,
      status: "partial",
      message: reason,
      answer: this.partialAnswer(reason),
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- notes is unset before run() starts the steps (a snapshot taken then)
      notes: this.notes || {},
      evidence: this.partialEvidence(),
      budget: this.runBudget.snapshot(),
      totals: { ...this.totals },
      record: [...this.record],
    };
  }

  // --- tabs ---------------------------------------------------------------------------------------------------------
  async windowTabs(): Promise<WindowTab[]> {
    const tabs = await chrome.tabs.query({ windowId: this.windowId });
    return tabs
      .filter((t): t is chrome.tabs.Tab & { url: string } => attachable(t.url))
      .map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
  }

  async group(tabId: number | undefined): Promise<void> {
    if (tabId === undefined) return; // Chrome rejects a tab without an id (the catch below ignored that)
    try {
      if (this.groupId == null) {
        const groupId = (this.groupId = await tabsCall(() =>
          chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: this.windowId } }),
        ));
        await tabsCall(() => chrome.tabGroups.update(groupId, { title: "Drex", color: "blue" }));
      } else {
        await tabsCall(() => chrome.tabs.group({ tabIds: [tabId], groupId: this.groupId }));
      }
    } catch {}
  }

  /** A background tab of the agent's own, in its "Drex" tab group, for reading one detail page of a list. */
  async openDetailTab(url: string): Promise<chrome.tabs.Tab & { id: number }> {
    webOnly(url);
    const t = await tabsCall(() => chrome.tabs.create({ windowId: this.windowId, url, active: false }));
    await this.group(t.id);
    if (!hasId(t)) throw new Error("Chrome gave the detail tab no id.");
    return t;
  }

  async openOwnTab(url: string): Promise<void> {
    webOnly(url);
    let from: string | undefined; // the page the agent's own tab showed before this one
    // the page the agent was on, own tab or the user's: whether the new page is a working copy of its logical tab
    const fromTab = this.agentTabId ? await chrome.tabs.get(this.agentTabId).catch(() => null) : null;
    if (this.agentTabId && this.ownTab) {
      const current = fromTab;
      from = current?.url;
      if (current?.url && new URL(current.url).href === new URL(url).href) {
        this.afterShot = null;
        this.log("tab", { what: "continued current page; redundant navigation skipped" });
        return;
      }
    }
    this.afterShot = null;
    const fromTabId = this.agentTabId;
    if (this.agentTabId && this.ownTab) {
      await tabsCall(() =>
        chrome.tabs.update(this.agentTabId ?? undefined, { url, ...(this.background ? {} : { active: true }) }),
      );
      this.bindOwnTab(this.agentTabId, url, fromTab?.url);
    } else {
      const t = await tabsCall(() => chrome.tabs.create({ windowId: this.windowId, url, active: !this.background }));
      this.agentTabId = t.id;
      this.ownTab = true;
      if (t.id != null) this.bindOwnTab(t.id, url, fromTab?.url);
      await this.group(t.id);
    }
    this.observations.push({
      action: "navigation boundary",
      before: { tabId: fromTabId },
      after: { tabId: this.agentTabId, url },
      note: "A document navigation occurred. Earlier editable values and selections are historical, not the current state. Check fresh page evidence before any commit.",
    });
    if (this.observations.length > 24) this.observations.shift();
    this.landing =
      this.namedUrls.has(url) && this.agentTabId != null
        ? { tabId: this.agentTabId, origin: L.originOf(url), from }
        : null;
    this.log("tab", { what: `opened ${L.host(url)}` });
  }

  /** The logical tab the agent's own tab stands for once it shows url, coming from the page fromUrl: on that page's site
   * it is a working copy of the plan's current tab and takes its index (a shop's search opened beside the user's shop);
   * on another site it is a logical tab of its own, and a user's tab keeps its index. Taking the index for any page sent
   * the steps that name the user's notes tab (use_tab 0) to the agent's Wikipedia tab. */
  bindOwnTab(tabId: number, url: string, fromUrl: string | undefined): void {
    const k = this.activePlanTab;
    if (k === null || !Number.isInteger(k) || k < 0) return; // no logical tab in play
    const site = L.originOf(url);
    if ((site && site === L.originOf(fromUrl ?? "")) || k >= this.startTabs.length) {
      this.tabBindings.set(k, tabId); // a working copy of the plan's tab, or the agent's own logical tab going on
      return;
    }
    const user = this.startTabs[k]?.id;
    if (user != null) this.tabBindings.set(k, user); // the user's tab, if a working copy of it had taken its index
    const index = Math.max(-1, ...this.tabBindings.keys()) + 1;
    this.tabBindings.set(index, tabId);
    this.activePlanTab = index;
  }

  /** A URL of the first plan (made from the task alone) that sends its tab on to another site by itself names that
   * site in effect: https://sheets.new opens docs.google.com. That site is trusted too, or the notes the run gathered
   * for it are withheld there (the sheet could never get its table). Only the first site the tab reaches before any
   * move of the agent's: a site a click leads to, or a later redirect, earns nothing. */
  trustLanding(tabId: number, url: string): void {
    const landing = this.landing;
    if (landing?.tabId !== tabId || url === landing.from) return; // a reused tab shows its old page until it commits
    const origin = L.originOf(url);
    if (!origin || origin === landing.origin) return; // still loading (about:blank) or still on the named site
    this.landing = null;
    if (this.trusted.has(origin)) return;
    this.trusted.add(origin);
    this.log("tab", { what: `trusted ${L.host(url)}: the planned ${L.host(landing.origin)} sent the tab there` });
  }

  /** The noteResolve accuracy switch: a step that uses a list reading's notes (their JSON of matches) gets, from one
   * small LLM call, the text it needs from them (the item's exact name), filled into its texts and named in its goal.
   * The step itself still runs as planned, through Drex's moves; a note with no usable value is never typed. */
  async resolveNotes(step: Step): Promise<void> {
    const names = L.collectionNoteRefs(step, this.notes);
    if (!names.length) return;
    const key = JSON.stringify([step.goal, names, names.map((n) => this.notes[n])]);
    let resolved = this.noteResolutions?.get(key);
    if (!resolved) {
      const r = await this.llmCall("resolve", () =>
        this.llm.resolveNote({
          task: this.task,
          step: { kind: step.kind, goal: step.goal, done_when: step.done_when, rules: step.rules, texts: step.texts },
          notes: Object.fromEntries(names.map((n) => [n, L.collectionNote(this.notes[n])])),
        }),
      );
      resolved = { why: r.json.why ?? "", value: (r.json.value ?? "").trim() };
      this.noteResolutions?.set(key, resolved);
    }
    const filled = L.withNoteValue(step, names, resolved.value);
    Object.assign(step, filled);
    for (const n of names) if (resolved.value) this.notes[`${n}_value`] = resolved.value;
    this.log("note_resolved", { names, value: resolved.value, why: resolved.why, goal: step.goal });
  }

  /** A step that would type a collect step's evidence (its JSON) gets a read step before it that writes that data in
   * the form the step types it, and types that instead: a plan that typed {{listings}} into a sheet put 4,035
   * characters of JSON at A1. True when the read step was added (it runs first). */
  writeEvidenceFirst(step: Step): boolean {
    const names = L.typedEvidenceNotes(step, this.notes);
    if (!names.length) return false;
    const save_as = `${names.join("_")}_text`;
    const written: Step = {
      kind: "read",
      goal: `Write the records gathered in the notes ${names.join(", ")} as the exact text the next step types (next step: ${step.goal}). A table or spreadsheet: tab-separated rows, the header row first, one row per record. Only that text.`,
      open_url: "",
      use_tab: -1,
      done_when: "",
      rules: "",
      max_moves: 0,
      question: "",
      choices: [],
      texts: [],
      save_as,
    };
    const typing = {
      ...step,
      texts: (step.texts ?? []).map((t) => ({
        ...t,
        text: names.reduce(
          (s, n) => s.replace(new RegExp(`\\{\\{\\s*${n.replace(/[^\w-]/g, "")}\\s*\\}\\}`, "g"), `{{${save_as}}}`),
          t.text,
        ),
      })),
    };
    this.plan.steps.splice(this.index, 1, written, typing);
    this.log("plan", {
      plan: structuredClone(this.plan),
      replanned: true,
      why: `The next step types the gathered records (${names.join(", ")}): they are written out first.`,
    });
    return true;
  }

  async prepare(step: { use_tab?: unknown; open_url?: string }): Promise<void> {
    // Planner references are logical indices, never arbitrary browser tab IDs.
    // Unknown or stale references preserve the current working context.
    const rawTab = step.use_tab;
    const logicalTab =
      typeof rawTab === "number"
        ? rawTab
        : typeof rawTab === "string" && /^-?\d+$/.test(rawTab.trim())
          ? Number(rawTab)
          : -1;
    if (Number.isInteger(logicalTab) && logicalTab >= 0) {
      const bound = this.tabBindings.get(logicalTab) ?? this.startTabs[logicalTab]?.id;
      // the tests' fake tabs have no window
      const info: { url?: string; windowId?: number } | null =
        bound == null ? null : await chrome.tabs.get(bound).catch(() => null);
      if (info && attachable(info.url) && (info.windowId == null || info.windowId === this.windowId)) {
        if (this.agentTabId !== bound) this.afterShot = null;
        this.agentTabId = bound;
        this.activePlanTab = logicalTab;
        this.ownTab = !this.startTabs.some((t) => t.id === bound);
      } else {
        this.log("tab", { what: "invalid or closed logical tab; continuing current tab", requested: logicalTab });
      }
    }
    if (step.open_url) {
      await this.openOwnTab(step.open_url);
      await this.awaitLanding();
    }
    if (!this.agentTabId) await this.openOwnTab(START_PAGE);
    const tab = await this.currentTab();
    await tab.settle();
  }

  /** A first-plan URL just opened: wait (LANDING_WAIT_MS at most) until its tab has left about:blank and either
   * finished loading on that site or gone on to another (trustLanding). Settling alone ended on about:blank while
   * https://sheets.new was still on its way to docs.google.com, and the first move then made the redirect a move's. */
  async awaitLanding(): Promise<void> {
    const until = performance.now() + LANDING_WAIT_MS;
    while (this.landing && performance.now() < until) {
      const { tabId, origin, from } = this.landing;
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (!t) return;
      const url = t.url ?? "";
      const here = L.originOf(url);
      // still on its way while a navigation is pending or a reused tab shows its old page (Sony's store, then sheets.new)
      if (!t.pendingUrl && url !== from) {
        if (here && here !== origin) {
          this.trustLanding(tabId, url);
          return;
        }
        if (here === origin && t.status === "complete") return; // no redirect (a later one by the page still counts)
      }
      await sleep(250);
    }
  }

  /** The agent's tab, in front and with the debugger attached. Follows a tab that the last click opened. */
  async currentTab(): Promise<Tab> {
    let followedFrom: number | null | undefined = null; // the tab before a new one the last click opened
    if (this.newTabId) {
      followedFrom = this.agentTabId;
      this.afterShot = null;
      const id = this.newTabId;
      this.newTabId = null;
      this.agentTabId = id;
      if (this.activePlanTab !== null && Number.isInteger(this.activePlanTab) && this.activePlanTab >= 0)
        this.tabBindings.set(this.activePlanTab, id);
      this.ownTab = true;
      await this.group(id);
      this.log("tab", { what: "followed the new tab the click opened" });
    }
    if (this.agentTabId == null) throw new Error("The agent has no tab."); // Chrome's tabs.get() threw a TypeError for it
    const info = await chrome.tabs.get(this.agentTabId).catch(() => null);
    if (!info) throw new Error("The agent's tab was closed.");
    if (!info.active && !this.background)
      await tabsCall(() => chrome.tabs.update(this.agentTabId ?? undefined, { active: true }));
    if (!attachable(info.url) && info.status === "complete") {
      // a click that opened a tab with nothing in it (a blank target, a download, a blocked pop-up): close it and go on
      // in the tab the click was made in (otherwise the run ended on "The agent can't work on .")
      if (followedFrom != null && (!info.url || info.url === "about:blank")) {
        // window.open() and then setting its address: the tab is blank and loaded for a moment before its page starts
        await sleep(BLANK_GRACE_MS);
        const later = await chrome.tabs.get(this.agentTabId).catch(() => null);
        // its address shows only once the page answers; until then it is pending and the tab is loading
        if ((later?.url && later.url !== "about:blank") || later?.pendingUrl || later?.status === "loading")
          return this.currentTab();
        await chrome.tabs.remove(this.agentTabId).catch(() => undefined);
        this.agentTabId = followedFrom;
        this.ownTab = !this.startTabs.some((t) => t.id === followedFrom);
        if (this.activePlanTab !== null && Number.isInteger(this.activePlanTab) && this.activePlanTab >= 0)
          this.tabBindings.set(this.activePlanTab, followedFrom);
        this.log("tab", { what: "closed the blank tab the click opened; back to the tab it was made in" });
        return this.currentTab();
      }
      throw new Error(`The agent can't work on ${info.url}.`);
    }
    let tab = this.tabs.get(this.agentTabId);
    if (!tab) {
      tab = new Tab(this.agentTabId);
      tab.signal = this.abort.signal;
      tab.overlay = this.cursor;
      tab.diagnostics = !!this.wantReport;
      await tab.attach({ background: this.background });
      this.tabs.set(this.agentTabId, tab);
    }
    return tab;
  }

  async logicalTabs(): Promise<
    ({ index: number; title: string | undefined; url: string; current: boolean } | { index: number; closed: boolean })[]
  > {
    const visible = await this.windowTabs();
    return [...this.tabBindings].map(([index, id]) => {
      const tab = visible.find((t) => t.id === id);
      return tab ? { index, title: tab.title, url: tab.url, current: id === this.agentTabId } : { index, closed: true };
    });
  }

  /** Chrome didn't paint the background tab: bring the agent's tab to the front for the rest of the run. */
  async toFront(tab: Tab, why: string): Promise<void> {
    this.background = false;
    await tab.setBackground(false);
    await tabsCall(() => chrome.tabs.update(tab.id, { active: true }));
    this.log("tab", { what: `brought the agent's tab to the front (${why})` });
    await sleep(400);
  }

  // --- model calls --------------------------------------------------------------------------------------------------
  async llmCall<T extends Accounted>(purpose: string, fn: () => Promise<T>): Promise<T> {
    this.check();
    if (purpose === "collect" && this.collectCalls !== null && ++this.collectCalls > MAX_COLLECT_CALLS)
      throw new ReadCap(`The collect step used its ${MAX_COLLECT_CALLS} model reads.`);
    this.emit("busy", { who: "llm", purpose });
    const account = (r: Accounted) => {
      const knownCost = typeof r.usd === "number" && Number.isFinite(r.usd);
      // when a later attempt's cost is unknown, the earlier attempts' known cost still counts
      const known = knownCost ? r.usd : Number.isFinite(r.knownCostUsd) ? (r.knownCostUsd as number) : 0;
      this.totals.llmUsd += known;
      this.totals.llmCalls += r.physicalCalls ?? 1;
      this.log("llm", {
        purpose,
        ms: Math.round(r.ms ?? 0),
        usd: knownCost ? r.usd : null,
        knownUsd: known,
        model: r.model,
        tokens: r.usage,
        ...(r.trace ? { trace: r.trace } : {}),
        ...(r.unreadable ? { unreadable_retries: r.unreadable, unreadable_causes: r.unreadableCauses } : {}),
      });
      this.tick();
    };
    try {
      const r = await fn();
      account(r);
      return r;
    } catch (error) {
      if (((error as Accounted).physicalCalls ?? 0) > 0) account(error as Accounted);
      // the error beneath an SDK wrapper, in the run's record (the message alone often names only the wrapper)
      this.log("llm_error", { purpose, error: describeError(error) });
      throw error;
    }
  }

  async drexCall(state: string, questions: Questions, images: string[]): Promise<DrexReply> {
    this.check();
    this.emit("busy", { who: "drex" });
    const account = (r: Accounted) => {
      const knownCost = typeof r.usd === "number" && Number.isFinite(r.usd);
      if (knownCost) this.totals.drexUsd += r.usd;
      this.totals.drexCalls += r.physicalCalls ?? 1;
      this.log("drex", {
        ms: Math.round(r.ms ?? 0),
        usd: knownCost ? r.usd : null,
        tokens: r.usage,
        ...(costOn("trace")
          ? {
              trace: {
                state: state.length,
                questions: JSON.stringify(questions).length,
                options: Object.values(questions).reduce(
                  (n, q) => n + ("criteria" in q ? Object.keys(q.criteria).length : 0),
                  0,
                ),
                images: images.length,
                ...(costOn("dump") ? { dump: { state, questions } } : {}),
              },
            }
          : {}),
      });
      this.tick();
    };
    try {
      const r = await this.drex.ask(state, questions, images);
      account(r);
      return r;
    } catch (error) {
      if (((error as Accounted).physicalCalls ?? 0) > 0) account(error as Accounted);
      throw error;
    }
  }

  /** The last moves as an LLM check reads them. With the obsLite cost switch the last OBS_LITE moves, each with fewer
   * controls and less page text: the screen itself is in the request. */
  recentObservations(n: number): Record<string, unknown>[] {
    if (!costOn("obsLite")) return this.observations.slice(-n);
    const side = (s: unknown): unknown => {
      if (!s || typeof s !== "object") return s;
      const o = s as { controls?: unknown[]; text?: unknown };
      return {
        ...o,
        ...(Array.isArray(o.controls) ? { controls: o.controls.slice(0, OBS_LITE_CONTROLS) } : {}),
        ...(typeof o.text === "string" ? { text: o.text.slice(0, OBS_LITE_TEXT) } : {}),
      };
    };
    return this.observations
      .slice(-Math.min(n, OBS_LITE))
      .map((o) => ({ ...o, before: side(o.before), after: side(o.after) }));
  }

  // --- reading the screen -------------------------------------------------------------------------------------------
  /** A screenshot of the agent's tab; in the background, a timeout means Chrome isn't painting it, so it comes to the
   * front once and stays there. */
  async capture(tab: Tab): Promise<string> {
    try {
      return await tab.screenshot();
    } catch (e) {
      if (!this.background || !(e as Error).message.includes("timed out")) throw e;
      await this.toFront(tab, "Chrome did not paint it in the background");
      return await tab.screenshot();
    }
  }

  async look(tab: Tab): Promise<Looked> {
    for (let attempt = 0; ; attempt++) {
      try {
        // the screenshot and elements read right after the last move (they decided whether it changed anything) are
        // the screen now: no second read of the page
        const reuse = this.afterShot?.tabId === tab.id ? this.afterShot : null;
        this.afterShot = null;
        const { els, off, vp } = reuse?.elements ?? (await tab.elements());
        const [title, url] = (await tab.eval("[document.title, location.href]")) as [string, string];
        this.trustLanding(tab.id, url);
        const jpeg = reuse ? reuse.jpeg : await this.capture(tab);
        const shot = await toShot(jpeg, vp);
        const marked = drawMarks(shot, els);
        const img1 = await dataUrl(shot);
        this.emit("screen", { image: img1, url, title, tabId: tab.id });
        // the tagged screen, small, for the run log: what each decision was made on
        return {
          els,
          off,
          vp,
          info: { title, url },
          shot,
          img1,
          img2: await dataUrl(marked),
          jpeg,
          thumb: await thumb(marked),
        };
      } catch (e) {
        if (attempt >= 3) throw e; // mid-navigation: the page's context went away; try again in a moment
        this.afterShot = null;
        await sleep(600);
      }
    }
  }

  // --- steps --------------------------------------------------------------------------------------------------------
  recoverySteps(step: Step, evidence: string | undefined): Step[] {
    const originalGoal = (step.recoveryGoal || step.goal || "").slice(0, 1500);
    const inspection = {
      ...step,
      recoveryGoal: originalGoal,
      recoveryInspection: true,
      kind: "browse",
      open_url: "",
      use_tab: -1,
      save_as: "",
      max_moves: 12,
      goal: `Find an alternative supported way to complete this step: ${originalGoal}. Current obstacle: ${String(evidence).slice(0, 2000)}. Inspect public controls, search, manual inputs or enumerate/filter records manually. Missing exact filter options are not missing user decisions. Preserve the original constraints; do not substitute an unrequested result or repeat confirmed mutations.`,
      done_when: "The missing evidence or prerequisite is available for rechecking",
      question: "",
      choices: [],
    };
    return step.recoveryInspection ? [inspection] : [inspection, { ...step, open_url: "", use_tab: -1 }];
  }

  repeatedObjection(step: Step, evidence: string | undefined): boolean {
    const key = JSON.stringify([
      step.recoveryGoal || step.goal,
      String(evidence).toLowerCase().replace(/\s+/g, " ").trim(),
    ]);
    const count = (this.objections.get(key) ?? 0) + 1;
    this.objections.set(key, count);
    return count === 2;
  }

  /** requeue: the step to run again when the answer is missing (collect and fill end in a verify read of their own,
   * but it's the macro that has to run again, not just its check). */
  async read(step: Step, { requeue = step }: { requeue?: Step } = {}): Promise<Outcome> {
    const tab = await this.currentTab();
    const scr = await this.look(tab);
    const info = await tab.info(60000);
    const purpose = step.kind === "look" || step.kind === "verify" ? step.kind : "read";
    const focus = scr.shot ? await focusedEvidence(scr.shot, scr.els) : null;
    const logicalTabs = await this.logicalTabs();
    const finalRead = step.kind === "read" && !!step.save_as && step.save_as === this.plan.answer_from;
    // the verifyDrex cost switch: a planned check of the page is asked of Drex first (yes/no from the page's text);
    // only a check Drex isn't sure passes goes to the LLM
    if (costOn("verifyDrex") && step.kind === "verify" && !step.finalCheck && requeue === step) {
      const state = `A web page in the user's browser, checked against one step of the task below.\nTASK: ${movesTask(this.task)}\nPAGE: ${info.title} (${info.url})\nPAGE TEXT:\n${info.text.slice(0, VERIFY_TEXT)}`;
      const claim = `${step.goal}${step.done_when ? ` (${step.done_when})` : ""}`;
      const q: Questions = {
        holds: {
          type: "noul",
          instructions: `Is this true of the page now, from its text: ${claim}`,
        },
      };
      const p = yes(await this.drexCall(state, q, drexImages(this.task, scr, scr.img1)), "holds") ?? 0;
      this.log("verification", { purpose: "drex_check", complete: p >= VERIFY_SURE, p: +p.toFixed(3), page: info.url });
      if (p >= VERIFY_SURE) {
        this.incompleteChecks = 0;
        const name = step.save_as || `note${this.index + 1}`;
        this.notes[name] = `Checked on ${info.url}: ${claim} (holds)`;
        this.log("note", { name, text: this.notes[name], page: info.url });
        return {};
      }
    }
    const r = await this.llmCall(purpose, () =>
      this.llm.read({
        task: this.task,
        planText: L.planLines(this.plan, this.index),
        step,
        notes: this.notes,
        info,
        image: scr.img1,
        candidates: candidatesOf(scr.els),
        purpose,
        observations: this.recentObservations(12),
        focus,
        logicalTabs,
        finalRead,
      }),
    );
    const d = r.json;
    this.log("verification", { purpose, complete: d.complete, evidence: d.evidence, page: info.url });
    if (!d.complete && step.finalCheck) {
      // the run's added final check: the task's steps are done (maybe a message was sent or an order placed), so a
      // missing confirmation is reported with the answer, never a reason to go back and act again
      const name = step.save_as || `note${this.index + 1}`;
      const text = need(d.text, "The read's text").trim();
      // an answer written in a structured format the task asked for (JSON) stays parseable: the caveat goes beside it
      if (structured(text)) {
        this.notes[name] = text;
        this.notes[`${name}_unconfirmed`] = `Not confirmed on screen: ${d.evidence}`;
      } else this.notes[name] = `${text ? `${text}\n` : ""}Not confirmed on screen: ${d.evidence}`;
      this.log("note", { name, text: this.notes[name], page: info.url });
      return {};
    }
    if (!d.complete && !this.planning) return { fail: `Could not find what the task needs: ${d.evidence}` };
    if (!d.complete) {
      // a read that keeps finding its answer missing ends the run instead of re-queuing itself forever
      if (++this.incompleteChecks >= MAX_INCOMPLETE_CHECKS) {
        // a collection that gathered its records goes on with them, the check's objection kept for the final answer:
        // it kept asking for what the list doesn't show (each listing's hot tub, a town's borough), which another pass
        // over the same list can't give, and the run ended before writing what it had found
        const gathered = requeue.kind === "collect" ? requeue.save_as || `collection${this.index + 1}` : "";
        if (gathered && this.notes[gathered]) {
          this.incompleteChecks = 0;
          this.notes[`${gathered}_unverified`] = `Not confirmed after ${MAX_INCOMPLETE_CHECKS} checks: ${d.evidence}`;
          this.log("note", {
            name: `${gathered}_unverified`,
            text: this.notes[`${gathered}_unverified`],
            page: info.url,
          });
          return {};
        }
        return {
          fail: `Could not find what step ${this.index + 1} needs after ${MAX_INCOMPLETE_CHECKS} checks: ${d.evidence}`,
          terminal: true,
        };
      }
      if (this.repeatedObjection(requeue, d.evidence))
        return { replan: this.recoverySteps(requeue, d.evidence), why: d.evidence };
      // a check repairs its own target only: a step opening what a later step opens is that step brought forward
      // without what it types (the Tahoe rerun's repairs opened sheets.new ahead of the step that writes the table)
      const later = new Set(this.plan.steps.slice(this.index + 1).map((s) => s.open_url));
      const next = need(d.next_steps, "The read's next steps").filter((s) => !s.open_url || !later.has(s.open_url));
      if (!next.length) return { replan: this.recoverySteps(requeue, d.evidence), why: d.evidence };
      // A navigation correction must not silently replace the answer-producing step.
      const continuation = [...next];
      if (!continuation.some((s) => s.kind === requeue.kind && s.save_as === requeue.save_as)) {
        continuation.push({ ...requeue, open_url: "", use_tab: -1 });
      }
      return { replan: continuation, why: d.evidence };
    }
    this.incompleteChecks = 0;
    const name = step.save_as || `note${this.index + 1}`;
    this.notes[name] = need(d.text, "The read's text").trim();
    // answerGuard: a final read that found the task complete but wrote no answer: the run's final answer is written
    // from its verdict (terminalAnswer), not judged again from the notes alone
    if (accOn("answerGuard") && finalRead && !this.notes[name]) this.finalCheckEvidence = d.evidence || "complete";
    this.log("note", { name, text: this.notes[name], page: info.url });
    return {};
  }

  async verifyStep(step: Step, scr: Looked): Promise<Outcome> {
    const tab = await this.currentTab();
    const info = await tab.info(60000);
    const focus = scr.shot ? await focusedEvidence(scr.shot, scr.els) : null;
    const logicalTabs = await this.logicalTabs();
    const r = await this.llmCall("verify", () =>
      this.llm.read({
        task: this.task,
        planText: L.planLines(this.plan, this.index),
        step: {
          ...step,
          goal: `Verify this step only: ${step.goal}. Required evidence: ${step.done_when || step.goal}`,
        },
        notes: this.notes,
        info,
        image: scr.img1,
        purpose: "verify",
        candidates: candidatesOf(scr.els),
        observations: this.recentObservations(12),
        focus,
        logicalTabs,
      }),
    );
    this.log("verification", {
      purpose: "step_done",
      complete: r.json.complete,
      evidence: r.json.evidence,
      page: info.url,
    });
    if (r.json.complete) {
      this.incompleteChecks = 0;
      this.notes[`evidence${this.index + 1}`] = r.json.evidence;
      return {};
    }
    // every miss counts, a rejection too: Drex saying "step done" on every move would otherwise cost a check per move
    if (++this.incompleteChecks >= MAX_INCOMPLETE_CHECKS) {
      return {
        fail: `Step ${this.index + 1} still isn't done after ${MAX_INCOMPLETE_CHECKS} checks: ${r.json.evidence}`,
        terminal: true,
      };
    }
    if (this.planning && this.repeatedObjection(step, r.json.evidence)) {
      return {
        rejected:
          String(r.json.evidence) +
          " This same objection was already observed: inspect an alternative supported route or fresh outcome evidence; do not repeat a confirmed mutation.",
      };
    }
    // with LLM planning off nothing replans: a failed check only sends Drex back to work
    const next = need(r.json.next_steps, "The check's next steps");
    if (next.length && this.planning) return { replan: next, why: r.json.evidence };
    return { rejected: r.json.evidence };
  }

  async browse(step: Step): Promise<Outcome> {
    const added: { name: string; text: string; origin: string | undefined }[] = []; // texts the LLM typed in this step: Drex can reuse them
    const history: HistoryEntry[] = [];
    let rescues = 0;
    let budget = L.moveBudget(step);
    // no plan: Drex may hand anything to the LLM, so its asks are bounded only by the step's moves
    const maxRescues = this.planning ? L.rescueBudget(budget) : Infinity;
    let extended = false;
    const paused = new Map<string, number>(); // move -> the move number its pause ends at
    let loop: { moves: string[] } | null = null; // the circle Drex is told about while its moves are paused
    let loops = 0;
    // Drex stuck in this step: a run of scrolls, or a repeat of a move that changed nothing, each counted on its own (a
    // scroll run and an unrelated dead move are not the same loop twice). The first time the helper takes the move (and
    // may replan the step); with a plan, the second time of the same kind ends the step, and the run's recovery
    // replans it.
    let scrollRounds = 0;
    let deadRounds = 0;
    const stuckFail = (what: string): Outcome => ({
      fail: `The step "${step.goal}" got stuck twice: ${what}. Use another way to the goal (the site's search, filters, sort, menu or the right tab).`,
    });
    let committed = false as boolean; // a risky move (send, pay, delete...) went through: the LLM checks its result at "step done"
    const checked = new Set<string>(); // irreversible clicks the LLM already found right for the task (no plan)
    // what a move's outcome means for the step: a replan or a failure ends it, an already-made move that checks out
    // finishes it, anything else goes on
    const outcome = (out: Outcome | undefined): Outcome | null => {
      if (out?.replan || out?.fail) return out;
      if (out?.stepDone) return {};
      if (out?.risky && !this.batchApproved) committed = true; // a bulk action you approved has its own checks
      return null;
    };
    const help = async (...args: Parameters<Agent["rescue"]>) => {
      const h = await this.rescue(...args);
      if (h.learned && !added.some((t) => t.text === h.learned))
        added.push({ name: `typed${added.length + 1}`, text: h.learned, origin: h.origin });
      // with a plan, the helper's "step done" ends the step as Drex's own does: after a move that can't be undone
      // (send, pay, delete...) only once the LLM's check of the step's result agrees
      if (h.done && this.planning && committed) {
        const verified = await this.verifyStep(step, args[2]);
        if (verified.replan || verified.fail)
          return { replan: verified.replan, why: verified.why, fail: verified.fail, terminal: verified.terminal };
        if (verified.rejected) {
          this.notes[`incomplete${this.index + 1}`] = verified.rejected;
          history.push({ what: `completion rejected: ${verified.rejected}`, changed: false });
          return {};
        }
      }
      return h;
    };
    for (let n = 0; ; n++) {
      this.check();
      const tab = await this.currentTab();
      const scr = await this.look(tab);
      const otherTabs = (await this.windowTabs()).filter((t) => t.id !== this.agentTabId);
      // texts that carry notes ({{name}}), and the notes themselves in the state the helper writes from, are offered only
      // on sites the task started on or named; a text the helper typed is offered again on its own site, or across
      // trusted sites when it was typed on one
      const here = L.originOf(scr.info.url);
      const trustedHere = this.trusted.has(here);
      const texts = [
        ...L.resolveTexts(step.texts, this.notes, trustedHere),
        ...added
          .filter((t) => t.origin === here || (trustedHere && this.trusted.has(t.origin ?? "")))
          .map(({ name, text }) => ({ name, text })),
      ];

      // a circle of moves (open a picker, close it, open it again): pause those moves, tell Drex, and hand the next
      // move to the LLM (the one case where the harness calls it without Drex asking; it doesn't use up the help)
      const found = L.findLoop(history);
      if (found) {
        loops++;
        loop = found;
        for (const w of found.moves) paused.set(w, n + PAUSE_MOVES);
        history.push({ marker: true });
        this.log("loop", { moves: found.moves, round: loops });
      }
      for (const [w, until] of paused) if (n >= until) paused.delete(w);
      if (!paused.size) loop = null;
      const { opts, acts } = L.withoutMoves(
        L.buildOptions({
          els: scr.els,
          off: scr.off,
          texts,
          tabs: otherTabs,
          direct: !this.planning,
          sliderValues: [...this.task.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0])),
        }),
        new Set(paused.keys()),
      );
      const stateKey = L.stableState(scr.info, scr.els);
      this.visits.set(stateKey, (this.visits.get(stateKey) ?? 0) + 1);
      const images = drexImages(this.task, scr, scr.img1, scr.img2);
      const remembered = [...(this.actionMemory.get(stateKey) ?? [])]
        .slice(-6)
        .map(([what, count]) => `${what} (${count} times)`);
      const state =
        L.stateText({
          task: movesTask(this.task),
          plan: this.plan,
          index: this.index,
          texts,
          history,
          info: scr.info,
          tagged: scr.els.length,
          moves: n,
          budget,
          site: siteFor(SITES, scr.info.url),
          step,
          loop,
          textOnly: !images.length,
        }) +
        `\nNOTES SO FAR:\n${trustedHere ? L.notesSummary(this.notes) : "(not shown on this site)"}\nTHIS SCREEN SEEN ${this.visits.get(stateKey)} TIMES. MOVES MADE HERE BEFORE: ${remembered.join("; ") || "none"}.`;

      if (found) {
        const h = await help(
          `Drex went round in a circle of moves (${found.moves.join(" -> ")}) and came back to where it started; those moves are paused. ${this.planning ? "If this step's goal is already true, or cannot be reached from this page (it belongs to a later page, like checkout), choose replan and give steps that fit what is on screen; else choose" : "Choose"} the move that gets out of the circle.`,
          state,
          scr,
          opts,
          acts,
          texts,
        );
        if (h.replan || h.fail) return h;
        if (h.done) return this.finished(h.done);
        if (h.ask) {
          await this.askUser(h.ask);
          history.push({ what: "handed the screen to the user", changed: true });
        } else if (h.act) {
          const end = outcome(await this.act(tab, h.act, h.text, scr, history, "llm", 1, h.why, { step }));
          if (end) return end;
        }
        continue;
      }

      if (L.scrollRun(history) >= L.SCROLL_RUN) {
        history.push({ marker: true });
        this.log("loop", { moves: ["scrolled"], round: ++scrollRounds, kind: "scroll" });
        // with no plan there is no replan to end the step for: the helper takes a move each time
        if (this.planning && scrollRounds >= 2)
          return stuckFail(`Drex scrolled ${L.SCROLL_RUN} times in a row without acting, again`);
        const h = await help(
          `Drex scrolled ${L.SCROLL_RUN} times in a row without acting on anything. ${this.planning ? "If what this step needs is not on this page or can't be found by scrolling, choose replan with steps that use the site's search, filters, sort, menu or the right tab; else choose" : "Choose"} the move that acts on what is on screen.`,
          state,
          scr,
          opts,
          acts,
          texts,
        );
        if (h.replan || h.fail) return h;
        if (h.done) return this.finished(h.done);
        if (h.ask) {
          await this.askUser(h.ask);
          history.push({ what: "handed the screen to the user", changed: true });
        } else if (h.act) {
          const end = outcome(await this.act(tab, h.act, h.text, scr, history, "llm", 1, h.why, { step }));
          if (end) return end;
        }
        continue;
      }

      if (n >= budget) {
        // out of moves: the LLM decides whether to keep going (once), replan, ask the user or give up
        const h = await help(
          `Drex has used ${n} moves on this step without finishing it.`,
          state,
          scr,
          opts,
          acts,
          texts,
        );
        if (h.replan || h.fail) return h;
        if (h.done) return this.finished(h.done);
        if (h.ask) await this.askUser(h.ask);
        if (extended || !h.act)
          return { fail: `The step "${step.goal}" did not finish in ${n} moves.`, terminal: true };
        extended = true;
        budget += EXTRA_MOVES;
        const end = outcome(await this.act(tab, h.act, h.text, scr, history, "llm", 1, h.why, { step }));
        if (end) return end;
        continue;
      }

      const qs: Questions = {
        move: {
          type: "choice",
          instructions: this.planning ? L.MOVE_Q : L.MOVE_Q_DIRECT,
          criteria: moveOptions(opts),
        },
      };
      if (step.done_when)
        qs.done = {
          type: "noul",
          instructions: `${step.done_when} ${images.length ? "Answer from Image 1, the screen now." : "Answer from the page as it is now."}`,
        };
      const r = await this.drexCall(state, qs, images);
      const { choice, p, probs } = pick(r, "move");
      const doneP = qs.done ? yes(r, "done") : choice === "step done" ? p : 0;
      const top = Object.entries(probs)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => [k, +v.toFixed(3)]);
      this.totals.drexMoves++;
      const last = history.at(-1);
      const afterReveal = !!last && !last.marker && !!last.revealOnly;
      if (L.isStepDone(Number(doneP), choice, Number(p), !this.planning, afterReveal)) {
        // after a move that can't be undone (send, pay, delete...), the LLM checks that it took effect; a step of
        // ordinary moves ends on Drex's word, as it always did
        if (committed) {
          const verified = await this.verifyStep(step, scr);
          if (verified.replan || verified.fail) return verified;
          if (verified.rejected) {
            this.notes[`incomplete${this.index + 1}`] = verified.rejected;
            history.push({ what: `completion rejected: ${verified.rejected}`, changed: false });
            continue;
          }
        }
        this.log("move", {
          who: "drex",
          what: "the step is done",
          p: +need(doneP, "Drex's done probability").toFixed(3),
          ms: Math.round(r.ms),
          usd: r.usd,
          top,
          shot: scr.thumb,
        });
        this.tick();
        return {};
      }

      // Drex decides when the LLM helps: only its own "ask for help" move hands the move over. A low top probability
      // is not a reason (it is usually a tie between equally good options: five restaurants, a list of rows).
      const ranked = Object.entries(probs)
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => k);
      if (acts[String(choice)]?.kind === "look") {
        const h = await help(
          "Inspect the visual information needed for this step: count, color, spatial relationship or untagged target. Use the screenshot. Explain evidence and choose the next actual move, or replan a look/fill step if several values are needed.",
          state,
          scr,
          opts,
          acts,
          texts,
        );
        if (h.replan || h.fail) return h;
        if (h.ask) {
          await this.askUser(h.ask);
          history.push({ what: "handed the screen to the user", changed: true });
        } else if (h.act) {
          const end = outcome(await this.act(tab, h.act, h.text, scr, history, "llm", 1, h.why, { step }));
          if (end) return end;
        } else history.push({ what: "visual helper supplied no move", changed: false });
        continue;
      }
      // No plan: whether the task is finished goes to the LLM when Drex asks ("ask if finished"), and when Drex says
      // "step done" but its own screen check disagrees (with a plan, Drex's next move is taken instead).
      const chosen = need(acts[String(choice)], `The move for Drex's choice '${choice}'`);
      const finishQ = !this.planning && (chosen.kind === "check_done" || choice === "step done");
      // Drex chose "ask for help" (or asked about the finish). With a plan, its hand-over to the user goes past the helper
      // first: a cookie or sign-up pop-up, or a step that is merely unclear, is not the user's (a run could hand over
      // at a consent dialog after its first call)
      const handover = this.planning && chosen.kind === "ask_user";
      const asked = chosen.kind === "stuck" || finishQ || handover;
      const doable = (k: string) => {
        const a = need(acts[k], `The move for option '${k}'`);
        return !META_KINDS.includes(a.kind) && !L.stallReason(history, L.whatOf(a, a.text?.text));
      };
      let act = chosen;
      let text = act.text?.text;
      let who: Who = "drex";
      let note: string | undefined = ""; // why the LLM made this move instead of Drex, for Drex's history
      let instead = "";
      if (choice === "step done" && !finishQ)
        instead = `its screen check says only ${(Number(doneP) * 100).toFixed(0)}% done`;
      else if (!asked && act.kind !== "ask_user" && L.stallReason(history, L.whatOf(act, text))) {
        paused.set(L.whatOf(act, text), n + PAUSE_MOVES); // a move that changed nothing before: not again for now
        instead = `'${L.whatOf(act, text)}' changed nothing before`;
        // with a plan, the second time in this step ends it (the run's recovery replans it); the first time the helper
        // takes the move and may replan the step. With no plan the move is only paused.
        if (this.planning && ++deadRounds >= 2) {
          this.log("loop", { moves: [L.whatOf(act, text)], round: deadRounds, kind: "no change" });
          return stuckFail(`${instead}, and Drex chose it again`);
        }
        if (this.planning && rescues < maxRescues) {
          rescues++;
          this.log("loop", { moves: [L.whatOf(act, text)], round: deadRounds, kind: "no change" });
          const h = await help(
            `Drex chose '${L.whatOf(act, text)}', which changed nothing on screen before. If this step's goal can't be reached this way, choose replan with steps that use another way (the site's search, filters, sort, menu or the right tab); else choose a move that does change the page.`,
            state,
            scr,
            opts,
            acts,
            texts,
          );
          if (h.replan || h.fail) return h;
          if (h.done) return this.finished(h.done);
          if (h.ask) {
            await this.askUser(h.ask);
            history.push({ what: "handed the screen to the user", changed: true });
            continue;
          }
          if (!h.act) continue;
          const end = outcome(await this.act(tab, h.act, h.text, scr, history, "llm", 1, h.why, { step }));
          if (end) return end;
          continue;
        }
      }
      if (instead) {
        // take Drex's best move that can still make progress
        const k = ranked.find(doable);
        if (k) {
          act = need(acts[k], `The move for option '${k}'`);
          text = act.text?.text;
          this.log("tab", { what: `${instead}, so Drex's next choice: ${L.whatOf(act, text)}` });
        }
      }

      this.log("decision", {
        who: "drex",
        choice,
        p: +need(p, "Drex's move probability").toFixed(3),
        doneP: +need(doneP, "Drex's done probability").toFixed(3),
        ms: Math.round(r.ms),
        usd: r.usd,
        top,
        url: scr.info.url,
        topText: ranked.slice(0, 3).map((k) => [opts[k], +need(probs[k], `Drex's probability of '${k}'`).toFixed(3)]),
        options: Object.keys(opts).length,
        shot: scr.thumb,
      });
      if (asked && rescues < maxRescues) {
        rescues++;
        this.totals.drexMoves--; // the move goes to the LLM instead
        let reason = handover
          ? "Drex wants to hand the screen to the user. Do that (ask_user) only for a CAPTCHA or human check, a login the task can't go on without, or payment details on screen. Close a cookie, consent, newsletter, app or sign-up pop-up instead (decline or close it), and treat unclear task wording by its most natural reading: choose the move that goes on."
          : !finishQ
            ? "Drex asked for help with this move."
            : choice === "step done"
              ? `Drex says the user's task is finished, but its own screen check gives only ${(Number(doneP) * 100).toFixed(0)}% that it is. ${FINISH_CHECK}`
              : `Drex thinks the user's task may be finished and asks you to check. ${FINISH_CHECK}`;
        // after a circle, the step's goal may not be reachable from this page at all: say so, so the LLM can replan
        if (loop) reason += ` Earlier in this step Drex went round in a circle (${loop.moves.join(" -> ")}).`;
        if (loop && this.planning)
          reason +=
            " If this step's goal is already true, or cannot be reached from this page (it belongs to a later page, like checkout), choose replan and give steps that fit what is on screen.";
        const h = await help(reason, state, scr, opts, acts, texts, finishQ ? "finish" : "help");
        if (h.replan || h.fail) return h;
        if (h.done) return this.finished(h.done);
        if (h.ask) {
          await this.askUser(h.ask);
          history.push({ what: "handed the screen to the user", changed: true });
          continue;
        }
        if (!h.act) continue;
        ({ act, text, why: note } = h);
        who = "llm";
      } else if (asked && !handover) {
        // this step's help is used up: take Drex's best move that can still make progress
        const k =
          ranked.find(doable) ||
          ranked.find((x) => !META_KINDS.includes(need(acts[x], `The move for option '${x}'`).kind));
        act = need(acts[String(k)], `The move for option '${k}'`);
        text = act.text?.text;
      }

      if (act.kind === "ask_user") {
        // Drex hands over: a CAPTCHA, a login or a choice only the user can make
        this.log("move", {
          who,
          what: "handed the screen to you",
          p: +need(p, "Drex's move probability").toFixed(3),
          changed: true,
        });
        await this.askUser("Drex needs you for this screen (a check, a login or a choice only you can make).");
        history.push({ what: "handed the screen to the user", changed: true });
        continue;
      }
      if (act.kind === "type_pick") {
        const q: Questions = {
          value: {
            type: "choice",
            instructions: `You are typing into ${L.describe(act.el)}. Which text do you type?`,
            criteria: Object.fromEntries(texts.map((t) => [t.name, L.preview(t)])),
          },
        };
        const r2 = await this.drexCall(
          `${state}\n\nYOUR MOVE: type into ${act.el.label} (${L.describe(act.el)}).`,
          q,
          drexImages(this.task, scr, scr.img1, scr.img2),
        );
        text = need(
          texts.find((t) => t.name === pick(r2, "value").choice),
          "The text Drex picked",
        ).text;
      }
      if (act.kind === "write" || act.kind === "write_cursor") {
        // Drex chose where to type; the LLM writes what (no LLM plan, so Drex was given no texts)
        const field =
          act.kind === "write" ? L.describe(act.el) : "wherever the text cursor is now (no field is tagged for it)";
        const r2 = await this.llmCall("write", () =>
          this.llm.write({
            task: this.task,
            field,
            info: scr.info,
            moves: history
              .filter((h) => !h.marker)
              .slice(-6)
              .map((h) => h.what),
            image: scr.img1,
          }),
        );
        text = need(r2.json.text, "The LLM's text to type").trim();
        if (!text) {
          this.log("tab", { what: `the LLM found nothing to type into ${field}` });
          history.push({ what: L.whatOf(act), changed: false, screen: L.screenOf(scr.info, scr.els) });
          continue;
        }
        act = act.kind === "write" ? { ...act, kind: "type" } : { ...act, kind: "type_cursor" };
      }
      if (!this.planning && who === "drex" && L.isRisky(act) && !checked.has(L.whatOf(act, text))) {
        // No plan: before Drex's click that can't be undone, the LLM checks the screen against the task (DoorDash:
        // Drex went to Place Order with only the Diet Coke, the burger not on the breakfast menu). Your approval
        // still comes after; this is about the order being right, not about your consent.
        const key = Object.keys(acts).find((k) => acts[k] === act);
        const h = await help(
          `Drex is about to click ${L.describe(need(act.el, "The click's control"))}${key ? ` (the move '${key}')` : ""}. ${RISKY_CHECK}`,
          state,
          scr,
          opts,
          acts,
          texts,
          "risky",
        );
        if (h.replan || h.fail) return h;
        if (h.done) return this.finished(h.done);
        if (h.ask) {
          await this.askUser(h.ask);
          history.push({ what: "handed the screen to the user", changed: true });
          continue;
        }
        if (!h.act) continue; // no move from the LLM: Drex looks again rather than click
        if (h.act === act)
          checked.add(L.whatOf(act, text)); // the LLM goes ahead with Drex's click
        else {
          ({ act, text, why: note } = h);
          who = "llm";
          this.totals.drexMoves--; // the move goes to the LLM instead
        }
      }
      // the no-plan check above already compared this click with the task: no second readiness check for it
      const end = outcome(
        await this.act(tab, act, text, scr, history, who, p, note, {
          prechecked: checked.has(L.whatOf(act, text)),
          step,
        }),
      );
      if (end) return end;
    }
  }

  /** Makes one move. Returns what happened: {dispatched, risky}; {blocked} when it wasn't made; {replan, why} when the
   * readiness check wants other steps first; {stepDone} when the same move was already made and the step checks out;
   * {fail} when the step's checks keep failing. Callers act on it; nothing is left behind on the agent.
   * note: the LLM's reason when it made the move, kept in the history so Drex knows why (e.g. "the burger is missing").
   * prechecked: the LLM already checked this click against the task (no plan). step: the step making the move (a
   * browse step, a fill or a collect); default the plan's current step. */
  async act(
    tab: Tab,
    act: MoveOption | null | undefined,
    text: string | null | undefined,
    scr: Looked,
    history: HistoryEntry[],
    who: Who,
    p: number | undefined,
    note = "",
    { prechecked = false, step = null }: { prechecked?: boolean; step?: Step | null } = {},
  ): Promise<Outcome> {
    const owner = step ?? this.plan.steps[this.index]; // the step this move belongs to: its checks are about it
    if (!act || META_KINDS.includes(act.kind)) {
      history.push({ what: "non-action completion/help choice was not dispatched", changed: false });
      return { blocked: "not a move on the page" };
    }
    this.landing = null; // from this move on, where the tab goes is the move's doing, not a planned URL's redirect
    // the searchEnter cost switch: typing into a site's search box submits it in the same move (no second decision
    // for Enter)
    const searchEnter =
      costOn("searchEnter") && (act.kind === "type" || act.kind === "type_pick") && L.searchField(act.el);
    const what =
      act.kind === "gesture"
        ? `performed page gesture ${JSON.stringify(act.gesture)}`
        : L.whatOf(act, text ?? undefined) + (searchEnter ? " and pressed Enter" : "");
    const memoryKey = L.stableState(scr.info, scr.els);
    const progressKey = `${memoryKey}\n${act.kind === "gesture" ? JSON.stringify(act.gesture) : L.actionIdentity(act, text)}`;
    const noProgress = () => this.noProgress.set(progressKey, (this.noProgress.get(progressKey) ?? 0) + 1);
    if ((this.noProgress.get(progressKey) ?? 0) >= 2) {
      this.log("blocked", { what, reason: "same action twice produced no semantic progress in this state" });
      history.push({ what, changed: false, note: "blocked: repeated action without progress" });
      return { blocked: "repeated without progress" };
    }
    const risky = L.isRisky(act);
    let pointKey = ""; // a point click let through by what was under it: the click goes ahead only if that is still there
    let readinessEvidence: Record<string, unknown> | null = null;
    // Before a click that can't be undone (the same clicks that ask for your approval), the LLM checks that the
    // screen holds what the task asks for. Ordinary moves get no check. Inside a bulk action you approved, none.
    if (risky && !prechecked && !this.batchApproved) {
      const info = await tab.info(30000);
      const focus = scr.shot ? await focusedEvidence(scr.shot, scr.els) : null;
      const logicalTabs = await this.logicalTabs();
      const result = await this.llmCall("ready", () =>
        this.llm.readiness({
          task: this.task,
          planText: L.planLines(this.plan, this.index),
          step: {
            kind: "verify",
            goal: `BEFORE ACTION readiness gate, not task completion: ${what}. Check this action is requested by the user or necessary for the current step, and all prerequisites for THIS action are satisfied on screen. For submission/save/send/order, compare every required value/selection and constraint BEFORE committing. Do not permit unrelated reorders, cart additions or duplicate submissions. Current step: ${need(owner, "The move's step").goal}. Return decision ready only when safe and ready; already_done when this same operation is confirmed; otherwise not_ready with what to fix and replacement steps if needed.`,
          },
          notes: this.notes,
          info,
          image: scr.img1,
          observations: this.recentObservations(12),
          candidates: candidatesOf(scr.els),
          focus,
          logicalTabs,
        }),
      );
      const d = result.json;
      const gated = need(owner, "The move's step");
      this.log("verification", {
        purpose: "before_action",
        decision: d.decision,
        complete: d.decision === "ready",
        evidence: d.evidence,
        what,
      });
      if (d.decision === "already_done") {
        history.push({ what: `did not repeat ${what}`, changed: false, note: d.evidence });
        const verified = await this.verifyStep(gated, scr);
        if (verified.replan || verified.fail) return verified;
        if (!verified.rejected) return { stepDone: true };
        this.notes.action_already_done = `${d.evidence}. Current step still incomplete: ${verified.rejected}`;
        this.noProgress.set(progressKey, 2);
        return { blocked: "already done" };
      }
      if (d.decision !== "ready") {
        noProgress();
        this.notes.action_not_ready = d.evidence;
        history.push({ what: `blocked ${what}`, changed: false, note: d.evidence });
        if (this.planning && this.repeatedObjection(gated, d.evidence))
          return { replan: this.recoverySteps(gated, d.evidence), why: d.evidence };
        const next = need(d.next_steps, "The readiness check's next steps");
        if (next.length && this.planning) {
          const continuation = next.filter((s) => s.kind !== gated.kind || s.goal !== gated.goal);
          continuation.push({ ...gated, open_url: "", use_tab: -1 });
          return { replan: continuation, why: d.evidence };
        }
        return { blocked: d.evidence };
      }
      // the check took a few seconds: the click goes ahead only if its target is still where it was
      const now = await tab.elements().catch(() => null);
      if (!now || L.targetStale(act.el, now)) {
        this.afterShot = null;
        noProgress();
        history.push({
          what: `did not make ${what}`,
          changed: false,
          note: "its target moved or went away while it was checked",
        });
        this.log("blocked", { what, reason: "the target moved during the readiness check" });
        return { blocked: "stale target" };
      }
      readinessEvidence = {
        action: what,
        url: scr.info.url,
        evidence: need(d.evidence, "The readiness check's evidence").slice(0, OBSERVATION_TEXT),
        controls: controlsOf(scr.els),
        meaning:
          "Model verified prerequisites before this exact dispatched action; not proof the action succeeded. Evaluate its observed after-state separately.",
      };
    }
    if (risky) {
      const el = need(act.el, "The click's control");
      if (!this.approvals) this.log("skipped", { what: `clicked ${L.describe(el)}` });
      else if (!this.batchApproved && !this.allowedClicks.has(el.name)) {
        const ok = await this.askApproval(
          `Drex wants to click ${L.describe(el)}. That may send, pay, post or delete something. Go ahead?`,
          scr.img1,
        );
        if (!ok) throw new Stopped(`You declined: ${L.describe(el)}.`);
        if (ok === "always") this.allowedClicks.add(el.name);
      }
    } else if (L.isRiskyGesture(act)) {
      // a gesture has no control name to check: with approvals on, it is asked about once per task. A point click is
      // judged by what is under the point (read with the mouse there): a filter, a tab or a chart range goes ahead,
      // a Delete, a Pay, a form that sends, an embedded frame or a card page asks, as does a point that can't be read
      let label =
        act.kind === "gesture"
          ? `${need(act.gesture, "The gesture").kind.replace("_", "-")} on the page`
          : "click a point on the screen";
      let why = "There's no button name to check, so it may send, pay or delete something.";
      let ask = true;
      const g = act.kind === "gesture" ? act.gesture : undefined;
      // a drag that starts on a slider's handle sets a value, as typing in a field does (L.sliderValueDrag)
      if (
        g?.kind === "drag" &&
        g.x !== undefined &&
        g.y !== undefined &&
        this.approvals &&
        !this.batchApproved &&
        !this.gesturesAllowed
      ) {
        const start = await readPoint(tab, g.x, g.y);
        if (L.sliderValueDrag(start)) {
          ask = false;
          this.log("gate", { what: label, decision: "no approval needed", role: "slider" });
        }
      }
      if (act.kind === "point" && this.approvals && !this.batchApproved && !this.gesturesAllowed) {
        const target = await readPoint(tab, act.x, act.y);
        const risk = L.pointRisk(target);
        if (target)
          label = `click a point on the screen (on ${target.role || "an element"} '${target.names[0] ?? ""}')`;
        if (risk) why = `It may send, pay or delete something: ${risk}.`;
        else {
          ask = false;
          pointKey = need(target, "The point's target").key;
          this.log("gate", { what: label, decision: "no approval needed", role: target?.role });
        }
      }
      if (!this.approvals) this.log("skipped", { what: label });
      else if (ask && !this.batchApproved && !this.gesturesAllowed) {
        const ok = await this.askApproval(
          `Drex's helper wants to ${label}${note ? ` (${note.slice(0, 200)})` : ""}. ${why} Go ahead?`,
          scr.img1,
        );
        if (!ok) throw new Stopped(`You declined: ${label}.`);
        if (ok === "always") this.gesturesAllowed = true;
      }
    }
    if (!this.actionMemory.has(memoryKey)) this.actionMemory.set(memoryKey, new Map());
    const memory = need(this.actionMemory.get(memoryKey), "The moves made on this screen");
    memory.set(what, (memory.get(what) ?? 0) + 1);
    const t0 = performance.now();
    const before = await tab.notices().catch(() => null);
    // where the move aims, for the marker on the panel's live view (the cursor in the tab itself moves in tab.click)
    const aim: [number, number] | null =
      act.kind === "point"
        ? [act.x, act.y]
        : act.el?.box && ["click", "hover", "type", "type_pick", "select"].includes(act.kind)
          ? [(act.el.box[0] + act.el.box[2]) / 2, (act.el.box[1] + act.el.box[3]) / 2]
          : null;
    if (this.cursor && aim && scr.vp) this.emit("aim", { fx: aim[0] / scr.vp.w, fy: aim[1] / scr.vp.h });
    this.check(); // A model check or user handover may have exhausted the run deadline.
    this.acting = true;
    try {
      // between the gate and the click the page may have changed under the point: what is there now is checked again
      // (the mouse is already there), and a click that would land on something risky is not made. The risk is read
      // afresh even when the target looks the same: a "Continue" in the same place may now submit a payment form
      if (pointKey && act.kind === "point") {
        const now = await readPoint(tab, act.x, act.y, { hover: false });
        if (!now || L.pointRisk(now)) {
          this.afterShot = null;
          noProgress();
          history.push({ what, changed: false, note: "what was under the point changed before the click" });
          this.log("blocked", { what, reason: "the target under the point changed after the approval check" });
          return { blocked: "stale target" };
        }
      }
      const execution = await this.perform(tab, act, text, searchEnter);
      if (execution?.dispatched === false) {
        this.afterShot = null;
        noProgress();
        history.push({
          what,
          changed: false,
          note: execution.reason || "Target could not be resolved before dispatch",
        });
        return { blocked: execution.reason || "stale target" };
      }
      if (
        risky ||
        ["type", "type_pick", "type_cursor", "select", "set_value", "adjust_slider", "point"].includes(act.kind) ||
        (act.kind === "gesture" && need(act.gesture, "The gesture").kind !== "hover") ||
        (["checkbox", "radio", "switch"] as unknown[]).includes(act.el?.role)
      )
        this.collectionMutationEpoch = (this.collectionMutationEpoch ?? 0) + 1;
      await tab.settle();
    } finally {
      this.acting = false;
    }
    // what the move did: a dialog it opened or closed, a notice it brought up, a new address (not just what it aimed at)
    const after = this.newTabId ? null : await tab.notices().catch(() => null);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- notices() always sends its list of notes; the check is kept as written
    if (after?.notes?.length) {
      const retained = this.notes.observed_notices ? (JSON.parse(this.notes.observed_notices) as unknown[]) : [];
      for (const notice of after.notes) {
        const line = `${after.url}: ${notice}`.slice(0, 200);
        if (!retained.includes(line)) retained.push(line);
      }
      this.notes.observed_notices = JSON.stringify(retained.slice(-MAX_NOTICES));
    }
    const effect = this.newTabId ? "opened a new tab" : L.effectOf(before, after);
    // the page after the move: whether it changed, and (with the screenshot below) the next look's elements
    const afterElements = this.newTabId ? null : await tab.elements().catch(() => null);
    const afterInfo: (Omit<PageInfo, "text"> & { text?: string }) | null = this.newTabId
      ? null
      : await tab.info(OBSERVATION_TEXT).catch(() => null);
    const semanticChanged =
      !!this.newTabId ||
      !afterElements ||
      memoryKey !== L.stableState(afterInfo ?? scr.info, afterElements.els) ||
      !!effect;
    if (semanticChanged) this.noProgress.set(progressKey, 0);
    else noProgress();
    this.observations.push({
      action: what,
      ...(readinessEvidence ? { precommit: readinessEvidence } : {}),
      before: { url: scr.info.url, controls: controlsOf(scr.els), notices: before },
      after: {
        url: afterInfo?.url,
        text: afterInfo?.text?.slice(0, OBSERVATION_TEXT),
        controls: controlsOf(afterElements?.els),
        notices: after,
      },
      semanticChanged,
    });
    if (this.observations.length > MAX_OBSERVATIONS) this.observations.shift();
    let changed = true;
    if (!this.newTabId && this.agentTabId === tab.id) {
      const jpeg = await this.capture(tab).catch(() => null);
      if (jpeg) {
        changed = jpeg !== scr.jpeg;
        this.afterShot = { tabId: tab.id, jpeg, elements: afterElements };
      }
    }
    const revealOnly = act.kind === "hover" || (act.kind === "gesture" && act.gesture?.kind === "hover");
    history.push({
      what,
      changed,
      effect,
      screen: L.screenOf(scr.info, scr.els),
      ...(note ? { note } : {}),
      ...(revealOnly ? { revealOnly } : {}),
    });
    if (who === "llm") this.totals.llmMoves++;
    this.log("move", {
      who,
      what,
      effect,
      p: who === "drex" ? +need(p, "Drex's move probability").toFixed(3) : undefined,
      changed,
      actMs: Math.round(performance.now() - t0),
    });
    this.tick();
    return { dispatched: true, risky };
  }

  async perform(
    tab: Tab,
    act: MoveOption,
    text: string | null | undefined,
    enter = false,
  ): Promise<{ dispatched: false; reason: string } | undefined> {
    const centre = (b: Box): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    switch (act.kind) {
      case "navigate_page": {
        const info = await tab.info(1000);
        let metadata;
        try {
          metadata = (await tab.on(act.el.node, publicMetadata.toString())) as PublicMetadata | null | undefined;
        } catch {
          return { dispatched: false, reason: "Pagination target became stale" };
        }
        if (
          metadata?.paginationURL !== act.url ||
          !safeLink({ href: act.url, text: metadata.paginationLabel || act.el.name || "" }, new URL(info.url).origin)
        )
          return {
            dispatched: false,
            reason: "Pagination target does not match a current safe same-origin public link",
          };
        await tab.navigate(act.url);
        this.afterShot = null;
        break;
      }
      case "adjust_slider": {
        const result = await tab.adjustSlider(act.el.node, act.direction);
        if (!result.ok) throw new Error("Slider adjustment was not accepted: " + String(result.error || result.value));
        break;
      }
      case "gesture":
        await tab.gesture(act.gesture);
        break;
      case "click":
        await tab.click(...centre(need(act.el.box, "The control's box")));
        if (text && act.el.field) await this.typeInto(tab, act.el, text);
        break;
      case "hover":
        await tab.hover(...centre(need(act.el.box, "The menu item's box")));
        break;
      case "point":
        await tab.click(act.x, act.y);
        if (text) {
          await sleep(150);
          await tab.type(text);
        }
        break;
      case "scroll_click":
      case "scroll_to": {
        let el: LocatedEl = act.el,
          c;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await tab.scrollIntoView(el.node);
            c = act.kind === "scroll_click" ? await tab.centre(el.node) : null;
            break;
          } catch (error) {
            if (
              !/no node|could not find node|cannot find context|detached|stale/i.test(
                String((error as Error | null | undefined)?.message || error),
              )
            )
              throw error;
            const fresh: { els?: OnScreenEl[]; off?: OffScreenEl[] } =
              attempt === 0 ? await tab.elements() : { els: [] };
            const name = (act.el.name || act.el.text || "").trim();
            const matches = [...(fresh.els ?? []), ...(fresh.off ?? [])].filter(
              (e) =>
                name &&
                (e.name || e.text || "").trim() === name &&
                e.role === act.el.role &&
                (!act.el.context || e.context === act.el.context) &&
                (!act.el.grid || JSON.stringify(e.grid) === JSON.stringify(act.el.grid)),
            );
            if (matches.length !== 1)
              return { dispatched: false, reason: "Stale target has no unique fresh public identity" };
            el = need(matches[0], "The fresh target");
          }
        }
        if (act.kind === "scroll_click") {
          if (!c) return { dispatched: false, reason: "Target has no visible click point" };
          await tab.click(...c);
        }
        break;
      }
      case "type":
      case "type_pick":
        await tab.click(...centre(need(act.el.box, "The field's box")));
        if (!(await this.typeInto(tab, act.el, text))) return { dispatched: false, reason: ONE_LINE_TABLE };
        if (enter) {
          await sleep(150);
          await tab.key("Enter");
        }
        break;
      case "type_cursor":
        if (!(await tab.type(need(text, "The text to type")))) return { dispatched: false, reason: ONE_LINE_TABLE };
        break;
      case "select":
        await tab.selectOption(act.el.node, act.index);
        break;
      case "set_value": {
        const result = await tab.setValue(act.el.node, act.value);
        if (!result.ok) throw new Error(`Slider value was not accepted: ${String(result.error || result.value)}`);
        break;
      }
      case "scroll":
        await tab.scroll(act.down);
        break;
      case "key":
        await tab.key(act.key);
        break;
      case "back":
        await chrome.tabs.goBack(tab.id).catch(() => undefined);
        break;
      case "tab":
        this.afterShot = null;
        this.agentTabId = act.tab.id;
        this.activePlanTab = [...this.tabBindings].find(([, id]) => id === act.tab.id)?.[0] ?? -1;
        this.ownTab = this.startTabs.every((t) => t.id !== act.tab.id);
        if (!this.background) await tabsCall(() => chrome.tabs.update(act.tab.id, { active: true }));
        break;
      case "wait":
        await sleep(1500);
        break;
      default: // the other kinds are not moves on the page (act() never sends them here)
        break;
    }
    return undefined;
  }

  /** After a click on the field: a single-line field or a form text area is emptied and gets the text; a document
   * editor (contenteditable: a document, an email body) gets the text added at its end, so what it holds is never
   * wiped. A text area holds a form value (a bio, a message), which typed text replaces: appended, it doubled the old
   * value ("Freelance Web DeveloperFreelance...", WebArena reddit 402). */
  /** False when nothing was typed (a table at a one-line box: Tab.type). */
  async typeInto(tab: Tab, el: PageEl, text: string | null | undefined): Promise<boolean> {
    await sleep(150);
    if (el.multi && !el.textarea) await tab.caretToEnd();
    else await tab.clearField();
    if (!(await tab.type(need(text, "The text to type")))) return false;
    // an autocomplete box: type, wait for the suggestions, then the next move picks one
    if (el.role === "combobox") await tab.waitForSuggestions().catch(() => false);
    return true;
  }

  /** A collect step with its model reads capped: at the cap it ends with what it read (kept in its notes and the
   * collection memory) instead of reading on to the run's call limit; the plan's next step answers from it. */
  async collectCapped(step: Step): Promise<Outcome> {
    this.collectCalls = 0;
    try {
      return await (costOn("collectLite") ? collectLite : collect).call(this, step);
    } catch (e) {
      if (!(e instanceof ReadCap)) throw e;
      this.notes.collection_read_cap = `Read as much of the list as ${MAX_COLLECT_CALLS} model calls allow; answer from what was read and what is on screen, and say what was not read.`;
      this.log("collection_done", { readCap: MAX_COLLECT_CALLS });
      return {};
    } finally {
      this.collectCalls = null;
    }
  }

  /** At the end of a run that found its answer: close a newsletter, cookie, app or offer pop-up over the page (at most
   * two), then scroll the answer into view if none of it is on screen. Only the agent's own tab; nothing is typed or
   * submitted, and a pop-up that reports what the run did (added to cart, an order) is left alone. */
  async showEvidence(): Promise<void> {
    if (!this.agentTabId || !this.planning) return;
    const answer = this.plan.answer_from ? this.notes[this.plan.answer_from] : "";
    const tokens = L.answerTokens(answer);
    const tab = await this.currentTab();
    const reveal = async (scroll: boolean) =>
      (await tab.eval(`(${revealAnswer.toString()})(${JSON.stringify(tokens)}, ${scroll})`)) as Reveal | null;
    for (let i = 0; i < 2; i++) {
      const r = await reveal(false);
      if (!r?.closer) break;
      // what the click would land on now, read as the approval gate reads a point (with the mouse already there, so a
      // control a hover reveals or swaps in is what counts): anything the gate would ask about is left alone, as no
      // approval is asked at the end of a run. The one exception is a close glyph ("×"), which the gate reads as a
      // button with no name; its other names, marks, frame and form are still checked
      const at = await readPoint(tab, ...r.closer);
      if (!at?.names.includes(r.closerName)) break;
      const glyph = /^[x×✕✖]$/i.test(r.closerName);
      if (L.pointRisk(glyph ? { ...at, role: "" } : at)) break;
      await tab.click(...r.closer);
      await tab.settle();
      this.log("move", {
        who: "drex",
        what: `closed the pop-up over the answer (button '${r.closerName}')`,
        changed: true,
      });
    }
    if (!tokens.length) return;
    const r = await reveal(true);
    if (r?.scrolled) {
      await tab.settle();
      this.log("move", { who: "drex", what: `scrolled the answer ('${r.scrolled}') into view`, changed: true });
    }
  }

  /** The LLM takes one move (or replans, or hands over, or, with no plan, says the task is finished).
   * Returns {act, text, learned?} | {replan, why} | {ask} | {fail} | {done} | {}. about: "help" or "finish" (for the panel). */
  async rescue(
    reason: string,
    state: string,
    scr: Looked,
    opts: Record<string, string>,
    acts: Record<string, MoveOption>,
    texts: StepText[],
    about = "help",
  ): Promise<Rescue> {
    // the state is Drex's: its "only these" texts once made the helper type the origin city into the destination
    const note =
      (scr.els.length
        ? "(Image 1 is the raw screen for color and visual details; Image 2 adds element tags for locating controls.)"
        : "(Image 1 is raw, Image 2 tagged. Nothing on this screen could be tagged: to click something, use click_point.)") +
      (texts.length
        ? " (The TEXT YOU CAN TYPE list limits Drex, not you: with a typing move, put whatever text the task needs in text.)"
        : "");
    // the helper can't hand the move to itself: on United's error page Haiku chose "ask for help" over and over
    const helperOpts = Object.fromEntries(
      Object.entries(opts).filter(
        ([k]) => !["stuck", "check_done", "look"].includes(need(acts[k], `The move for option '${k}'`).kind),
      ),
    );
    const logicalTabs = await this.logicalTabs();
    const r = await this.llmCall("rescue", () =>
      this.llm.rescue({
        task: this.task,
        state: `${state}\n${note}\nVALID LOGICAL TABS: ${JSON.stringify(logicalTabs)}. Step use_tab=-1 continues current tab; other values must be listed logical indices, not a guessed count of windows.`,
        reason,
        image: scr.img2,
        rawImage: scr.img1,
        opts: helperOpts,
        replan: this.planning,
        finish: !this.planning,
      }),
    );
    const d = r.json;
    this.log("rescue", {
      reason,
      about,
      decision: d.decision,
      option: d.option,
      text: d.text,
      why: d.why,
      shot: scr.thumb,
    });
    if (d.decision === "finished") return { done: d.why || "the task is finished" };
    if (d.decision === "replan" && need(d.new_steps, "The LLM's new steps").length)
      return { replan: d.new_steps, why: d.why };
    // a hand-over waits for you: a CAPTCHA, a login, a payment detail or a choice only you can make (with no plan,
    // any hand-over). One the LLM can't name a reason for counts as giving up: with a plan, the run looks for another
    // way (within its MAX_RECOVERIES), without one it ends.
    // Unattended, nobody makes a choice: it counts as a failed step, so the run looks for another way. A CAPTCHA, a login
    // or a payment detail still ends the run (askUser hands over, and the run answers).
    if (this.unattended && d.decision === "ask_user" && (d.user_need === "choice" || d.user_need === "none"))
      return { fail: d.why || "The LLM could not choose for the user." };
    if (d.decision === "ask_user" && (d.user_need !== "none" || !this.planning))
      return { ask: d.why || "Drex needs your help on this screen." };
    if (d.decision === "give_up" || d.decision === "ask_user")
      return { fail: d.why || "The LLM gave up on this step." };
    // the LLM's coordinates are in screenshot pixels; Number() is what the division did to them
    const scale = () => need(scr.shot, "The screenshot").scale;
    if (d.decision === "gesture") {
      const spec = d.gesture;
      if (
        !spec ||
        !(spec.kind === "hover" || spec.kind === "double_click" || spec.kind === "drag" || spec.kind === "keychord")
      )
        throw new Error("Invalid helper gesture");
      const gesture =
        spec.kind === "keychord"
          ? { kind: spec.kind, key: spec.key, modifiers: spec.modifiers }
          : {
              kind: spec.kind,
              x: Number(d.x) / scale(),
              y: Number(d.y) / scale(),
              ...(spec.kind === "drag" ? { endX: Number(spec.endX) / scale(), endY: Number(spec.endY) / scale() } : {}),
            };
      return { act: { kind: "gesture", gesture }, text: "", why: d.why };
    }
    if (d.decision === "click_point")
      return { act: { kind: "point", x: Number(d.x) / scale(), y: Number(d.y) / scale() }, text: d.text, why: d.why };
    const act = acts[String(d.option)];
    // "step done": with no plan the task is finished; with a plan this step is (help() checks it after a risky move).
    // With a plan it used to be dropped, and at the move limit that failed a step the helper had just seen was done.
    if (act?.kind === "step_done")
      return { done: d.why || (this.planning ? "this step's goal is on screen" : "the task is finished") };
    if (!act || META_KINDS.includes(act.kind)) return {};
    let text = act.text?.text;
    let learned = "";
    if (d.text && /type|click|write/.test(act.kind)) {
      text = d.text;
      if (!texts.some((t) => t.text === d.text)) learned = d.text; // the step offers it to Drex from now on
    }
    const typed: MoveOption | undefined =
      act.kind === "type_pick" || act.kind === "write"
        ? { ...act, kind: "type" }
        : act.kind === "write_cursor"
          ? { ...act, kind: "type_cursor" }
          : undefined;
    if (typed && !text) return {}; // a typing move with nothing to type
    return { act: typed ?? act, text, why: d.why, ...(learned ? { learned, origin: L.originOf(scr.info.url) } : {}) };
  }

  /** The LLM checked the screen and the user's task is finished (no plan): the run's one step ends. */
  finished(why: string): Outcome {
    this.log("tab", {
      what: `The LLM checked the screen: ${this.planning ? "this step is done" : "the task is finished"}. ${why}`,
    });
    this.tick();
    return {};
  }

  // --- batch steps --------------------------------------------------------------------------------------------------
  /** The same question for every item of a list: Drex decides up to 16 items per call (the calls run in parallel),
   * items it is unsure about are opened and decided from their full content, then each answer's action is done
   * once for all its items (tick them + one bulk action) or item by item when the list has no checkboxes. Items
   * already decided are remembered by their text, so items that stay in the list are not asked again; when no new
   * items are left on screen, the agent goes to the next page. */
  async batch(step: Step): Promise<Outcome> {
    // a batch step decides between its choices; with none, the plan is wrong (no silent switch to another kind of step)
    if (!hasChoices(step)) return { fail: "This batch step has no choices to decide between.", terminal: true };
    const seen = new Set<string>();
    const results: Record<string, string[]> = {};
    const allowed = new Set<string>(); // answers whose action you allowed for the rest of the task
    for (let pages = 0; ;) {
      this.check();
      const tab = await this.currentTab();
      const fresh = (await tab.items()).filter((it) => !seen.has(it.key));
      if (!fresh.length) {
        if (pages >= MAX_PAGES || !(await this.nextPage(step, seen))) break;
        pages++;
        continue;
      }
      const decided = await this.decideItems(step, fresh, await this.look(tab));
      for (const d of decided) if (Number(d.p) < L.BATCH_SURE) await this.decideOpened(step, d);
      for (const choice of step.choices.filter((c): c is StepChoice & { action: string } => !!c.action)) {
        const group = decided.filter((d) => d.choice === choice.name).map((d) => d.item);
        if (group.length) await this.applyChoice(choice, group, allowed);
      }
      for (const d of decided) {
        seen.add(d.item.key);
        (results[String(d.choice)] ??= []).push(d.item.text);
      }
    }
    const name = step.save_as || `batch${this.index + 1}`;
    this.notes[name] = L.batchSummary(step, results) || "The list had no items.";
    this.log("note", { name, text: this.notes[name] });
    return {};
  }

  async decideItems(step: BatchStep, items: PageItem[], scr: Looked): Promise<Decided[]> {
    const state = L.batchState({ task: this.task, step, info: scr.info, site: siteFor(SITES, scr.info.url) });
    const t0 = performance.now();
    const replies = await Promise.all(
      L.chunks(items).map(async (c) => ({ c, r: await this.drexCall(state, L.itemQuestions(step, c), [scr.img1]) })),
    );
    const out: Decided[] = [];
    for (const { c, r } of replies) {
      c.forEach((item, i) => {
        const { choice, p } = pick(r, `I${i + 1}`);
        out.push({ item, choice, p });
      });
    }
    this.totals.drexItems += items.length;
    const counts: Record<string, number> = {};
    for (const d of out) counts[String(d.choice)] = (counts[String(d.choice)] ?? 0) + 1;
    this.log("batch", {
      shot: scr.thumb,
      items: items.length,
      calls: replies.length,
      ms: Math.round(performance.now() - t0),
      counts,
      unsure: out.filter((d) => Number(d.p) < L.BATCH_SURE).length,
      usd: replies.reduce((a, x) => a + x.r.usd, 0),
      decisions: out.map((d) => ({
        text: d.item.text.slice(0, 120),
        choice: d.choice,
        p: +need(d.p, "Drex's probability for an item").toFixed(3),
      })),
    });
    this.tick();
    return out;
  }

  /** Opens an item Drex was unsure about, decides again from its full content, and goes back to the list. */
  async decideOpened(step: BatchStep, d: Decided): Promise<void> {
    const tab = await this.currentTab();
    const listUrl = await tab.eval("location.href");
    // opening an earlier item and going back can re-render the list: find this row again by its text if needed
    let node: number | undefined = d.item.node;
    try {
      await tab.openItem(node);
    } catch {
      node = (await tab.items()).find((i) => i.key === d.item.key)?.node;
      if (!node) return; // gone from the list: keep the first answer
      await tab.openItem(node);
    }
    await tab.settle();
    const scr = await this.look(tab);
    const state = L.batchState({
      task: this.task,
      step,
      info: scr.info,
      site: siteFor(SITES, scr.info.url),
      opened: true,
    });
    const q: Questions = {
      item: {
        type: "choice",
        instructions: `ITEM: "${d.item.text}"\n${step.question}`,
        criteria: Object.fromEntries(step.choices.map((c) => [c.name, c.description])),
      },
    };
    const r = await this.drexCall(state, q, [scr.img1]);
    const { choice, p } = pick(r, "item");
    this.log("move", {
      who: "drex",
      what: `opened "${d.item.text.slice(0, 60)}" and decided: ${choice} (was ${d.choice} at ${Math.round(Number(d.p) * 100)}%)`,
      p: +need(p, "Drex's probability for the item").toFixed(3),
      ms: Math.round(r.ms),
      changed: true,
    });
    Object.assign(d, { choice, p });
    if ((await tab.eval("location.href")) !== listUrl) {
      await chrome.tabs.goBack(tab.id).catch(() => undefined);
      await tab.settle();
      await this.findItems(new Set([d.item.key]), PAGE_WAIT_MS); // the list can take seconds to come back
    }
  }

  /** Does one answer's action for its items: tick them all, then one bulk action; or one item at a time. */
  async applyChoice(choice: StepChoice & { action: string }, items: PageItem[], allowed: Set<string>): Promise<void> {
    if (!this.approvals)
      this.log("skipped", { what: `${choice.action}: ${items.length} item${items.length > 1 ? "s" : ""}` });
    else if (!allowed.has(choice.name)) {
      const ok = await this.waitForUser(
        "approve",
        `${choice.action}: ${items.length} item${items.length > 1 ? "s" : ""}`,
        null,
        items.map((it) => it.text),
      );
      if (!ok) throw new Stopped(`You declined: ${choice.action}.`);
      if (ok === "always") allowed.add(choice.name);
    }
    const tab = await this.currentTab();
    const keys = new Set(items.map((i) => i.key));
    const now = await this.findItems(keys, LIST_REFRESH_MS); // the list may have re-rendered (or still be loading) since deciding
    if (now.length < keys.size)
      this.log("tab", {
        what: `${keys.size - now.length} of ${keys.size} items for "${choice.action}" are no longer in the list`,
      });
    this.batchApproved = true;
    try {
      if (now.length && now.every((i) => i.checkbox)) {
        const listBefore = new Set((await tab.items()).map((i) => i.key));
        const ticked = await this.tickAll(tab, now);
        this.log("tick", { what: `ticked ${ticked} item${ticked === 1 ? "" : "s"} for: ${choice.action}` });
        await this.subStep({
          goal: `${ticked} items are ticked (selected) in the list. Do this to all the selected items at once, using the page's controls for selected items (a toolbar or a menu above the list): ${choice.action}.`,
          done_when: `Is "${choice.action}" done for the selected items: are they gone from the list or changed as asked, with no menu or dialog still open?`,
          max_moves: BULK_MOVES,
        });
        await this.waitForList(listBefore, LIST_REFRESH_MS);
      } else {
        for (const it of now) {
          await this.subStep({
            goal: `For this one item of the list, "${it.text.slice(0, 120)}": ${choice.action}. Leave the other items alone.`,
            done_when: `Is "${choice.action}" done for that item (it is gone from the list or shows the change), with the list shown again?`,
            max_moves: ITEM_MOVES,
          });
        }
      }
    } finally {
      this.batchApproved = false;
    }
  }

  /** Ticks every row of `items`. Ticking can re-render the whole list (old row nodes vanish), so a row whose node
   * is gone is found again by its text. */
  async tickAll(tab: Tab, items: PageItem[]): Promise<number> {
    let ticked = 0;
    const left = new Map(items.map((i) => [i.key, i]));
    for (let guard = 0; left.size && guard < items.length * 3; guard++) {
      const [key, it] = need(left.entries().next().value, "A row left to tick");
      if (await tab.tick(it.node)) {
        ticked++;
        left.delete(key);
        continue;
      }
      const again = (await tab.items()).find((i) => i.key === key);
      if (!again)
        left.delete(key); // gone from the list
      else if (again.node === it.node)
        left.delete(key); // the row is there but its checkbox won't tick
      else left.set(key, again);
    }
    return ticked;
  }

  async subStep(sub: { goal: string; done_when: string; max_moves: number }): Promise<Outcome> {
    const res = await this.browse({ kind: "browse", rules: "", texts: [], open_url: "", use_tab: -1, ...sub });
    if (res.fail || res.replan) this.log("tab", { what: `could not finish: ${sub.goal.slice(0, 100)}` });
    return res;
  }

  /** The rows with these keys, waiting up to `ms` for them to show (a list re-renders after going back or paging). */
  async findItems(keys: Set<string>, ms: number): Promise<PageItem[]> {
    const t0 = performance.now();
    let found: PageItem[] = [];
    while (performance.now() - t0 < ms) {
      const tab = await this.currentTab();
      found = (await tab.items().catch(() => [])).filter((i) => keys.has(i.key));
      if (found.length === keys.size) return found;
      await sleep(300);
    }
    return found;
  }

  /** Waits until the list's rows differ from `before` (rows came or went), up to `ms`; true when they did. The page's
   * own settle is not enough: the next page of a list often arrives seconds after the click. */
  async waitForList(before: Set<string>, ms: number, isNew = (k: string) => !before.has(k)): Promise<boolean> {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      this.check();
      const tab = await this.currentTab();
      const keys = (await tab.items().catch(() => [])).map((i) => i.key);
      if (keys.some(isNew) || [...before].some((k) => !keys.includes(k))) return keys.some(isNew);
      await sleep(300);
    }
    return false;
  }

  /** One Drex move toward the list's next page (Older / Next, or scrolling for more); true when rows not decided yet
   * appeared within PAGE_WAIT_MS. */
  async nextPage(step: BatchStep, seen = new Set<string>()): Promise<boolean> {
    const tab = await this.currentTab();
    const before = new Set((await tab.items()).map((i) => i.key));
    const scr = await this.look(tab);
    const { opts, acts } = L.buildOptions({ els: scr.els, off: scr.off, texts: [] });
    const goal =
      "Show the next page of this list: click its Older / Next page control, or scroll down if more items load as you scroll. If there is no next page (no such control, or it is disabled), choose 'step done'.";
    const images = drexImages(this.task, scr, scr.img1, scr.img2);
    const state = L.stateText({
      task: movesTask(this.task),
      plan: this.plan,
      index: this.index,
      texts: [],
      history: [],
      info: scr.info,
      tagged: scr.els.length,
      step: { goal, done_when: "There is no next page of the list.", rules: step.rules },
      textOnly: !images.length,
    });
    const r = await this.drexCall(
      state,
      { move: { type: "choice", instructions: L.MOVE_Q, criteria: moveOptions(opts) } },
      images,
    );
    const { choice, p } = pick(r, "move");
    this.totals.drexMoves++;
    const act = need(acts[String(choice)], `The move for Drex's choice '${choice}'`);
    if (["step_done", "stuck", "ask_user"].includes(act.kind)) {
      this.log("move", {
        who: "drex",
        what: "no next page: the list is done",
        p: +need(p, "Drex's move probability").toFixed(3),
        changed: false,
      });
      return false;
    }
    await this.act(tab, act, act.text?.text, scr, [], "drex", p, "", { step });
    return this.waitForList(before, PAGE_WAIT_MS, (k) => !before.has(k) && !seen.has(k));
  }

  // --- the user -----------------------------------------------------------------------------------------------------
  /** items: the list rows a batch action is about to touch, shown one per line. */
  async waitForUser(
    kind: "approve" | "user",
    message: string,
    image?: string | null,
    items: string[] | null = null,
  ): Promise<UserAnswer> {
    // the person is at the coding agent, not at this panel: end the run and hand the question back
    if (this.wantReport)
      throw new Handover(kind === "approve" ? `Needs approval before this action: ${message}` : message);
    // unattended: no panel is open to answer; approvals still wait because the runner answers those itself
    if (this.unattended && kind === "user") throw new Handover(message);
    const t0 = performance.now();
    this.check();
    let ok: UserAnswer;
    // the deadline's clock stops while you decide: an approval or a hand-over never expires with the run's time
    this.runBudget.pause();
    try {
      ok = await new Promise<UserAnswer>((resolve) => {
        this.pendingAsk = resolve;
        this.log("ask", { kind, message, image, items });
      });
    } finally {
      this.runBudget.resume();
      this.pendingAsk = null;
      this.totals.waitSeconds += (performance.now() - t0) / 1000;
    }
    this.log("answer", { kind, ok });
    this.check();
    return ok;
  }

  /** ok: false (stop), true or "once" (go ahead), "always" (go ahead for the rest of this task). */
  answer(ok: UserAnswer): void {
    if (this.pendingAsk) this.pendingAsk(ok);
  }

  askApproval(message: string, image: string): Promise<UserAnswer> {
    return this.waitForUser("approve", message, image);
  }

  async askUser(message: string): Promise<void> {
    // a search engine's CAPTCHA on the way to the task's website is not the user's to solve: back to the site, whose
    // own menus and search the run uses instead
    if (this.site && this.agentTabId) {
      const tab = await this.currentTab();
      const url = (await tab.info(0).catch(() => null))?.url;
      if (L.isSearchEngine(url)) {
        this.notes.search_engine_blocked = `A search engine refused the run (${String(url).slice(0, 80)}): find the page through ${L.host(this.site)}'s own menus, search and links.`;
        this.log("tab", { what: `left the search engine's check for ${L.host(this.site)}` });
        await tab.navigate(this.site);
        await tab.settle();
        return;
      }
    }
    const ok = await this.waitForUser("user", message);
    if (!ok) throw new Stopped("Stopped at your request.");
  }
}
