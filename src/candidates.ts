import type { PublicMetadata } from "./types.ts";

// Clickable things the accessibility tree misses: a canvas, or a div/span/svg that only a click handler or a pointer
// cursor makes clickable. Native controls (inputs, buttons, links, selects) are left out: the accessibility tree has
// them already. Only rendered public DOM is inspected, never application globals or handler source.
// The DevTools command-line getEventListeners exists in a plain DevTools session but not under chrome.debugger, so
// with probeListeners the painted or labelled leaf elements on screen that nothing else marks as clickable come last,
// from index probeFrom on: the caller keeps those of them that DOMDebugger.getEventListeners finds a click listener on
// (MiniWoB's color tiles are spans with only an addEventListener("click")).
/** What domCandidates reads off an element: the properties only some elements have are optional. */
interface Candidate extends Element {
  innerText?: string;
  href?: string;
  rel?: string;
  onclick?: unknown;
}
declare function getEventListeners(e: Element): Record<string, unknown[]>;
export function domCandidates({ probeListeners = false } = {}): Element[] & { probeFrom?: number } {
  const roots: (Document | ShadowRoot)[] = [document],
    out: Element[] = [],
    probes: Element[] = [];
  // controls the accessibility tree lists: a pointer-styled wrapper around one (the same box, or no text of its own
  // besides theirs) or a pointer-styled part inside one (a menu item's <li>, its caret icon) is the same control again
  // under a second, vaguer name. Drex clicked MiniWoB's <li> "Jinny", which chose Jinny instead of opening its submenu.
  const control =
    "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox]," +
    "[role=menuitemradio],[role=option],[role=tab],[role=checkbox],[role=radio],[role=switch]";
  // the accessibility tree drops a nameless button, link or menu item (an icon with no label): its pointer-styled
  // wrapper or icon stays the one click target. Fields and toggles are listed without a name. Nothing under
  // aria-hidden="true" is listed, so a pointer-styled wrapper around an aria-hidden checkbox stays the target.
  const listed = (c: Element) =>
    !c.closest('[aria-hidden="true"]') &&
    (c.matches("input,select,textarea,[role=checkbox],[role=radio]") ||
      !!(
        c.getAttribute("aria-label")?.trim() ||
        c.getAttribute("aria-labelledby")?.trim() ||
        c.getAttribute("title")?.trim() ||
        c.textContent.trim() ||
        c.querySelector("img[alt]:not([alt='']),svg title")
      ));
  const same = (a: DOMRect, b: DOMRect) =>
    Math.abs(a.left - b.left) <= 3 &&
    Math.abs(a.top - b.top) <= 3 &&
    Math.abs(a.right - b.right) <= 3 &&
    Math.abs(a.bottom - b.bottom) <= 3;
  scan: for (const root of roots)
    for (const e of root.querySelectorAll<Candidate>("*")) {
      if (e.shadowRoot) roots.push(e.shadowRoot);
      if (e.closest("[data-drex], #__drex_cursor")) continue;
      if (e.matches(".ui-slider-handle") && e.closest(".ui-slider")) continue;
      const customSlider = e.matches(".ui-slider") && !!e.querySelector(".ui-slider-handle");
      let pager = false;
      if (e.matches("a[href]")) {
        const label = (e.getAttribute("aria-label") || e.innerText || "").replace(/\s+/g, " ").trim();
        try {
          const url = new URL(String(e.href), location.href);
          const marker = e.closest(
            '[aria-label*="pagination" i], [aria-label*="pages" i], .pagination, .pages, .toolbar, [role="navigation"]',
          );
          const numbered = /^(?:page\s*)?\d+$/i.test(label);
          const pageParam = [...url.searchParams.keys()].some((k) =>
            /^(?:p|page|page_number|pageindex|offset)$/i.test(k),
          );
          pager =
            url.origin === location.origin &&
            (/\b(?:next|prev)\b/i.test(e.rel ?? "") ||
              (numbered && (!!marker || pageParam)) ||
              (!!marker && /\b(?:next|previous|older|newer)\b/i.test(label)));
        } catch {}
      }
      if (!pager && e.matches("input,button,select,textarea,a[href],summary,option,label")) continue;
      const canvas = e.tagName === "CANVAS";
      const custom = e.matches("div,span,svg,li,td,img");
      if (!canvas && !custom && !customSlider && !pager) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) continue;
      const s = getComputedStyle(e);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") continue;
      const events = typeof getEventListeners === "function" && !canvas ? getEventListeners(e) : {};
      const listener =
        e.hasAttribute("onclick") ||
        typeof e.onclick === "function" ||
        ["click", "pointerdown", "mousedown"].some((k) => events[k]?.length);
      const pointer =
        s.cursor === "pointer" &&
        (!e.parentElement || getComputedStyle(e.parentElement).cursor !== "pointer" || e.children.length === 0);
      if (pointer && !(canvas || customSlider || pager || listener)) {
        // only controls cdp lists with a box (at least 3x3, as Tab.elements keeps) inside the wrapper's: a switch's hidden,
        // 0x0, sr-only 1x1, moved-off-screen (left:-9999px) or visibility:hidden <input> is not listed, so its
        // pointer-styled wrapper stays the one click target
        const inner = [...e.querySelectorAll(control)].filter((c) => {
          const b = c.getBoundingClientRect(),
            cs = getComputedStyle(c);
          return (
            b.width >= 3 &&
            b.height >= 3 &&
            cs.visibility !== "hidden" &&
            (cs.opacity !== "0" || c.matches("input,[role=checkbox],[role=radio],[role=switch]")) &&
            listed(c)
          );
        });
        const shown = inner.filter((c) => {
          const b = c.getBoundingClientRect();
          return (
            Math.min(b.right, r.right) - Math.max(b.left, r.left) >= 3 &&
            Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top) >= 3
          );
        });
        const outer = e.parentElement?.closest(control);
        // text of every rendered listed inner control is theirs, wherever it sits (an open popup below the wrapper's
        // box included); a closed, display:none list's options are not, so they do not erase the wrapper's own label
        const own = inner
          .reduce((t, c) => (c.textContent ? t.split(c.textContent).join(" ") : t), e.textContent)
          .trim();
        const first = shown[0];
        // a wrapper with no text of its own is its inner control again, even one painting a picture (a photo tile around
        // its Delete button): listed as well, under its own name or none, a click on its centre could land on that
        // control with no approval
        if ((outer && listed(outer)) || (first && (!own || same(first.getBoundingClientRect(), r)))) continue;
      }
      if (canvas || customSlider || pager || listener || pointer) out.push(e);
      else if (
        probeListeners &&
        custom &&
        probes.length < 64 &&
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < innerHeight &&
        r.left < innerWidth &&
        e.children.length <= 6 &&
        !e.querySelector(control) &&
        !e.parentElement?.closest(control) &&
        (/^(?:svg|img)$/i.test(e.tagName) ||
          !!(e.innerText ?? "").trim() ||
          !/^(?:transparent|rgba\(.*,\s*0\))$/.test(s.backgroundColor) ||
          ["Top", "Right", "Bottom", "Left"].some(
            (side) =>
              parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
              s.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none",
          ))
      )
        probes.push(e);
      if (out.length >= 150) break scan;
    }
  return Object.assign([...out, ...probes], { probeFrom: out.length });
}

// One element's public name, role, checked state and slider range. Runs on the element (this).
/** What publicMetadata reads off the element it runs on: the properties only some elements have are optional. */
interface Probe extends HTMLElement {
  labels?: NodeListOf<HTMLElement> | null;
  value?: string;
  checked?: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  type?: string;
  href?: string;
}
export function publicMetadata(this: Probe): PublicMetadata {
  const flat = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
  const labels = this.labels ? [...this.labels].map((e) => e.innerText).join(" ") : "";
  const labelled = (this.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.innerText || "")
    .join(" ");
  const name = flat(
    this.getAttribute("aria-label") ||
      labelled ||
      labels ||
      this.getAttribute("title") ||
      this.innerText ||
      this.getAttribute("alt") ||
      this.getAttribute("placeholder"),
  ).slice(0, 120);
  const number = (v: string | null | undefined, fallback: number) =>
    v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback;
  const custom = this.matches(".ui-slider") && !!this.querySelector(".ui-slider-handle");
  let observed = null;
  if (custom) {
    const values = [];
    for (const e of this.parentElement?.children ?? []) {
      if (e === this || e.contains(this)) continue;
      const r = e.getBoundingClientRect(),
        st = getComputedStyle(e);
      if (!r.width || !r.height || st.display === "none" || st.visibility === "hidden" || st.opacity === "0") continue;
      const text = flat((e as Candidate).innerText);
      const match = /^(?:(?:value|current)\s*[:=]?\s*)?([+-]?\d+(?:\.\d+)?)$/i.exec(text);
      if (match) values.push(Number(match[1]));
    }
    if (values.length === 1) observed = values[0] ?? null;
  }
  const slider = custom
    ? {
        kind: "custom" as const,
        min: null,
        max: null,
        step: null,
        value: observed,
        orientation: this.classList.contains("ui-slider-vertical") ? "vertical" : "horizontal",
      }
    : this.matches("input[type=range], [role=slider]")
      ? {
          min: number(this.getAttribute("min") ?? this.getAttribute("aria-valuemin"), 0),
          max: number(this.getAttribute("max") ?? this.getAttribute("aria-valuemax"), 100),
          step: number(this.getAttribute("step"), 1),
          value: number(this.value ?? this.getAttribute("aria-valuenow"), 0),
          orientation:
            this.getAttribute("aria-orientation") ||
            (getComputedStyle(this).writingMode.startsWith("vertical") ? "vertical" : "horizontal"),
        }
      : null;
  let paginationURL = "",
    paginationLabel = "";
  if (this.matches("a[href]")) {
    try {
      const u = new URL(String(this.href), location.href);
      const marker = this.closest(
        '[aria-label*="pagination" i], [aria-label*="pages" i], .pagination, .pages, .toolbar, [role="navigation"]',
      );
      const rel = this.getAttribute("rel") ?? "";
      const numbered = /^(?:page\s*)?\d+$/i.test(name);
      const pageParam = [...u.searchParams.keys()].some((k) => /^(?:p|page|page_number|pageindex|offset)$/i.test(k));
      const pager =
        /\b(?:next|prev)\b/i.test(rel) ||
        (numbered && (!!marker || pageParam)) ||
        (!!marker && /\b(?:next|previous|older|newer)\b/i.test(name));
      const mutation =
        /(?:delete|remove|reorder|checkout|logout|log.out|subscribe|submit|purchase|addtocart|add.to.cart|cancel)/i;
      if (
        pager &&
        u.origin === location.origin &&
        /^https?:$/.test(u.protocol) &&
        !mutation.test(decodeURIComponent(u.pathname + " " + u.search)) &&
        this.getAttribute("aria-current") !== "page" &&
        this.getAttribute("aria-disabled") !== "true" &&
        !this.hasAttribute("disabled") &&
        u.href !== location.href
      ) {
        paginationURL = u.href;
        paginationLabel = numbered ? "Page " + name.replace(/^page\s*/i, "") : name || rel;
      }
    } catch {}
  }
  const type = this.type;
  const role = slider
    ? "slider"
    : this.getAttribute("role") ||
      (this.tagName === "CANVAS"
        ? "canvas"
        : this.tagName === "SELECT"
          ? "combobox"
          : type === "checkbox" || type === "radio"
            ? type
            : // a submit, button or image input is a button: the approval gate judges it by its name ("Place your order")
              this.tagName === "INPUT" && /^(submit|button|reset|image)$/.test(type ?? "")
              ? "button"
              : this.tagName === "INPUT" || this.tagName === "TEXTAREA"
                ? "textbox"
                : this.tagName === "A"
                  ? "link"
                  : "button");
  const checkable = this.matches("input[type=checkbox],input[type=radio],[role=checkbox],[role=radio],[role=switch]");
  const ariaChecked = this.getAttribute("aria-checked");
  const checked =
    typeof this.checked === "boolean"
      ? this.checked
      : ariaChecked === "true"
        ? true
        : ariaChecked === "false"
          ? false
          : null;
  const indeterminate = this.indeterminate === true || ariaChecked === "mixed";
  // An unlabeled control that shows no text is known by its look alone (a color tile, a swatch): its painted color,
  // named by hue band and given as hue/saturation/lightness, says "light red" where the picture left Haiku torn
  // between pink and red (MiniWoB click-shades: hsl(0 74% 83%) was left out of "the shades of red").
  let color = "";
  if (!name && !flat(this.innerText) && !this.matches("input,select,textarea,canvas,img,svg")) {
    const paint = getComputedStyle(this);
    // a gradient or picture paints over the background color, and a translucent one blends with what lies under it,
    // so only an opaque background color (rgb(), no alpha) is the color that shows,
    // and opacity, a filter or a blend mode on it or any ancestor changes it again on screen
    const plain = (a: Element) => {
      const as = getComputedStyle(a);
      return as.opacity === "1" && as.filter === "none" && as.mixBlendMode === "normal";
    };
    // up the rendered tree: into the slot it shows in, and out of a shadow root to its host
    const up = (a: Element): Element | null =>
      a.assignedSlot ?? a.parentElement ?? (a.parentNode instanceof ShadowRoot ? a.parentNode.host : null);
    let shown = plain(this);
    for (let a = up(this); a && shown; a = up(a)) shown = plain(a);
    const m =
      shown && paint.backgroundImage === "none" ? /^rgb\((\d+), (\d+), (\d+)\)$/.exec(paint.backgroundColor) : null;
    if (m) {
      const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number(v) / 255) as [number, number, number];
      const max = Math.max(r, g, b),
        min = Math.min(r, g, b),
        l = (max + min) / 2,
        d = max - min;
      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      const hue = Math.round(h * 60),
        sat = Math.round(s * 100),
        light = Math.round(l * 100);
      // a plain name by hue band, as a person would say it: hue 0 at 83% lightness is "light red", not "pink"
      const bands: [number, string][] = [
        [15, "red"],
        [45, "orange"],
        [70, "yellow"],
        [160, "green"],
        [200, "cyan"],
        [255, "blue"],
        [290, "purple"],
        [335, "magenta"],
        [361, "red"],
      ];
      const named =
        sat < 12
          ? light > 90
            ? "white"
            : light < 10
              ? "black"
              : "gray"
          : (light > 75 ? "light " : light < 30 ? "dark " : "") + (bands.find(([top]) => hue < top)?.[1] ?? "red");
      color = `${named}, hsl(${hue} ${sat}% ${light}%)`;
    }
  }
  return {
    name,
    ...(color ? { color } : {}),
    slider,
    role,
    paginationURL,
    paginationLabel,
    ...(checkable ? { checked, indeterminate } : {}),
    disabled:
      !!this.disabled || this.getAttribute("aria-disabled") === "true" || this.classList.contains("ui-state-disabled"),
  };
}
