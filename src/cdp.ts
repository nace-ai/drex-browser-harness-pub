import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import { domCandidates, publicMetadata } from "./candidates.ts";
import { pointTargetAt } from "./point-target.ts";
import { normalizeLiteral, originOf } from "./logic.ts";
import { accOn } from "./accuracy.ts";
import { revealAnswer, revealFacts, type RevealOptions, type Revealed } from "./evidence.ts";
import type {
  Box,
  FieldValue,
  GestureResult,
  GestureSpec,
  LocatedEl,
  MoveMutations,
  Mutation,
  Notices,
  OffScreenEl,
  OnScreenEl,
  PageElements,
  PageInfo,
  PageItem,
  PointTarget,
  Problem,
  PublicMetadata,
  ReadBack,
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
// confirmedChanges: the requests that may change something on the site, and the telemetry a page sends after every
// click, which would otherwise count as a change (by path, or a ping/beacon)
const MUTATING = /^(POST|PUT|PATCH|DELETE)$/i;
const TELEMETRY_PATH = /collect|analytics|track|beacon|metrics|\/log\b|\/event/i;
const TELEMETRY_TYPE = /^(ping|beacon)$/i;
const GRAPHQL_PATH = /\/graphql\/?$/i;
const MAX_MUTATIONS = 100; // the site requests a tab keeps (the oldest go first)
const LISTENER_CACHE_MS = 5000;
const CLICK_EVENTS = new Set(["click", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"]);
const MAX_OFFSCREEN = 40;
const NAME_CHARS = 120;
const SELECT_INLINE = 30;
/** frames: at most this many iframes are read, at most this deep */
const MAX_FRAMES = 6;
const MAX_FRAME_DEPTH = 3;
const READ_CHARS = 30000;
const DROP_PAST = 3; // px Tab.dragTo drops past the target's centre: jQuery UI's sortable ignores an up/left drop at it

// Runs on one element: its viewport box (the largest line box for a link that wraps), whether a fixed/sticky layer
// (dialog backdrop, cookie banner) covers its centre, its group of alternatives, whether it takes typed text, and
// whether it is marked as something to drag.
const BOX_FN = `function () {
  // Inline native options are operated through their owning select. A raw click would clear a multiselect.
  // Larger selects still need their existing option targets because their full option list is not inlined.
  if (this.tagName === "OPTION" && this.closest("select")?.options.length <= ${SELECT_INLINE}) return null;
  let r = this.getBoundingClientRect(), clipTarget = this;
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
      if (hit) { r = { left: hit[0] - 4, top: hit[1] - 4, width: 8, height: 8 }; clipTarget = lab; break; }
    }
  }
  const st = getComputedStyle(this);
  // an invisible native control is still the click target: Material-style radios and checkboxes put an opacity-0
  // <input> over the circle or box they draw (Google Flights' Stops filter), so only other invisible things are skipped
  const control = this.tagName === "INPUT" || ["checkbox", "radio", "switch"].includes(this.getAttribute("role"));
  if (st.visibility === "hidden" || (st.opacity === "0" && !control)) return null;
  // Intersect each clipping ancestor, independently per axis. A viewport-visible box can still be outside its
  // nested scroll pane. Keep its original box for identity/scrolling and expose only the visible part for clicks.
  let left = Math.max(0, r.left), topEdge = Math.max(0, r.top);
  let right = Math.min(innerWidth, r.left + r.width), bottom = Math.min(innerHeight, r.top + r.height);
  const parentOf = e => e.parentElement || e.getRootNode().host;
  let clipStart = parentOf(clipTarget);
  const position = getComputedStyle(clipTarget).position;
  if (position === "fixed" || position === "absolute") {
    // Positioned descendants escape overflow ancestors below their containing block (fixed can be viewport-bound).
    while (clipStart) {
      const c = getComputedStyle(clipStart);
      if ((position === "absolute" && c.position !== "static") || c.transform !== "none" || c.perspective !== "none" || c.filter !== "none" || /paint|layout|strict|content/.test(c.contain) || /transform|perspective|filter/.test(c.willChange)) break;
      clipStart = parentOf(clipStart);
    }
  }
  for (let p = clipStart; p; p = parentOf(p)) {
    if (p === document.body || p === document.documentElement) continue;
    const style = getComputedStyle(p), box = p.getBoundingClientRect();
    const sx = p.offsetWidth ? box.width / p.offsetWidth : 1, sy = p.offsetHeight ? box.height / p.offsetHeight : 1;
    const x = box.left + p.clientLeft * sx, y = box.top + p.clientTop * sy;
    if (/^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowX)) { left = Math.max(left, x); right = Math.min(right, x + p.clientWidth * sx); }
    if (/^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowY)) { topEdge = Math.max(topEdge, y); bottom = Math.min(bottom, y + p.clientHeight * sy); }
  }
  const visible = right - left >= 3 && bottom - topEdge >= 3 ? [left, topEdge, right, bottom] : null;
  const cx = visible ? (left + right) / 2 : -1, cy = visible ? (topEdge + bottom) / 2 : -1;
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
  // marked to be dragged (HTML5, jQuery UI's draggable and sortable items, ARIA), never by a grab cursor: that would
  // tag map canvases and carousels
  const cl = this.classList;
  const draggable = this.getAttribute("draggable") === "true" || cl.contains("ui-draggable") ||
    cl.contains("ui-sortable-handle") || this.hasAttribute("aria-grabbed");
  // visible text of its own (not a name from an aria-label, alt or <label>): what a copy of it would carry
  const ownText = !["INPUT", "SELECT", "TEXTAREA"].includes(tag) && !!(this.innerText || "").trim();
  return [r.left, r.top, r.width, r.height, covered, group, editable, tag === "SELECT", multi, form, readOnly, draggable, ownText, visible];
}`;
// Where an element sits, for Tab.dragTo: its box on the page and its parent (a sortable item dropped into another
// list may keep its place on screen but not its parent).
const PLACE_FN = `function () {
  const r = this.getBoundingClientRect(), p = this.parentElement;
  window.__drexG = window.__drexG || new WeakMap(); window.__drexN = window.__drexN || 0;
  if (p && !window.__drexG.has(p)) window.__drexG.set(p, ++window.__drexN);
  return [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height), p ? window.__drexG.get(p) : 0];
}`;
// The box a scroll is for: [centre x, centre y, scrollTop], marked data-drex-scroll, or null for the page itself.
const SCROLL_BOX_EXPR = `(() => {
  const root = document.scrollingElement || document.documentElement;
  const can = (e) => {
    if (!e || e === document.body || e === document.documentElement) return false;
    const s = getComputedStyle(e);
    return (/(auto|scroll|overlay)/.test(s.overflowY) || e.tagName === "TEXTAREA") && e.scrollHeight > e.clientHeight + 2;
  };
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < innerHeight; };
  let e = document.activeElement;
  while (e && !(can(e) && shown(e))) e = e.parentElement;
  if (!e && root.scrollHeight <= innerHeight + 2) {
    let area = 0;
    for (const c of document.querySelectorAll("textarea, div, ul, ol, section, main, aside, table, tbody")) {
      if (!can(c) || !shown(c)) continue;
      const r = c.getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; e = c; }
    }
  }
  if (!e) return null;
  document.querySelectorAll("[data-drex-scroll]").forEach((x) => x.removeAttribute("data-drex-scroll"));
  e.setAttribute("data-drex-scroll", "");
  const r = e.getBoundingClientRect();
  // the middle of the part of the box that is on screen
  const x = (Math.max(0, r.left) + Math.min(r.right, innerWidth)) / 2, y = (Math.max(0, r.top) + Math.min(r.bottom, innerHeight)) / 2;
  return [Math.round(x), Math.round(y), e.scrollTop];
})()`;
const EDIT_COMMANDS: Record<string, string> = {
  a: "selectAll",
  z: "undo",
  y: "redo",
  c: "copy",
  v: "paste",
  x: "cut",
  End: "moveToEndOfDocument",
  Home: "moveToBeginningOfDocument",
};
// a multiple select also says which options are chosen: its selectedIndex is only the first of them
/** The page function that sets a date or time input (this, or the input whose segment this is) to text. */
const temporalFn = (text: string) => `function () {
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
    }`;
const SELECT_FN =
  "function () { return [Array.from(this.options).map(o => o.text.trim()), this.selectedIndex, this.multiple ? Array.from(this.selectedOptions).map(o => o.text.trim()) : null]; }";

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

// settingReadback: where the page shows each of a step's values applied, by the first of: a field holding it ("field
// value"); a select's chosen option ("select"); a pressed, selected or checked control showing it ("aria-pressed",
// "aria-selected", "aria-checked"; a ticked checkbox or radio is checked); a control marked active, selected, checked,
// applied or current by its data-state, class or aria-current ("state"); a filter chip, its text beside or around a
// remove control ("chip"); a heading equal to it, as on a category page ("heading"); a query value or path segment of
// the address equal to it ("url"). A value is compared normalised (norm: logic.ts normalizeLiteral), and only as a
// whole: "price" is not found in the address's price_asc. Nothing here knows any site. It runs in the page
// (READBACK_FN), so it uses nothing from outside itself.
function readBackPage(literals: string[], norm: (s: string) => string): ReadBack {
  const flat = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
  };
  const textOf = (e: Element) => flat(e instanceof HTMLElement ? e.innerText : e.textContent);
  // a control's name: its aria-label, what labels it, its own text, or (a bare box) the text around it
  const nameOf = (e: Element) => {
    const aria = flat(e.getAttribute("aria-label"));
    if (aria) return aria;
    const by = (e.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => (id ? flat(document.getElementById(id)?.textContent) : ""))
      .join(" ");
    if (flat(by)) return by;
    const labels = e instanceof HTMLInputElement && e.labels ? Array.from(e.labels).map(textOf).join(" ") : "";
    if (flat(labels)) return labels;
    return textOf(e) || (e.parentElement ? textOf(e.parentElement) : "");
  };
  const words = (t: string) => ` ${norm(t)} `;
  // a control shows a value when its name holds it as words and is not much longer: a whole panel marked active
  // (class "tab-pane active") holds every word of the page
  const holds = (name: string, n: string) => norm(name).length <= n.length + 60 && words(name).includes(` ${n} `);
  const big = (e: Element) => e.textContent.length > 2000;

  const fields: string[] = [];
  for (const e of Array.from(document.querySelectorAll("input, textarea"))) {
    if (
      e instanceof HTMLInputElement &&
      /^(hidden|checkbox|radio|password|submit|button|reset|image|file)$/i.test(e.type)
    )
      continue;
    if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) fields.push(norm(e.value));
  }
  // a combobox or text box drawn without a form field shows its value as its text
  for (const e of Array.from(document.querySelectorAll("[role=combobox], [role=textbox], [role=searchbox]"))) {
    if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement || big(e))
      continue;
    fields.push(norm(e.getAttribute("aria-valuetext") ?? textOf(e)));
  }
  const chosen: string[] = [];
  for (const s of Array.from(document.querySelectorAll("select")))
    for (const o of Array.from(s.selectedOptions)) chosen.push(norm(o.text), norm(o.value));
  // a state class or data-state is read token by token, and a token is the state only as a whole: "active",
  // "is-active", "has-checked" or a BEM modifier "tab--selected", never a longer name that starts with one
  // ("current-price", "selected-item"), nor a Tailwind variant ("data-[state=active]:bg-white", "peer-checked:...",
  // "active:...") that styles a state the element may not be in; and an element that says it is off (aria-pressed,
  // aria-selected or aria-checked false; data-state inactive, unchecked, off or closed) is off
  const off = (e: Element) =>
    ["aria-pressed", "aria-selected", "aria-checked"].some((a) => e.getAttribute(a) === "false") ||
    /^(inactive|unchecked|off|closed)$/i.test(e.getAttribute("data-state") ?? "");
  const STATE = /^(is-|has-)?(active|selected|checked|applied|current)$|--(active|selected|checked|applied|current)$/;
  // (the cheap test first: "[class]" is nearly every element)
  const marked = (sel: string, also: (e: Element) => boolean = () => true) =>
    Array.from(document.querySelectorAll(sel)).filter((e) => also(e) && !big(e));
  const states: [string, Element[]][] = [
    ["aria-pressed", marked("[aria-pressed=true]")],
    ["aria-selected", marked("[aria-selected=true]")],
    ["aria-checked", marked("[aria-checked=true], input[type=checkbox]:checked, input[type=radio]:checked")],
    [
      "state",
      marked(
        "[data-state], [class], [aria-current]",
        (e) =>
          (!off(e) &&
            [e.getAttribute("data-state") ?? "", ...(e.getAttribute("class") ?? "").split(/\s+/)].some(
              (t) => !/[:[]/.test(t) && STATE.test(t),
            )) ||
          (e.hasAttribute("aria-current") && e.getAttribute("aria-current") !== "false"),
      ),
    ],
  ];
  // a ticked box drawn by its label (the box itself hidden) is shown when its label is
  const visible = (e: Element) =>
    shown(e) || (e instanceof HTMLInputElement && !!e.labels && Array.from(e.labels).some(shown));
  // filter chips: a control that removes or clears (by its name or text, as whole words: "Clearance" and "Closet
  // Organizers" are links), and the text in it or beside it
  const REMOVE = /\b(remove|clear|close)\b|[×✕]/i;
  const removers = Array.from(
    document.querySelectorAll("button, [role=button], a, [aria-label], [title], span, i"),
  ).filter((e) => {
    const control = e.matches("button, [role=button], a, [aria-label], [title]");
    const name = flat(
      e.getAttribute("aria-label") || e.getAttribute("title") || (control || !e.children.length ? e.textContent : ""),
    );
    // a bare span or icon removes only by its sign; "Closed" in a status label removes nothing
    return name.length <= 40 && (control ? REMOVE.test(name) : /^[×✕✖]$/.test(name)) && shown(e);
  });
  const without = (t: string, part: string) => {
    const at = part ? t.lastIndexOf(part) : -1;
    return at < 0 ? t : `${t.slice(0, at)} ${t.slice(at + part.length)}`;
  };
  const chips: string[] = [];
  for (const r of removers) {
    // the remover's own box, and the wrappers around it that hold nothing else
    let w: Element = r;
    for (let i = 0; i < 3 && w.parentElement && w.parentElement !== document.body; i++) {
      if (textOf(w.parentElement) !== textOf(w)) break;
      w = w.parentElement;
    }
    const own = textOf(r);
    for (const c of [r, w.parentElement, w.previousElementSibling, w.nextElementSibling]) {
      if (!c || c === document.body || big(c) || !shown(c)) continue;
      chips.push(norm(c === r || !c.contains(r) ? textOf(c) : without(textOf(c), own)));
    }
  }
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, [role=heading]"))
    .filter((h) => !big(h) && shown(h))
    .map((h) => norm(textOf(h)));
  const address: string[] = [];
  const url = new URL(location.href);
  url.searchParams.forEach((v) => address.push(norm(v)));
  for (const seg of url.pathname.split("/")) {
    try {
      address.push(norm(decodeURIComponent(seg)));
    } catch {
      address.push(norm(seg));
    }
  }

  const found: Record<string, string> = {};
  const missing: string[] = [];
  for (const literal of literals) {
    const n = norm(literal);
    const where = !n
      ? ""
      : fields.includes(n)
        ? "field value"
        : chosen.includes(n)
          ? "select"
          : (states.find(([, els]) => els.some((e) => holds(nameOf(e), n) && visible(e)))?.[0] ??
            (chips.includes(n) ? "chip" : headings.includes(n) ? "heading" : address.includes(n) ? "url" : ""));
    if (where) found[literal] = where;
    else missing.push(literal);
  }
  return { found, missing };
}
/** A page script built from functions' sources the first time it is sent, not when the module loads: the extension's
 * background stringifies nothing for a switch that never runs, and a function missing from the scope fails the call
 * that sends it, not the whole module. */
function pageScript(build: () => string): () => string {
  let text: string | undefined;
  return () => (text ??= build());
}
/** settingReadback: the page script of Tab.readBack, called with the values; it compares them as logic.ts does. */
const READBACK_FN = pageScript(
  () => `function (literals) { return (${readBackPage.toString()})(literals, ${normalizeLiteral.toString()}); }`,
);
/** revealEvidence: the page script of Tab.revealFacts (evidence.ts revealFacts), called with the literals and options;
 * it compares them as logic.ts does and keeps revealAnswer's pop-up closer. */
const REVEAL_FN = pageScript(
  () =>
    `function (literals, opts) { return (${revealFacts.toString()})(literals, opts, ${normalizeLiteral.toString()}, ${revealAnswer.toString()}); }`,
);

// The page's readable text: the main content when the page marks it, else the whole body.
const TEXT_EXPR = `(() => {
  const main = document.querySelector("main, article, [role=main]");
  const pick = main && main.innerText.length > 500 ? main : document.body;
  return JSON.stringify([document.title, location.href, (pick && pick.innerText) || ""]);
})()`;

// What the page is showing besides its controls: open dialogs (by their label or heading), notices (alerts, status
// messages, live regions such as an "Item Added!" toast) and the address. Read before and after each move, so the
// history can say what the move did (logic.ts effectOf).
const LIVE_REGIONS = "[role=alert], [role=status], [aria-live=assertive], [aria-live=polite]";
// navMap: the site's own navigation: every same-origin link in its menus, header, side bar and footer, hidden ones too
// (a dropdown's items), each with the labels of the menu items it sits under. At most NAV_MAP_LINKS, none twice.
const NAV_MAP_LINKS = 250;
const NAV_MAP_EXPR = `(() => {
  const flat = (t) => (t || "").split(/\\s+/).join(" ").trim();
  const label = (e) => flat(e.getAttribute("aria-label") || e.innerText || e.textContent).slice(0, 60);
  const shown = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const roots = [...document.querySelectorAll("nav, header, footer, aside, [role=navigation], [role=menubar], [role=menu], [class*=menu], [class*=nav], [id*=menu], [id*=nav], [class*=sidebar]")]
    .filter((r) => !roots_has_parent(r));
  function roots_has_parent(r) { let p = r.parentElement; while (p) { if (p.matches && p.matches("nav, header, footer, aside, [role=navigation], [role=menubar], [role=menu], [class*=menu], [class*=nav], [id*=menu], [id*=nav], [class*=sidebar]")) return true; p = p.parentElement; } return false; }
  const seen = new Set();
  const out = [];
  for (const root of roots) for (const a of root.querySelectorAll("a[href]")) {
    const raw = a.getAttribute("href") || "";
    if (/^(javascript:|#|mailto:|tel:)/i.test(raw)) continue;
    let u; try { u = new URL(a.href, location.href); } catch { continue; }
    if (u.origin !== location.origin) continue;
    const href = u.pathname + u.search;
    const text = label(a);
    if (!text || seen.has(href)) continue;
    const path = [];
    for (let p = a.parentElement; p && p !== root && path.length < 3; p = p.parentElement) {
      if (p.tagName !== "LI") continue;
      const head = [...p.children].find((c) => !c.contains(a) && /^(A|BUTTON|SPAN|STRONG|DIV|H\\d)$/.test(c.tagName));
      const t = head ? label(head) : "";
      if (t && t !== text && !path.includes(t)) path.unshift(t);
    }
    seen.add(href);
    out.push([[...path, text].join(" › "), href, shown(a) ? 0 : 1]);
    if (out.length >= ${NAV_MAP_LINKS}) break;
  }
  return JSON.stringify(out);
})()`;

const NOTICES_EXPR = `(() => {
  const flat = (t) => (t || "").split(/\\s+/).join(" ").trim();
  const vis = (e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0"; };
  const label = (e) => flat(e.getAttribute("aria-label") || (e.querySelector("h1, h2, h3, [role=heading]") || {}).innerText || e.innerText).slice(0, 80);
  const dialogs = [...document.querySelectorAll("[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true]")].filter(vis).map(label).filter(Boolean);
  const notes = [...document.querySelectorAll(${JSON.stringify(LIVE_REGIONS)})].filter(vis)
    .map((e) => flat(e.innerText).slice(0, 80)).filter(Boolean);
  return JSON.stringify({ dialogs: [...new Set(dialogs)], notes: [...new Set(notes)], url: location.href, title: document.title });
})()`;

// pickSuggestion. After typing into a field: the suggestion lists the typing opened, of these kinds only (a list that
// appeared somewhere near the field is not one): the element the field names (aria-controls, aria-owns), a listbox, a
// menu, jQuery UI's autocomplete. Each counts only once it shows after the mark taken just before the typing (since;
// null takes the mark and returns the page's clock), so a list already open on the page (recent searches, a site menu)
// is no suggestion. Each item: its centre, which a click there lands on, and its text. announced: a live region (the
// notices') newly says there are results ("1 result is available": jQuery UI's, which is read when no list is found).
// What was seen is kept in WeakMaps on the page's window, not in attributes on its DOM.
const SUGGEST_LISTS = "[role=listbox], [role=menu], ul.ui-autocomplete";
const SUGGEST_ITEMS = 50;
const SUGGEST_WAIT_MS = 1500;
const SUGGEST_POLL_MS = 150;
const ALNUM = /[\p{L}\p{N}]/u;
const suggestionsFn = (since: number | null) => `function () {
  const since = ${since === null ? "null" : Number.isFinite(since) ? since : 0};
  const flat = (t) => (t || "").split(/\\s+/).join(" ").trim();
  const vis = (e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0"; };
  const now = Date.now();
  const seen = (window.__drexSeen = window.__drexSeen || new WeakMap()); // list -> when it was first seen open
  const heard = (window.__drexHeard = window.__drexHeard || new WeakMap()); // live region -> its text at the mark
  const ids = ((this.getAttribute("aria-controls") || "") + " " + (this.getAttribute("aria-owns") || "")).split(/\\s+/).filter(Boolean);
  const named = ids.map((id) => document.getElementById(id)).filter(Boolean);
  const lists = [...new Set([...named, ...document.querySelectorAll(${JSON.stringify(SUGGEST_LISTS)})])];
  const regions = [...document.querySelectorAll(${JSON.stringify(LIVE_REGIONS)})];
  if (since === null) {
    for (const l of lists) if (vis(l)) seen.set(l, now); else seen.delete(l);
    for (const r of regions) heard.set(r, r.textContent);
    return now;
  }
  const found = [];
  for (const l of lists) {
    // a list seen closed since the mark, open again, is new
    if (!vis(l)) { seen.delete(l); continue; }
    if (!seen.has(l)) seen.set(l, Math.max(now, since + 1));
    if (seen.get(l) <= since) continue;
    const options = l.querySelectorAll("[role=option], [role=menuitem]");
    for (const o of options.length ? options : l.querySelectorAll("li")) {
      if (found.length >= ${SUGGEST_ITEMS}) break;
      if (found.some((f) => f.o === o) || o.getAttribute("aria-disabled") === "true" || !vis(o)) continue;
      const r = o.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      // an item scrolled out of its list or off the screen can't be clicked at its centre
      const hit = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementFromPoint(x, y) : null;
      if (hit && o.contains(hit)) found.push({ o, x, y, text: flat(o.innerText || o.textContent || o.getAttribute("aria-label")) });
    }
  }
  const results = /\\b(\\d+|one|no) (results?|suggestions?|options?)\\b/i, available = /\\bresults?\\b.*\\bavailable\\b/i;
  const single = /\\b(1|one) (results?|suggestions?|options?)\\b/i;
  // "No search results." (jQuery UI's), "No results available", "0 results": nothing to pick, nothing to wait for
  const empty = /\\b(no|0|zero) (\\w+ )?(results?|suggestions?|options?|matches)\\b/i;
  let announced = false, one = false, none = false;
  for (const r of regions) {
    if (heard.has(r) && heard.get(r) === r.textContent) continue;
    const t = vis(r) ? flat(r.innerText) : "";
    if (empty.test(t)) none = true;
    else if (results.test(t) || available.test(t)) { announced = true; one = one || single.test(t); }
  }
  return { items: found.map(({ x, y, text }) => ({ x, y, text })), announced, one, none };
}`;
// Whether the field says it has suggestions: jQuery UI's class, the ARIA combobox attributes, a datalist. Not
// autocomplete="off" alone, which login forms carry.
const AUTOCOMPLETE_HINT_FN = `function () {
  const a = (n) => this.getAttribute(n);
  return a("role") === "combobox" || (this.hasAttribute("aria-autocomplete") && a("aria-autocomplete") !== "none") ||
    this.hasAttribute("aria-controls") || this.hasAttribute("aria-owns") ||
    (this.hasAttribute("aria-haspopup") && a("aria-haspopup") !== "false") || this.hasAttribute("list") ||
    this.classList.contains("ui-autocomplete-input");
}`;
// The field's value, the option it marks as highlighted (aria-activedescendant) and whether it still has the focus.
const FIELD_STATE_FN = `function () {
  return { value: typeof this.value === "string" ? this.value : null, active: this.getAttribute("aria-activedescendant") || "",
    focused: document.activeElement === this };
}`;

// datePicker. The calendar a date field opened, found by what it shows, not by a library's markup: around a
// month-and-year header ("December 2016", "2016-12"; spaces normalised, as jQuery UI puts a no-break space between the
// month and the year; month and year in one element or in two side by side), the smallest element (never the page's
// body) that holds at least 28 day cells (an element that takes a click and shows only a number from 1 to 31) and a
// previous and a next control on the header's row, within the calendar's width. A control: something that takes a
// click (a link, a button, role=button, a tabindex or onclick, or the pointer cursor a page gives what it handles
// itself: bootstrap's <th class="prev">«</th>) whose short text, title or aria-label says previous or next; of those,
// the nearest the header. With two months shown, the leftmost header is the calendar's. Each day: its number, centre,
// whether it is another month's (a class saying so, a data-month that is not the header's month, which jQuery UI counts
// from 0, or a cell under another month's header) and whether it is disabled. A disabled control (Prev at the
// calendar's first month) has no centre. null: no calendar shows.
const CALENDAR_FN = `function () {
  const flat = (t) => (t || "").split(/\\s+/).join(" ").trim();
  const vis = (e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0"; };
  const centre = (e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const cls = (e) => (e && e.getAttribute("class")) || "";
  const off = (e) => e.getAttribute("aria-disabled") === "true" || /disabled/i.test(cls(e)) || e.disabled === true;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const monthOf = (w) => months.indexOf(w.slice(0, 3).toLowerCase()) + 1;
  const month = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*$/i;
  const named = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\\d{4})$/i;
  const yearFirst = /^(\\d{4})[-\\/ ](\\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)/i;
  const headerOf = (t) => {
    let m = named.exec(t);
    if (m) return { y: Number(m[2]), m: monthOf(m[1]) };
    m = yearFirst.exec(t);
    const mo = m ? (/^\\d/.test(m[2]) ? Number(m[2]) : monthOf(m[2])) : 0;
    return m && mo >= 1 && mo <= 12 ? { y: Number(m[1]), m: mo } : null;
  };
  const all = [...document.querySelectorAll("body *")];
  let heads = [];
  const cells = [];
  for (const e of all) {
    const raw = e.textContent || "";
    if (!raw.trim() || raw.length > 60) continue;
    const t = flat(e.innerText);
    let h = t.length <= 30 ? headerOf(t) : null;
    if (!h && month.test(t)) {
      const y = e.nextElementSibling ? flat(e.nextElementSibling.innerText) : "";
      if (/^\\d{4}$/.test(y)) h = { y: Number(y), m: monthOf(t) };
    }
    if (h && vis(e)) heads.push({ e, y: h.y, m: h.m });
    // a day: the innermost element showing the number, inside what takes the click (the cell itself, its link...)
    if (!/^\\d{1,2}$/.test(t) || Number(t) < 1 || Number(t) > 31) continue;
    if ([...e.children].some((k) => flat(k.textContent) === t)) continue;
    const c = e.closest("a, button, td, [role=button], [role=gridcell], [role=option], [tabindex], [onclick]");
    if (c && flat(c.textContent) === t && vis(e)) cells.push({ e, c, d: Number(t) });
  }
  heads = heads.filter((h) => !heads.some((o) => o !== h && h.e.contains(o.e)));
  if (!heads.length) return null;
  const isDay = new Set(cells.map((c) => c.c));
  // only short words count (a region whose text mentions "next" is no control)
  const short = (t, n) => { const v = flat(t); return v.length <= n ? v : ""; };
  const says = (e, re) => re.test(short((e.textContent || "").length <= 60 ? e.innerText : "", 20)) ||
    re.test(short(e.getAttribute("title"), 40)) || re.test(short(e.getAttribute("aria-label"), 40));
  const takes = (e) => /^(A|BUTTON)$/.test(e.tagName) || e.getAttribute("role") === "button" || e.hasAttribute("tabindex") ||
    e.hasAttribute("onclick") || typeof e.onclick === "function" || getComputedStyle(e).cursor === "pointer";
  const prevs = [], nexts = [];
  for (const e of all) {
    if (isDay.has(e) || heads.some((h) => e.contains(h.e))) continue;
    const p = says(e, /prev|previous|back|‹|«|</i), n = says(e, /next|forward|›|»|>/i);
    if (!(p || n) || !takes(e) || !vis(e)) continue;
    if (p) prevs.push(e);
    if (n) nexts.push(e);
  }
  // a control on the header's row and within the calendar's width (its header and days), nearest the header first
  const areaOf = (els) => els.map((e) => e.getBoundingClientRect())
    .reduce((a, r) => [Math.min(a[0], r.left), Math.max(a[1], r.right)], [Infinity, -Infinity]);
  const nearest = (list, h, box, area, not) => {
    const r = h.e.getBoundingClientRect(), [hx, hy] = centre(h.e);
    const fits = (e) => { const [x, y] = centre(e);
      return Math.abs(y - hy) <= Math.max(40, 2 * r.height) && x >= area[0] - 40 && x <= area[1] + 40; };
    const d = (e) => { const [x, y] = centre(e); return Math.hypot(x - hx, y - hy); };
    return list.filter((e) => e !== not && box.contains(e) && fits(e)).sort((a, b) => d(a) - d(b))[0] || null;
  };
  // each header's smallest box; of those, the smallest on the page
  let best = null;
  for (const h of heads)
    for (let box = h.e.parentElement; box && box !== document.body && box !== document.documentElement; box = box.parentElement) {
      const days = cells.filter((c) => box.contains(c.e));
      if (days.length < 28) continue;
      const area = areaOf([h.e, ...days.map((c) => c.e)]);
      const prev = nearest(prevs, h, box, area);
      if (!prev || !nearest(nexts, h, box, area, prev)) continue;
      const size = box.getElementsByTagName("*").length;
      if (!best || size < best.size) best = { box, size, days };
      break;
    }
  if (!best) return null;
  const { box, days } = best;
  const inside = heads.filter((o) => box.contains(o.e));
  const main = inside.reduce((a, b) => (b.e.getBoundingClientRect().left < a.e.getBoundingClientRect().left ? b : a));
  const area = areaOf([...inside.map((o) => o.e), ...days.map((c) => c.e)]);
  const prev = nearest(prevs, main, box, area), next = nearest(nexts, main, box, area, prev);
  if (!prev || !next) return null;
  // the header a day sits under, with two months shown (null: under none of them alone)
  const owner = (c) => {
    for (let x = c.e.parentElement; x && x !== box; x = x.parentElement) {
      const hs = inside.filter((o) => x.contains(o.e));
      if (hs.length) return hs.length === 1 ? hs[0] : null;
    }
    return null;
  };
  const mine = inside.length > 1 ? days.filter((c) => [null, main].includes(owner(c))) : days;
  // data-month counts months from 0 (jQuery UI) or from 1: whichever most of the header's own days carry
  const dataMonth = (c) => { const x = c.e.closest("[data-month]"); return x && box.contains(x) ? x.getAttribute("data-month") : null; };
  const count = (v) => mine.filter((c) => dataMonth(c) === String(v)).length;
  const current = String(count(main.m - 1) >= count(main.m) ? main.m - 1 : main.m);
  return {
    header: { y: main.y, m: main.m },
    prev: off(prev) ? null : centre(prev),
    next: off(next) ? null : centre(next),
    days: days.map((c) => {
      const marks = [c.e, c.c, c.e.closest("td, [role=gridcell]")].filter(Boolean);
      const dm = dataMonth(c), o = inside.length > 1 ? owner(c) : null;
      const [x, y] = centre(c.e);
      return { d: c.d, x, y, disabled: marks.some(off),
        other: marks.some((m) => /other-?month|outside-?month/i.test(cls(m))) || (dm !== null && dm !== current) || (!!o && o !== main) };
    }),
  };
}`;
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
const KEYS: Record<"Enter" | "Escape" | "Tab" | "Backspace" | "ArrowDown" | "ArrowUp", KeyDef> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, // no text: a Tab with text types a tab character
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
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
/** Box FN's answer: left, top, width, height, covered by a layer, group, takes typed text, is a select, multi-line,
 * a form text area, read-only, marked to be dragged. */
type BoxInfo = [
  number,
  number,
  number,
  number,
  boolean,
  string,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean?,
  (Box | null)?,
];
/** The accessibility tree's nodes that are controls: a role Drex acts on or a focusable node, with a name unless its
 * role may go without one. */
function axCandidates(nodes: Protocol.Accessibility.AXNode[]): Cand[] {
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
  return cands;
}

const boxCentre = (b: BoxInfo): [number, number] =>
  b[13] ? [(b[13][0] + b[13][2]) / 2, (b[13][1] + b[13][3]) / 2] : [b[0] + b[2] / 2, b[1] + b[3] / 2];
/** suggestionsFn's answer: the new suggestions, each by its centre (CSS px) and text; a new results notice, whether
 * it said one result, and a new notice of no results. */
export interface Suggestions {
  items: { x: number; y: number; text: string }[];
  announced: boolean;
  one?: boolean;
  none?: boolean;
}
/** Tab.pickSuggestion's answer: picked is the item's text ("" when nothing in what appeared was picked), left out when
 * no list or results notice appeared at all; noResults: a notice said there were none for the typed text. */
export interface SuggestionPick {
  ok: boolean;
  picked?: string;
  noResults?: boolean;
}
interface FieldState {
  value: string | null;
  active: string;
  focused: boolean;
}
/** CALENDAR_FN's answer: the month the calendar shows (1-based), the centres of its previous and next controls (null
 * when disabled) and its day cells, each with its number and centre (CSS px). */
interface Calendar {
  header: { y: number; m: number };
  prev: [number, number] | null;
  next: [number, number] | null;
  days: { d: number; x: number; y: number; other: boolean; disabled: boolean }[];
}
/** Tab.setDate's answer: the field holds the date; clicks made in the calendar (the field's own click aside). */
export interface DatePick {
  ok: boolean;
  clicks: number;
}
const CALENDAR_MONTHS = 60; // further than this from the month a calendar opens at is not clicked to (~a minute)
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
/** setDate's check: the field's value names the date in a known form: the year, and the month and day as numbers in
 * that order (2016-04-08, 04/08/2016), or day-first with dots (08.04.2016), or the month by name beside the day
 * (8 April 2016, Apr 8, 2016). */
function holdsDate(value: unknown, date: { y: number; m: number; d: number }): boolean {
  const t = typeof value === "string" ? value.toLowerCase().trim() : "";
  const year = String(date.y);
  if (!new RegExp(`(^|\\D)${year}(\\D|$)`).test(t)) return false;
  const rest = t.replace(year, " ");
  const nums = (rest.match(/\d+/g) ?? []).map(Number);
  const named = [...rest.matchAll(/[a-z]{3,}/g)]
    .map((w) => MONTH_NAMES.findIndex((n) => n.startsWith(w[0])) + 1)
    .filter((m) => m > 0);
  if (named.length) return named[0] === date.m && nums.includes(date.d);
  const [first, second] = /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(t) ? [nums[1], nums[0]] : [nums[0], nums[1]];
  return first === date.m && second === date.d;
}
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
  | "y"
  | "c"
  | "v"
  | "x";

/** confirmedChanges: a GraphQL post (to .../graphql) changes something only when it is a mutation: a query or a
 * subscription reads. A body Chrome did not send with the event (too large) or that isn't JSON says nothing, and counts
 * as no change. */
function graphqlMutation(request: Protocol.Network.Request): boolean {
  try {
    const parsed: unknown = JSON.parse(postBody(request));
    return (Array.isArray(parsed) ? (parsed as unknown[]) : [parsed]).some(
      (op) =>
        !!op &&
        typeof op === "object" &&
        "query" in op &&
        typeof op.query === "string" &&
        /^mutation\b/.test(op.query.trim()),
    );
  } catch {
    return false;
  }
}

/** The body Chrome sent with a request event: its postDataEntries (base64), or the older postData; "" when neither
 * came. */
function postBody(request: Protocol.Network.Request): string {
  const entries = request.postDataEntries ?? [];
  if (entries.length) {
    const bytes = entries.map((e) => atob(e.bytes ?? "")).join("");
    return new TextDecoder().decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
  }
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Chrome still sends it beside postDataEntries
  return request.postData ?? "";
}

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
  /** confirmedChanges: the site's requests that may change something, by request id (mutationsSince) */
  declare mutations: Map<string, Mutation>;
  /** the origin of the page the tab shows (its main frame's last navigation), or "" before one */
  declare siteOrigin: string;
  declare onEvent: (src: chrome.debugger.DebuggerSession, method: string, params?: object) => void;
  /** The run's Stop: once it fires, every command waiting for Chrome rejects with its reason. */
  declare signal: AbortSignal | undefined;
  declare listenerCache: Map<number, { at: number; present: boolean }>;
  /** frames: how far an element inside a same-process iframe sits from the page's viewport (its frame's offset), by
   * backend node id, as the last elements() found it */
  declare frameShift: Map<number, [number, number]>;

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
    this.frameShift = new Map();
    this.urls = new Map(); // request id -> "GET https://...", to name a failed request
    this.mutations = new Map();
    this.siteOrigin = "";
    this.onEvent = (src, method, params) => {
      if (src.tabId !== this.id) return;
      if (method === "Network.requestWillBeSent") {
        const e = need(params) as Protocol.Network.RequestWillBeSentEvent;
        if (!LONG_LIVED.has(e.type)) this.inflight.set(e.requestId, performance.now());
      } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed")
        this.inflight.delete((need(params) as Protocol.Network.LoadingFinishedEvent).requestId);
      else if (method === "Page.frameNavigated" && !(need(params) as Protocol.Page.FrameNavigatedEvent).frame.parentId)
        this.inflight.clear();
      try {
        this.noteMutation(method, params); // always kept: it is a few entries
      } catch {} // an event of a shape it does not expect costs that event's record only, never the diagnostics
      if (this.diagnostics) this.noteProblem(method, params);
    };
  }

  /** confirmedChanges: the site's own requests that may change something (POST, PUT, PATCH, DELETE), and its answers.
   * The site's own: the request goes to the origin of the document that sent it, which is the page the tab shows once
   * it has navigated (a third-party frame posting to itself is not the site). */
  noteMutation(method: string, params: object | undefined): void {
    if (method === "Page.frameNavigated") {
      const { frame } = need(params) as Protocol.Page.FrameNavigatedEvent;
      if (!frame.parentId) this.siteOrigin = originOf(frame.url);
    } else if (method === "Network.requestWillBeSent") {
      const e = need(params) as Protocol.Network.RequestWillBeSentEvent;
      const known = this.mutations.get(e.requestId);
      if (known) {
        // a redirect is the same request sent again. As a GET (a form post's 302 or 303) it fetches the page after the
        // change, which is no change: the post's answer is the redirect. With its method kept (307, 308) it continues
        if (!e.redirectResponse || known.status !== undefined) return;
        if (MUTATING.test(e.request.method)) {
          known.redirectedFrom ??= known.url;
          known.url = e.request.url;
        } else known.status = e.redirectResponse.status;
        return;
      }
      const origin = originOf(e.request.url);
      if (
        !MUTATING.test(e.request.method) ||
        !origin ||
        origin !== originOf(e.documentURL) ||
        (this.siteOrigin && origin !== this.siteOrigin) ||
        TELEMETRY_PATH.test(new URL(e.request.url).pathname) ||
        TELEMETRY_TYPE.test(e.type ?? "") ||
        (GRAPHQL_PATH.test(new URL(e.request.url).pathname) && !graphqlMutation(e.request))
      )
        return;
      this.mutations.set(e.requestId, {
        method: e.request.method.toUpperCase(),
        url: e.request.url,
        type: e.type ?? "",
        ts: performance.now(),
      });
      const oldest = this.mutations.keys().next();
      if (this.mutations.size > MAX_MUTATIONS && !oldest.done) this.mutations.delete(oldest.value);
    } else if (method === "Network.responseReceived") {
      const e = need(params) as Protocol.Network.ResponseReceivedEvent;
      const known = this.mutations.get(e.requestId);
      if (known && known.status === undefined) known.status = e.response.status;
    }
  }

  /** confirmedChanges: the site's answers to its requests that may change something, sent since `ts`
   * (performance.now()): "POST /newsletter/subscriber/new 302", 2xx and 3xx confirmed, 4xx and 5xx rejected. A request
   * not answered yet is left out; a redirected one counts once, as the request the move sent. `strong` when a confirmed
   * one is a form post that navigated (a Document request) or a PUT, PATCH or DELETE: a POST the page's script sends
   * (XHR, Fetch) may be a search or a filter as well as a save. */
  mutationsSince(ts: number): MoveMutations {
    const out: MoveMutations = { confirmed: [], rejected: [] };
    for (const m of this.mutations.values()) {
      if (m.ts < ts || m.status === undefined || m.status < 200) continue;
      const line = `${m.method} ${new URL(m.redirectedFrom ?? m.url).pathname.slice(0, 200)} ${m.status}`;
      (m.status < 400 ? out.confirmed : out.rejected).push(line);
      if (m.status < 400 && (m.type === "Document" || /^(PUT|PATCH|DELETE)$/.test(m.method))) out.strong = true;
    }
    return out;
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

  /** navMap: the site's own navigation links, as "Reports › Marketing › Search Terms -> /admin/search/term/report"
   * lines, a hidden one (inside a closed menu) marked so. */
  async navMap(): Promise<string[]> {
    const rows = JSON.parse((await this.eval(NAV_MAP_EXPR)) as string) as [string, string, number][];
    return rows.map(([path, href, hidden]) => `${path} -> ${href}${hidden ? " (in a closed menu)" : ""}`);
  }

  async notices(): Promise<Notices> {
    return JSON.parse((await this.eval(NOTICES_EXPR)) as string) as Notices;
  }

  /** revealEvidence: where the page shows each of the facts a run's answer cites, and the one scrolled to the middle of
   * the screen when none is shown (REVEAL_FN). */
  async revealFacts(literals: string[], opts: RevealOptions): Promise<Revealed | null> {
    return (await this.eval(
      `(${REVEAL_FN()})(${JSON.stringify(literals)}, ${JSON.stringify(opts)})`,
    )) as Revealed | null;
  }

  /** settingReadback: where the page shows each of these values applied, and the ones it doesn't show (READBACK_FN). */
  async readBack(literals: string[]): Promise<ReadBack> {
    return (await this.eval(`(${READBACK_FN()})(${JSON.stringify(literals)})`)) as ReadBack;
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
    const cands: Cand[] = axCandidates(nodes);
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
    // frames: the controls inside same-process iframes (a calculator, a quiz), their boxes moved to the page's viewport
    this.frameShift = new Map();
    if (accOn("frames")) {
      const framed = await this.frameControls(known);
      cands.push(...framed.cands);
      boxes.push(...framed.boxes);
      metadata.push(...framed.cands.map(() => ({})));
    }
    const found: OnScreen[] = [];
    const off: OffScreen[] = [];
    cands.forEach((c, i) => {
      const box = boxes[i];
      if (!box) return;
      const [x, y, w, h, covered, group, editable, isSelect, multi, textarea, readOnly, draggable, ownText] = box;
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
        c.props.inFrame ? " (inside an embedded frame)" : "",
        field && textarea ? " (multi-line text area)" : "",
        meta.colorField ? " (colour field: type a hex code such as #AB2567)" : "",
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
        // only when set, to keep each element's JSON small
        ...(draggable ? { draggable } : {}),
        ...(readOnly ? { readOnly } : {}),
        ...(ownText ? { ownText } : {}),
      };
      if (box[13] === null || y >= vp.h || y + h <= 0) {
        if ((c.name || ["checkbox", "radio", "slider"].includes(role)) && OFFSCREEN_ROLES.has(role)) {
          const outside = y >= vp.h || y + h <= 0;
          const dist = outside ? (y >= vp.h ? (y - vp.h) / vp.h + 1 : -y / vp.h) : 0.1;
          off.push({
            ...el,
            dist,
            where: outside
              ? `${dist.toFixed(1)} screens ${y >= vp.h ? "down" : "up"}`
              : "clipped inside a scrollable container",
          });
        }
        return;
      }
      if (x + w <= 0 || x >= vp.w) return;
      const box4: Box = box[13] ?? [Math.max(x, 0), Math.max(y, 0), Math.min(x + w, vp.w), Math.min(y + h, vp.h)];
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
        const [names, idx, chosen] = (await this.on(e.node, SELECT_FN)) as [string[], number, string[] | null];
        if (names.length <= SELECT_INLINE) Object.assign(e, { options: names, selectedIndex: idx });
        // longSelects: a longer list (countries, states, time slots) keeps its options too, marked long: the fill
        // macro reads them all, and Drex is offered only the ones the step names (L.buildOptions)
        else if (accOn("longSelects")) Object.assign(e, { options: names, selectedIndex: idx, longList: true });
        // admin forms re-clicked the same group 40 times: they couldn't see it was already chosen
        if (chosen) Object.assign(e, { multiple: true, selectedOptions: chosen });
        if (chosen)
          e.state = `${e.state ?? ""} (multiple choice; chosen: ${chosen.length ? chosen.join(", ").slice(0, 120) : "none"})`;
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
        c: ["KeyC", 67],
        v: ["KeyV", 86],
        x: ["KeyX", 88],
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
        (["a", "y", "z", "c", "v", "x"].includes(spec.key) && !command) ||
        (command &&
          ![
            "a",
            "y",
            "z",
            "c",
            "v",
            "x",
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
        const editCommand = command ? EDIT_COMMANDS[spec.key] : undefined;
        await this.send("Input.dispatchKeyEvent", {
          type: text ? "keyDown" : "rawKeyDown",
          key,
          code,
          windowsVirtualKeyCode: vk,
          modifiers: mask,
          ...(text ? { text } : {}),
          // Chrome's editing commands for the chords a page can't see as text: select all, undo/redo, copy/paste/cut, and moving to
          // the start or end of a text box (Ctrl+End did nothing in a text area: it needs moveToEndOfDocument)
          ...(editCommand ? { commands: [editCommand] } : {}),
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
    const x = spec.x,
      y = spec.y;
    let pressed = false;
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
      } else await this.pointerDrag(x, y, endX, endY);
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

  /** Press at (x0, y0), move to (x1, y1) in 12 steps with the button held, release there; the button is released
   * whatever fails on the way. */
  private async pointerDrag(x0: number, y0: number, x1: number, y1: number): Promise<void> {
    let x = x0,
      y = y0,
      pressed = false;
    try {
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
        x = x0 + ((x1 - x0) * i) / 12;
        y = y0 + ((y1 - y0) * i) / 12;
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

  /** Drags one element onto another as a person would: the mouse goes to the middle of the part of the first one that
   * is on screen (the box Drex is shown, as Tab.elements clips it), presses, moves onto the second one's with the
   * button held and releases just past it. True when the dragged element then sits elsewhere on the page or under
   * another parent (the page took the drag); false when it doesn't; null when either element has no part on screen
   * (nothing is sent then). */
  async dragTo(fromNode: number, toNode: number): Promise<boolean | null> {
    const read = (n: number) => (this.on(n, BOX_FN) as Promise<BoxInfo | null>).catch(() => null);
    const [source, target] = await Promise.all([read(fromNode), read(toNode)]);
    const { w, h } = await this.viewport();
    // left, top, right, bottom of the part on screen, at least 3 px each way (what Tab.elements keeps), or null
    const onScreen = (b: BoxInfo | null): Box | null => {
      if (!b || b[4] || b[13] === null) return null;
      const c: Box = b[13] ?? [
        Math.max(b[0], 0),
        Math.max(b[1], 0),
        Math.min(b[0] + b[2], w),
        Math.min(b[1] + b[3], h),
      ];
      return c[2] - c[0] >= 3 && c[3] - c[1] >= 3 ? c : null;
    };
    const fromBox = onScreen(source),
      toBox = onScreen(target);
    if (!fromBox || !toBox) return null;
    const middle = (b: Box): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const from = middle(fromBox),
      to = middle(toBox);
    const place = () =>
      this.on(fromNode, PLACE_FN)
        .then((v) => JSON.stringify(v))
        .catch(() => "gone");
    const before = await place();
    this.inputAt = performance.now();
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from[0], y: from[1], buttons: 0 });
    // dropped a few pixels past the target's centre, along the drag's main axis and never outside the target: a
    // sortable list (jQuery UI's) puts an item before another only once the pointer has crossed that one's middle
    // going up or left
    const axis = Math.abs(to[0] - from[0]) >= Math.abs(to[1] - from[1]) ? 0 : 1;
    const size = axis === 0 ? toBox[2] - toBox[0] : toBox[3] - toBox[1];
    const past = Math.sign(to[axis] - from[axis]) * Math.min(DROP_PAST, Math.max(0, size / 2 - 1));
    const [endX, endY] = axis === 0 ? [to[0] + past, to[1]] : [to[0], to[1] + past];
    await this.pointerDrag(from[0], from[1], endX, endY);
    await sleep(50); // a page may put the dropped element in its place on the next frame
    return before !== (await place());
  }

  /** Copies one element's text into a field without the clipboard: the source's own value (a field) or its innerText,
   * the target focused by a click on its centre, emptied (append: caret to its end instead), and given the text whole (a text area keeps its lines), then
   * the page is told. Nothing is touched when the source has no text: {chars: 0}. */
  async copyInto(fromNode: number, toNode: number, append = false): Promise<{ chars: number }> {
    const read = (await this.on(
      fromNode,
      `function(){ return typeof this.value === 'string' && (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') ? this.value : (this.innerText || '') }`,
    )) as string | null;
    const text = typeof read === "string" ? read : "";
    if (!text) return { chars: 0 };
    const at = await this.centre(toNode);
    this.inputAt = performance.now();
    if (at) await this.click(...at);
    else await this.send("DOM.focus", { backendNodeId: toNode }); // not on screen: focus it without a click
    // a document editor (an email body) is added to at its end, never wiped; an input or form text area is replaced
    if (append) await this.caretToEnd();
    else await this.clearField();
    await this.send("Input.insertText", { text });
    await this.eval(NOTIFY_EXPR).catch(() => undefined);
    return { chars: text.length };
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

  /** Scrolls where the work is: the scrollable box the focused element sits in (a text area, a pane, a dialog's list),
   * else, when the page itself can't scroll, the largest scrollable box on screen; otherwise the page. A wheel at the
   * page's centre missed a box elsewhere on it (a terms box, a calendar's day, a side list), and a box the wheel doesn't
   * move (a disabled text area) is scrolled by its position instead. */
  async scroll(down: boolean): Promise<void> {
    const { w, h } = await this.viewport();
    const sign = down ? 1 : -1;
    const box = (await this.eval(SCROLL_BOX_EXPR).catch(() => null)) as [number, number, number] | null;
    this.inputAt = performance.now();
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: box ? box[0] : w / 2,
      y: box ? box[1] : h / 2,
      deltaX: 0,
      deltaY: sign * Math.round(h * 0.7),
    });
    if (!box) return;
    await sleep(120);
    await this.eval(
      `(() => { const e = document.querySelector("[data-drex-scroll]"); if (!e) return;
        if (e.scrollTop === ${box[2]}) { e.scrollTop += ${sign} * Math.max(40, e.clientHeight * 0.8); e.dispatchEvent(new Event("scroll")); }
        e.removeAttribute("data-drex-scroll"); })()`,
    ).catch(() => undefined);
  }

  /** Is there a real page before this one in the tab's history (not about:blank, a new tab or nothing)? */
  async canGoBack(): Promise<boolean> {
    const h = await this.send("Page.getNavigationHistory").catch(() => null);
    if (!h) return true; // unknown: Back is allowed, as before
    const prev = h.entries[h.currentIndex - 1];
    return !!prev && !/^(about:blank|chrome:\/\/newtab|chrome-search:|about:newtab)/i.test(prev.url);
  }

  async scrollIntoView(node: number): Promise<void> {
    await this.on(
      node,
      "function () { this.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); }",
    );
    await sleep(350);
  }

  /** frames: the controls of the page's iframes that share its process (a cross-site frame in another process has no
   * accessibility tree here and is left out), at most MAX_FRAMES frames, MAX_FRAME_DEPTH deep. Each box is moved by
   * its frame's offset (the iframe's box plus its border) and cut to the part of the iframe on screen; frameShift
   * keeps the offset for later lookups (centre). */
  async frameControls(known: Set<number>): Promise<{ cands: Cand[]; boxes: (BoxInfo | null)[] }> {
    const out: { cands: Cand[]; boxes: (BoxInfo | null)[] } = { cands: [], boxes: [] };
    const tree = await this.send("Page.getFrameTree").catch(() => null);
    if (!tree) return out;
    let frames = 0;
    const walk = async (
      node: Protocol.Page.FrameTree,
      depth: number,
      shift: [number, number],
      clip: Box | null,
    ): Promise<void> => {
      for (const child of node.childFrames ?? []) {
        if (frames >= MAX_FRAMES || depth > MAX_FRAME_DEPTH) return;
        const owner = await this.send("DOM.getFrameOwner", { frameId: child.frame.id }).catch(() => null);
        if (!owner?.backendNodeId) continue;
        const ob = (await this.on(owner.backendNodeId, BOX_FN).catch(() => null)) as BoxInfo | null;
        if (!ob || ob[4] || ob[13] === null || ob[2] < 20 || ob[3] < 20) continue; // hidden, covered or a tracker pixel
        const border = ((await this.on(
          owner.backendNodeId,
          "function () { return [this.clientLeft, this.clientTop]; }",
        ).catch(() => [0, 0])) ?? [0, 0]) as [number, number];
        const dx = shift[0] + ob[0] + border[0];
        const dy = shift[1] + ob[1] + border[1];
        const shown = ob[13] ?? [ob[0], ob[1], ob[0] + ob[2], ob[1] + ob[3]];
        const own: Box = [shown[0] + shift[0], shown[1] + shift[1], shown[2] + shift[0], shown[3] + shift[1]];
        const area: Box = clip
          ? [Math.max(own[0], clip[0]), Math.max(own[1], clip[1]), Math.min(own[2], clip[2]), Math.min(own[3], clip[3])]
          : own;
        const ax = await this.send("Accessibility.getFullAXTree", { frameId: child.frame.id }).catch(() => null);
        if (!ax) continue; // another process (a cross-site frame): no tree here
        frames++;
        const cands = axCandidates(ax.nodes).filter((c) => !known.has(c.id));
        const boxes = (await Promise.all(
          cands.map((c) => this.on(c.id, BOX_FN).catch(() => null)),
        )) as (BoxInfo | null)[];
        cands.forEach((c, i) => {
          const b = boxes[i];
          if (!b) return;
          known.add(c.id);
          this.frameShift.set(c.id, [dx, dy]);
          const inner = b[13] ?? [b[0], b[1], b[0] + b[2], b[1] + b[3]];
          const moved: Box = [
            Math.max(inner[0] + dx, area[0]),
            Math.max(inner[1] + dy, area[1]),
            Math.min(inner[2] + dx, area[2]),
            Math.min(inner[3] + dy, area[3]),
          ];
          const visible = b[13] === null || moved[2] - moved[0] < 3 || moved[3] - moved[1] < 3 ? null : moved;
          const next = [...b] as BoxInfo;
          next[0] = b[0] + dx;
          next[1] = b[1] + dy;
          next[13] = visible;
          out.cands.push({ ...c, props: { ...c.props, inFrame: true } });
          out.boxes.push(next);
        });
        await walk(child, depth + 1, [dx, dy], area);
      }
    };
    await walk(tree.frameTree, 1, [0, 0], null);
    return out;
  }

  /** The element's centre on screen now (after a scroll it has moved). */
  async centre(node: number): Promise<[number, number] | null> {
    const box = (await this.on(node, BOX_FN)) as BoxInfo | null;
    if (!box || box[4] || box[13] === null) return null;
    const point = boxCentre(box);
    // frames: a control inside an iframe is checked at its frame's own point and clicked at the page's
    const shift = this.frameShift.get(node);
    if (shift) {
      const local = point;
      const hitHere = await this.on(
        node,
        `function () { const hit = document.elementFromPoint(${local[0]}, ${local[1]}); return !!hit && (hit === this || this.contains(hit)); }`,
      );
      return hitHere ? [local[0] + shift[0], local[1] + shift[1]] : null;
    }
    const hit = await this.on(
      node,
      `function () {
      const hit = document.elementFromPoint(${point[0]}, ${point[1]});
      return !!hit && (hit === this || this.contains(hit) || Array.from(this.labels || []).some(l => l === hit || l.contains(hit)) || (this.getRootNode().host && hit === this.getRootNode().host));
    }`,
    );
    return hit ? point : null;
  }

  /** Read public field state to verify a fill. */
  async fieldValue(node: number): Promise<FieldValue> {
    return this.on(
      node,
      `function () { const meta = (${METADATA_FN}).call(this); if (meta.slider?.kind === "custom") return {value:meta.slider.value,disabled:meta.disabled}; return {value: this.value ?? this.getAttribute("aria-valuenow") ?? this.innerText,
      checked: this.checked ?? (this.getAttribute("aria-checked") === "true"),
      selectedIndex: this.selectedIndex, multiple: !!this.multiple, selectedOptions: this.options ? Array.from(this.selectedOptions).map(o => o.text.trim()) : undefined, disabled: !!this.disabled}; }`,
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
    const done = await this.on(node, temporalFn(text)).catch(() => false);
    if (done) this.inputAt = performance.now();
    return done === true;
  }

  /** datePicker: sets a read-only date field (a date picker's input) through the calendar it opens, as a person does:
   * a click on the field, Prev or Next until the calendar shows the date's month (its header read again after each
   * click: a click that doesn't bring it nearer ends the routine), a click on the day (not another month's, not a
   * disabled one), then the field's value must hold the date. The page settles after each click. When any of that
   * fails, the date is given to a native date input's setter (setTemporal); ok is false when that fails too. */
  async setDate(node: number, date: { y: number; m: number; d: number }): Promise<DatePick> {
    let clicks = 0;
    const pad = (n: number) => String(n).padStart(2, "0");
    const failed = async (): Promise<DatePick> => ({
      ok: await this.setTemporal(node, `${date.y}-${pad(date.m)}-${pad(date.d)}`),
      clicks,
    });
    const at = await this.centre(node).catch(() => null);
    if (!at) return failed();
    await this.click(...at);
    await this.settle();
    const read = async () => ((await this.eval(`(${CALENDAR_FN})()`).catch(() => null)) as Calendar | null) ?? null;
    const away = (c: Calendar) => (date.y - c.header.y) * 12 + (date.m - c.header.m);
    let cal = await read();
    if (!cal || Math.abs(away(cal)) > CALENDAR_MONTHS) return failed();
    while (away(cal) !== 0) {
      const before = away(cal);
      const control = before < 0 ? cal.prev : cal.next;
      if (!control) return failed();
      await this.click(...control);
      clicks++;
      await this.settle();
      const now = await read();
      // the header didn't come nearer the date: a calendar at its first or last month, a control that does other things
      if (!now || Math.abs(away(now)) >= Math.abs(before)) return failed();
      cal = now;
    }
    const day = cal.days.find((c) => c.d === date.d && !c.other && !c.disabled);
    if (!day) return failed();
    await this.click(day.x, day.y);
    clicks++;
    await this.settle();
    this.inputAt = performance.now();
    const value = await this.on(node, "function () { return this.value; }").catch(() => null);
    return holdsDate(value, date) ? { ok: true, clicks } : failed();
  }

  /** setTemporal for the field the cursor is in (a "type at the cursor" move): the same "8:22 AM" went into the hours
   * segment when the move typed at the cursor instead of into a named field. */
  async setTemporalFocused(text: string): Promise<boolean> {
    const done = await this.eval(
      `(() => { let e = document.activeElement; while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement; return e ? (${temporalFn(text)}).call(e) : false; })()`,
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

  /** pickSuggestion: does the field say it has suggestions (AUTOCOMPLETE_HINT_FN)? Only such a field waits for them. */
  async autocompleteHint(field: number): Promise<boolean> {
    return (await this.on(field, AUTOCOMPLETE_HINT_FN)) === true;
  }

  /** pickSuggestion, just before typing into the field: notes the suggestion lists and live regions on the page now,
   * which say nothing about what is about to be typed. Returns the page's clock, for suggestions(); null when the page
   * gave none (then nothing is picked: every list on it would count as new). */
  async markSuggestions(field: number): Promise<number | null> {
    const now = await this.on(field, suggestionsFn(null));
    return typeof now === "number" ? now : null;
  }

  /** The field's suggestions that showed after markSuggestions (since), and whether a results notice came. */
  async suggestions(field: number, since: number): Promise<Suggestions> {
    const found = (await this.on(field, suggestionsFn(since))) as Suggestions | null | undefined;
    return found ?? { items: [], announced: false };
  }

  /** The field's value, highlighted option and focus (FIELD_STATE_FN); null when it can't be read (the field is gone). */
  async fieldState(field: number): Promise<FieldState | null> {
    return ((await this.on(field, FIELD_STATE_FN).catch(() => null)) as FieldState | null | undefined) ?? null;
  }

  /** After typing `typed` into the field (pickSuggestion): waits up to ms for its suggestions, then clicks the one
   * equal to the typed text (case and spacing aside), else the first that starts with it, else the first that contains
   * it as a word ("SHV" in "Shreveport, LA (SHV)", not in "Nashville"), else the first that contains it, else the only
   * one (or the first, when the notice said one result). A results notice with no list found gets ArrowDown, then Enter
   * once the arrow highlighted something. A notice of no results ends the wait. ok: the field's value now starts with
   * the typed text or the picked item. */
  async pickSuggestion(field: number, typed: string, since: number, ms = SUGGEST_WAIT_MS): Promise<SuggestionPick> {
    const norm = (t: string) => t.split(/\s+/).join(" ").trim().toLowerCase();
    const want = norm(typed);
    if (!want) return { ok: false };
    const t0 = performance.now();
    let first = await this.suggestions(field, since);
    while (!first.items.length && !first.announced) {
      if (first.none) return { ok: false, noResults: true };
      if (performance.now() - t0 >= ms) return { ok: false };
      await sleep(SUGGEST_POLL_MS);
      first = await this.suggestions(field, since);
    }
    // the rest of the list renders (as in waitForSuggestions); what shows then is what is picked from
    await sleep(SUGGEST_POLL_MS);
    const { items, announced, one } = await this.suggestions(field, since);
    const find = (match: (text: string) => boolean) => items.find((i) => match(norm(i.text)));
    const word = (t: string) => {
      for (let i = t.indexOf(want); i >= 0; i = t.indexOf(want, i + 1))
        if (!ALNUM.test(t[i - 1] ?? "") && !ALNUM.test(t[i + want.length] ?? "")) return true;
      return false;
    };
    const item =
      find((t) => t === want) ??
      find((t) => t.startsWith(want)) ??
      find(word) ??
      find((t) => t.includes(want)) ??
      (items.length === 1 || one || first.one ? items[0] : undefined);
    this.inputAt = performance.now();
    let picked = "";
    if (item) {
      await this.click(item.x, item.y);
      picked = item.text;
    } else if (items.length || !(announced || first.announced)) return { ok: false, picked: "" };
    else {
      // the keys go to whatever has the focus: none when the field has lost it
      const before = await this.fieldState(field);
      if (!before?.focused) return { ok: false, picked: "" };
      await this.key("ArrowDown");
      await sleep(SUGGEST_POLL_MS);
      const moved = await this.fieldState(field);
      // Enter only once the arrow highlighted something (the value, the field's active option, or the focus moved into
      // the list): in a field nothing answers, Enter would submit its form
      if (!moved || (moved.value === before.value && !moved.active && moved.focused)) return { ok: false, picked: "" };
      await this.key("Enter");
    }
    await sleep(SUGGEST_POLL_MS);
    const value = (await this.fieldState(field))?.value ?? null;
    const ok = value !== null && [want, norm(picked)].some((w) => !!w && norm(value).startsWith(w));
    // a pick made by the keys has no item text: what it put in the field is the pick
    return { ok, picked: picked || (ok && value ? value : "") };
  }

  /** Set the complete requested set of a native multiselect; reject missing/ambiguous labels before touching it. */
  async selectValues(node: number, values: string[]): Promise<boolean> {
    return this.on(
      node,
      `function () {
      const values = ${JSON.stringify(values)};
      if (this.tagName !== "SELECT" || !this.multiple || this.disabled) return false;
      const options = Array.from(this.options);
      if (values.some(v => options.filter(o => o.text.trim() === v).length !== 1)) return false;
      const chosen = new Set(values);
      let changed = false;
      for (const o of options) { const want = chosen.has(o.text.trim()); if (o.selected !== want) { o.selected = want; changed = true; } }
      if (changed) { this.dispatchEvent(new Event('input', {bubbles:true})); this.dispatchEvent(new Event('change', {bubbles:true})); }
      return true;
    }`,
    ) as Promise<boolean>;
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
