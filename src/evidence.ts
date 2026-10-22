// The end of a run that found an answer: the answer should be on screen, not under a pop-up or below the fold, since
// whoever checks the run (a person, or a benchmark's judge reading screenshots) sees the screen. For example, a run
// reached the article with the answer, a newsletter pop-up covered it, and the answer was never scrolled to. revealAnswer runs in the page (Tab.eval sends its source), so it uses nothing from outside itself.
// revealFacts (the revealEvidence switch; Tab.revealFacts sends it with logic.ts normalizeLiteral and revealAnswer) is
// the same end with what the reveal diagnostic found missing: a fact matched across the elements that hold it, shown only
// in the middle of the screen with nothing over it, and a picker the run's last moves left open closed first.

/** What revealAnswer found: a nuisance pop-up's close control to click (CSS pixels), or where the answer is. */
export interface Reveal {
  /** the centre of a close / no-thanks control of a newsletter, cookie, app or offer pop-up over the page */
  closer: [number, number] | null;
  closerName: string;
  /** an answer token was already in the viewport */
  visible: boolean;
  /** the token scrolled into view (scroll: true), or "" */
  scrolled: string;
  /** where each token is (for the run's log): in the viewport or not, or on no text of the page */
  found: Record<string, Seen>;
}

export function revealAnswer(tokens: string[], scroll: boolean): Reveal {
  const flat = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const W = innerWidth,
    H = innerHeight;
  // a pop-up that only sells something: a newsletter, sign-up, cookie, app or discount offer. One that reports what
  // the run did (added to cart, an order, a booking) is evidence and stays.
  const NUISANCE =
    /newsletter|subscribe|sign ?up|cookie|consent|notifications?|download (our|the) app|get the app|% off|discount|special offer|join (now|us|our)|stay (updated|in touch)/i;
  const EVIDENCE =
    /added to (your )?(cart|bag|basket)|in your (cart|bag)|order (placed|confirmed|number)|booking|reservation/i;
  const CLOSE =
    /^(close|close (dialog|modal|popup|pop-up|banner)|dismiss|×|✕|✖|x|no,? thanks|no thank you|not now|maybe later|skip)$/i;
  // declining is a cookie or consent banner's own close, not an invitation's or an offer's answer
  const DECLINE = /^(reject all|decline|i decline|continue without (accepting|agreeing))$/i;
  // not "privacy": a newsletter's or an invitation's pop-up links its Privacy Policy too
  const CONSENT = /cookie|consent/i;
  // a close control submits nothing and goes nowhere: not a form's submit button (a "No thanks" inside a newsletter
  // form submits it) and not a link to another page
  const inert = (c: Element) => {
    if (c.matches("input[type=submit], input[type=image]")) return false;
    if (c instanceof HTMLButtonElement && c.type === "submit" && c.form) return false;
    const href = c.getAttribute("href");
    return !(c.matches("a[href]") && href && !/^(#|javascript:)/i.test(href.trim()));
  };
  let closer: [number, number] | null = null,
    closerName = "";
  const overlays = [...document.querySelectorAll("[role=dialog], [aria-modal=true], dialog[open], body *")]
    .filter((e) => {
      if (!shown(e)) return false;
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      const dialog = e.matches("[role=dialog], [aria-modal=true], dialog");
      // a pop-up floats over the page and says little; a fixed page shell or sidebar holds the page's own text
      const short = ((e as HTMLElement).innerText || "").length <= 1500;
      return (
        (cs.position === "fixed" || dialog) && short && r.width * r.height > 0.08 * W * H && r.bottom > 0 && r.top < H
      );
    })
    .slice(0, 40);
  for (const o of overlays) {
    const text = flat((o as HTMLElement).innerText);
    if (!NUISANCE.test(text) || EVIDENCE.test(text)) continue;
    for (const c of o.querySelectorAll("button, [role=button], a, [aria-label]")) {
      const name = flat(c.getAttribute("aria-label") || c.getAttribute("title") || (c as HTMLElement).innerText);
      if (!(CLOSE.test(name) || (DECLINE.test(name) && CONSENT.test(text))) || !shown(c) || !inert(c)) continue;
      const r = c.getBoundingClientRect();
      const x = (r.left + r.right) / 2,
        y = (r.top + r.bottom) / 2;
      if (x < 0 || y < 0 || x > W || y > H) continue;
      // the click lands on whatever is on top at that point: a second pop-up laid over the close control would take it
      const top = document.elementFromPoint(x, y);
      if (!top || (top !== c && !c.contains(top))) continue;
      closer = [x, y];
      closerName = name;
      break;
    }
    if (closer) break;
  }
  // where the answer's tokens are: the first text on the page holding one, shown on screen or not
  const found: { token: string; el: Element; inView: boolean }[] = [];
  if (tokens.length) {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n && found.length < 20; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest("script, style, noscript, [aria-hidden=true]")) continue;
      const text = flat(n.textContent).toLowerCase();
      const token = tokens.find((t) => text.includes(t.toLowerCase()));
      if (!token || !shown(el)) continue;
      const r = el.getBoundingClientRect();
      found.push({ token, el, inView: r.bottom > 0 && r.top < H && r.right > 0 && r.left < W });
    }
  }
  const visible = found.some((f) => f.inView);
  let scrolled = "";
  const first = found[0];
  if (scroll && !closer && !visible && first) {
    first.el.scrollIntoView({ block: "center" });
    scrolled = first.token;
  }
  const where: Record<string, Seen> = {};
  for (const t of tokens) {
    const at = found.filter((f) => f.token === t);
    where[t] = at.some((f) => f.inView) ? "in_view" : at.length ? "off_screen" : "none";
  }
  return { closer, closerName, visible, scrolled, found: where };
}

/** revealEvidence: where a literal is on the page. in_view: its text lies in the middle band of the screen (15-85% of
 * the height, so the row around it shows too) with nothing over it; occluded: on screen under something else (a fixed
 * or sticky header, banner or notice, a popover); off_screen: outside the viewport, or inside it but outside that band
 * (at an edge, its row cut off); none: no text of the page holds it. */
export type Seen = "in_view" | "occluded" | "off_screen" | "none";

/** What revealFacts does besides looking. */
export interface RevealOptions {
  /** with none of the literals in view, scroll the first one on the page to the middle of the screen */
  scroll: boolean;
  /** the literal that decides (the agent's best-ranked one on the page): with scroll on, it alone is scrolled to the
   * middle when it is occluded or off screen, whatever else is in view; in view, nothing scrolls. Unset: any literal in
   * view stops the scroll, as before */
  main?: string;
  /** blur the focused element first: the rest of closing a picker, after the Escape the agent sent to it */
  blur: boolean;
}

/** What revealFacts found, and the literal it scrolled to. */
export interface Revealed {
  /** where each literal is: its best place on the page */
  found: Record<string, Seen>;
  /** a date picker, listbox, menu or popover left open over the middle of the screen ("dialog 'Choose a date'") that an
   * Escape to the focused element would reach (and nothing else), or "" */
  picker: string;
  /** the close control of a nuisance pop-up still over the page (revealAnswer's): nothing scrolls while there is one */
  closerName: string;
  /** the literal scrolled to the middle of the screen, or "" */
  scrolled: string;
}

/** revealEvidence: the end of a run, looking for the facts it cites (literals). norm is logic.ts normalizeLiteral, the
 * same on the page's text and the literals; nuisance is revealAnswer, whose pop-up closer this keeps as it is. */
export function revealFacts(
  literals: string[],
  opts: RevealOptions,
  norm: (s: string) => string,
  nuisance: (tokens: string[], scroll: boolean) => Reveal,
): Revealed {
  const focused = document.activeElement;
  if (opts.blur && focused instanceof HTMLElement && focused !== document.body) focused.blur();
  const W = innerWidth,
    H = innerHeight;
  // the middle band of the screen: a fact at its edge has its row cut off (a travel time without its route)
  const TOP = 0.15 * H,
    BOTTOM = 0.85 * H;
  const flat = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
  const textOf = (e: Element) => flat(e instanceof HTMLElement ? e.innerText : e.textContent);
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const lits = literals.map((literal) => ({ literal, n: norm(literal) }));
  const holds = (text: string) => {
    const t = ` ${norm(text)} `;
    return lits.some(({ n }) => n && t.includes(` ${n} `));
  };
  const { closer, closerName } = nuisance([], false);

  // a picker the run's last moves left open over the middle of the screen: a date picker, listbox, menu or popover
  // floating over the page, holding none of the literals. A pop-up reporting what the run did (EVIDENCE, revealAnswer's
  // pattern copied: a page script shares no constants) is never one, and while one is open nothing is closed: Escape
  // could close it too
  const EVIDENCE =
    /added to (your )?(cart|bag|basket)|in your (cart|bag)|order (placed|confirmed|number)|booking|reservation/i;
  const floats = (e: Element) => {
    for (let a: Element | null = e, i = 0; a && a !== document.body && i < 4; a = a.parentElement, i++)
      if (/^(fixed|absolute)$/.test(getComputedStyle(a).position)) return true;
    return false;
  };
  const middle = (r: DOMRect) => r.right > 0.25 * W && r.left < 0.75 * W && r.bottom > TOP && r.top < BOTTOM;
  let picker = "";
  // the layers floating over the page, as revealAnswer's overlays (absolute ones too): a dialog, or a fixed or absolute
  // box the size of a pop-up that says little (a page shell holds the page's own text)
  const DIALOG = "[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]";
  const layers = [...document.querySelectorAll("body *")].filter((e) => {
    const r = e.getBoundingClientRect();
    if (r.width * r.height <= 0.08 * W * H || r.bottom <= 0 || r.top >= H) return false;
    const layer = e.matches(DIALOG) || /^(fixed|absolute)$/.test(getComputedStyle(e).position);
    return layer && shown(e) && textOf(e).length <= 1500;
  });
  const reporting = [...document.querySelectorAll(DIALOG), ...layers]
    .filter(shown)
    .some((d) => EVIDENCE.test(textOf(d)));
  // Escape goes to the focused element, so it is sent only where it reaches the picker and nothing else: focus on the
  // page itself, in the picker, or under no other layer (a modal holding the answer would close instead)
  const active = document.activeElement;
  const reaches = (p: Element) =>
    !active ||
    active === document.body ||
    p.contains(active) ||
    !layers.some((l) => l.contains(active) && !l.contains(p));
  // Escape in a search field clears what the run typed there (and may search again): nothing is closed from one
  const typed = active instanceof HTMLInputElement && active.type === "search" && active.value !== "";
  if (!closer && !reporting && !typed)
    for (const e of document.querySelectorAll(
      "[role=dialog], [role=listbox], [role=menu], [role=grid], [data-state=open], dialog[open], [class*=calendar i], [class*=datepicker i], [class*=date-picker i], [class*=daypicker i], [class*=day-picker i]",
    )) {
      if (!shown(e) || !floats(e)) continue;
      const r = e.getBoundingClientRect();
      const role = e.getAttribute("role") ?? "";
      const kind = /^(dialog|listbox|menu|grid)$/.test(role)
        ? role
        : e.matches("dialog")
          ? "dialog"
          : e.matches("[data-state=open]")
            ? "popover"
            : "calendar";
      // a calendar by its class name is the widget, not the icon of one
      if ((kind === "calendar" && (r.width < 150 || r.height < 150)) || !middle(r)) continue;
      const text = textOf(e);
      if (EVIDENCE.test(text) || holds(text) || !reaches(e)) continue;
      picker = `${kind} '${flat(e.getAttribute("aria-label") || text).slice(0, 40)}'`;
      break;
    }

  // the page's text node by node (not scripts, styles or what assistive technology is told to skip), read two ways:
  // with the nodes apart ("13" and "km/h" in two elements read "13 km/h"), and run together where a letter or digit
  // meets one ("1" in bold before "3" reads "13"). A literal is found in the smallest element holding all of it.
  const nodes: Text[] = [];
  const pieces: string[] = [];
  const joins: boolean[] = [];
  const WORD = /[\p{L}\p{M}\p{N}]/u;
  let gap = true;
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n instanceof Element && n.matches("script, style, noscript, template, [aria-hidden=true]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walk.nextNode(); n && nodes.length < 50000; n = walk.nextNode()) {
    if (!(n instanceof Text)) continue;
    const piece = norm(n.data);
    if (!piece) {
      gap ||= n.data.length > 0; // a space or a sign between two texts keeps them apart
      continue;
    }
    const prev = nodes.at(-1);
    joins.push(!gap && !!prev && WORD.test(prev.data.slice(-1)) && WORD.test(n.data.charAt(0)));
    nodes.push(n);
    pieces.push(piece);
    gap = false;
  }
  const index = (glue: boolean) => {
    let text = "";
    const starts: number[] = [];
    pieces.forEach((p, i) => {
      if (i) text += glue && joins[i] ? "" : " ";
      starts.push(text.length);
      text += p;
    });
    return { text: ` ${text} `, starts };
  };
  const indexes = [index(false), index(true)];
  // the node holding a character of the text: the last one starting at or before it
  const nodeAt = (starts: number[], pos: number) => {
    let lo = 0,
      hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // the literal's own characters in one text node (a long paragraph is not the fact in it)
  const exact = (n: string) =>
    new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${n.split(" ").join("[^\\p{L}\\p{M}\\p{N}]+")}(?![\\p{L}\\p{M}\\p{N}])`, "iu");
  const occurrences = (n: string) => {
    const out: { e: Element; range: Range; order: number }[] = [];
    const seen = new Set<Element>();
    for (const { text, starts } of indexes)
      for (let i = text.indexOf(` ${n} `); i >= 0 && out.length < 20; i = text.indexOf(` ${n} `, i + 1)) {
        const first = nodeAt(starts, i),
          last = nodeAt(starts, i + n.length - 1);
        const a = nodes[first],
          b = nodes[last];
        if (!a || !b) continue;
        const range = document.createRange();
        range.setStart(a, 0);
        range.setEnd(b, b.length);
        const c = range.commonAncestorContainer;
        const e = c instanceof Element ? c : c.parentElement;
        if (!e || seen.has(e) || !shown(e)) continue;
        seen.add(e);
        const m = a === b ? exact(n).exec(a.data) : null;
        if (m) {
          range.setStart(a, m.index);
          range.setEnd(a, m.index + m[0].length);
        }
        out.push({ e, range, order: first });
      }
    return out;
  };
  // shown: in the middle band, and the topmost element at its centre is it, inside it, or around it with no other
  // text; under anything else it is occluded (by the fixed or sticky element the hit is in, when there is one)
  const placeOf = (e: Element, range: Range): { at: Seen; over: Element | null } => {
    const box = range.getBoundingClientRect();
    const x = (box.left + box.right) / 2,
      y = (box.top + box.bottom) / 2;
    if (x < 0 || x >= W || y < 0 || y >= H) return { at: "off_screen", over: null };
    const hit = document.elementFromPoint(x, y);
    const own =
      !!hit && (hit === e || e.contains(hit) || (hit.contains(e) && norm(hit.textContent) === norm(e.textContent)));
    if (!own) {
      let over = hit;
      while (over && over !== document.body && !/^(fixed|sticky)$/.test(getComputedStyle(over).position))
        over = over.parentElement;
      return { at: "occluded", over: over === document.body ? null : over };
    }
    return { at: box.top >= TOP && box.bottom <= BOTTOM ? "in_view" : "off_screen", over: null };
  };

  const RANK: Record<Seen, number> = { in_view: 0, occluded: 1, off_screen: 2, none: 3 };
  const found: Record<string, Seen> = {};
  const targets = new Map<string, { literal: string; e: Element; range: Range }>();
  for (const { literal, n } of lits) {
    const places = (n ? occurrences(n) : []).map((o) => ({ ...o, ...placeOf(o.e, o.range) }));
    places.sort((p, q) => RANK[p.at] - RANK[q.at] || p.order - q.order);
    const best = places[0];
    found[literal] = best ? best.at : "none";
    if (best && best.at !== "in_view") targets.set(literal, { literal, e: best.e, range: best.range });
  }
  let scrolled = "";
  // the main literal decides when the agent names one; else the first one on the page, and only with none in view
  const target =
    opts.main !== undefined
      ? (targets.get(opts.main) ?? null)
      : Object.values(found).includes("in_view")
        ? null
        : ([...targets.values()][0] ?? null);
  if (opts.scroll && !closer && target) {
    const { e, range } = target;
    // the nearest box that scrolls the fact (a side panel), else the page
    const by = (dy: number) => {
      let a = e.parentElement;
      while (
        a &&
        a !== document.body &&
        !(/(auto|scroll|overlay)/.test(getComputedStyle(a).overflowY) && a.scrollHeight > a.clientHeight)
      )
        a = a.parentElement;
      (a && a !== document.body ? a : (document.scrollingElement ?? document.documentElement)).scrollBy({
        top: dy,
        behavior: "instant",
      });
    };
    const before = range.getBoundingClientRect();
    // instant: what is read next is where the scroll left the fact, not where a smooth scroll started
    e.scrollIntoView({ block: "center", behavior: "instant" });
    let box = range.getBoundingClientRect();
    const mid = (box.top + box.bottom) / 2;
    if (mid < TOP || mid > BOTTOM) by(mid - H / 2);
    // still under a fixed or sticky header or banner above it: once more, by that element's height, while it fits
    const after = placeOf(e, range);
    box = range.getBoundingClientRect();
    if (after.at === "occluded" && after.over) {
      const o = after.over.getBoundingClientRect();
      if (o.top <= box.top && box.bottom + o.height <= H) by(-o.height);
    }
    // a page that cannot scroll (a short one) leaves the fact where it was: no scroll is claimed
    box = range.getBoundingClientRect();
    if (Math.abs(box.top - before.top) >= 1 || Math.abs(box.left - before.left) >= 1) scrolled = target.literal;
  }
  return { found, picker, closerName: closer ? closerName : "", scrolled };
}
