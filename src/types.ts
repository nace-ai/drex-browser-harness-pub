// Shapes shared between modules. Type-only: nothing here exists at runtime, so import it with `import type`.
import type { CATALOG, PROVIDERS } from "./models.ts";
import type { Tab } from "./cdp.ts";
import type { LLM } from "./llm.ts";
import type { RunBudget } from "./run-budget.ts";

export type ProviderId = keyof typeof PROVIDERS;
export type ModelId = keyof typeof CATALOG;
/** $ per million tokens: input, output, cache read, cache write. */
export type Prices = readonly [input: number, output: number, cacheRead: number, cacheWrite: number];
export interface CatalogEntry {
  provider: ProviderId;
  label: string;
  prices: Prices | null;
  vision?: boolean;
  offered?: boolean;
}
export interface ProviderEntry {
  label: string;
  keyName: string;
  prefix: RegExp;
  defaultModel: string;
}
export type KeyName = (typeof PROVIDERS)[ProviderId]["keyName"];

/** chrome.storage.local, with the defaults loadSettings fills in. Anything stored may be missing (older builds). */
export interface Settings {
  drexKey?: string;
  anthropicKey?: string;
  openaiKey?: string;
  fireworksKey?: string;
  googleKey?: string;
  openrouterKey?: string;
  model: ModelId;
  background: boolean;
  approvals: boolean;
  unattended: boolean;
  notify: boolean;
  cursor: boolean;
  planning: boolean;
  bridge: boolean;
  bridgeCode?: string;
  runLimits?: LimitsInput;
}

/** One site's tips (src/sites.json, made by scripts/distill-sites.mjs). */
export interface Site {
  key: string;
  name: string;
  url_prefixes: string[];
  names: string[];
  planner_tips: string;
  screen_tips: string;
}

/** A screenshot scaled into a canvas; `scale` turns CSS pixels into image pixels. */
export interface Shot {
  canvas: OffscreenCanvas;
  w: number;
  h: number;
  scale: number;
}
/** A value a lookup is known to find. `!` is banned and a cast to the plain type is flagged as a `!`, so a cast to `X & object` says "not undefined". The 2D context of a fresh OffscreenCanvas is assumed non-null. */
export type Ctx2D = OffscreenCanvasRenderingContext2D & object;
/** An element's box in CSS pixels: x0, y0, x1, y1. */
export type Box = [number, number, number, number];
export interface FocusedEvidence {
  image: string;
  sourceRectCSS: number[];
  sourceRectPixels: number[];
  scale: number;
  offset: number[];
  output: number[];
  candidateCount: number;
  use: string;
}

/** How to add the Drex MCP server to one coding agent. */
export interface AgentSetup {
  id: string;
  label: string;
  how: string;
  text: string;
  link?: string;
}

/** A value from storage that may hold run limits: any field may be missing or not a number; limitsFrom checks each one. */
export type LimitsInput = Partial<Record<keyof RunLimits, unknown>> | string | number | boolean | null | undefined;
export interface RunLimits {
  maxHaikuCalls: number;
  maxCostUsd: number;
  maxSeconds: number;
}
/** Who a run's model request is for: the planner's LLM calls ("anthropic" counts every LLM) and Drex. */
export type BudgetProvider = "anthropic" | "drex";
export interface BudgetTicket {
  provider: BudgetProvider;
  reserved: number;
  settled: boolean;
}

export interface ImageSource {
  type: string;
  media_type: string;
  data: string;
}
export interface ObservationTransform {
  original_width: number;
  original_height: number;
  width: number;
  height: number;
  scale: number;
  offset_x: number;
  offset_y: number;
  coordinates: string;
}

/** Anything that can be page evidence: text, numbers, or a JSON-like object or array. */
export type Evidence = object | string | number | boolean | null | undefined;
export interface EvidenceEntry {
  path: string;
  index: number;
  text: string;
}
export interface EvidenceRef extends EvidenceEntry {
  ref: string;
}
export interface EvidenceItem {
  ref: string;
  path: string;
  text: string;
  aliases?: string[];
}
export interface OmittedEvidence {
  ref: string;
  path: string;
  preview: string;
  aliases?: string[];
}
export interface EvidenceSection {
  path: string;
  count: number;
  first_index: number;
  last_index: number;
}
export interface CompactedContext extends Record<string, unknown> {
  evidence: EvidenceItem[];
  context_inventory: OmittedEvidence[];
  context_incomplete: boolean;
  context_rule: string;
  context_catalog: { total_chunks: number; omitted_chunks: number; sections: EvidenceSection[]; selectors: string };
}
/** What a run keeps back for its final answer: physical model calls, dollars and milliseconds. */
export interface BudgetHold {
  calls: number;
  usd: number;
  ms: number;
}
export interface BudgetSnapshot {
  limits: RunLimits;
  knownCostUsd: number;
  reservedCostUsd: number;
  unknownCost: boolean;
  costComplete: boolean;
  physicalCalls: Record<BudgetProvider, number>;
  remainingMs: number;
}

// --- plan and moves (logic.ts; consumed by llm, macros and agent) ---
/** The kinds the plan schema offers. A provider that doesn't enforce the enum can send any other string, which runs as a browse step. */
export type StepKind = "browse" | "read" | "batch" | "look" | "verify" | "collect" | "fill";
export interface StepChoice {
  name: string;
  description: string;
  action?: string;
}
export interface StepText {
  name: string;
  text: string;
}
/** One plan step as the LLM writes it (the schema in llm.ts requires every field, but not every provider enforces it) plus what the agent adds.
 * Any field may be missing, kind and goal too: the agent runs a step without a kind as a browse step, and a missing goal reads "undefined" in prompts. */
export interface Step {
  kind?: StepKind | (string & Record<never, never>);
  goal?: string;
  open_url?: string;
  use_tab?: number;
  done_when?: string;
  rules?: string;
  max_moves?: number;
  question?: string;
  choices?: StepChoice[];
  texts?: StepText[];
  save_as?: string;
  finalCheck?: boolean;
  recoveryGoal?: string;
  recoveryInspection?: boolean;
}
/** A batch step: the agent checks it has choices; its question is read as it is ("undefined" when missing). */
export type BatchStep = Step & { choices: StepChoice[] };
/** A plan as the panel and the worker see it: the planner (or a stored test plan) may leave out any field, steps too. */
export type PlanLike = PlanJson & { direct?: boolean };
export interface Plan {
  summary: string;
  steps: Step[];
  answer_from: string;
  direct?: boolean;
}

/** A slider the page draws with its own markup (jQuery UI): no range is known and the value is read off a nearby label, if there is exactly one. */
export interface CustomSlider {
  kind: "custom";
  min: null;
  max: null;
  step: null;
  value: number | null;
  orientation?: string;
}
/** A native range input or an ARIA slider. */
export interface RangeSlider {
  kind?: undefined;
  min: number;
  max: number;
  step: number;
  value: number;
  orientation?: string;
}
export type Slider = CustomSlider | RangeSlider;
/** An element's place on the whole page (not the viewport), in CSS pixels: x, y, width, height. */
export type Rect = [number, number, number, number];
/** Where a control sits among others with the same role and label: row and column of their shared geometry. */
export interface GridPlace {
  row: number;
  column: number;
  ordinal: number;
  total: number;
}
/** A control on screen as cdp.elements() describes it (E1.. on screen, D1.. off screen). */
export interface PageEl {
  text: string;
  name?: string;
  role?: string;
  state?: string;
  label: string;
  node?: number;
  box?: Box;
  context?: string;
  where?: string;
  field?: boolean;
  multi?: boolean;
  /** a form <textarea> (multi-line, but not a document editor): typing replaces what it holds */
  textarea?: boolean;
  select?: boolean;
  options?: string[];
  selectedIndex?: number;
  /** longSelects: a native select with more options than are offered as moves; only the ones the step names are */
  longList?: boolean;
  selectedOptions?: string[];
  multiple?: boolean;
  slider?: Slider | null;
  paginationURL?: string;
  paginationLabel?: string;
  group?: string;
  documentPosition?: Rect;
  checked?: boolean | null;
  indeterminate?: boolean;
  dist?: number;
  grid?: GridPlace;
  /** A menu item that opens a submenu (aria-haspopup), still closed: pointing at it opens the submenu, where a click
   * on the item itself may choose it instead. */
  submenu?: boolean;
  /** cdp.elements() never sets this: the read in macros' detailControls is a guard that never fires. */
  disabled?: boolean;
  /** marked as something to drag (draggable="true", jQuery UI's ui-draggable or ui-sortable-handle, aria-grabbed) */
  draggable?: boolean;
  /** a read-only field (a date picker's input): it takes no typing */
  readOnly?: boolean;
  /** shows text of its own (not only a name from an aria-label, alt or label): copyMove copies it */
  ownText?: boolean;
}
/** What a click at a screen point would land on (Tab.pointTarget), read with the mouse already at the point. */
export interface PointTarget {
  /** the names of the element hit and of its ancestors up to the control that takes the click (accessible name,
   * label, title, alt, value; nearest first) */
  names: string[];
  /** the names of the control that takes the click itself, without those of the elements inside it */
  own?: string[];
  /** the role of the control that takes the click ("button", "link", "checkbox"...), or "" */
  role: string;
  /** risky words in that control's id, classes, test id or icon ("delete", "trash", "checkout"), for icon-only
   * controls with no name */
  marks: string[];
  /** it submits a form that sends data (POST, or a form with a password, email, phone or message field) */
  submits: boolean;
  /** the point is inside an iframe, embed or object (a payment widget, say): its controls can't be read */
  frame: boolean;
  /** that frame's address, title, id and name: a consent manager's frame says so */
  frameInfo?: string;
  /** the element hit, or a wrapper on its way up, is a small element with no name that takes the click itself (an
   * icon-only Delete on a photo tile): with no control above it, laid over a bigger control, or a nameless control
   * with no role; whatever the tile is called says nothing of what it does */
  overlay?: boolean;
  /** the control sits in a cookie or consent banner or dialog: a nameless close there takes a privacy choice only */
  consent?: boolean;
  /** the page shows a card-number, security-code or password field */
  payment: boolean;
  /** identifies the control (tag, role, name and place), so a change under the point before the click is seen */
  key: string;
}
export interface Viewport {
  w: number;
  h: number;
}
/** What cdp.elements() sets on every element it lists: the node, and the place on the page. */
export type LocatedEl = PageEl & { node: number; documentPosition: Rect };
/** An element on screen (E1..): it has its box in the viewport. */
export type OnScreenEl = LocatedEl & { box: Box };
/** An element off screen (D1..): how many screens away, and the words for it. */
export type OffScreenEl = LocatedEl & { dist: number; where: string };
export interface PageElements {
  els: OnScreenEl[];
  off: OffScreenEl[];
  vp: Viewport;
}
/** One row of the page's main list (Tab.items). */
export interface PageItem {
  key: string;
  text: string;
  node: number;
  checkbox: boolean;
  checked: boolean;
}
/** One list row as the page script reads it (cdp.ts RECORD_FN): header-to-cell pairs, its rating text, its best link. */
export interface RawRecord {
  index: number;
  text: string;
  cells: [string, string][];
  rating: string | null;
  href: string;
}
/** A row typed on the host: fields by lower-cased header, each cell's first number, stars from the rating; virtual
 * fields text, amount, date and stars are always present when the row has them. */
export interface ListRecord {
  index: number;
  text: string;
  href: string;
  fields: Record<string, string>;
  numbers: Record<string, number>;
  stars: number | null;
}
/** What an aggregation computes over a list's records (records.ts aggregate); none asks for nothing. */
export type AggregateOp = "none" | "count" | "sum" | "avg" | "min" | "max" | "list" | "top" | "argmax" | "argmin";
/** How a filter compares a record's field with its value: by date, by number, or as text with case aside. */
export type FilterOp = "eq" | "neq" | "contains" | "gte" | "lte" | "between";
/** One exact condition on a record's field; a between value is written from..to. */
export interface AggregateFilter {
  field: string;
  op: FilterOp;
  value: string;
}
/** The LLM's aggregation spec for a collect step; field, group_by and output name the records' fields, "" when none
 * applies. */
export interface AggregateSpec {
  op: AggregateOp;
  field: string;
  filters: AggregateFilter[];
  group_by: string;
  output: string;
  order: "asc" | "desc" | "none";
  limit: number;
  /** conditions no field decides (a complaint about quality): the row screen judges them, not the filters */
  semantic_constraints: string[];
}
/** An aggregation computed in code over the rows read: a value that can't be computed is null, never 0, with the
 * reason in unresolved; groups are the rows per key of a group_by, most first. */
export interface AggregateResult {
  op: AggregateOp;
  value: number | string | string[] | null;
  rows_total: number;
  rows_used: number;
  groups?: { key: string; value: number }[];
  /** the rows a top, argmax or argmin chose (a group's own rows, latest first), with their links: a later step opens
   * the entity from here instead of searching for it again */
  selected?: { text: string; href: string; date?: string }[];
  /** how many rows or groups share the best value: every one is in value, never only the first */
  ties?: number;
  /** list values past the cap, left out of value */
  more?: number;
  unresolved: string[];
}
/** What the page shows besides its controls (Tab.notices). */
export interface Notices {
  dialogs: string[];
  notes: string[];
  url: string;
  title: string;
}
/** settingReadback: where the page shows each of a step's values applied (Tab.readBack), by the value as the step
 * says it, and the values it doesn't show. Where: "field value", "select", "aria-pressed", "aria-selected",
 * "aria-checked", "state", "chip", "heading" or "url"; the agent adds "drex" and "llm" for a value one of them saw. */
export interface ReadBack {
  found: Record<string, string>;
  missing: string[];
}
/** The page's title, address and readable text (Tab.info). */
export interface PageInfo {
  title: string;
  url: string;
  text: string;
  truncated: boolean;
  chars: number;
}
/** A console error, uncaught exception or failed request, for a coding agent (Tab.problems). */
export interface Problem {
  kind: string;
  text: string;
  url?: string;
}
/** A site request that may change something (POST, PUT, PATCH, DELETE), as Tab keeps it for confirmedChanges. */
export interface Mutation {
  method: string;
  url: string;
  /** the site's answer; unset until it came */
  status?: number;
  /** Chrome's resource type (Document, XHR, Fetch, Ping...) */
  type: string;
  /** performance.now() when it was sent */
  ts: number;
  /** a redirect that kept the method (307, 308): the request continues at url, and this is where it was sent */
  redirectedFrom?: string;
}
/** The site's answers to a move's requests: "POST /path 302" for each, 2xx and 3xx confirmed, 4xx and 5xx rejected. */
export interface MoveMutations {
  confirmed: string[];
  rejected: string[];
  /** set when a confirmed request is a form post that navigated (a Document request) or a PUT, PATCH or DELETE: a
   * change of the site's data, where a POST from the page's script may be a search (Tab.mutationsSince) */
  strong?: true;
}
/** A change a move made (confirmedChanges), as the notes confirmed_changes and rejected_changes list it. */
export interface RecordedChange {
  /** the goal of the step the move was made for */
  step: string;
  move: string;
  requests: string[];
  notices: string[];
}
/** The state of a field as the page reports it (Tab.fieldValue): a custom slider has only a value. */
export interface FieldValue {
  value: unknown;
  checked?: boolean;
  selectedIndex?: number;
  selectedOptions?: string[];
  multiple?: boolean;
  disabled: boolean;
}
/** What a slider move reports (Tab.adjustSlider, Tab.setValue). `value` is whatever the page showed. */
export interface SliderResult {
  ok: boolean;
  requested?: number | null;
  before?: number | null;
  value?: unknown;
  steps?: number;
  error?: string;
}
/** What a browser gesture reports (Tab.gesture). */
export interface GestureResult {
  kind: string;
  x?: number;
  y?: number;
  endX?: number;
  endY?: number;
  steps?: number;
  key?: string;
  modifiers?: unknown;
  released?: boolean;
}
export interface TabInfo {
  title?: string;
  url: string;
  id?: number;
}
export interface GestureSpec {
  kind: string;
  x?: number;
  y?: number;
  endX?: number;
  endY?: number;
  key?: string;
  modifiers?: unknown;
  /** a drag_to gesture: the tags (E#) of the element dragged and of the one it is dropped onto */
  from?: string;
  to?: string;
}
/** One move Drex can pick (buildOptions), plus the two the agent builds from the LLM's answer: a click at a point and a gesture.
 * Its element is one cdp.elements() listed (the agent reads its node). A move without an element or a text has them
 * undefined: the agent reads act.el and act.text before it looks at the kind. A type_cursor move the agent makes from
 * write_cursor has no text of its own (the text is passed beside it). */
export type MoveOption =
  | { kind: "look"; el?: LocatedEl; text?: undefined }
  | { kind: "set_value"; el: LocatedEl; value: number; text?: undefined }
  | { kind: "adjust_slider"; el: LocatedEl; direction: number; text?: undefined }
  | { kind: "select"; el: LocatedEl; index: number; value: string; values?: string[]; text?: undefined }
  | { kind: "type" | "type_pick" | "click" | "scroll_to" | "scroll_click"; el: LocatedEl; text?: StepText }
  | { kind: "hover"; el: LocatedEl; text?: undefined }
  /** Drex chose what to drag; where it goes is its next choice (agent.ts makes it a drag_to) */
  | { kind: "drag_pick"; el: LocatedEl; text?: undefined }
  | { kind: "drag_to"; el: LocatedEl; to: LocatedEl; text?: undefined }
  /** Drex chose whose text to copy; the field it goes into is its next choice (agent.ts makes it a copy_to) */
  | { kind: "copy_pick"; el: LocatedEl; text?: undefined }
  | { kind: "copy_to"; el: LocatedEl; to: LocatedEl; text?: undefined }
  | { kind: "write"; el: LocatedEl; text?: undefined }
  | { kind: "navigate_page"; el: LocatedEl; url: string; text?: undefined }
  | { kind: "type_cursor"; text?: StepText; el?: undefined }
  | { kind: "write_cursor"; el?: undefined; text?: undefined }
  | { kind: "back" | "wait" | "step_done" | "check_done" | "ask_user" | "stuck"; el?: undefined; text?: undefined }
  | { kind: "scroll"; down: boolean; el?: undefined; text?: undefined }
  | { kind: "key"; key: Parameters<Tab["key"]>[0]; el?: undefined; text?: undefined }
  | { kind: "tab"; tab: TabInfo; el?: undefined; text?: undefined }
  | { kind: "point"; x: number; y: number; el?: undefined; text?: undefined }
  | { kind: "gesture"; gesture?: GestureSpec; el?: undefined; text?: undefined };
export interface Options {
  opts: Record<string, string>;
  acts: Record<string, MoveOption>;
}
export interface Screen {
  url: string;
  texts: string[];
}
/** One move in a step's history, or a loop marker. */
export interface MoveRecord {
  marker?: false;
  what: string;
  changed: boolean;
  effect?: string;
  note?: string;
  screen?: Screen;
  /** The move only pointed at something (a hover): it may reveal a submenu but changes nothing by itself. */
  revealOnly?: boolean;
}
export type HistoryEntry = { marker: true } | MoveRecord;
/** What candidates.publicMetadata reports for one element. checked and indeterminate come only for checkable controls. */
export interface PublicMetadata {
  name: string;
  /** a colour input: typing a hex code ("#AB2567") sets it */
  colorField?: boolean;
  /** a tel:, mailto: or sms: link: it opens another app, never a page, so it is not offered as a move */
  appLink?: boolean;
  /** The painted background of an unlabeled control that shows no text: "light red, hsl(0 74% 83%)". */
  color?: string;
  slider: Slider | null;
  role: string;
  paginationURL: string;
  paginationLabel: string;
  checked?: boolean | null;
  indeterminate?: boolean;
  disabled: boolean;
}

// --- Drex Max (drex.ts, keycheck.ts, cheap-collection.ts) ---
export type Question =
  { type: "choice"; instructions: string; criteria: Record<string, string> } | { type: "noul"; instructions: string };
/** One named question per entry; ask() accepts 1 to 16. */
export type Questions = Record<string, Question>;
/** A choice question answers with `choice` and `probabilities`, a noul question with `noul` (the probability of yes). A reply may omit any of them; pick and yes check what they read. */
export interface DrexAnswer {
  choice?: string;
  probabilities?: Record<string, number>;
  noul?: number;
}
export interface RequestUsage {
  input_tokens?: unknown;
}
/** The JSON body of a reply, a non-null value of any kind: every field is whatever the server sent. */
export interface DrexBody {
  model?: unknown;
  usage?: unknown;
  answers?: unknown;
  request_id?: unknown;
}
/** `answers` is missing when the body had none; pick and yes throw then, as reading it always has. */
export interface DrexReply {
  answers?: Record<string, DrexAnswer>;
  usage: RequestUsage;
  ms: number;
  usd: number;
  requestId?: unknown;
}
export interface KeyCheck {
  ok: boolean;
  message: string;
}
export type LlmKeyCheck = (key: string | undefined, model: string, fetchFn?: typeof fetch) => Promise<KeyCheck>;

// --- LLM requests (providers.ts; built by llm.ts) ---
/** API keys by provider, as the settings hold them. */
export type ApiKeys = Partial<Record<ProviderId, string>>;
export type Effort = "low" | "medium" | "high";
export interface TextBlock {
  type: "text";
  text: string;
  /** The prompt cache ends here (Anthropic): what comes before is read from the cache by later requests. */
  cache_control?: { type: "ephemeral"; ttl?: string };
}
export interface ImageBlock {
  type: "image";
  source: ImageSource;
}
export type LlmBlock = TextBlock | ImageBlock;
export interface SystemBlock extends TextBlock {
  cache_control?: { type: "ephemeral"; ttl?: string };
}
/** One request in the shape llm.ts has always built (Anthropic's messages API), which providers.ts turns into an AI SDK call. */
export interface LlmRequest {
  model: string;
  system: string | SystemBlock[];
  max_tokens: number;
  messages: { role: "user"; content: LlmBlock[] }[];
  output_config?: { effort?: Effort; format?: { type: "json_schema"; schema?: object } };
  /** No hidden reasoning for this request (the noThink cost switch). */
  noThinking?: boolean;
}
export interface LlmAnswer {
  content: TextBlock[];
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

// --- cheap collection (cheap-collection.ts; the agent supplies the CollectionAgent) ---
/** The LLM's reading of the task. Only these fields are read here; the rest goes to the model unchanged. */
export interface CollectionContract extends Record<string, unknown> {
  intent?: string;
  objective_field?: string;
  sort_direction?: string;
  ranked_count?: unknown;
  constraints?: unknown[];
}
/** The LLM's claim that the list is already ordered by the objective; its evidence is checked against the page text. */
export interface CollectionPreparation {
  ordering?: {
    field?: string;
    direction?: string;
    starts_at_beginning?: unknown;
    covers_requested_scope?: unknown;
    evidence?: unknown[];
  } | null;
}
export interface PublicInfo {
  url: string;
  text: string;
  truncated?: boolean;
}
export interface DetailScreen {
  img1: string;
  img2: string;
  els?: unknown[];
}
/** A record the agent read: its public text, and whether its detail coverage was incomplete. */
export interface BatchRecord {
  source_id?: string;
  url: string;
  text: string;
  coverage_incomplete?: boolean;
}
/** One fact in the batch answer; the model can send any value, validateBatch checks them. */
export interface BatchFact {
  field?: unknown;
  value?: unknown;
  quote?: unknown;
}
export interface BatchItem {
  source_id?: string;
  source_url?: string;
  facts?: BatchFact[];
  match?: unknown;
  complete?: unknown;
}
export interface BatchAnswer {
  records?: BatchItem[];
}
/** The cost accounting the agent reads off a model call's result, or off the error the call threw (llm.ts and drex.ts
 * attach it to their errors). Any of it may be missing: the agent checks usd and knownCostUsd before it adds them up. */
export interface Accounted {
  readonly usd?: unknown;
  readonly knownCostUsd?: unknown;
  readonly physicalCalls?: number;
  readonly ms?: number;
  readonly model?: unknown;
  readonly usage?: unknown;
  readonly trace?: Record<string, unknown>;
  readonly unreadable?: number;
  readonly unreadableCauses?: string[];
}
/** What cheap-collection uses of the agent. */
export interface CollectionAgent {
  task: string;
  drexCall(state: string, questions: Questions, images: string[]): Promise<DrexReply>;
  log(event: string, data: Record<string, unknown>): void;
  /** Counts the call's time and cost, which it reads off the result. */
  llmCall<T extends Accounted>(kind: string, call: () => Promise<T>): Promise<T>;
  llm: {
    collectBatch(input: {
      task: string;
      contract: CollectionContract;
      records: BatchRecord[];
    }): Promise<LlmResult<BatchAnswer>>;
  };
}
export interface DetailVerdict {
  decision: "match" | "no_match" | "need_more_information";
  confidence: number | undefined;
  needsReveal: boolean;
  next: string | undefined;
  raw: { url: string; text: string; coverage_incomplete: boolean };
  /** Drex's own reading behind the decision: its choices, how sure it was of each, and whether text was cut. */
  reading: { match: string; p: number; coverage: string; coverageP: number; truncated: boolean };
}

// --- LLM answers (llm.ts) ---
/** A step as the LLM wrote it: the schema requires every field, but llm.ts checks none of them, and not every provider enforces a schema. */
export type LlmStep = Partial<Step>;
/** The usage a model reply reports. Only the token counts cost() reads are named. */
export interface ReplyUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number };
}
/** A model reply as call() reads it. The tests' fakes may leave out the usage. */
export interface LlmReply {
  content: { type: string; text?: string }[];
  model: string;
  stop_reason: string;
  usage?: ReplyUsage;
}
/** What one call() cost, summed over its physical requests. `usd` is null when any request's cost is unknown. */
export interface Accounting {
  ms: number;
  usd: number | null;
  knownCostUsd: number;
  costUnknown: boolean;
  usage: Record<string, unknown>;
  model: string;
  physicalCalls: number;
  contextReductions: number;
  contextRetrievals: number;
  contextOverLimit?: boolean;
  /** Where the last request's input went, by part (characters; images counted): logged with the trace cost switch. */
  trace?: Record<string, unknown>;
  /** 200 answers that couldn't be read and were sent again (each settled at its reservation) */
  unreadable?: number;
  /** what each of those answers was, beneath the SDK's wrapper (errors.ts describeError) */
  unreadableCauses?: string[];
}
/** `json` is the parsed answer typed as the fields the caller reads, all optional. A JSON answer of `null` makes call() throw; any other value (a number, a string) comes through with every field undefined, as the old code saw it. It is `null` only for a call without a schema. */
export type LlmResult<T> = Accounting & { text: string; json: T };
/** The run options the LLM reads: the run's limits and which efficiency features are off (a feature is on unless it is false). */
export interface RunOptions {
  limits?: Partial<RunLimits>;
  efficiency?: Record<string, boolean | undefined>;
}
/** A JSON schema the LLM's answer must fit, with the two fields call() extends when it lets the model ask for more page text. */
export type JsonSchema = { properties: Record<string, unknown>; required: string[] } & Record<string, unknown>;

export interface PlanJson {
  summary?: string;
  steps?: LlmStep[];
  answer_from?: string;
}
/** A read, a look or a verify. `complete` is the LLM's own for a done check and derived from availability or verdict for the others. */
export interface ReadJson {
  evidence?: string;
  text?: string;
  next_steps?: LlmStep[];
  complete?: boolean;
  availability?: unknown;
  verdict?: unknown;
}
export interface FillJson {
  why?: string;
  fields?: { label?: string; desired_value?: string; source_kind?: string; source_evidence?: string }[];
  unresolved?: { label?: string; reason?: string }[];
}
export interface ReadinessJson {
  evidence?: string;
  decision?: string;
  next_steps?: LlmStep[];
}
export interface PreparationJson extends CollectionPreparation {
  ready?: boolean;
  evidence?: string;
  sort_available?: boolean;
  observed_sort_direction?: string;
  whole_list_on_page?: boolean;
  steps?: LlmStep[];
}
export interface CollectJson {
  evidence?: string;
  complete?: boolean;
  details?: string[];
  next?: string;
  selection?: { href?: string; facts?: string[]; constraints_satisfied?: boolean; comparison?: string };
  /** A list verified sorted by the objective: each row in order, judged against the constraints from its own text. */
  ordered_rows?: { row?: unknown; verdict?: unknown; quote?: unknown }[];
}
/** The run's own final answer when it ended before its final read: the facts behind it, whether they support it, and
 * the answer in the task's format. */
export interface FinalAnswerJson {
  evidence?: string;
  supported?: boolean;
  answer?: string;
}
export interface WriteJson {
  text?: string;
}
export interface RescueJson {
  why?: string;
  user_need?: string;
  decision?: string;
  option?: string;
  text?: string;
  x?: number;
  y?: number;
  gesture?: {
    kind?: string;
    endX?: number;
    endY?: number;
    key?: string;
    modifiers?: unknown;
    from?: string;
    to?: string;
  };
  new_steps?: LlmStep[];
}

// --- macros (macros.ts; the Agent is `this`) ---
/** The screen as Agent.look() reads it: the elements, the page's title and address, the screenshot and its tagged copy. `shot`, `off` and `vp` are missing in the tests' fakes. */
export interface Looked {
  els: OnScreenEl[];
  off?: OffScreenEl[];
  vp?: Viewport;
  info: { title: string; url: string };
  shot?: Shot;
  img1: string;
  img2: string;
  jpeg: string;
  thumb: string;
}
/** What a step or a move reports to the run loop. Every field is optional; the loop reads the ones it knows. */
export interface Outcome {
  replan?: LlmStep[];
  why?: string;
  fail?: string;
  terminal?: boolean;
  partial?: string;
  blocked?: string;
  dispatched?: boolean;
  stepDone?: boolean;
  reason?: string;
  done?: string;
  ask?: string;
  rejected?: string;
  risky?: boolean;
}
/** What a collect step remembers about one collection, across steps of the same run. */
export interface CollectionMemory {
  epoch: number;
  sources: Map<string, Set<string>>;
  completedDetails: Set<string>;
  verifiedSelections: Map<string, string>;
  raw?: Map<string, BatchRecord | { source_id: string; url: string; text: string }>;
  coverageComplete?: boolean;
  /** Details a sorted-list scan ruled out: a replan back to the list doesn't read them again. */
  ruledOut?: Set<string>;
  /** The first record of a list proven in the requested order that met every condition: the collection's answer. */
  firstQualified?: string;
}
/** What the collect and fill macros use of the Agent. The members the tests' fakes may leave out are optional. */
export interface MacroHost extends CollectionAgent {
  index: number;
  /** A note may hold undefined: the agent stores the LLM's evidence as it came. */
  notes: Record<string, string | undefined>;
  /** The LLM requests the macros make; aggregationSpec and screenRows are collectLite's (the aggregate and listCoverage
   * switches). */
  llm: CollectionAgent["llm"] &
    Pick<
      LLM,
      "collectionContract" | "collectionPreparation" | "collect" | "read" | "fill" | "aggregationSpec" | "screenRows"
    >;
  runOptions?: RunOptions;
  runBudget?: RunBudget;
  trusted?: Set<string>;
  totals: { drexMoves: number };
  collectionTaskContract?: { task: string; contract: CollectionContract } | null;
  collectionPreparationAttempts?: number;
  /** Each list state's preparation check this run (macros' collect: its address and sort/filter controls), with the
   * list position (address fragment and scroll) it was checked at. */
  collectionPreparations?: Map<string, { preparation: PreparationJson; at: string }>;
  collectionMutationEpoch?: number;
  collectionMemory?: Map<string, CollectionMemory>;
  fillObjections?: Map<string, number>;
  /** pickSuggestion: the suggestion the last typing in each field (by node) committed, which fill accepts */
  pickedSuggestions?: Record<number, string>;
  tabs: Map<number, Tab>;
  /** Chrome's tab ids, which its types leave optional. */
  tabBindings?: Map<number, number | undefined>;
  agentTabId: number | null | undefined;
  ownTab: boolean;
  newTabId: number | null | undefined;
  activePlanTab: number | null;
  afterShot: { tabId: number } | null;
  check(): void;
  currentTab(): Promise<Tab>;
  look(tab: Tab): Promise<Looked>;
  /** A tab the agent opens in the window without activating it; Chrome always gives a tab it creates an id. */
  openDetailTab(url: string): Promise<{ id: number }>;
  act(
    tab: Tab,
    act: MoveOption,
    text: string | null,
    scr: Looked,
    history: HistoryEntry[],
    who: Who,
    p: number | undefined,
    note?: string,
    opts?: { prechecked?: boolean; step?: Step | null },
  ): Promise<Outcome | undefined>;
  read(step: Step, opts?: { requeue?: Step }): Promise<Outcome>;
  /** settingReadback: the agent's read-back of a fill step's values once its check passed (verified), which ends the
   * step or goes on with it. */
  readBackFill?(step: Step, verified: Outcome): Promise<Outcome>;
}

// --- the run (agent.ts; background, bridge and the panel read what it reports) ---
/** A step's or a run's status as the agent logs it: a step is running, done or failed, or ends the run partial; a run
 * ends done, failed, partial, stopped (by you), needs_user (a coding agent's run that needs the person) or error. */
export type RunStatus = "running" | "done" | "failed" | "partial" | "stopped" | "needs_user" | "error";
/** Who made a move: Drex, the LLM taking one over, or a macro (collect, fill). */
export type Who = "drex" | "llm" | "macro";
/** Your answer to an approval or a hand-over: false stops, true or "once" goes ahead, "always" goes ahead for the rest of the task. */
export type UserAnswer = boolean | "once" | "always";
/** What the agent tells the panel: an event's type and its data. */
export type Emit = (type: string, data: Record<string, unknown>) => void;
export interface Totals {
  drexUsd: number;
  llmUsd: number;
  drexCalls: number;
  llmCalls: number;
  drexMoves: number;
  llmMoves: number;
  drexItems: number;
  seconds: number;
  waitSeconds: number;
}
/** One entry of the run's log (Agent.record): its type, the seconds since the run started, and the event's data. */
export interface RunEvent {
  type: string;
  t: number;
  [key: string]: unknown;
}
/** The notes a run gathered, by name. A note may hold undefined (the LLM's evidence as it came). */
export type Notes = Record<string, string | undefined>;
/** The agent's tab at the end of a coding agent's run (Agent.report), and how sure Drex is that `expect` holds. */
export interface EndScreen {
  url: string;
  title: string;
  screenshot: string;
  expect?: { statement: string; p: number | undefined };
}
/** The end screen, or why it couldn't be taken, and the page errors seen on the way. */
export type EndReport = (EndScreen | { error: string }) & { problems: Problem[] };
/** What one collection gathered, as an interrupted run reports it. */
export interface CollectionEvidence {
  historical: boolean;
  sources: { source_id: string; facts: string[] }[];
  coverageComplete: boolean;
  completedDetails: string[];
  rawSources: (BatchRecord | { source_id: string; url: string; text: string })[];
  verifiedSelections: [string, string][];
  coverage: string;
}
export interface PartialEvidence {
  notes: Notes;
  collections: CollectionEvidence[];
}
/** What Agent.run() returns. */
export interface RunResult {
  status: RunStatus;
  /** Task completion is distinct from exhausting the planned steps. */
  completion?: { verified: boolean; evidence: string };
  message: string;
  answer: string;
  notes: Notes;
  evidence: PartialEvidence;
  budget: BudgetSnapshot;
  totals: Totals;
  record: RunEvent[];
  report: EndReport | null;
}

// --- the service worker, the panel and the coding-agent link (background.ts, bridge.ts, mcp/server.mjs, sidepanel.ts) ---
/** What the worker settings a run changes (`planning`, `approvals`), and a coding agent's `report`: the statement about the end screen for Drex to check.
 * The local runner (runner/) also passes the run's keys, model, limits and notify setting here, so its keys come from
 * its environment for one run and are never written to the profile's storage. */
export interface RunOver extends Partial<Pick<Settings, KeyName | "drexKey" | "notify">> {
  planning?: boolean;
  approvals?: boolean;
  unattended?: boolean;
  report?: { expect?: string };
  model?: string;
  runLimits?: LimitsInput;
}
/** A finished run, with what the worker adds to it: the build's run mode ("" or "loop", see src/mode.ts) is there so that
 * a run's artifacts show which agent made them. */
export type LastRun = RunResult & { task: string; model: ModelId; planning: boolean; mode: string; started: string };
/** What a panel shows of the run in progress: the events so far, as [type, data] (only the newest of a screen, aim, totals or busy). */
export interface PanelRun {
  task: string;
  model: ModelId;
  running: boolean;
  events: [string, Record<string, unknown>][];
}
/** An "ask" event: an approval or a hand-over. `items` are list rows, shown one per line. */
export interface AskEvent {
  kind?: "approve" | "user";
  message: string;
  items?: string[];
}
/** The states of the coding-agent link, as the worker tells the panel. */
export type BridgeState =
  "off" | "waiting" | "pairing" | "connected" | "no-code" | "wrong-code" | "unpaired-server" | "impostor";

/** The panel to the worker, over the port named "panel". */
export type PanelMessage =
  | { type: "run"; task: string; windowId: number | undefined; over?: RunOver }
  | { type: "stop" }
  | { type: "answer"; value: UserAnswer }
  | { type: "lastRun" };
/** The worker to the panel. `event` carries one agent event (its type and data, without the screen thumbnail). */
export type WorkerMessage =
  | { type: "hello"; run: PanelRun | null; hasRun: boolean; bridge: BridgeState }
  | { type: "running"; on: true; task: string; model: ModelId }
  | { type: "running"; on: false; hasRun: boolean }
  | { type: "event"; event: string; data: Record<string, unknown> }
  | { type: "refused"; why: "busy" | "keys" }
  | { type: "refused"; why: "error"; message: string }
  | { type: "bridge"; state: BridgeState }
  | { type: "lastRun"; run: LastRun | null };

/** What a coding agent's request carries (mcp/server.mjs): `run` reads task, url, expect and plan; `screenshot` and `read` read tab_id. */
export interface BridgeParams {
  task?: string;
  url?: string;
  expect?: string;
  plan?: unknown;
  tab_id?: number;
}
/** The paired server to the extension: the handshake (`challenge`, `welcome`, `denied`), `pong`, or a request {id, method, params}. A request may carry any id; the reply echoes it. */
export interface BridgeIn {
  type?: string;
  v?: number;
  nonce?: unknown;
  proof?: unknown;
  reason?: unknown;
  id?: unknown;
  method?: string;
  params?: BridgeParams | null;
}
/** The extension to the server: `auth` (the proof of the code), `ping`, or the reply to a request. */
export type BridgeOut =
  | { type: "auth"; v: number; nonce: string; proof: string; name: string; version: string }
  | { type: "ping" }
  | { id: unknown; result: unknown }
  | { id: unknown; error: string };
