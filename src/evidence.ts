// The end of a run that found an answer: the answer should be on screen, not under a pop-up or below the fold, since
// whoever checks the run (a person, or a benchmark's judge reading screenshots) sees the screen. For example, a run
// reached the article with the answer, a newsletter pop-up covered it, and the answer was never scrolled to. revealAnswer runs in the page (Tab.eval sends its source), so it uses nothing from outside itself.

/** What revealAnswer found: a nuisance pop-up's close control to click (CSS pixels), or where the answer is. */
export interface Reveal {
  /** the centre of a close / no-thanks control of a newsletter, cookie, app or offer pop-up over the page */
  closer: [number, number] | null;
  closerName: string;
  /** an answer token was already in the viewport */
  visible: boolean;
  /** the token scrolled into view (scroll: true), or "" */
  scrolled: string;
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
  return { closer, closerName, visible, scrolled };
}
