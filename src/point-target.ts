import type { PointTarget } from "./types.ts";

// What a click at a screen point would land on, for the approval gate (logic.ts pointRisk). It runs in the page
// (Tab.pointTarget sends its source), so it uses nothing from outside itself. Only public DOM is read: names, roles,
// attributes and the form around the control, never application globals or handler source.
/** What the probe reads off an element: DOM typings promise these on every element, but an SVG part or a detached
 * node has no innerText, a non-input no labels, and textContent can be null. */
interface Loose {
  innerText?: string;
  labels?: NodeListOf<HTMLElement> | null;
  textContent: string | null;
}
export function pointTargetAt(x: number, y: number): PointTarget | null {
  const flat = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
  const tag = (e: Element) => e.tagName.toLowerCase();
  const docs: Document[] = [document]; // the page, and each same-origin frame the point is in
  // the agent's own cursor and click ring (data-drex) are drawn over the page: what is under them counts
  const ours = (e: Element) => !!e.closest("[data-drex], #__drex_cursor");
  let hit: Element | null = document.elementsFromPoint(x, y).find((e) => !ours(e)) ?? null;
  for (let depth = 0; hit && depth < 8; depth++) {
    // into open shadow roots: the element under the point in a web component, not the component's host
    const inner = hit.shadowRoot?.elementFromPoint(x, y);
    if (inner && inner !== hit) {
      hit = inner;
      continue;
    }
    // into a same-origin frame (a quiz or a widget the site serves itself), at the point's place in it; a frame of
    // another origin can't be read and stays the target
    if (!["iframe", "frame"].includes(tag(hit))) break;
    let doc: Document | null;
    try {
      doc = (hit as HTMLIFrameElement).contentDocument;
    } catch {
      doc = null;
    }
    if (!doc) break;
    const r = hit.getBoundingClientRect();
    x -= r.left + hit.clientLeft;
    y -= r.top + hit.clientTop;
    docs.push(doc);
    const below = doc.elementFromPoint(x, y);
    if (!below) break;
    hit = below;
  }
  if (!hit) return null;
  const home = hit.ownerDocument;
  const CONTROL =
    "a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=menuitem]," +
    "[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=tab],[role=checkbox],[role=radio]," +
    "[role=switch],[role=slider],[role=combobox],[onclick]";
  const roleOf = (e: Element): string => {
    const explicit = e.getAttribute("role");
    if (explicit) return explicit;
    const t = tag(e);
    if (t === "a") return "link";
    if (t === "button" || t === "summary") return "button";
    if (t === "select") return "combobox";
    if (t === "textarea") return "textbox";
    if (t === "label") {
      const control = (e as HTMLLabelElement).control;
      return control ? roleOf(control) : "";
    }
    if (t === "input") {
      const type = (e as HTMLInputElement).type;
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      return "textbox";
    }
    return "";
  };
  const namesOf = (e: Element): string[] => {
    const out: string[] = [];
    const push = (t: string | null | undefined) => {
      const v = flat(t);
      if (v) out.push(v);
    };
    push(e.getAttribute("aria-label"));
    const by = e.getAttribute("aria-labelledby");
    if (by)
      push(
        by
          .split(/\s+/)
          .map((id) => (home.getElementById(id) as Loose | null)?.textContent ?? "")
          .join(" "),
      );
    const labels = (e as Loose).labels;
    if (labels?.length) push([...labels].map((l) => (l as Loose).textContent ?? "").join(" "));
    push(e.getAttribute("title"));
    push(e.getAttribute("data-tooltip")); // an icon's hover tip ("Delete" on a mail row)
    push(e.getAttribute("alt"));
    if (tag(e) === "input" && ["submit", "button", "reset", "image"].includes((e as HTMLInputElement).type))
      push((e as HTMLInputElement).value);
    // an element's own words, unless it is a big container (its text is content, and reading it is slow)
    const own = (e as Loose).textContent ?? "";
    if (own.length <= 200) push((e as Loose).innerText ?? own);
    push((e.querySelector(":scope svg title") as Loose | null)?.textContent);
    return out;
  };
  const frame = ["iframe", "frame", "embed", "object"].includes(tag(hit));
  // a frame of another origin can't be read; what it says of itself (its address, title, id) can be
  // the frame's address as the browser resolved it ("//pay.example.com/x" or "/x" is a full address there)
  const src = hit.getAttribute("src") ?? hit.getAttribute("data");
  let address = src;
  try {
    if (src) address = new URL(src, hit.baseURI).href;
  } catch {
    address = src;
  }
  const frameInfo = frame
    ? flat(
        [address, hit.getAttribute("title"), hit.id, hit.getAttribute("name"), hit.getAttribute("aria-label")]
          .filter(Boolean)
          .join(" "),
      ).slice(0, 300)
    : "";
  const names: string[] = [];
  const path: Element[] = []; // the element hit and its ancestors up to the control
  let control: Element | null = null;
  for (let e: Element | null = hit, depth = 0; e && depth < 8; depth++) {
    path.push(e);
    for (const n of namesOf(e)) if (!names.includes(n)) names.push(n);
    if (e.matches(CONTROL)) {
      control = e;
      break;
    }
    const root = e.getRootNode();
    e = e.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  const target = control ?? hit;
  // a small element with no name, nor any inside it, takes the click itself (an icon-only Delete revealed on hover):
  // - with no control on the way up: its handler is the page's script, so it could be anything
  // - under a control with no role (a row with an onclick): the control says nothing of what its icons do
  // - under a bigger control, laid over it (it or a wrapper on its way up is positioned, a hover toolbar say, or
  //   stacked on a sibling, a grid cell over the photo); an icon in the control's flow is the control's own
  // - a small nameless control with no role (a div with an onclick)
  // A glyph or emoji ("×", "🗑") is no name: it says nothing a word would.
  const area = (e: Element) => {
    const b = e.getBoundingClientRect();
    return b.width * b.height;
  };
  const named = (e: Element) => namesOf(e).some((n) => /[\p{L}\p{N}]/u.test(n) && !/^[x×✕✖]$/i.test(n));
  const icon = (e: Element) => {
    const b = e.getBoundingClientRect();
    return b.width <= 64 && b.height <= 64 && !named(e) && ![...e.querySelectorAll("*")].some(named);
  };
  const positioned = (e: Element) => ["absolute", "fixed"].includes(getComputedStyle(e).position);
  const stacked = (e: Element) => {
    const b = e.getBoundingClientRect();
    return [...(e.parentElement?.children ?? [])].some((s) => {
      if (s === e) return false;
      const o = s.getBoundingClientRect();
      return (
        Math.min(b.right, o.right) > Math.max(b.left, o.left) && Math.min(b.bottom, o.bottom) > Math.max(b.top, o.top)
      );
    });
  };
  const under = control ? path.slice(0, -1) : path;
  const small = (e: Element) => {
    const b = e.getBoundingClientRect();
    return b.width <= 64 && b.height <= 64;
  };
  // an icon in the flow of a small wrapper that names it (a 'Back' button made of a div and an svg) is that control's
  // own picture; one laid over its wrapper (positioned or stacked: a Delete over a thumbnail) is not
  const namedBy = (i: number) => {
    for (let j = i; j < path.length; j++) {
      const w = path[j];
      if (!w || !small(w)) return false;
      if (j > i && named(w)) return true;
      if (positioned(w) || stacked(w)) return false;
    }
    return false;
  };
  // inside an interactive widget (a map, a chart, an editor: role=application), a nameless spot is the widget's own
  const widget = path.some((e) => e.getAttribute("role") === "application");
  const overlay =
    !widget &&
    (under.some(
      (e, i) =>
        icon(e) &&
        !namedBy(i) &&
        (!control ||
          !roleOf(control) ||
          (area(e) * 4 <= area(control) && under.slice(i).some((w) => positioned(w) || stacked(w)))),
    ) ||
      (!!control && !roleOf(control) && icon(control)));
  // a cookie or consent banner around the control (a consent manager's own element, often in a shadow root, or a fixed
  // or dialog box that talks about cookies): its nameless close ("×") takes a privacy choice only
  const chain: Element[] = [];
  for (let e: Element | null = hit; e && chain.length < 30;) {
    chain.push(e);
    const root = e.getRootNode();
    e = e.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  // "cookie" alone is not a consent manager's: a bakery's product card or mini cart ("cookie-tile") is not one
  const CMP =
    /consent|cookies?[-_ ]?(banner|bar|notice|consent|law|policy|settings|preferences|popup|modal|dialog|wall)|\bcmp\b|usercentrics|onetrust|didomi|cookiebot|truste|sp_message|privacy-?(center|manager)/i;
  const consent = chain.some((e) => {
    // a consent manager's own element by its id or class; not the page's body or root ("cookie-accepted")
    if (!["body", "html"].includes(tag(e)) && CMP.test(`${e.id} ${e.getAttribute("class") ?? ""}`)) return true;
    const fixedOrDialog =
      e.matches("[role=dialog], [role=alertdialog], [aria-modal=true], dialog") ||
      ["fixed", "sticky"].includes(getComputedStyle(e).position);
    if (!fixedOrDialog) return false;
    // a shadow host's own text is empty: its banner is in its shadow root (Usercentrics on porsche.com)
    const text =
      (e as HTMLElement).innerText ||
      [...(e.shadowRoot?.children ?? [])]
        .filter((c) => !["style", "script"].includes(tag(c)))
        .map((c) => (c as HTMLElement).innerText || "")
        .join(" ");
    // the banner's own words about cookies or consent, not a page or cart that lists cookies for sale
    const CONSENT_TEXT =
      /consent|we use cookies|uses? cookies|use of cookies|cookies? (policy|settings|preferences|notice)|accept (all )?cookies|(reject|decline) (all )?cookies|cookies (to|for|on|help|and similar)/i;
    return text.length <= 20000 && CONSENT_TEXT.test(text) && !/card number|cvv|cvc|password/i.test(text);
  });
  // an icon-only control with no name still says what it does in its id, classes, test id or icon, on the element hit,
  // on its way up to the control, or inside the control. Each class or address part is read on its own, camelCase split
  // ("DeleteIcon", "btnDelete"); a part that also names a filter is a filter's own remove button, not a delete, and an
  // address's query ("?sort=new") says nothing of what the link does.
  const MARK =
    /(?:^|[^a-z])(delete|trash|remove|send|pay|payment|purchase|checkout|subscribe|publish|buy|place[- ]?order|submit[- ]?order)(?:[^a-z]|$)/i;
  const FILTER = /(?:^|[^a-z])(filters?|facets?|refine(ment)?s?|chips?|sort(ing)?|tags?)(?:[^a-z]|$)/i;
  const marks: string[] = [];
  // with no control on the way up, only the hit's nearest wrappers: a page section's class ("checkout-page") is not a
  // control's
  const way = control ? path : path.slice(0, 3);
  // inside: the control's icons, or a small element's own (an icon hit with no control); a big container's descendants
  // are the page's, not what the point is on
  const holder = control ?? (hit.querySelectorAll("*").length <= 10 ? hit : null);
  const inside = holder ? [...holder.querySelectorAll("svg use, svg, img, i, span")].slice(0, 20) : [];
  const scan = [...way, ...inside];
  for (const e of scan) {
    for (const v of [
      e.id,
      e.getAttribute("class"),
      e.getAttribute("data-testid"),
      e.getAttribute("data-test"),
      e.getAttribute("data-action"),
      e.getAttribute("name"),
      e.getAttribute("href")?.split(/[?#]/)[0],
      e.getAttribute("xlink:href"),
      (e.getAttribute("src") ?? "").split(/[?#]/)[0]?.split("/").pop(),
    ])
      for (const part of flat(v).split(" ")) {
        const words = part.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
        const m = MARK.exec(words);
        if (m?.[1] && !FILTER.test(words) && !marks.includes(m[1].toLowerCase())) marks.push(m[1].toLowerCase());
      }
  }
  // a submit button of a form that sends something: a POST (it changes something on the server: a confirmation form
  // of hidden ids and a "Confirm" may delete), a password or card field, or an email, phone or message the agent
  // filled in (a search box or a filter form sends nothing of the user's)
  const button = target as HTMLButtonElement;
  const isSubmit =
    (tag(target) === "button" && button.type === "submit") ||
    (tag(target) === "input" && ["submit", "image"].includes((target as HTMLInputElement).type));
  const form = isSubmit ? button.form : null;
  const method = (target.getAttribute("formmethod") ?? form?.getAttribute("method") ?? "get").trim().toLowerCase();
  const sends =
    !!form &&
    (method === "post" ||
      [...form.querySelectorAll("input, textarea")].some((f) => {
        const field = f as HTMLInputElement;
        if (field.type === "password" || field.autocomplete.startsWith("cc-")) return true;
        return (tag(field) === "textarea" || ["email", "tel"].includes(field.type)) && !!field.value.trim();
      }));
  const visible = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
  };
  const payment = docs.some((doc) =>
    [
      ...doc.querySelectorAll(
        'input[type=password], input[autocomplete^="cc-"], input[name*="card" i][name*="num" i], input[id*="card" i][id*="num" i], input[name*="cvv" i], input[name*="cvc" i], input[id*="cvv" i], input[id*="cvc" i]',
      ),
    ].some(visible),
  );
  const r = target.getBoundingClientRect();
  return {
    names: names.slice(0, 8),
    own: control ? namesOf(control) : [],
    role: roleOf(target),
    marks,
    submits: sends,
    frame,
    frameInfo,
    overlay,
    consent,
    payment,
    key: [tag(target), roleOf(target), names[0] ?? "", Math.round(r.left), Math.round(r.top)].join("|"),
  };
}
