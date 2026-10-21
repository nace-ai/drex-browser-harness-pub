import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import { domCandidates, publicMetadata } from "./candidates.ts";
import { pointTargetAt } from "./point-target.ts";
import type {
  Box,
  FieldValue,
  GestureResult,
  GestureSpec,
  LocatedEl,
  Notices,
  OffScreenEl,
  OnScreenEl,
  PageElements,
  PageInfo,
  PageItem,
  PointTarget,
  Problem,
  PublicMetadata,
  SliderResult,
  Viewport,
} from "./types.ts";
const METADATA_FN = publicMetadata.toString();
// The agent's eyes and hands in one Chrome tab, over the DevTools protocol (chrome.debugger).
// Ported from ~/drex-cu/drexcu/dom.py: the elements Drex can use come from Chrome's accessibility tree (role, name,
// state, box); clicks and keystrokes are real input events sent into the page, not DOM tricks.

const ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "spinbutton",
  "slider",
  "gridcell",
  "treeitem",
  "row",
  "MenuListOption",
  "ListBoxOption",
  "PopUpButton",
  "ToggleButton",
]);
const NAMELESS_OK = new Set(["textbox", "searchbox", "combobox", "checkbox", "radio", "spinbutton", "slider"]);
const OFFSCREEN_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "dropdown",
  "checkbox",
  "radio",
  "row",
  "tab",
  "searchbox",
  "slider",
]);
const LABEL_ROLE: Record<string, string> = {
  MenuListOption: "option",
  ListBoxOption: "option",
  PopUpButton: "dropdown",
  ToggleButton: "button",
};
const MAX_ELEMENTS = 150;
const LISTENER_CACHE_MS = 5000;
const CLICK_EVENTS = new Set(["click", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"]);
const MAX_OFFSCREEN = 40;
const NAME_CHARS = 120;
const SELECT_INLINE = 30;
const READ_CHARS = 30000;

// Runs on one element: its viewport box (the largest line box for a link that wraps), whether a fixed/sticky layer
// (dialog backdrop, cookie banner) covers its centre, its group of alternatives, and whether it takes typed text.
const BOX_FN = `function () {
  let r = this.getBoundingClientRect();
  const rects = Array.from(this.getClientRects()).filter(q => q.width > 2 && q.height > 2);
  if (rects.length > 1) r = rects.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  if (!r.width || !r.height) return null;
  // a native radio or checkbox hidden to a pixel or two (Magento's star rating: clip: rect(0,0,0,0)) is chosen through
  // its label: the box becomes a point of the label that the label itself answers to (a star, where narrower labels
  // drawn over the wider ones don't cover it), so a real click there sets this control and no other
  if (this.tagName === "INPUT" && (this.type === "radio" || this.type === "checkbox") && (r.width < 4 || r.height < 4)) {
    for (const lab of Array.from(this.labels || [])) {
      const lr = lab.getBoundingClientRect();
      if (!lr.width || !lr.height) continue;
      let hit = null;
      for (let i = 1; i < 16 && !hit; i++) {
        const x = lr.left + (lr.width * i) / 16, y = lr.top + lr.height / 2;
        const t = document.elementFromPoint(x, y);
        // a link or button inside the label (consent text's "Terms") would take the click instead of the control
        const own = t && t.closest("a[href],button");
        if (t && (t === lab || lab.contains(t)) && !(own && lab.contains(own))) hit = [x, y];
      }
      if (hit) { r = { left: hit[0] - 4, top: hit[1] - 4, width: 8, height: 8 }; break; }
    }
  }
  const st = getComputedStyle(this);
  // an invisible native control is still the click target: Material-style radios and checkboxes put an opacity-0
  // <input> over the circle or box they draw (Google Flights' Stops filter), so only other invisible things are skipped
  const control = this.tagName === "INPUT" || ["checkbox", "radio", "switch"].includes(this.getAttribute("role"));
  if (st.visibility === "hidden" || (st.opacity === "0" && !control)) return null;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let covered = false;
  if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
    const top = document.elementFromPoint(cx, cy);
    for (let e = top; e && e !== document.body && !covered; e = e.parentElement) {
      if (e === this || e.contains(this)) break;
      const pos = getComputedStyle(e).position;
      if ((pos === "fixed" || pos === "sticky") && !e.contains(this)) covered = true;
    }
  }
  let group = "";
  if (this.type === "radio" && this.name) group = "r:" + this.name;
  else if (this.parentElement) {
    window.__drexG = window.__drexG || new WeakMap(); window.__drexN = window.__drexN || 0;
    if (!window.__drexG.has(this.parentElement)) window.__drexG.set(this.parentElement, ++window.__drexN);
    group = "p:" + window.__drexG.get(this.parentElement);
  }
  const tag = this.tagName;
  const noText = ["button", "submit", "checkbox", "radio", "reset", "image", "file", "range", "color"];
  const multi = this.isContentEditable || tag === "TEXTAREA";
  // a read-only field (a date picker's input) takes no typing: a click opens what sets it
  const readOnly = this.readOnly === true || this.getAttribute("aria-readonly") === "true";
  const editable = (multi || (tag === "INPUT" && !noText.includes(this.type))) && !readOnly;
  // a form text area, which typing replaces; a code editor's hidden input box (Monaco: GitLab's file editor, Ace,
  // CodeMirror 5) is a <textarea> too, but select-all there selects the whole file, so it is added to like a document
  const form = tag === "TEXTAREA" && !this.closest(".monaco-editor,.ace_editor,.CodeMirror") && r.width > 4 && r.height > 4;
  return [r.left, r.top, r.width, r.height, covered, group, editable, tag === "SELECT", multi, form, readOnly];
}`;
const SELECT_FN = "function () { return [Array.from(this.options).map(o => o.text.trim()), this.selectedIndex]; }";

// Controls that share one label ("Add item to cart" on every menu item, "Edit" on every row) say nothing on their
// own: each gets the text of the nearest card around it (its item, price, sender...), so Drex can tell them apart and
// its history says which one it used. Containers with a lot of text (the whole list) are not a card.
const CONTEXT_CHARS = 120;
const CARD_MAX_CHARS = 400;
// how far up the card may be: a DoorDash carousel card's "+" sits deep inside the picture, far from the dish's name
// (6 levels gave it no text, and Drex clicked an off-screen "Add item to cart" blind); the list and size checks
// below still stop the walk at the list
const CARD_DEPTH = 12;
const CONTEXT_FN = `function () {
  const flat = (t) => (t || "").split(/\\s+/).join(" ").trim();
  const own = flat(this.innerText || this.getAttribute("aria-label") || this.value);
  // controls like this one: same tag and same label (every "Add item to cart"), so a card's other controls styled the
  // same (its Save button) don't make the card look like the list; an ancestor holding several is the list
  const aria = this.getAttribute("aria-label");
  const tag = this.tagName.toLowerCase();
  const sel = aria ? tag + '[aria-label="' + CSS.escape(aria) + '"]' : tag + Array.from(this.classList).map((c) => "." + CSS.escape(c)).join("");
  const label = flat(this.textContent);
  const likeIn = (e) => aria ? e.querySelectorAll(sel).length : Array.from(e.querySelectorAll(sel)).filter((x) => flat(x.textContent) === label).length;
  let e = this.parentElement;
  for (let i = 0; e && i < ${CARD_DEPTH}; i++, e = e.parentElement) {
    if (likeIn(e) > 1) return "";
    const t = flat(e.innerText);
    if (t.length > ${CARD_MAX_CHARS}) return "";
    const rest = own ? flat(t.split(own).join(" ")) : t;
    if (rest.length > 2) return rest.length > ${CONTEXT_CHARS} ? rest.slice(0, ${CONTEXT_CHARS - 3}) + "..." : rest;
  }
  return "";
}`;

// Batch mode: the rows of the page's main list. Candidates are rows, list items, articles and tree items, plus links
// and buttons that come in a long run of siblings (a list built from links); the list is the biggest group of
// same-role siblings. Nothing here knows any site.
const ITEM_ROLES: ReadonlySet<string | undefined> = new Set(["row", "listitem", "article", "treeitem"]);
const LINKISH: ReadonlySet<string | undefined> = new Set(["link", "button"]);
/** Landmarks that hold the site's own chrome (menus, header, footer), not the page's records. */
const CHROME_LANDMARKS: ReadonlySet<string | undefined> = new Set(["navigation", "banner", "contentinfo"]);
const MIN_ITEMS: Record<string, number> = { row: 2, listitem: 2, article: 2, treeitem: 2, link: 5, button: 5 };
const ITEM_TEXT_CHARS = 300;
const CHECKBOX_SEL = "input[type=checkbox], [role=checkbox]";
// One row: its text, whether it has a checkbox (for bulk actions) and whether that is ticked; null when not rendered.
const ITEM_FN = `function () {
  if (!this.isConnected) return null;
  const r = this.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  if (this.querySelector('[role=columnheader], th')) return null;
  const text = (this.innerText || this.textContent || "").split(/\\s+/).join(" ").trim();
  const cb = this.querySelector(${JSON.stringify(CHECKBOX_SEL)});
  const checked = !!cb && (cb.checked === true || cb.getAttribute("aria-checked") === "true");
  return [text.slice(0, ${ITEM_TEXT_CHARS}), !!cb, checked];
}`;
// Scrolls a row's checkbox into view and returns its centre and state, or null.
const CHECKBOX_FN = `function () {
  if (!this.isConnected) return null; // the list re-rendered: this row's node is gone
  const cb = this.querySelector(${JSON.stringify(CHECKBOX_SEL)});
  if (!cb) return null;
  cb.scrollIntoView({ block: "center" });
  const r = cb.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return [r.left + r.width / 2, r.top + r.height / 2, cb.checked === true || cb.getAttribute("aria-checked") === "true"];
}`;
// Where to click to open a row: its first link, else the middle of the row away from its checkbox.
const OPEN_POINT_FN = `function () {
  if (!this.isConnected) return null;
  this.scrollIntoView({ block: "center" });
  const a = this.querySelector("a[href]") || (this.matches("a[href]") ? this : null);
  const r = (a || this).getBoundingClientRect();
  return [r.left + Math.min(r.width / 2, 260), r.top + r.height / 2];
}`;

// The page's readable text: the main content when the page marks it, else the whole body.
const TEXT_EXPR = `(() => {
  const main = document.querySelector("main, article, [role=main]");
  const pick = main && main.innerText.length > 500 ? main : document.body;
  return JSON.stringify([document.title, location.href, (pick && pick.innerText) || ""]);
})()`;

// What the page is showing besides its controls: open dialogs (by their label or heading), notices (alerts, status
// messages, live regions such as an "Item Added!" toast) and the address. Read before and after each move, so the
// history can say what the move did (logic.ts effectOf).
const NOTICES_EXPR = `(() => {
  const flat = (t) => (t || "").split(/\\s+/).join(" ").trim();
  const vis = (e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0"; };
  const label = (e) => flat(e.getAttribute("aria-label") || (e.querySelector("h1, h2, h3, [role=heading]") || {}).innerText || e.innerText).slice(0, 80);
  const dialogs = [...document.querySelectorAll("[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true]")].filter(vis).map(label).filter(Boolean);
  const notes = [...document.querySelectorAll("[role=alert], [role=status], [aria-live=assertive], [aria-live=polite]")].filter(vis)
    .map((e) => flat(e.innerText).slice(0, 80)).filter(Boolean);
  return JSON.stringify({ dialogs: [...new Set(dialogs)], notes: [...new Set(notes)], url: location.href, title: document.title });
})()`;

// The visible cursor: a dark arrow with a "Drex" tag that glides to each target before the click, so a person
// watching the tab (or a recording) sees what the agent is doing. Built with DOM calls, not innerHTML: pages that
// enforce Trusted Types (Gmail, Google Docs) refuse HTML strings. Marked data-drex, so settle() ignores it, and hidden
// while screenshots are taken, so Drex never sees it and "did the screen change?" isn't fooled by it.
const GLIDE_MIN_MS = 180;
const GLIDE_MAX_MS = 420;
const cursorExpr = (x: number, y: number, from: [number, number], ms: number) => `(() => {
  let c = document.getElementById("__drex_cursor");
  if (!c) {
    c = document.createElement("div");
    c.id = "__drex_cursor";
    c.dataset.drex = "cursor";
    c.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(${from[0] - 2}px,${from[1] - 1}px)";
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "22");
    svg.setAttribute("viewBox", "0 0 20 22");
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", "M2 1.5v17l4.6-4.2 3 6.6 3-1.4-3-6.4h6.3z");
    p.setAttribute("fill", "#1d1816");
    p.setAttribute("stroke", "#fff");
    p.setAttribute("stroke-width", "1.5");
    p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p);
    const tag = document.createElement("span");
    tag.textContent = "Drex";
    tag.style.cssText = "position:absolute;left:16px;top:18px;padding:2px 6px;background:#1d1816;color:#fbfaf9;font:600 11px/1.3 Inter,system-ui,sans-serif;white-space:nowrap;box-shadow:0 0 0 1px #fff";
    c.append(svg, tag);
    document.documentElement.appendChild(c);
    c.getBoundingClientRect();
  }
  c.style.transition = "transform ${ms}ms cubic-bezier(.2,0,0,1)";
  c.style.visibility = "visible";
  c.style.transform = "translate(${x - 2}px,${y - 1}px)";
})()`;
const cursorVisibility = (show: boolean) =>
  `(() => { const c = document.getElementById("__drex_cursor"); if (c) c.style.visibility = "${show ? "visible" : "hidden"}"; })()`;

interface KeyDef {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}
const KEYS: Record<"Enter" | "Escape" | "Tab" | "Backspace", KeyDef> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, // no text: a Tab with text types a tab character
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
};
const MAC = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

// Typing key by key with the codes a US keyboard sends, as browser-harness's press_key does (MIT, Browser Use;
// third_party/): inputs run by a framework (React, Vue) can ignore pasted text (Input.insertText) and leave a Submit
// button disabled. Long or multi-line text is still pasted, line by line, which editors handle fine.
const KEY_BY_KEY_MAX = 120;
const PUNCT: Record<string, [string, number]> = {
  "`": ["Backquote", 192],
  "-": ["Minus", 189],
  "=": ["Equal", 187],
  "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  ";": ["Semicolon", 186],
  "'": ["Quote", 222],
  ",": ["Comma", 188],
  ".": ["Period", 190],
  "/": ["Slash", 191],
};
const SHIFTED: Record<string, string> = {
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

/** The physical key for one character on a US layout, or null (accented letters, Cyrillic, emoji: the char event's
 * text alone inserts them). */
export function keyOf(ch: string): { code: string; vk: number; shift: boolean } | null {
  if (ch === " ") return { code: "Space", vk: 32, shift: false };
  const base = SHIFTED[ch] || ch;
  const shift = ch in SHIFTED || /^[A-Z]$/.test(ch);
  if (/^[a-zA-Z]$/.test(base)) return { code: `Key${base.toUpperCase()}`, vk: base.toUpperCase().charCodeAt(0), shift };
  if (/^[0-9]$/.test(base)) return { code: `Digit${base}`, vk: base.charCodeAt(0), shift };
  const punct = PUNCT[base];
  if (punct) return { code: punct[0], vk: punct[1], shift };
  return null;
}

// Tells a framework that the focused input changed (after typing), like browser-harness's fill_input. Only for
// inputs and text areas: rich editors (documents, email bodies) handle typing themselves.
const NOTIFY_EXPR = `(() => {
  let e = document.activeElement;
  while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
  if (!e || !["INPUT", "TEXTAREA"].includes(e.tagName)) return;
  e.dispatchEvent(new Event("input", { bubbles: true }));
  e.dispatchEvent(new Event("change", { bubbles: true }));
})()`;

// Tab-separated text (cells split by tabs, rows by lines) as one paste at the focused editor, the way a spreadsheet
// takes a copied table: Google Sheets fills a cell per value. Typed, every row went into one cell, tabs and all.
// "taken" when the page took the paste; a plain field doesn't (a paste the user didn't make inserts nothing there), and
// says "one-line" for a one-line box (an <input>) and "other" for anything else.
const PASTE_TABLE_FN = `function (text) {
  let e = document.activeElement;
  for (;;) {
    if (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
    else if (e && e.tagName === "IFRAME") {
      let inner = null;
      try { inner = e.contentDocument; } catch (err) { inner = null; }
      if (!inner) break;
      e = inner.activeElement || inner.body;
    } else break;
  }
  if (!e) return "other";
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = text.split("\\n").map((r) => "<tr>" + r.split("\\t").map((c) => "<td>" + esc(c) + "</td>").join("") + "</tr>");
  const data = new DataTransfer();
  data.setData("text/plain", text);
  data.setData("text/html", "<table>" + rows.join("") + "</table>");
  const paste = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
  e.dispatchEvent(paste);
  return paste.defaultPrevented ? "taken" : e.tagName === "INPUT" ? "one-line" : "other";
}`;

// How long the page's DOM has been quiet, from a MutationObserver the probe installs once per document. The click
// ring (data-drex) doesn't count. Replaces polling scaled-down screenshots, which made Chrome re-render the page at
// another size for a frame each time: visible flicker on a Retina screen.
const SETTLE_EXPR = `(() => {
  const w = window;
  if (!w.__drexMO) {
    w.__drexLast = performance.now();
    const ours = (n) => n && n.dataset && n.dataset.drex;
    w.__drexMO = new MutationObserver((ms) => {
      if (ms.some((m) => !ours(m.target) && ![...m.addedNodes, ...m.removedNodes].some(ours))) w.__drexLast = performance.now();
    });
    w.__drexMO.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  return [document.readyState, performance.now() - w.__drexLast];
})()`;
const SLIDER_ARROWS = 200; // arrow presses sent blind; a longer way goes by sliderByKeys, which reads every key
const SLIDER_KEYS = 400;
type SliderKey = "ArrowRight" | "ArrowLeft" | "PageUp" | "PageDown" | "Home" | "End";
const QUIET_MS = 350;
const SETTLE_MAX_MS = 5000;
const LONG_LIVED: ReadonlySet<string | undefined> = new Set([
  "WebSocket",
  "EventSource",
  "Media",
  "Ping",
  "Manifest",
  "Other",
]);
const NET_YOUNG_MS = 1000;

/** Is the page still fetching because of the last move? Only requests that started after the move's input count,
 * and only while they are young: Gmail and other web apps keep a background request open at all times (and reopen
 * it after each action); waiting on those cost ~3 s per move (measured on Gmail and on e2e/site/mail?longpoll=1). */
export function networkBusy(inflight: ReadonlyMap<string, number>, inputAt: number, now: number): boolean {
  for (const startedAt of inflight.values())
    if (startedAt >= inputAt - 50 && now - startedAt < NET_YOUNG_MS) return true;
  return false;
}
const SHOT_TIMEOUT_MS = 5000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Why a signal fired, as an Error (the run's Stop aborts with one). */
export const abortReason = (s: AbortSignal): Error =>
  s.reason instanceof Error ? s.reason : new Error(String(s.reason));
const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

type Meta = Partial<PublicMetadata>;
/** Box FN's answer: left, top, width, height, covered by a layer, group, takes typed text, is a select, multi-line. */
type BoxInfo = [number, number, number, number, boolean, string, boolean, boolean, boolean, boolean, boolean];
type Found = Omit<LocatedEl, "label" | "box">;
type OnScreen = Omit<OnScreenEl, "label">;
type OffScreen = Omit<OffScreenEl, "label">;
type Described = Omit<Protocol.Runtime.PropertyDescriptor, "value"> & {
  value: Protocol.Runtime.RemoteObject & { objectId: string };
};
interface Cand {
  id: number;
  value?: string | number;
  role: string;
  props: Record<string, unknown>;
  name: string;
}
type ModName = "Alt" | "Control" | "Meta" | "Shift";
type ChordKey =
  | "Enter"
  | "Escape"
  | "Tab"
  | "Backspace"
  | "Delete"
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown"
  | "Space"
  | "a"
  | "z"
  | "y";

const hasKey = <T extends object>(o: T, k: PropertyKey): k is keyof T => Object.hasOwn(o, k);
/** Debugger events with no parameters (Runtime.executionContextsCleared) arrive without `params`; the ones read here always have them. */
const need = (params: object | undefined): object => {
  if (!params) throw new TypeError("debugger event without params");
  return params;
};

export class Tab {
  declare id: number;
  declare target: { tabId: number };
  declare inflight: Map<string, number>;
  declare inputAt: number;
  declare ringUntil: number;
  declare overlay: boolean;
  declare cursorAt: [number, number] | null;
  declare diagnostics: boolean;
  declare problems: Problem[];
  declare urls: Map<string, string>;
  declare onEvent: (src: chrome.debugger.DebuggerSession, method: string, params?: object) => void;
  /** The run's Stop: once it fires, every command waiting for Chrome rejects with its reason. */
  declare signal: AbortSignal | undefined;
  declare listenerCache: Map<number, { at: number; present: boolean }>;

  constructor(id: number) {
    this.id = id;
    this.target = { tabId: id };
    this.inflight = new Map(); // request id -> when it started, for settle()
    this.inputAt = 0; // when the last input event (click, key, typing, scroll) was sent
    this.ringUntil = 0;
    this.overlay = true; // the visible cursor and click ring (the "Show Drex's cursor" setting)
    this.cursorAt = null; // where the cursor was last put (it starts there again on a new page)
    // for a coding agent: console errors, uncaught exceptions and failed requests. Off by default: Runtime.enable is
    // one of the things bot checks (Cloudflare) look for
    this.diagnostics = false;
    this.problems = [];
    this.listenerCache = new Map(); // backend node id -> whether it has a click listener, for clickListener()
    this.urls = new Map(); // request id -> "GET https://...", to name a failed request
    this.onEvent = (src, method, params) => {
      if (src.tabId !== this.id) return;
      if (method === "Network.requestWillBeSent") {
        const e = need(params) as Protocol.Network.RequestWillBeSentEvent;
        if (!LONG_LIVED.has(e.type)) this.inflight.set(e.requestId, performance.now());
      } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed")
        this.inflight.delete((need(params) as Protocol.Network.LoadingFinishedEvent).requestId);
      else if (method === "Page.frameNavigated" && !(need(params) as Protocol.Page.FrameNavigatedEvent).frame.parentId)
        this.inflight.clear();
      if (this.diagnostics) this.noteProblem(method, params);
    };
  }

  noteProblem(method: string, params: object | undefined): void {
    let p: Problem | null = null;
    if (method === "Network.requestWillBeSent") {
      const e = need(params) as Protocol.Network.RequestWillBeSentEvent;
      this.urls.set(e.requestId, `${e.request.method} ${e.request.url}`);
    } else if (method === "Network.loadingFinished")
      this.urls.delete((need(params) as Protocol.Network.LoadingFinishedEvent).requestId);
    else if (method === "Network.responseReceived") {
      const e = need(params) as Protocol.Network.ResponseReceivedEvent;
      if (e.response.status >= 400)
        p = { kind: `HTTP ${e.response.status}`, text: this.urls.get(e.requestId) || e.response.url };
    } else if (method === "Network.loadingFailed") {
      const e = need(params) as Protocol.Network.LoadingFailedEvent;
      if (!e.canceled) p = { kind: "request failed", text: `${e.errorText} ${this.urls.get(e.requestId) ?? ""}` };
    } else if (method === "Runtime.exceptionThrown") {
      const d = (need(params) as Protocol.Runtime.ExceptionThrownEvent).exceptionDetails;
      p = { kind: "exception", text: d.exception?.description || d.text, url: d.url };
    } else if (method === "Runtime.consoleAPICalled") {
      const e = need(params) as Protocol.Runtime.ConsoleAPICalledEvent;
      if (e.type === "error" || e.type === "assert")
        p = {
          kind: `console.${e.type}`,
          text: e.args.map((a): unknown => a.value ?? a.description ?? "").join(" "),
          url: e.stackTrace?.callFrames[0]?.url,
        };
    }
    if (method === "Network.loadingFailed")
      this.urls.delete((need(params) as Protocol.Network.LoadingFailedEvent).requestId);
    if (!p || this.problems.length >= 30) return;
    p.text = p.text.trim().slice(0, 300);
    const { kind, text } = p;
    if (!this.problems.some((q) => q.kind === kind && q.text === text)) this.problems.push(p);
  }

  /** background: the tab may stay behind other tabs; focus is emulated so pages that check focus still work and
   * Chrome is asked to keep the page running (browser-harness works the same way). */
  async attach({ background = false }: { background?: boolean } = {}): Promise<void> {
    try {
      await this.answer(chrome.debugger.attach(this.target, "1.3"));
    } catch (e) {
      if (!/already attached/i.test((e as Error).message)) throw e;
    }
    chrome.debugger.onEvent.addListener(this.onEvent);
    await this.send("Page.enable").catch(() => undefined);
    await this.send("Network.enable").catch(() => undefined);
    if (this.diagnostics) await this.send("Runtime.enable").catch(() => undefined);
    if (background) await this.setBackground(true);
  }

  async setBackground(on: boolean): Promise<void> {
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: on }).catch(() => undefined);
    if (on) await this.send("Page.setWebLifecycleState", { state: "active" }).catch(() => undefined);
  }

  async detach(): Promise<void> {
    chrome.debugger.onEvent.removeListener(this.onEvent);
    await chrome.debugger.detach(this.target).catch(() => undefined);
  }

  /** One DevTools command. The reply is typed from the protocol, as Chrome documents it. */
  send<M extends keyof ProtocolMapping.Commands>(
    method: M,
    params?: ProtocolMapping.Commands[M]["paramsType"][0],
  ): Promise<ProtocolMapping.Commands[M]["returnType"]> {
    return this.answer(chrome.debugger.sendCommand(this.target, method, (params ?? {}) as Record<string, unknown>));
  }

  /** Chrome's answer, unless the run stops first: a command Chrome never answers must not keep Stop from working. */
  async answer<T>(reply: Promise<T>): Promise<T> {
    const signal = this.signal;
    if (!signal) return reply;
    if (signal.aborted) throw abortReason(signal);
    let onAbort = (): void => undefined;
    try {
      return await Promise.race([
        reply,
        new Promise<never>((_, reject) => {
          onAbort = () => {
            reject(abortReason(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Runs an expression in the page. What it returns is the page script's own business: callers cast it. */
  async eval(expression: string): Promise<unknown> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.text}`);
    return r.result.value;
  }

  /** Calls a function declaration with `this` set to the DOM node. As with eval, callers cast the result. */
  async on(node: number, fn: string): Promise<unknown> {
    const { object } = await this.send("DOM.resolveNode", { backendNodeId: node, objectGroup: "drex" });
    const r = await this.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: fn,
      returnByValue: true,
    });
    return r.result.value;
  }

  async viewport(): Promise<Viewport> {
    const [w, h] = (await this.eval("[innerWidth, innerHeight]")) as [number, number];
    return { w, h };
  }

  async notices(): Promise<Notices> {
    return JSON.parse((await this.eval(NOTICES_EXPR)) as string) as Notices;
  }

  /** Title, URL and readable text of the page (for read steps and the agent's notes). */
  async info(limit = READ_CHARS): Promise<PageInfo> {
    const [title, url, body] = JSON.parse((await this.eval(TEXT_EXPR)) as string) as [string, string, string];
    const text = body
      .split("\n")
      .map((l) => l.split(/\s+/).join(" ").trim())
      .filter(Boolean)
      .join("\n");
    return { title, url, text: text.slice(0, limit), truncated: text.length > limit, chars: text.length };
  }

  /** Has this element a click-like listener of its own? DOMDebugger answers under chrome.debugger, where the
   * command-line getEventListeners is missing. Answers are kept for a few seconds per node: a page reads its elements
   * after every move, and its tiles' listeners don't change between two moves. */
  async clickListener(id: number, objectId: string): Promise<boolean> {
    const now = performance.now();
    const cached = this.listenerCache.get(id);
    if (cached && now - cached.at < LISTENER_CACHE_MS) return cached.present;
    let present: boolean;
    try {
      const { listeners } = await this.send("DOMDebugger.getEventListeners", { objectId });
      present = listeners.some((l) => CLICK_EVENTS.has(l.type));
    } catch {
      return false;
    }
    this.listenerCache.set(id, { at: now, present });
    const oldest = this.listenerCache.keys().next();
    if (this.listenerCache.size > 512 && !oldest.done) this.listenerCache.delete(oldest.value);
    return present;
  }

  /** On-screen interactive elements in reading order (E1, E2, ...) and the nearest ones above/below the screen (D1, ...). */
  async elements(): Promise<PageElements> {
    const vp = await this.viewport();
    const scroll = (await this.eval("[scrollX, scrollY]")) as [number, number];
    const { nodes } = await this.send("Accessibility.getFullAXTree");
    const cands: Cand[] = [];
    for (const n of nodes) {
      const id = n.backendDOMNodeId;
      if (n.ignored || !id) continue;
      const role = (n.role?.value || "") as string;
      const props: Record<string, unknown> = Object.fromEntries(
        (n.properties ?? []).map(
          (
            p: Pick<Protocol.Accessibility.AXProperty, "name"> & { value?: Partial<Protocol.Accessibility.AXValue> },
          ): [string, unknown] => [p.name, p.value?.value],
        ),
      );
      if (!ROLES.has(role) && !props.focusable) continue;
      if (role === "row" && !props.focusable) continue; // table rows only when the app made them clickable
      const name = String(n.name?.value || "")
        .split(/\s+/)
        .join(" ")
        .trim();
      if (!name && !NAMELESS_OK.has(role)) continue;
      if ((role === "MenuListOption" || role === "option") && !props.focusable) continue; // a closed dropdown's options
      cands.push({ id, value: n.value?.value as string | number | undefined, role, props, name });
    }
    // The accessibility tree's own name and state cover named nodes; only nameless ones and sliders (for their range)
    // get a look at the DOM.
    const reads: unknown[] = cands.map((c) =>
      !c.name || c.role === "slider" ? this.on(c.id, METADATA_FN).catch(() => ({})) : {},
    );
    const metadata = (await Promise.all(reads)) as Meta[];
    // Clickable things the accessibility tree misses (a canvas, a div with a click handler): one call finds them and
    // reads their metadata, and their backend node ids are resolved in parallel.
    const known = new Set(cands.map((c) => c.id));
    const extra: Partial<Protocol.Runtime.EvaluateResponse> | null = await this.send("Runtime.evaluate", {
      expression: `(${domCandidates.toString()})({ probeListeners: true })`,
      includeCommandLineAPI: true,
      objectGroup: "drex",
    }).catch(() => null);
    if (extra?.result?.objectId) {
      const objectId = extra.result.objectId;
      const [metas, props] = await Promise.all([
        this.send("Runtime.callFunctionOn", {
          objectId,
          returnByValue: true,
          functionDeclaration: `function () { const meta = ${METADATA_FN}; return this.map((e) => meta.call(e)); }`,
        })
          .then((r) => (r.result.value || []) as PublicMetadata[])
          .catch(() => []),
        this.send("Runtime.getProperties", { objectId, ownProperties: true })
          .then((r) => r.result)
          .catch((): Protocol.Runtime.PropertyDescriptor[] => []),
      ]);
      const items = props.filter((p): p is Described => /^\d+$/.test(p.name) && !!p.value?.objectId);
      const described: (Partial<Protocol.DOM.DescribeNodeResponse> | null)[] = await Promise.all(
        items.map((p) => this.send("DOM.describeNode", { objectId: p.value.objectId }).catch(() => null)),
      );
      // the probed elements count only with a click-like listener of their own (event types only, never handler code)
      const probeFrom = Number(props.find((p) => p.name === "probeFrom")?.value?.value ?? Infinity);
      const listening = await Promise.all(
        items.map((p, i) => {
          const id = described[i]?.node?.backendNodeId;
          return Number(p.name) < probeFrom || !id || known.has(id)
            ? Promise.resolve(true)
            : this.clickListener(id, p.value.objectId);
        }),
      );
      items.forEach((p, i) => {
        const id = described[i]?.node?.backendNodeId;
        const meta = metas[Number(p.name)];
        if (!id || !meta || !listening[i]) return;
        if (known.has(id)) {
          // Pager metadata was read in the one batched DOM call above, not one
          // extra protocol call for every named link in the accessibility tree.
          const index = cands.findIndex((c) => c.id === id);
          metadata[index] = { ...metadata[index], ...meta };
          return;
        }
        known.add(id);
        cands.push({ id, role: meta.role, name: meta.name, props: { disabled: meta.disabled, checked: meta.checked } });
        metadata.push(meta);
      });
    }
    const boxes = (await Promise.all(cands.map((c) => this.on(c.id, BOX_FN).catch(() => null)))) as (BoxInfo | null)[];
    const found: OnScreen[] = [];
    const off: OffScreen[] = [];
    cands.forEach((c, i) => {
      const box = boxes[i];
      if (!box) return;
      const [x, y, w, h, covered, group, editable, isSelect, multi, textarea, readOnly] = box;
      if (covered) return; // behind a dialog's backdrop or a banner: not clickable now
      const meta = metadata[i] ?? {};
      if (meta.appLink) return; // tel:/mailto:/sms: open another app, not a page
      if (!c.name && meta.name) c.name = meta.name;
      const role = LABEL_ROLE[c.role] || (c.role === "combobox" && !editable ? "dropdown" : c.role);
      const value = String(c.value || "");
      const popup = c.props.hasPopup;
      // a menu, not a dialog, listbox or grid a "Delete..." item may open (the approval gate lets a submenu through)
      const submenu =
        role === "menuitem" && (popup === "menu" || popup === "true" || popup === true) && c.props.expanded !== true;
      const field = editable && !isSelect;
      const state = [
        c.props.disabled ? " (disabled)" : "",
        c.props.checked === "true" || c.props.checked === true
          ? " (checked)"
          : ["checkbox", "radio", "switch"].includes(c.role)
            ? " (not checked)"
            : "",
        c.props.selected ? " (selected)" : "",
        c.props.focused ? " (focused)" : "",
        submenu ? " (has a submenu)" : "",
        field && textarea ? " (multi-line text area)" : "",
        readOnly && !field ? " (read-only: click it to open what sets it)" : "",
        meta.color ? ` (color: ${meta.color})` : "",
        value ? ` (shows '${value.slice(0, 50)}')` : field ? " (empty)" : "",
      ].join("");
      const text = c.name ? `${role} '${c.name.slice(0, NAME_CHARS)}'` : `${role} (no label)`;
      const checkable = ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(c.role);
      const checked = Object.hasOwn(meta, "checked")
        ? { checked: meta.checked, indeterminate: meta.indeterminate }
        : checkable
          ? {
              checked: c.props.checked === "true" || c.props.checked === true,
              indeterminate: c.props.checked === "mixed",
            }
          : {};
      const el: Found = {
        text,
        name: c.name,
        role,
        state,
        node: c.id,
        group,
        field,
        multi: field && multi,
        ...(field && textarea ? { textarea: true } : {}),
        select: isSelect,
        documentPosition: [x + scroll[0], y + scroll[1], w, h],
        paginationURL: meta.paginationURL || "",
        paginationLabel: meta.paginationLabel || "",
        ...checked,
        ...(submenu ? { submenu } : {}),
        ...(meta.slider ? { slider: meta.slider } : {}),
      };
      if (y >= vp.h || y + h <= 0) {
        if ((c.name || ["checkbox", "radio", "slider"].includes(role)) && OFFSCREEN_ROLES.has(role)) {
          const dist = y >= vp.h ? (y - vp.h) / vp.h + 1 : -y / vp.h;
          off.push({ ...el, dist, where: `${dist.toFixed(1)} screens ${y >= vp.h ? "down" : "up"}` });
        }
        return;
      }
      if (x + w <= 0 || x >= vp.w) return;
      const box4: Box = [Math.max(x, 0), Math.max(y, 0), Math.min(x + w, vp.w), Math.min(y + h, vp.h)];
      if (box4[2] - box4[0] < 3 || box4[3] - box4[1] < 3) return;
      found.push({ ...el, box: box4 });
    });
    // controls whose role and label repeat get their card's text as context (only they: a context that changes with the
    // page, like a countdown next to a button, would make the same control look new on every move)
    const count = new Map<string, number>();
    for (const e of [...found, ...off]) count.set(e.text, (count.get(e.text) ?? 0) + 1);
    const shared = [...found, ...off].filter((e) => (count.get(e.text) ?? 0) > 1);
    const contexts = (await Promise.all(shared.map((e) => this.on(e.node, CONTEXT_FN).catch(() => "")))) as string[];
    shared.forEach((e, i) => {
      const context = contexts[i];
      if (context) e.context = context;
    });
    // Repeated controls may each live under a different wrapper. Label their shared rendered geometry,
    // not their immediate parent's child index. Document positions remain stable after scrolling.
    const repeated = new Map<string, Found[]>();
    for (const e of [...found, ...off]) {
      const key = `${e.role}\u0000${e.name ?? ""}`;
      let list = repeated.get(key);
      if (!list) {
        list = [];
        repeated.set(key, list);
      }
      list.push(e);
    }
    for (const group of repeated.values()) {
      if (group.length < 2) continue;
      const ordered = [...group].sort(
        (a, b) => a.documentPosition[1] - b.documentPosition[1] || a.documentPosition[0] - b.documentPosition[0],
      );
      const rows: { cy: number; height: number; items: Found[] }[] = [];
      for (const e of ordered) {
        const [, y, , h] = e.documentPosition;
        const cy = y + h / 2;
        let row = rows.find((r) => Math.abs(r.cy - cy) <= Math.max(4, Math.min(r.height, h) * 0.4));
        if (!row) {
          row = { cy, height: h, items: [] };
          rows.push(row);
        }
        row.items.push(e);
      }
      let ordinal = 0;
      rows
        .sort((a, b) => a.cy - b.cy)
        .forEach((row, ri) => {
          row.items.sort((a, b) => a.documentPosition[0] - b.documentPosition[0]);
          row.items.forEach((e, ci) => {
            ordinal++;
            const local = e.context ?? "";
            e.grid = { row: ri + 1, column: ci + 1, ordinal, total: group.length };
            const position = `grid row ${ri + 1}, column ${ci + 1}; ${e.role} ${ordinal} of ${group.length}`;
            e.context = [local, position].filter(Boolean).join("; ");
          });
        });
    }
    found.sort(
      (a, b) =>
        Number(!!b.paginationURL) - Number(!!a.paginationURL) ||
        Math.floor(a.box[1] / 10) - Math.floor(b.box[1] / 10) ||
        a.box[0] - b.box[0],
    );
    const els: OnScreenEl[] = [];
    const seen = new Set<string>();
    for (const e of found) {
      const k = `${e.text}|${e.box.map(Math.round).join(",")}`;
      if (seen.has(k)) continue;
      seen.add(k);
      els.push({ ...e, label: `E${els.length + 1}` });
      if (els.length >= MAX_ELEMENTS) break;
    }
    for (const e of els.filter((e) => e.select)) {
      try {
        const [names, idx] = (await this.on(e.node, SELECT_FN)) as [string[], number];
        if (names.length <= SELECT_INLINE) Object.assign(e, { options: names, selectedIndex: idx });
      } catch {}
    }
    off.sort((a, b) => Number(!!b.paginationURL) - Number(!!a.paginationURL) || a.dist - b.dist);
    const offscreen: OffScreenEl[] = [];
    const seenOff = new Set<string>();
    for (const d of off) {
      if (seenOff.has(`${d.text}|${d.context ?? ""}`)) continue;
      seenOff.add(`${d.text}|${d.context ?? ""}`);
      offscreen.push({ ...d, label: `D${offscreen.length + 1}` });
      if (offscreen.length >= MAX_OFFSCREEN) break;
    }
    // off-screen options have no picture, only words: each also gets the text around it, so "Wonton Soup" inside a
    // customer review reads differently from the dish on the menu
    const bare = offscreen.filter((d) => !d.context);
    const around = (await Promise.all(bare.map((d) => this.on(d.node, CONTEXT_FN).catch(() => "")))) as string[];
    bare.forEach((d, i) => {
      const context = around[i];
      if (context) d.context = context;
    });
    await this.send("Runtime.releaseObjectGroup", { objectGroup: "drex" }).catch(() => undefined);
    return { els, off: offscreen, vp };
  }

  /** The rows of the page's main list (batch mode): [{key, text, node, checkbox, checked}]. */
  async items(): Promise<PageItem[]> {
    const { nodes } = await this.send("Accessibility.getFullAXTree");
    const parent = new Map<string, string>();
    for (const n of nodes) for (const c of n.childIds ?? []) parent.set(c, n.nodeId);
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const groups = new Map<string, { id: number; nodeId: string }[]>();
    for (const n of nodes) {
      const role = n.role?.value as string | undefined;
      const id = n.backendDOMNodeId;
      if (n.ignored || !id || !(ITEM_ROLES.has(role) || LINKISH.has(role))) continue;
      const k = `${String(parent.get(n.nodeId))}|${String(role)}`;
      let list = groups.get(k);
      if (!list) {
        list = [];
        groups.set(k, list);
      }
      list.push({ id, nodeId: n.nodeId });
    }
    // The page's records, not its menus: a list inside the site's navigation, header or footer is passed over when
    // another list qualifies, and of the few largest lists left the one with the most text wins (a store's account
    // menu has 11 short links, its order table 10 rows of number, date, total and status; a filter sidebar's
    // "Home Audio 215 item" entries are shorter than the products beside them)
    const landmark = (nodeId: string): boolean => {
      for (let at = parent.get(nodeId), depth = 0; at !== undefined && depth < 40; at = parent.get(at), depth++)
        if (CHROME_LANDMARKS.has(byId.get(at)?.role?.value as string | undefined)) return true;
      return false;
    };
    const sized = [...groups]
      .filter(([k, g]) => g.length >= (MIN_ITEMS[k.split("|")[1] ?? ""] ?? Infinity))
      .sort((a, b) => b[1].length - a[1].length);
    const content = sized.filter(([, g]) => !landmark(g[0]?.nodeId ?? ""));
    const contenders = (content.length ? content : sized).slice(0, 4).map(([, g]) => g);
    const read = async (g: { id: number }[]) =>
      (await Promise.all(g.map((n) => this.on(n.id, ITEM_FN).catch(() => null)))) as (
        [string, boolean, boolean] | null
      )[];
    let best: { id: number }[] = [];
    let infos: ([string, boolean, boolean] | null)[] = [];
    let bestText = -1;
    for (const g of contenders) {
      const got = await read(g);
      const text = got.reduce((sum, info) => sum + Math.min(info?.[0]?.length ?? 0, ITEM_TEXT_CHARS), 0);
      if (text > bestText) {
        best = g;
        infos = got;
        bestText = text;
      }
    }
    await this.send("Runtime.releaseObjectGroup", { objectGroup: "drex" }).catch(() => undefined);
    const out: PageItem[] = [];
    best.forEach((n, i) => {
      const info = infos[i];
      if (!info?.[0]) return;
      out.push({
        key: info[0].toLowerCase().slice(0, 160),
        text: info[0],
        node: n.id,
        checkbox: info[1],
        checked: info[2],
      });
    });
    return out;
  }

  /** Ticks a row's checkbox with a real click (scrolled into view first); true when it ends up ticked. */
  async tick(node: number): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cb = (await this.on(node, CHECKBOX_FN).catch(() => null)) as [number, number, boolean] | null;
      if (!cb) return false;
      if (cb[2]) return true;
      await this.click(cb[0], cb[1]);
      await sleep(120);
    }
    const cb = (await this.on(node, CHECKBOX_FN).catch(() => null)) as [number, number, boolean] | null;
    return !!cb && cb[2];
  }

  /** Opens a row (clicks its link, or the row itself). */
  async openItem(node: number): Promise<void> {
    const pt = (await this.on(node, OPEN_POINT_FN)) as [number, number] | null;
    if (!pt) throw new Error("the row is no longer on the page");
    await sleep(150);
    await this.click(pt[0], pt[1]);
  }

  async screenshot(): Promise<string> {
    if (this.overlay && this.cursorAt) await this.eval(cursorVisibility(false)).catch(() => undefined);
    try {
      const { data } = await withTimeout(
        this.send("Page.captureScreenshot", { format: "jpeg", quality: 85 }),
        SHOT_TIMEOUT_MS,
        "screenshot",
      );
      return data;
    } finally {
      if (this.overlay && this.cursorAt) await this.eval(cursorVisibility(true)).catch(() => undefined);
    }
  }

  // --- hands --------------------------------------------------------------------------------------------------------

  /** Glides the visible cursor to (x, y) and waits for it to arrive (longer moves take a little longer). */
  async moveCursor(x: number, y: number): Promise<void> {
    if (!this.overlay) return;
    const from: [number, number] = this.cursorAt ?? [x - 80, y - 50];
    const ms = Math.round(Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, Math.hypot(x - from[0], y - from[1]) * 0.6)));
    await this.eval(cursorExpr(x, y, from, ms)).catch(() => undefined);
    this.cursorAt = [x, y];
    await sleep(ms);
  }

  /** A short ring where the agent clicks, so a person watching (or a screen recording) sees each move. */
  async pulse(x: number, y: number): Promise<void> {
    if (!this.overlay) return;
    const css =
      `position:fixed;left:${x - 15}px;top:${y - 15}px;width:30px;height:30px;border-radius:50%;box-sizing:border-box;` +
      "border:2px solid #1d1816;background:rgba(29,24,22,.12);box-shadow:0 0 0 2px rgba(255,255,255,.8);z-index:2147483646;pointer-events:none;" +
      "transition:transform .45s ease-out,opacity .45s ease-out";
    this.ringUntil = performance.now() + 560;
    await this.eval(
      `(() => { const d = document.createElement("div"); d.dataset.drex = "ring"; d.style.cssText = ${JSON.stringify(css)};
      document.documentElement.appendChild(d);
      requestAnimationFrame(() => requestAnimationFrame(() => { d.style.transform = "scale(1.9)"; d.style.opacity = "0"; }));
      setTimeout(() => d.remove(), 520); })()`,
    ).catch(() => undefined);
  }

  async click(x: number, y: number): Promise<void> {
    await this.moveCursor(x, y);
    await this.pulse(x, y);
    this.inputAt = performance.now();
    const base = { x, y, button: "left", clickCount: 1 } as const;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }

  /** Points at (x, y) without clicking, as a person moving the mouse there: menus open their submenus on it. */
  async hover(x: number, y: number): Promise<void> {
    await this.moveCursor(x, y);
    this.inputAt = performance.now();
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(250);
  }

  /** What a click at (x, y) would land on, for the approval gate: read with the mouse already there (hover: true),
   * so a control that only shows on hover (a Delete over a photo) is what is found. null when the page can't say. */
  async pointTarget(x: number, y: number, { hover = true }: { hover?: boolean } = {}): Promise<PointTarget | null> {
    if (hover) await this.hover(x, y);
    return (await this.eval(`(${pointTargetAt.toString()})(${x}, ${y})`)) as PointTarget | null;
  }

  /** Bounded real browser gestures. Coordinates are CSS pixels of the original viewport. */
  async gesture(spec: GestureSpec | null | undefined): Promise<GestureResult> {
    const kinds = new Set(["hover", "double_click", "drag", "keychord"]);
    if (!spec || !kinds.has(spec.kind)) throw new Error("Unknown browser gesture");
    this.inputAt = performance.now();
    if (spec.kind === "keychord") {
      const keys: Record<ChordKey, [string, number]> = {
        Enter: ["Enter", 13],
        Escape: ["Escape", 27],
        Tab: ["Tab", 9],
        Backspace: ["Backspace", 8],
        Delete: ["Delete", 46],
        ArrowLeft: ["ArrowLeft", 37],
        ArrowUp: ["ArrowUp", 38],
        ArrowRight: ["ArrowRight", 39],
        ArrowDown: ["ArrowDown", 40],
        Home: ["Home", 36],
        End: ["End", 35],
        PageUp: ["PageUp", 33],
        PageDown: ["PageDown", 34],
        Space: ["Space", 32],
        a: ["KeyA", 65],
        z: ["KeyZ", 90],
        y: ["KeyY", 89],
      };
      const mods: Record<ModName, { code: string; vk: number; bit: number }> = {
        Alt: { code: "AltLeft", vk: 18, bit: 1 },
        Control: { code: "ControlLeft", vk: 17, bit: 2 },
        Meta: { code: "MetaLeft", vk: 91, bit: 4 },
        Shift: { code: "ShiftLeft", vk: 16, bit: 8 },
      };
      const isMod = (m: unknown): m is ModName => typeof m === "string" && hasKey(mods, m);
      const modifiers = spec.modifiers ?? [];
      if (
        spec.key === undefined ||
        !hasKey(keys, spec.key) ||
        !Array.isArray(modifiers) ||
        modifiers.length > 4 ||
        !modifiers.every(isMod) ||
        new Set(modifiers).size !== modifiers.length
      )
        throw new Error("Unsupported page key or modifier");
      // Exclude browser/OS shortcut combinations; permit page focus/selection/editing only.
      if (modifiers.includes("Alt") || (modifiers.includes("Control") && modifiers.includes("Meta")))
        throw new Error("Browser-global modifier combination is not allowed");
      const command = modifiers.includes("Control") || modifiers.includes("Meta");
      if (
        (["a", "y", "z"].includes(spec.key) && !command) ||
        (command &&
          ![
            "a",
            "y",
            "z",
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Home",
            "End",
            "Backspace",
            "Delete",
          ].includes(spec.key))
      )
        throw new Error("Only page editing/navigation key combinations are allowed");
      const [code, vk] = keys[spec.key],
        key = spec.key === "Space" ? " " : spec.key;
      let mask = 0;
      const pressed: ModName[] = [];
      try {
        for (const modifier of modifiers) {
          const m = mods[modifier];
          mask |= m.bit;
          pressed.push(modifier);
          await this.send("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: modifier,
            code: m.code,
            windowsVirtualKeyCode: m.vk,
            modifiers: mask,
          });
        }
        const text = !command && spec.key === "Enter" ? "\r" : !command && spec.key === "Space" ? " " : undefined;
        await this.send("Input.dispatchKeyEvent", {
          type: text ? "keyDown" : "rawKeyDown",
          key,
          code,
          windowsVirtualKeyCode: vk,
          modifiers: mask,
          ...(text ? { text } : {}),
          ...(command && spec.key === "a" ? { commands: ["selectAll"] } : {}),
        });
      } finally {
        let releaseFailure = null as Error | null;
        await this.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
          code,
          windowsVirtualKeyCode: vk,
          modifiers: mask,
        }).catch((e: unknown) => {
          releaseFailure = e as Error;
        });
        for (const modifier of pressed.reverse()) {
          const m = mods[modifier];
          mask &= ~m.bit;
          await this.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: modifier,
            code: m.code,
            windowsVirtualKeyCode: m.vk,
            modifiers: mask,
          }).catch((e: unknown) => {
            releaseFailure = e as Error;
          });
        }
        // eslint-disable-next-line no-unsafe-finally -- a modifier key left pressed must surface even over the try's own error
        if (releaseFailure) throw new Error("Could not confirm gesture key release: " + releaseFailure.message);
      }
      return { kind: spec.kind, key: spec.key, modifiers, released: true };
    }
    const { w, h } = await this.viewport();
    const valid = (x: number | undefined, y: number | undefined) =>
      x !== undefined &&
      y !== undefined &&
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      x >= 0 &&
      y >= 0 &&
      x < w &&
      y < h;
    if (
      spec.x === undefined ||
      spec.y === undefined ||
      !valid(spec.x, spec.y) ||
      (spec.kind === "drag" && !valid(spec.endX, spec.endY))
    )
      throw new Error("Gesture coordinates must be inside the current viewport");
    if ((spec.modifiers as { length?: unknown } | null | undefined)?.length)
      throw new Error("Pointer gesture modifiers are not supported");
    const endX = Number(spec.endX),
      endY = Number(spec.endY); // for a drag valid() checked them above; the other kinds never read them
    let x = spec.x,
      y = spec.y,
      pressed = false;
    try {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
      if (spec.kind === "hover") {
        await sleep(250);
        return { kind: spec.kind, x, y };
      }
      if (spec.kind === "double_click") {
        for (const clickCount of [1, 2]) {
          pressed = true;
          await this.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x,
            y,
            button: "left",
            buttons: 1,
            clickCount,
          });
          await this.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x,
            y,
            button: "left",
            buttons: 0,
            clickCount,
          });
          pressed = false;
          if (clickCount === 1) await sleep(60);
        }
      } else {
        pressed = true;
        await this.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
        for (let i = 1; i <= 12; i++) {
          x = spec.x + ((endX - spec.x) * i) / 12;
          y = spec.y + ((endY - spec.y) * i) / 12;
          await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
          await sleep(25);
        }
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        });
        pressed = false;
      }
      return {
        kind: spec.kind,
        x: spec.x,
        y: spec.y,
        ...(spec.kind === "drag" ? { endX, endY, steps: 12 } : {}),
        released: true,
      };
    } finally {
      if (pressed)
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        });
    }
  }

  async key(name: keyof typeof KEYS): Promise<void> {
    this.inputAt = performance.now();
    const k = KEYS[name];
    await this.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...k });
    const { text, ...up } = k;
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...up });
  }

  async shortcut(k: Omit<Protocol.Input.DispatchKeyEventRequest, "type">, command: string): Promise<void> {
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k, commands: [command] });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  }

  /** Empties a single-line field: select all, then Backspace. */
  async clearField(): Promise<void> {
    await this.shortcut({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: MAC ? 4 : 2 }, "selectAll");
    await this.key("Backspace");
  }

  /** Puts the caret at the end of a multi-line editor (Cmd+Down / Ctrl+End), so typing adds to what it holds instead
   * of replacing it. */
  async caretToEnd(): Promise<void> {
    const k = MAC
      ? { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, modifiers: 4 }
      : { key: "End", code: "End", windowsVirtualKeyCode: 35, modifiers: 2 };
    await this.shortcut(k, "moveToEndOfDocument");
  }

  async typeChar(ch: string): Promise<void> {
    this.inputAt = performance.now();
    const k = keyOf(ch);
    const base = {
      key: ch,
      code: k?.code || "",
      windowsVirtualKeyCode: k?.vk ?? 0,
      nativeVirtualKeyCode: k?.vk ?? 0,
      modifiers: k?.shift ? 8 : 0,
    };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "char", text: ch, ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Types text at the cursor: short single-line text key by key, longer text pasted line by line with real Enter
   * presses between lines (so documents and text areas get real lines). Tab-separated text (a table) goes to the page
   * as one paste first, which a spreadsheet turns into cells. False when it typed nothing: a table (rows of
   * tab-separated cells) at a one-line box, which would take each row with an Enter after it (in Sheets' menu search, an
   * unlabeled button's, that ran "Import file"). */
  async type(text: string): Promise<boolean> {
    if (text.includes("\t")) {
      this.inputAt = performance.now();
      const table = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
      const where = await this.eval(`(${PASTE_TABLE_FN})(${JSON.stringify(table)})`).catch(() => "other");
      if (where === "taken") return true;
      if (where === "one-line" && table.includes("\n")) return false;
    }
    if (text.length <= KEY_BY_KEY_MAX && !text.includes("\n")) {
      for (const ch of text) await this.typeChar(ch);
    } else {
      const lines = text.split("\n");
      this.inputAt = performance.now();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line) await this.send("Input.insertText", { text: line });
        if (i < lines.length - 1) await this.key("Enter");
      }
    }
    await this.eval(NOTIFY_EXPR).catch(() => undefined);
    return true;
  }

  async scroll(down: boolean): Promise<void> {
    const { w, h } = await this.viewport();
    this.inputAt = performance.now();
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: w / 2,
      y: h / 2,
      deltaX: 0,
      deltaY: (down ? 1 : -1) * Math.round(h * 0.7),
    });
  }

  async scrollIntoView(node: number): Promise<void> {
    await this.on(node, "function () { this.scrollIntoView({ block: 'center', inline: 'nearest' }); }");
    await sleep(350);
  }

  /** The element's centre on screen now (after a scroll it has moved). */
  async centre(node: number): Promise<[number, number] | null> {
    const box = (await this.on(node, BOX_FN)) as BoxInfo | null;
    if (!box) return null;
    return [box[0] + box[2] / 2, box[1] + box[3] / 2];
  }

  /** Read public field state to verify a fill. */
  async fieldValue(node: number): Promise<FieldValue> {
    return this.on(
      node,
      `function () { const meta = (${METADATA_FN}).call(this); if (meta.slider?.kind === "custom") return {value:meta.slider.value,disabled:meta.disabled}; return {value: this.value ?? this.getAttribute("aria-valuenow") ?? this.innerText,
      checked: this.checked ?? (this.getAttribute("aria-checked") === "true"),
      selectedIndex: this.selectedIndex, disabled: !!this.disabled}; }`,
    ) as Promise<FieldValue>;
  }

  /** One real keyboard increment, checked against a unique adjacent rendered numeric label. */
  async adjustSlider(node: number, direction: number): Promise<SliderResult> {
    if (![-1, 1].includes(direction)) return { ok: false, error: "Slider direction must be -1 or 1" };
    const before = (await this.on(node, METADATA_FN)) as Meta | null;
    if (!before?.slider || before.disabled) return { ok: false, error: "Not an enabled slider" };
    if (before.slider.kind === "custom" && !Number.isFinite(before.slider.value))
      return { ok: false, error: "Custom slider has no unique visible numeric value" };
    await this.on(node, `function () { (this.querySelector('.ui-slider-handle') || this).focus(); }`);
    const vertical = before.slider.orientation === "vertical";
    const key = direction > 0 ? (vertical ? "ArrowUp" : "ArrowRight") : vertical ? "ArrowDown" : "ArrowLeft";
    const vk = { ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ArrowLeft: 37 }[key];
    this.inputAt = performance.now();
    try {
      await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: vk });
    } finally {
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk });
    }
    await sleep(40);
    const after = await this.fieldValue(node);
    const observable =
      Number.isFinite(before.slider.value) && Number.isFinite(Number(after.value)) && after.value !== null;
    return {
      ok: observable && Number(after.value) !== before.slider.value,
      before: before.slider.value,
      value: after.value,
      ...(!observable ? { error: "Slider value has no unambiguous visible numeric label" } : {}),
    };
  }

  /** A slider to a value: a native range input through its public value setter plus input/change events; an ARIA
   * slider (role=slider) with real arrow keys from its aria-valuenow. */
  /** A date or time input (or one of the segments it shows) set to the typed text through the native setter, as a
   * person's picker sets it: typed key by key, "8:22 AM" went into the hours segment and left the field empty. True
   * when the field now holds the value; false for any other field or a text it can't read (then it is typed). */
  async setTemporal(node: number, text: string): Promise<boolean> {
    const done = await this.on(
      node,
      `function () {
      let el = this;
      while (el && !(el instanceof HTMLInputElement) && el.getRootNode && el.getRootNode().host) el = el.getRootNode().host;
      if (!(el instanceof HTMLInputElement) || !/^(time|date|datetime-local|month)$/.test(el.type)) return false;
      const t = ${JSON.stringify(text)}.trim(), pad = (n) => String(n).padStart(2, "0");
      let time = "", date = "";
      const tm = /(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*([ap])\\.?m?\\.?/i.exec(t) || /(\\d{1,2}):(\\d{2})(?::(\\d{2}))?/.exec(t);
      if (tm) {
        let h = Number(tm[1]);
        if (tm[4]) h = (h % 12) + (/p/i.test(tm[4]) ? 12 : 0);
        time = pad(h) + ":" + tm[2] + (tm[3] ? ":" + tm[3] : "");
      }
      const iso = /(\\d{4})-(\\d{1,2})-(\\d{1,2})/.exec(t), us = /(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/.exec(t);
      if (iso) date = iso[1] + "-" + pad(iso[2]) + "-" + pad(iso[3]);
      else if (us) date = us[3] + "-" + pad(us[1]) + "-" + pad(us[2]);
      const v = el.type === "time" ? time : el.type === "date" ? date : el.type === "month" ? date.slice(0, 7)
        : date && time ? date + "T" + time : "";
      if (!v) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value === v;
    }`,
    ).catch(() => false);
    if (done) this.inputAt = performance.now();
    return done === true;
  }

  async setValue(node: number, value: unknown): Promise<SliderResult> {
    const requested = Number(value);
    if (!Number.isFinite(requested)) return { ok: false, requested: null, error: "Expected a finite numeric value" };
    const meta = (await this.on(node, METADATA_FN)) as Meta | null;
    if (!meta?.slider || meta.disabled) return { ok: false, requested, error: "Not an enabled slider" };
    if (meta.slider.kind === "custom") {
      let current = meta.slider.value;
      if (current === null || !Number.isFinite(current))
        return { ok: false, requested, error: "Custom slider has no unique visible numeric value" };
      for (let steps = 0; steps < 200; steps++) {
        if (Math.abs(current - requested) < 1e-6) return { ok: true, value: current, requested, steps };
        const direction = requested > current ? 1 : -1;
        const result = await this.adjustSlider(node, direction);
        if (!result.ok)
          return {
            ok: false,
            value: result.value,
            requested,
            steps: steps + 1,
            error: result.error || "Slider stopped making visible progress",
          };
        if ((Number(result.value) - current) * direction <= 0)
          return {
            ok: false,
            value: result.value,
            requested,
            error: "Slider keyboard direction disagrees with visible value",
          };
        current = Number(result.value);
        if ((requested - current) * direction < -1e-6)
          return { ok: false, value: current, requested, error: "Requested value is between observable slider steps" };
      }
      return {
        ok: Math.abs(current - requested) < 1e-6,
        value: current,
        requested,
        steps: 200,
        error: "Slider keyboard adjustment reached 200-step bound",
      };
    }
    const { min, max, step } = meta.slider;
    if (requested < min || requested > max) return { ok: false, requested, error: "Value outside slider bounds" };
    this.inputAt = performance.now();
    const native = await this.on(
      node,
      `function () {
      if (!this.matches('input[type=range]')) { this.focus(); return false; }
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(this, ${JSON.stringify(requested)});
      this.dispatchEvent(new Event("input", {bubbles:true}));
      this.dispatchEvent(new Event("change", {bubbles:true}));
      return true;
    }`,
    );
    if (!native) {
      if (step <= 0) return { ok: false, requested, error: "Slider has no keyboard step" };
      const presses = Math.round((requested - meta.slider.value) / step);
      if (Math.abs(presses) <= SLIDER_ARROWS) {
        const key = presses >= 0 ? "ArrowRight" : "ArrowLeft";
        for (let i = 0; i < Math.abs(presses); i++) await this.sliderKey(key);
      } else return this.sliderByKeys(node, requested, meta.slider);
    }
    const state = await this.fieldValue(node);
    return { ok: Math.abs(Number(state.value) - requested) < 1e-6, value: state.value, requested };
  }

  async sliderKey(key: SliderKey): Promise<void> {
    const vk = { ArrowRight: 39, ArrowLeft: 37, PageUp: 33, PageDown: 34, Home: 36, End: 35 }[key];
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: vk });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk });
  }

  /** An ARIA slider far from its value (a price range of thousands in steps of 1: student.com): Home or End for an
   * end of the range, then Page Up/Down while a page still fits, then arrows, reading the slider's value after every
   * key. It stops when a key moves nothing or overshoots by less than a step, so it can't run away. */
  async sliderByKeys(
    node: number,
    requested: number,
    slider: { min: number; max: number; step: number },
  ): Promise<SliderResult> {
    const read = async () => Number((await this.fieldValue(node)).value);
    const near = (a: number) => Math.abs(a - requested) < 1e-6;
    if (near(slider.min) || near(slider.max)) await this.sliderKey(near(slider.min) ? "Home" : "End");
    let current = await read();
    let page: number | null = null; // how far one Page key moves the value; 0 once it doesn't help
    for (let keys = 0; keys < SLIDER_KEYS && Number.isFinite(current); keys++) {
      if (near(current)) return { ok: true, value: current, requested, steps: keys };
      const direction = requested > current ? 1 : -1;
      const remaining = Math.abs(requested - current);
      const paging = page !== 0 && remaining > slider.step * 10 && (page === null || page <= remaining + 1e-6);
      await this.sliderKey(
        paging ? (direction > 0 ? "PageUp" : "PageDown") : direction > 0 ? "ArrowRight" : "ArrowLeft",
      );
      const next = await read();
      const moved = (next - current) * direction;
      if (paging) page = moved > 0 ? moved : 0;
      else if (moved <= 0)
        return { ok: false, value: next, requested, steps: keys + 1, error: "Slider stopped making visible progress" };
      else if (moved > remaining + 1e-6 && moved - remaining < slider.step)
        return { ok: false, value: next, requested, error: "Requested value is between observable slider steps" };
      current = next;
    }
    return {
      ok: near(current),
      value: current,
      requested,
      steps: SLIDER_KEYS,
      error: near(current) ? undefined : "Slider keyboard adjustment reached its key bound",
    };
  }

  /** After typing into an autocomplete box: wait (up to ms) until its suggestions show, so the next look has them to
   * pick from. True when a visible option or suggestion list appeared. Without the wait, runs looked again before
   * the list came, and typed or cleared the box over and over. */
  async waitForSuggestions(ms = 2000): Promise<boolean> {
    const t0 = performance.now();
    const probe = `(() => { const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
      const f = document.activeElement; const id = f && (f.getAttribute("aria-controls") || f.getAttribute("aria-owns"));
      const list = id && document.getElementById(id);
      if (list && shown(list) && list.querySelector("[role=option], li, a, button")) return true;
      return [...document.querySelectorAll("[role=option], [role=listbox] li, [role=listbox] [role=link]")].some(shown); })()`;
    while (performance.now() - t0 < ms) {
      if ((await this.eval(probe).catch(() => false)) === true) {
        await sleep(200); // the rest of the list renders
        return true;
      }
      await sleep(150);
    }
    return false;
  }

  async selectOption(node: number, index: number): Promise<void> {
    this.inputAt = performance.now();
    await this.on(
      node,
      // a multiple select keeps what is already chosen: setting selectedIndex chose one and dropped the others
      `function () { if (this.multiple && this.options[${index}]) this.options[${index}].selected = true; else this.selectedIndex = ${index};
      this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); }`,
    );
  }

  /** Loads url in this tab (a page of a list, or back to the list after a detail) and waits for it like any move.
   * Only http(s): callers check the address is the page's own site first. Throws when the navigation fails. */
  async navigate(url: string): Promise<void> {
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol)) throw new Error(`Refusing to navigate to ${target.protocol} URL`);
    const before = (await this.eval("location.href").catch(() => "")) as string;
    this.inputAt = performance.now();
    const r = (await this.send("Page.navigate", { url: target.href })) as
      Partial<Protocol.Page.NavigateResponse> | undefined;
    if (r?.errorText) throw new Error(`Navigation to ${target.href} failed: ${r.errorText}`);
    // Page.navigate answers when the navigation starts: wait for the new document before the usual settle, or the
    // old page (already "complete" and quiet) would pass for the new one
    const t0 = performance.now();
    const sameDocument = before && target.href.split("#")[0] === before.split("#")[0];
    while (!sameDocument && r?.loaderId !== undefined && performance.now() - t0 < SETTLE_MAX_MS) {
      const now = await withTimeout(this.eval("location.href"), 1500, "navigation probe").catch(() => "");
      if (now && now !== before) break;
      await sleep(100);
    }
    await this.settle();
  }

  /** Waits until the page has loaded, its DOM has been quiet for QUIET_MS, the requests the move started are done
   * (or older than NET_YOUNG_MS) and the click ring is gone; at most SETTLE_MAX_MS. */
  async settle(): Promise<void> {
    const t0 = performance.now();
    await sleep(120);
    while (performance.now() - t0 < SETTLE_MAX_MS) {
      let probe: [string, number] | null = null;
      try {
        probe = (await withTimeout(this.eval(SETTLE_EXPR), 1500, "settle probe")) as [string, number];
      } catch {} // navigating: no page context yet
      const now = performance.now();
      if (
        probe?.[0] === "complete" &&
        probe[1] >= QUIET_MS &&
        !networkBusy(this.inflight, this.inputAt, now) &&
        now >= this.ringUntil
      )
        return;
      await sleep(120);
    }
  }
}
