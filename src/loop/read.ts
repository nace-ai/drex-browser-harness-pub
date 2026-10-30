// The read action: JavaScript the LLM sends to look at a page. A read may look at the page but must not change it,
// click, or reach the network, so the code is checked before it runs.

const NETWORK = "reads must not use the network";
const CHANGE = "reads must not click or change elements";
const VALUE =
  "reads must not change values or markup; " +
  "build result objects with literals, e.g. ({href: a.href}), instead of assigning to page objects";
const NAVIGATE = "reads must not navigate or open windows";
const STORAGE = "reads must not use storage or cookies";
const CODE = "reads must not run code strings or write the document";

// The first pattern that matches gives the reason. The patterns are plain regexes: they refuse some harmless code,
// and they miss code that builds its names at run time.
const REFUSALS: [RegExp, string][] = [
  [
    /\b(fetch|importScripts)\s*\(|\bnew\s+(XMLHttpRequest|WebSocket|EventSource)\b|\bsendBeacon\s*\(|\bimport\s*\(/,
    NETWORK,
  ],
  [
    /\.(click|submit|requestSubmit|reset|focus|blur|dispatchEvent|remove|removeChild|appendChild|append|prepend|insertBefore|replaceWith|replaceChildren|setAttribute|removeAttribute|toggleAttribute|scrollTo|scrollBy|scrollIntoView|showModal|close)\s*\(/,
    CHANGE,
  ],
  [/insertAdjacent(HTML|Element|Text)\s*\(/, CHANGE],
  [/classList\.(add|remove|toggle|replace)\s*\(/, CHANGE],
  [/\.(after|before|select|scrollTop|scrollLeft)\s*(\(|=(?!=))/, CHANGE],
  [/\[\s*['"](click|submit|requestSubmit|focus|dispatchEvent|remove|setAttribute)['"]\s*\]/, CHANGE],
  [/\.(click|submit|dispatchEvent)\.(call|apply)\s*\(/, CHANGE],
  [/location\.(search|pathname|hash|host|hostname|port|protocol|href)\s*=(?!=)/, NAVIGATE],
  [
    /\.(value|checked|selected|selectedIndex|innerHTML|outerHTML|innerText|textContent|src|href|hidden|disabled)\s*(=(?!=)|\+=)/,
    VALUE,
  ],
  [/\.style(\.\w+|\[[^\]]+\])\s*=(?!=)/, VALUE],
  [/document\.title\s*=(?!=)/, VALUE],
  [/\b(localStorage|sessionStorage|indexedDB)\b|document\.cookie/, STORAGE],
  [
    /\blocation\s*=(?!=)|location\.(assign|replace|reload)|window\.open|history\.(pushState|replaceState|back|forward|go)\b/,
    NAVIGATE,
  ],
  [/\b(eval|Function)\s*\(|document\.(write|open|close)\s*\(/, CODE],
];

// What a snippet that returns nothing gives back: text the LLM can act on, not a null.
const NO_VALUE = "undefined: the code returned nothing; end it with return <value>, or give one expression";

/** Why the read's code is refused, or null when it may run. The check is a pattern match, not a parser, so it also
 * refuses some harmless code; the reason tells the LLM what to change. */
export function readProblem(js: string): string | null {
  for (const [pattern, reason] of REFUSALS) {
    if (pattern.test(js)) return reason;
  }
  return null;
}

/** The first `max` characters of `text`. If the cut would leave the high half of a surrogate pair at its end, that half
 * is dropped, so the text stays well formed. */
export function clip(text: string, max: number): string {
  return text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
}

/** The page-side code for Tab.eval. "expression" gives the value of `js`; "body" runs `js` as a function body, so it
 * needs its own return. The caller picks the form. A string value is cut to `maxChars` characters of its own text, and
 * any other value comes back as JSON text cut to the same length. An undefined value gets a message instead. */
export function readExpression(js: string, maxChars: number, form: "expression" | "body"): string {
  const code = js.trim().replace(/[;\s]+$/, "");
  const run = form === "expression" ? `return (${code}\n);` : code;
  // Every name in the wrapper starts with __drex, so a snippet that reads `value` or `raw` gets the page's own.
  return `(async () => {
const __drexV = await (async () => {
${run}
})();
if (__drexV === undefined) return JSON.stringify(${JSON.stringify(NO_VALUE)});
const __drexStr = typeof __drexV === "string";
const __drexRaw = __drexStr ? __drexV : (JSON.stringify(__drexV) ?? "null");
let __drexShown = __drexRaw;
if (__drexRaw.length > ${maxChars}) {
__drexShown = __drexRaw.slice(0, ${maxChars});
const __drexLast = __drexShown.charCodeAt(__drexShown.length - 1);
if (__drexLast >= 0xd800 && __drexLast <= 0xdbff) __drexShown = __drexShown.slice(0, -1);
}
const __drexOut = __drexStr ? JSON.stringify(__drexShown) : __drexShown;
const __drexCut = __drexRaw.length > ${maxChars};
return __drexCut ? __drexOut + " …[cut at ${maxChars} of " + __drexRaw.length + " chars]" : __drexOut;
})()`;
}

/** The `chars` characters from the first match of `find` in `text`, or null when there is none. Case is ignored, and
 * each whitespace run in `find` matches any whitespace run in the text; the ends of `find` are trimmed first. */
export function textFrom(text: string, find: string, chars: number): string | null {
  const pattern = find
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const hit = new RegExp(pattern, "i").exec(text);
  return hit ? clip(text.slice(hit.index), chars) : null;
}
