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
    /\b(fetch|importScripts)\s*\(|\bnew\s+(XMLHttpRequest|WebSocket|EventSource)\b|\bsendBeacon\s*\(|\bimport\b(?!-)/,
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

/** Runs first in the isolated world a read's code runs in (Tab.sealedRead), and takes away that world's ways to act on
 * the page, reach the network or run later: a read only looks at the page as it is now. Every request the tab makes
 * while a read runs is failed anyway; this is for what would happen after it (a timer, a listener, an observer, a
 * lazy image, a style), and for changes to the page that send nothing. The page's own world and scripts are untouched:
 * each world has its own globals and its own copies of the DOM's prototypes. It runs in the page, so it uses nothing
 * from this module. What it can't take away: `location` (no world can let go of it), so the read's code runs as the
 * body of a strict function whose window, document and location are stand-ins (__drexScope); another frame's window,
 * Location or document comes back undefined. While the read runs, sealedRead fails every request; a read that moved
 * the page or set a `javascript:` address (which runs in the page's own world) has the page swapped for about:blank
 * before the seal lifts, as a backstop. After it, the tab's navigation guard fails a
 * page request to another site that no action started, and taking away what settles later leaves code little to
 * resume on. */
export function sealReadWorld(): void {
  "use strict"; // a function of the seal's in sloppy mode would show the real window as its `this` (to a stack trace's call sites)
  const g = globalThis as unknown as Record<string, unknown>;
  // sealed already: a read before this one, in the same world, did all of it (its own property: a page element with
  // that id is no scope)
  if (Object.getOwnPropertyDescriptor(g, "__drexScope")) return;
  // kept before the constructors are taken away below: the read's code is compiled with it (__drexScope.compile)
  const READ_NAMES = ["window", "self", "globalThis", "top", "parent", "frames", "opener", "location", "document"];
  const AsyncFunction = (
    Object.getPrototypeOf(async function () {
      /* the constructor of async functions */
    }) as { constructor: new (...a: string[]) => (...a: unknown[]) => Promise<unknown> }
  ).constructor;
  const PlainFunction = Function; // kept too: the guard of the read's global names is built with it (compile)
  const READ_PARAMS = READ_NAMES.join(", "); // joined now, before any read's code could replace join
  let reading = false; // whether a read's code is running now (compile's runner): timers are set only then
  // kept before the read's code can replace them: the stand-ins below call these, and the real window and document pass
  // through them
  const rGet = Reflect.get;
  const rApply = Reflect.apply;
  const rConstruct = Reflect.construct;
  const rDesc = Reflect.getOwnPropertyDescriptor;
  const rHas = Reflect.has;
  const rOwnKeys = Reflect.ownKeys;
  const rProto = Object.getPrototypeOf;
  const rDefine = Object.defineProperty;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called on its own object, through rApply
  const toStr = Object.prototype.toString;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called on its own object, through rApply
  const reTest = RegExp.prototype.test;
  // a stack trace's call sites show each frame's `this`: none is given out
  try {
    Object.defineProperty(Error, "prepareStackTrace", { value: undefined, writable: false, configurable: false });
  } catch {} // a world sealed before keeps it so
  const no = (what: string) =>
    function () {
      throw new Error(`${what} is not available in a read: a read only looks at the page as it is now`);
    };
  const own = (obj: object, key: string) => {
    for (let o: object | null = obj; o; o = Object.getPrototypeOf(o) as object | null) {
      const d = Object.getOwnPropertyDescriptor(o, key);
      if (d) return { o, d };
    }
    return null;
  };
  // kind: "call" replaces a method, "set" refuses assignment (reading stays), "get" refuses reading too
  const shut = (obj: object | undefined, keys: string[], kind: "call" | "set" | "get") => {
    if (!obj) return;
    for (const key of keys) {
      const hit = own(obj, key);
      if (!hit?.d.configurable) continue;
      const { o, d } = hit;
      const stop = no(key);
      try {
        if (kind === "call") Object.defineProperty(o, key, { value: stop, writable: false, configurable: false });
        else if (kind === "get") Object.defineProperty(o, key, { get: stop, configurable: false });
        else if (d.set) Object.defineProperty(o, key, { ...d, set: stop, configurable: false });
      } catch {} // a property the browser won't let go of keeps its own behaviour
    }
  };
  const proto = (name: string) => (g[name] as { prototype?: object } | undefined)?.prototype;
  // these hand out an accessor of the real window (location's) when asked on it
  shut(Object.prototype, ["__lookupGetter__", "__lookupSetter__", "__defineGetter__", "__defineSetter__"], "call");
  // what reaches the network or runs later, from the window itself
  shut(g, ["fetch", "XMLHttpRequest", "WebSocket", "WebTransport", "EventSource", "Worker", "SharedWorker"], "call");
  // WebRTC sends DNS and STUN, which Fetch never sees: its methods go first (proto() reads the global), then both names
  shut(
    proto("RTCPeerConnection"),
    [
      "createOffer",
      "createAnswer",
      "setLocalDescription",
      "setRemoteDescription",
      "createDataChannel",
      "addIceCandidate",
      "setConfiguration",
    ],
    "call",
  );
  shut(g, ["BroadcastChannel", "MessageChannel", "RTCPeerConnection", "webkitRTCPeerConnection"], "call");
  // code from a string: eval and the Function constructors would let a read build an import() the refusal can't see.
  // The constructors are reached through the functions' prototypes too, so those go first.
  /* eslint-disable @typescript-eslint/require-await */
  const fnProtos = [
    Function.prototype,
    Object.getPrototypeOf(async function () {
      return 0;
    }) as object,
    Object.getPrototypeOf(function* () {
      yield 0;
    }) as object,
    Object.getPrototypeOf(async function* () {
      yield 0;
    }) as object,
  ];
  /* eslint-enable @typescript-eslint/require-await */
  for (const p of fnProtos) shut(p, ["constructor"], "get");
  shut(g, ["eval", "Function"], "call");
  shut(g, ["Image", "Audio", "Notification", "OffscreenCanvas"], "call");
  shut(proto("OffscreenCanvas"), ["convertToBlob", "getContext"], "call");
  shut(g.CSS as object | undefined, ["paintWorklet", "layoutWorklet", "animationWorklet"], "get");
  shut(proto("Document"), ["importNode", "adoptNode"], "call");
  // a read may wait on the page (setTimeout, setInterval) while it runs, never after: each timer it sets is cleared when the
  // read ends (compile's runner), and none can be set once it has. Kept on an object with no prototype, so nothing a
  // read replaces (Array.prototype.push, Map.prototype.set) is in the way.
  const timers = Object.create(null) as Record<string, ((id: number) => void) | null>;
  const clearAll = () => {
    for (const id in timers) {
      const clear = timers[id];
      timers[id] = null; // no delete: the key stays, and a cleared one is skipped
      if (clear) rApply(clear, realWin0, [+id]);
    }
  };
  const realWin0 = g as unknown as Window;
  const end = () => {
    reading = false;
    clearAll();
  };
  const later = (set: unknown, clear: unknown, what: string) =>
    function (fn: unknown, ms?: unknown, ...args: unknown[]): number {
      if (!reading) throw new Error(`${what} works only while a read runs`);
      if (typeof fn !== "function") throw new Error(`${what} takes a function in a read`);
      // the callback is run by the page with the real window as `this`: it gets the stand-in instead
      const cb = fn as (...a: unknown[]) => unknown;
      // its extra arguments reach it through the stand-in wrapper as real objects: each is made safe again
      const run = () => {
        const given: unknown[] = [];
        for (let i = 0; i < args.length; i++)
          rDefine(given, i, { value: safe(args[i]), writable: true, enumerable: true, configurable: true });
        return rApply(cb, standInWin, given);
      };
      const id = rApply(set as (...a: unknown[]) => number, realWin0, [run, ms]);
      timers[id] = clear as (id: number) => void;
      return id;
    };
  const [st, ct, si, ci] = [g.setTimeout, g.clearTimeout, g.setInterval, g.clearInterval];
  // configurable, so the window's stand-in may give its own wrapper of them; the read's code reaches the real window
  // through no name, so nothing can redefine them
  rDefine(g, "setTimeout", { value: later(st, ct, "setTimeout"), writable: false, configurable: true });
  rDefine(g, "setInterval", { value: later(si, ci, "setInterval"), writable: false, configurable: true });
  shut(g, ["requestAnimationFrame", "webkitRequestAnimationFrame", "requestIdleCallback", "postMessage"], "call");
  shut(
    g,
    [
      "MutationObserver",
      "IntersectionObserver",
      "ResizeObserver",
      "PerformanceObserver",
      "ReportingObserver",
      "PressureObserver",
      "FinalizationRegistry",
    ],
    "call",
  );
  shut(g, ["open", "close", "stop", "print", "alert", "confirm", "prompt", "focus", "blur"], "call");
  shut(g, ["find", "scroll", "scrollTo", "scrollBy", "moveTo", "moveBy", "resizeTo", "resizeBy"], "call");
  shut(
    g,
    ["frames", "parent", "opener", "localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore"],
    "get",
  );
  shut(g, ["name", "status"], "set");
  shut(proto("Navigator"), ["sendBeacon", "registerProtocolHandler", "share", "vibrate"], "call");
  shut(proto("Navigator"), ["serviceWorker", "clipboard", "credentials", "locks"], "get");
  shut(proto("History"), ["pushState", "replaceState", "back", "forward", "go"], "call");
  // page-shared state outside the Node prototypes: select options, the navigation entry's state, registered CSS properties
  shut(proto("HTMLOptionsCollection"), ["add", "remove"], "call");
  shut(proto("HTMLOptionsCollection"), ["length", "selectedIndex"], "set");
  shut(g, ["Option", "DOMParser"], "call");
  shut(g.Document as object | undefined, ["parseHTMLUnsafe"], "call");
  shut(proto("DOMImplementation"), ["createHTMLDocument", "createDocument"], "call");
  shut(proto("Navigation"), ["navigate", "reload", "back", "forward", "traverseTo", "updateCurrentEntry"], "call");
  shut(g.CSS as object | undefined, ["registerProperty"], "call");
  shut(proto("EventTarget"), ["addEventListener", "dispatchEvent"], "call");
  // other ways to run code later, or to send later (a deferred fetch), from the main frame's world
  shut(g, ["fetchLater", "matchMedia", "Animation", "KeyframeEffect"], "call");
  shut(g, ["scheduler"], "get");
  shut(g.AbortSignal as object | undefined, ["timeout", "any"], "call");
  shut(proto("Document"), ["timeline", "fonts", "getAnimations"], "get");
  shut(proto("Element"), ["getAnimations"], "call");
  shut(proto("Animation"), ["finished", "ready", "onfinish", "oncancel"], "get");
  // event handler properties (onclick, onload, ...): assigning one would run code later, on every type that has them
  const targets: object[] = [g];
  const win = proto("Window");
  if (win) targets.push(win);
  for (const name of Object.getOwnPropertyNames(g)) {
    try {
      const p = proto(name); // a window property already shut above throws when read
      if (p instanceof EventTarget) targets.push(p);
    } catch {}
  }
  for (const o of targets)
    shut(
      o,
      Object.getOwnPropertyNames(o).filter((k) => /^on[a-z]+$/.test(k)),
      "set",
    );
  // changes to the page's tree, attributes and text
  shut(proto("Node"), ["appendChild", "insertBefore", "replaceChild", "removeChild", "normalize"], "call");
  shut(proto("Node"), ["textContent", "nodeValue"], "set");
  shut(proto("Element"), ["append", "prepend", "after", "before", "replaceWith", "replaceChildren", "remove"], "call");
  shut(proto("Element"), ["insertAdjacentHTML", "insertAdjacentElement", "insertAdjacentText", "setHTML"], "call");
  shut(
    proto("Element"),
    ["setHTMLUnsafe", "setAttribute", "setAttributeNS", "setAttributeNode", "removeAttribute"],
    "call",
  );
  shut(proto("Element"), ["removeAttributeNS", "toggleAttribute", "attachShadow", "animate", "scrollIntoView"], "call");
  shut(proto("Element"), ["scrollIntoViewIfNeeded"], "call");
  shut(proto("Element"), ["scroll", "scrollTo", "scrollBy", "requestFullscreen", "requestPointerLock"], "call");
  // the same tree changes on the document and on fragments and shadow roots (ParentNode's methods sit on each)
  for (const name of ["Document", "DocumentFragment", "ShadowRoot"])
    shut(proto(name), ["append", "prepend", "replaceChildren", "moveBefore"], "call");
  shut(proto("Element"), ["moveBefore", "setAttributeNodeNS"], "call");
  shut(proto("NamedNodeMap"), ["setNamedItem", "setNamedItemNS", "removeNamedItem", "removeNamedItemNS"], "call");
  shut(proto("Element"), ["innerHTML", "outerHTML", "className", "id", "slot", "scrollTop", "scrollLeft"], "set");
  shut(proto("CharacterData"), ["appendData", "insertData", "deleteData", "replaceData"], "call");
  shut(proto("CharacterData"), ["after", "before", "remove", "replaceWith"], "call");
  shut(proto("CharacterData"), ["data"], "set");
  shut(proto("Attr"), ["value"], "set");
  shut(proto("DOMTokenList"), ["add", "remove", "toggle", "replace"], "call");
  shut(proto("DOMTokenList"), ["value"], "set");
  shut(proto("ShadowRoot"), ["innerHTML", "adoptedStyleSheets"], "set");
  shut(proto("ShadowRoot"), ["setHTMLUnsafe"], "call");
  shut(proto("Range"), ["insertNode", "surroundContents", "deleteContents", "extractContents"], "call");
  shut(proto("Range"), ["createContextualFragment"], "call");
  shut(proto("Selection"), ["addRange", "removeAllRanges", "selectAllChildren", "collapse", "extend"], "call");
  shut(proto("Document"), ["write", "writeln", "open", "close", "execCommand", "exitFullscreen"], "call");
  shut(proto("Document"), ["cookie"], "get");
  shut(proto("Document"), ["title", "body", "designMode", "dir", "adoptedStyleSheets"], "set");
  // what acts or loads: clicks, focus, forms, media and every address an element loads from
  shut(proto("HTMLElement"), ["click", "focus", "blur", "showPopover", "hidePopover", "togglePopover"], "call");
  shut(proto("HTMLElement"), ["innerText", "outerText", "hidden", "title", "inert", "contentEditable"], "set");
  shut(proto("SVGElement"), ["focus", "blur"], "call");
  shut(proto("MathMLElement"), ["focus", "blur"], "call");
  shut(proto("HTMLFormElement"), ["submit", "requestSubmit", "reset"], "call");
  shut(proto("HTMLFormElement"), ["action", "method", "target"], "set");
  shut(proto("HTMLInputElement"), ["select", "setRangeText", "setSelectionRange", "stepUp", "stepDown"], "call");
  shut(proto("HTMLInputElement"), ["showPicker"], "call");
  shut(proto("HTMLInputElement"), ["value", "checked", "indeterminate", "src", "formAction", "files"], "set");
  shut(proto("HTMLTextAreaElement"), ["select", "setRangeText", "setSelectionRange"], "call");
  shut(proto("HTMLTextAreaElement"), ["value"], "set");
  shut(proto("HTMLSelectElement"), ["add", "remove", "showPicker"], "call");
  shut(proto("HTMLSelectElement"), ["value", "selectedIndex", "length"], "set");
  shut(proto("HTMLOptionElement"), ["selected", "value"], "set");
  shut(proto("HTMLButtonElement"), ["formAction"], "set");
  shut(proto("HTMLImageElement"), ["src", "srcset", "sizes", "loading"], "set");
  shut(proto("HTMLSourceElement"), ["src", "srcset"], "set");
  shut(proto("HTMLScriptElement"), ["src", "text"], "set");
  shut(proto("HTMLLinkElement"), ["href", "rel"], "set");
  shut(proto("HTMLMetaElement"), ["httpEquiv", "content", "name"], "set"); // a refresh runs later, after the read
  shut(proto("HTMLBaseElement"), ["href", "target"], "set");
  shut(proto("HTMLAreaElement"), ["href", "ping", "target"], "set");
  shut(proto("HTMLVideoElement"), ["poster"], "set");
  shut(proto("HTMLTableElement"), ["tHead", "tFoot", "caption"], "set");
  // a link's address in parts, and what a later click or submit would send where: set by a read, they would act later
  const parts = ["href", "protocol", "host", "hostname", "port", "pathname", "search", "hash", "username", "password"];
  shut(proto("HTMLAnchorElement"), [...parts, "ping", "target", "download"], "set");
  shut(proto("HTMLAreaElement"), parts, "set");
  // an SVG link's address is an SVGAnimatedString: its baseVal is what the click follows
  shut(proto("SVGAnimatedString"), ["baseVal"], "set");
  // the other setters of a form control's value: a later submit would send what they put there
  shut(proto("HTMLInputElement"), ["valueAsNumber", "valueAsDate"], "set");
  shut(proto("HTMLInputElement"), ["defaultValue", "name", "type", "formMethod", "formEnctype", "formTarget"], "set");
  shut(proto("HTMLButtonElement"), ["name", "value", "type", "formMethod", "formEnctype", "formTarget"], "set");
  shut(proto("HTMLFormElement"), ["enctype", "encoding", "acceptCharset", "name", "noValidate"], "set");
  shut(proto("HTMLTextAreaElement"), ["defaultValue", "name"], "set");
  shut(proto("HTMLOptionElement"), ["defaultSelected", "text", "label"], "set");
  shut(proto("HTMLSelectElement"), ["name"], "set");
  // the DOM is shared with the page's own world: any attribute a read writes (data-*, aria-*, lang, ...) is seen there at
  // once by its observers and scripts, which could send it after the read. So no setter of any node's interface works
  // (reading stays), `dataset` gives a frozen copy (its named setters can't be sealed), and so is what runs the page's
  // handlers (form validation events, the selection).
  const nodeProtos: object[] = [];
  const nodeProto = proto("Node");
  if (nodeProto) nodeProtos.push(nodeProto);
  for (const name of Object.getOwnPropertyNames(g)) {
    try {
      const p = proto(name);
      if (typeof Node !== "undefined" && p instanceof Node) nodeProtos.push(p);
    } catch {}
  }
  for (const p of nodeProtos) {
    const keys = Object.getOwnPropertyNames(p).filter(
      (k) => k !== "style" && !/^on[a-z]+$/.test(k) && !!Object.getOwnPropertyDescriptor(p, k)?.set,
    );
    shut(p, keys, "set");
  }
  // `dataset` reads still work: it gives a frozen copy
  for (const name of ["HTMLElement", "SVGElement", "MathMLElement"]) {
    const p = proto(name);
    const hit = p && own(p, "dataset");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const read = hit?.d.get as ((this: unknown) => Record<string, string>) | undefined;
    if (!hit || !read || !hit.d.configurable) continue;
    try {
      Object.defineProperty(hit.o, "dataset", {
        get(this: unknown) {
          return Object.freeze({ ...read.call(this) });
        },
        configurable: false,
      });
    } catch {}
  }
  for (const name of ["HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "HTMLButtonElement"])
    shut(proto(name), ["setCustomValidity", "checkValidity", "reportValidity"], "call");
  for (const name of ["HTMLFormElement", "HTMLFieldSetElement", "HTMLOutputElement", "HTMLObjectElement"])
    shut(proto(name), ["setCustomValidity", "checkValidity", "reportValidity"], "call");
  shut(
    proto("Selection"),
    ["deleteFromDocument", "setBaseAndExtent", "setPosition", "modify", "collapseToStart", "collapseToEnd", "empty"],
    "call",
  );
  // the selection's own live Range would change the page's selection when moved
  shut(proto("Selection"), ["removeRange", "getRangeAt"], "call");
  shut(proto("EventTarget"), ["when"], "call");
  // what settles later: code that awaits one of these would run on after the read is over (a loop that sets location)
  shut(proto("Crypto"), ["subtle"], "get");
  shut(g, ["WebAssembly", "documentPictureInPicture", "sharedStorage", "launchQueue", "speechSynthesis"], "get");
  shut(g.Atomics as object | undefined, ["waitAsync"], "call");
  shut(g, ["Response", "Request", "FileReader", "AudioContext", "OfflineAudioContext", "MediaRecorder"], "call");
  shut(
    g,
    ["createImageBitmap", "ImageDecoder", "VideoDecoder", "VideoEncoder", "AudioDecoder", "AudioEncoder"],
    "call",
  );
  shut(g, ["EyeDropper", "IdleDetector", "PaymentRequest", "MediaSource", "CompressionStream"], "call");
  shut(g, ["DecompressionStream", "showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"], "call");
  shut(g, ["queryLocalFonts", "getScreenDetails", "SpeechRecognition", "webkitSpeechRecognition"], "call");
  shut(proto("Blob"), ["text", "arrayBuffer", "bytes", "stream"], "call");
  // a blob: address is a document of the read's own making, loaded with no request Fetch could fail
  shut(g.URL as object | undefined, ["createObjectURL"], "call");
  shut(g, ["Blob", "File"], "call");
  shut(proto("HTMLImageElement"), ["decode"], "call");
  shut(proto("SVGImageElement"), ["decode"], "call");
  // the canvas's bitmap and a media element's tracks are shared with the page's world, which could send what was drawn
  shut(proto("HTMLCanvasElement"), ["toBlob", "captureStream", "transferControlToOffscreen"], "call");
  // a canvas reads (its pixels: a colour wheel's green, a chart's bars) through a read-only 2D context: drawing and
  // settings would change the bitmap the page shares, so only the reading methods and the properties' values are there
  // The proxies below read with the real object as receiver, so a getter or method a read puts on these interfaces' prototypes
  // would be handed it: the prototypes can take nothing new.
  shut(proto("CSSStyleDeclaration"), ["setProperty", "removeProperty", "cssText"], "call");
  for (const name of ["CanvasRenderingContext2D", "CSSStyleDeclaration", "CSS2Properties"]) {
    for (
      let p = proto(name) as object | null | undefined;
      p && p !== Object.prototype;
      p = rProto(p) as object | null
    ) {
      try {
        Object.freeze(p);
      } catch {} // a prototype the browser won't let go of keeps it
    }
  }
  const READ_CANVAS =
    /^(getImageData|isPointInPath|isPointInStroke|measureText|getTransform|getLineDash|getContextAttributes)$/;
  const canvasProto = proto("HTMLCanvasElement");
  const canvasDesc = canvasProto && rDesc(canvasProto, "getContext");
  const getContext = canvasDesc?.value as ((this: unknown, kind: string) => object | null) | undefined;
  if (canvasProto && canvasDesc?.configurable && getContext)
    rDefine(canvasProto, "getContext", {
      value(this: unknown, kind: unknown): unknown {
        if (kind !== "2d") throw new Error("getContext gives only a 2d context in a read, to read its pixels");
        const ctx = rApply(getContext, this, ["2d"]);
        if (!ctx) return null;
        return new Proxy(ctx, {
          get: (t, k) => {
            const v: unknown = rGet(t, k, t);
            if (typeof v !== "function") return v;
            return typeof k === "string" && rApply(reTest, READ_CANVAS, [k])
              ? (...a: unknown[]): unknown => rApply(v as (...a: unknown[]) => unknown, t, a)
              : undefined;
          },
          set: () => {
            throw new Error("a canvas is read-only in a read");
          },
          defineProperty: () => {
            throw new Error("a canvas is read-only in a read");
          },
          deleteProperty: () => {
            throw new Error("a canvas is read-only in a read");
          },
          setPrototypeOf: () => {
            throw new Error("a canvas is read-only in a read");
          },
          preventExtensions: () => {
            throw new Error("a canvas is read-only in a read");
          },
        });
      },
      writable: false,
      configurable: false,
    });
  shut(proto("HTMLMediaElement"), ["addTextTrack"], "call");
  shut(proto("TextTrack"), ["addCue", "removeCue"], "call");
  shut(proto("HTMLVideoElement"), ["requestVideoFrameCallback", "requestPictureInPicture"], "call");
  shut(proto("HTMLMediaElement"), ["setSinkId", "setMediaKeys", "captureStream"], "call");
  shut(proto("CustomElementRegistry"), ["whenDefined"], "call");
  shut(
    proto("Document"),
    ["requestStorageAccess", "hasStorageAccess", "startViewTransition", "browsingTopics"],
    "call",
  );
  shut(
    proto("Document"),
    ["hasPrivateToken", "hasRedemptionRecord", "exitPointerLock", "exitPictureInPicture"],
    "call",
  );
  shut(
    proto("Navigator"),
    ["storage", "permissions", "mediaDevices", "gpu", "usb", "hid", "serial", "bluetooth"],
    "get",
  );
  shut(proto("Navigator"), ["wakeLock", "xr", "keyboard", "presentation", "userAgentData", "mediaCapabilities"], "get");
  shut(proto("Navigator"), ["geolocation", "login", "ink", "virtualKeyboard", "mediaSession", "managed"], "get");
  shut(proto("Navigator"), ["getBattery", "requestMIDIAccess", "requestMediaKeySystemAccess", "getUserMedia"], "call");
  shut(proto("Navigator"), ["getInstalledRelatedApps", "setAppBadge", "clearAppBadge", "webkitGetUserMedia"], "call");
  // more promise sources that settle through the browser process
  shut(proto("Navigator"), ["storageBuckets", "credentials", "ml", "serviceWorker"], "get");
  shut(
    proto("Navigator"),
    ["createAuctionNonce", "joinAdInterestGroup", "runAdAuction", "leaveAdInterestGroup"],
    "call",
  );
  shut(proto("ScreenOrientation"), ["lock", "unlock"], "call");
  shut(proto("Document"), ["requestStorageAccessFor", "hasUnpartitionedCookieAccess"], "call");
  shut(g, ["Translator", "LanguageDetector", "Summarizer", "Writer", "Rewriter", "LanguageModel"], "call");
  shut(g, ["WebSocketStream", "WebTransport", "PresentationRequest", "IdentityProvider"], "call");
  shut(proto("HTMLMediaElement"), ["play", "load", "pause"], "call");
  shut(proto("HTMLMediaElement"), ["src", "srcObject"], "set");
  shut(proto("HTMLTrackElement"), ["src"], "set");
  shut(proto("HTMLEmbedElement"), ["src"], "set");
  shut(proto("HTMLObjectElement"), ["data"], "set");
  shut(proto("HTMLDialogElement"), ["show", "showModal", "close", "requestClose"], "call");
  // tree and table mutators change the page's DOM, which its own observers see; performance entries are shared with its world
  shut(
    proto("HTMLTableElement"),
    [
      "insertRow",
      "deleteRow",
      "createTHead",
      "deleteTHead",
      "createTFoot",
      "deleteTFoot",
      "createTBody",
      "createCaption",
      "deleteCaption",
    ],
    "call",
  );
  shut(proto("HTMLTableSectionElement"), ["insertRow", "deleteRow"], "call");
  shut(proto("HTMLTableRowElement"), ["insertCell", "deleteCell"], "call");
  shut(proto("HTMLSlotElement"), ["assign"], "call");
  shut(proto("Performance"), ["mark", "measure", "clearMarks", "clearMeasures"], "call");
  shut(proto("HTMLDetailsElement"), ["open"], "set");
  // a frame's window has a world of its own, with all of the above
  shut(proto("HTMLIFrameElement"), ["src", "srcdoc"], "set");
  shut(proto("HTMLIFrameElement"), ["contentWindow", "contentDocument"], "get");
  shut(proto("HTMLFrameElement"), ["src"], "set");
  shut(proto("HTMLFrameElement"), ["contentWindow", "contentDocument"], "get");
  shut(proto("HTMLObjectElement"), ["contentWindow", "contentDocument"], "get");
  for (const name of ["HTMLObjectElement", "HTMLEmbedElement", "HTMLIFrameElement", "HTMLFrameElement"])
    shut(proto(name), ["getSVGDocument"], "call");
  shut(proto("CSSNestedDeclarations"), ["style"], "get");
  // styles: a background or font address loads. Chrome's style properties (style.backgroundImage) can't be sealed one
  // by one, so an element's or a rule's own style is out of reach; getComputedStyle, read-only, still gives a style
  shut(proto("CSSStyleDeclaration"), ["setProperty", "removeProperty", "cssText"], "call");
  // an element's own style reads as it is (el.style.display, a common visibility check) but takes no change: what it
  // gives is a read-only view, whose methods are the reading ones
  const READ_STYLE = /^(getPropertyValue|getPropertyPriority|item)$/;
  for (const name of ["HTMLElement", "SVGElement", "MathMLElement"]) {
    const o = proto(name);
    const d = o && rDesc(o, "style");
    const get = d?.get;
    if (!o || !d?.configurable || !get) continue;
    rDefine(o, "style", {
      get(this: unknown) {
        const style = rApply(get, this, []) as object;
        return new Proxy(style, {
          get: (t, k) => {
            const v: unknown = rGet(t, k, t);
            if (typeof v !== "function") return v;
            return typeof k === "string" && rApply(reTest, READ_STYLE, [k])
              ? (...a: unknown[]): unknown => rApply(v as (...a: unknown[]) => unknown, t, a)
              : undefined;
          },
          set: () => {
            throw new Error("style is read-only in a read");
          },
          defineProperty: () => {
            throw new Error("style is read-only in a read");
          },
          deleteProperty: () => {
            throw new Error("style is read-only in a read");
          },
          setPrototypeOf: () => {
            throw new Error("style is read-only in a read");
          },
          preventExtensions: () => {
            throw new Error("style is read-only in a read");
          },
        });
      },
      configurable: false,
    });
  }
  for (const name of ["HTMLElement", "SVGElement", "MathMLElement"]) shut(proto(name), ["attributeStyleMap"], "get");
  for (const name of ["CSSStyleRule", "CSSPageRule", "CSSFontFaceRule"])
    shut(proto(name), ["style", "attributeStyleMap"], "get");
  shut(proto("CSSKeyframeRule"), ["style"], "get");
  // a rule's selector, key or name is page-shared state a page script could poll after the read
  shut(proto("CSSStyleRule"), ["selectorText"], "set");
  shut(proto("CSSPageRule"), ["selectorText"], "set");
  shut(proto("CSSKeyframeRule"), ["keyText"], "set");
  shut(proto("CSSKeyframesRule"), ["name"], "set");
  shut(proto("CSSStyleSheet"), ["disabled"], "set");
  shut(proto("StyleSheet"), ["disabled"], "set");
  shut(proto("MediaList"), ["mediaText"], "set");
  shut(proto("MediaList"), ["appendMedium", "deleteMedium"], "call");
  shut(proto("Element"), ["attributeStyleMap"], "get");
  shut(proto("StylePropertyMap"), ["set", "append", "delete", "clear"], "call");
  shut(proto("CSSStyleSheet"), ["insertRule", "deleteRule", "addRule", "removeRule", "replace", "replaceSync"], "call");
  shut(proto("CSSGroupingRule"), ["insertRule", "deleteRule"], "call");
  shut(proto("CSSKeyframesRule"), ["appendRule", "deleteRule"], "call");
  shut(proto("FontFace"), ["load"], "call");
  shut(proto("FontFaceSet"), ["add", "load"], "call");
  shut(g, ["FontFace"], "call");

  // The read's code gets no way to the real window, document or Location (readExpression shadows those names with
  // __drexScope's stand-ins): `location` can't be sealed, and a location set from here, a javascript: one above all, would
  // run code in the page's own world. The stand-ins read as the real ones do; `location` is a frozen copy of the address.
  if (typeof document === "undefined") return; // the tests' Node, which has no page
  const realDoc = document;
  const realWin = window;
  const address = () => {
    const l = realWin.location;
    const copy = { href: l.href, origin: l.origin, protocol: l.protocol, host: l.host, hostname: l.hostname };
    return Object.freeze({
      ...copy,
      port: l.port,
      pathname: l.pathname,
      search: l.search,
      hash: l.hash,
      toString: () => copy.href,
    });
  };
  // eslint-disable-next-line prefer-const -- each proxy refers to the other
  let standInDoc: Document;
  // eslint-disable-next-line prefer-const
  let standInWin: Window;
  // a window, Location or document of another frame (window[0], an object's SVG document) is of another realm, so
  // instanceof can't tell it: its tag can. Any window or Location but the stand-ins' is out of reach, and so is a
  // document with a browsing context (it has a location); one without (a clone) has none to give.
  // A cross-origin window or Location shows no tag (it is an "[object Object]") but has no prototype either: out of reach.
  const DOC_TAG = /^\[object (HTML|XML)?Document\]$/;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- rApply's type comes from the kept Reflect.apply
  const tag = (v: unknown) => (v !== null && typeof v === "object" ? (rApply(toStr, v, []) as string) : "");
  const safe = (v: unknown): unknown => {
    if (v === realDoc) return standInDoc;
    if (v === realWin) return standInWin;
    const t = tag(v);
    if (t === "[object Location]") return v === realWin.location ? address() : undefined;
    if (t === "[object Window]") return undefined;
    if (t === "[object Object]" && rProto(v) === null) return undefined;
    if (rApply(reTest, DOC_TAG, [t]) && rGet(v as object, "location") != null) return undefined;
    return v;
  };
  const real = (v: unknown): unknown => (v === standInDoc ? realDoc : v === standInWin ? realWin : v);
  // the arguments with the stand-ins made real: built by defining, so nothing on Array.prototype can see them
  const realArgs = (a: unknown[]): unknown[] => {
    const out: unknown[] = [];
    for (let i = 0; i < a.length; i++)
      rDefine(out, i, { value: real(a[i]), writable: true, enumerable: true, configurable: true });
    return out;
  };
  // a method of the real one, called on the real one with the stand-ins' arguments made real, its result made safe
  const method =
    (fn: (...a: unknown[]) => unknown, self: object) =>
    (...a: unknown[]) =>
      safe(rApply(fn, self, realArgs(a)));
  const readOnly = (what: string) => () => {
    throw new Error(`${what} is read-only in a read`);
  };
  const isSelf = (k: unknown) =>
    k === "window" || k === "self" || k === "globalThis" || k === "top" || k === "parent" || k === "frames";
  // a node filter of the document's walkers is called with the real nodes, the document among them: it gets them safe
  const filtered = (filter: unknown): unknown =>
    typeof filter === "function"
      ? (n: unknown): unknown => rApply(filter as (n: unknown) => unknown, undefined, [safe(n)])
      : filter !== null && typeof filter === "object"
        ? {
            acceptNode: (n: unknown): unknown =>
              rApply(rGet(filter, "acceptNode") as (n: unknown) => unknown, filter, [safe(n)]),
          }
        : filter;
  // a descriptor hands out its value as it is: a child frame (window[0], a named iframe) is a real Window there, so a
  // property whose value would change when made safe is not shown
  // The stand-ins wrap blank objects, not the real window and document: a proxy of the real one must report its locked
  // properties (location, document, NaN, ...) as they are, so it couldn't hide or change them, and a read that listed
  // the window's or the document's own properties would throw. Each reads through to the real one explicitly.
  const docGet = (k: string | symbol): unknown => {
    if (k === "location") return address();
    if (k === "defaultView") return standInWin;
    if (k === "createNodeIterator" || k === "createTreeWalker") {
      const make = rGet(realDoc, k, realDoc) as (...a: unknown[]) => unknown;
      return (root: unknown, show?: number, filter?: unknown) =>
        safe(rApply(make, realDoc, [real(root), show, filtered(filter)]));
    }
    const v: unknown = rGet(realDoc, k, realDoc);
    return typeof v === "function" ? method(v as (...a: unknown[]) => unknown, realDoc) : safe(v);
  };
  const winGet = (k: string | symbol): unknown => {
    if (k === "__drexScope") return undefined; // the host's, never the read's: its compiler is an eval, its runner sets timers on
    if (k === "location") return address();
    if (k === "document") return standInDoc;
    if (k === "constructor" || k === "Window") return undefined;
    if (k === "opener") return null;
    if (isSelf(k)) return standInWin;
    const v: unknown = rGet(realWin, k, realWin);
    // a constructor (Array, Node, ...) is passed as it is; a function of the window's is called on the window
    return typeof v === "function" && !(typeof k === "string" && rApply(reTest, /^[A-Z]/, [k]))
      ? method(v as (...a: unknown[]) => unknown, realWin)
      : safe(v);
  };
  // a property as the stand-in shows it: its value as get gives it, read-only (never a getter of the real one's)
  // (a property the seal takes away throws when read: listed, it shows undefined and not enumerable, so a spread or
  // Object.assign of the window passes over it)
  const shown = (real0: object, k: string | symbol, read: () => unknown): PropertyDescriptor | undefined => {
    const d = rDesc(real0, k);
    if (!d) return undefined;
    try {
      return { value: read(), writable: false, enumerable: !!d.enumerable, configurable: true };
    } catch {
      return { value: undefined, writable: false, enumerable: false, configurable: true };
    }
  };
  standInDoc = new Proxy(Object.create(null) as Document, {
    get: (_t, k) => docGet(k),
    has: (_t, k) => rHas(realDoc, k),
    ownKeys: () => rOwnKeys(realDoc),
    getOwnPropertyDescriptor: (_t, k) => shown(realDoc, k, () => docGet(k)),
    getPrototypeOf: () => rProto(realDoc) as object | null,
    set: readOnly("document"),
    defineProperty: readOnly("document"),
    deleteProperty: readOnly("document"),
    setPrototypeOf: readOnly("document"),
    preventExtensions: readOnly("document"),
  });
  standInWin = new Proxy(Object.create(null) as Window, {
    get: (_t, k) => winGet(k),
    has: (_t, k) => k !== "__drexScope" && rHas(realWin, k),
    ownKeys: () => {
      const out: (string | symbol)[] = [];
      for (const k of rOwnKeys(realWin)) if (k !== "__drexScope") out[out.length] = k;
      return out;
    },
    getOwnPropertyDescriptor: (_t, k) => (k === "__drexScope" ? undefined : shown(realWin, k, () => winGet(k))),
    // the window's prototype chain holds the frames' names (WindowProperties, above Window.prototype): it shows none, and
    // nor does the window give its constructor (Window.prototype is the way up to them)
    getPrototypeOf: () => null,
    set: readOnly("window"),
    defineProperty: readOnly("window"),
    deleteProperty: readOnly("window"),
    setPrototypeOf: readOnly("window"),
    preventExtensions: readOnly("window"),
  });
  // the DOM's own ways back to the document or the window: what they give is made safe
  const safeGet = (o: object | undefined, keys: string[]) => {
    for (const key of keys) {
      const d = o && Object.getOwnPropertyDescriptor(o, key);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called on its own object, below
      const get = d?.get;
      if (!o || !d?.configurable || !get) continue;
      Object.defineProperty(o, key, {
        get(this: unknown) {
          return safe(rApply(get, this, []));
        },
        // eslint-disable-next-line @typescript-eslint/unbound-method -- the setter stays the DOM's own
        set: d.set,
        configurable: false,
      });
    }
  };
  const safeCall = (o: object | undefined, keys: string[]) => {
    for (const key of keys) {
      const d = o && Object.getOwnPropertyDescriptor(o, key);
      const fn = d?.value as ((...a: unknown[]) => unknown) | undefined;
      if (!o || !d?.configurable || typeof fn !== "function") continue;
      Object.defineProperty(o, key, {
        value(this: unknown, ...a: unknown[]) {
          return safe(rApply(fn, this, realArgs(a)));
        },
        writable: false,
        configurable: false,
      });
    }
  };
  safeGet(proto("Node"), ["ownerDocument", "parentNode", "parentElement"]);
  safeCall(proto("Node"), ["getRootNode", "contains", "compareDocumentPosition", "isSameNode", "isEqualNode"]);
  for (const name of ["AbstractRange", "Range", "StaticRange"])
    safeGet(proto(name), ["startContainer", "endContainer", "commonAncestorContainer"]);
  safeCall(proto("Range"), [
    "setStart",
    "setEnd",
    "setStartBefore",
    "setStartAfter",
    "selectNode",
    "selectNodeContents",
  ]);
  safeGet(proto("Selection"), ["anchorNode", "focusNode", "baseNode", "extentNode"]);
  // a walker of any document (a clone's, `new Document()`'s) calls its filter with the real nodes, a real document among
  // them (currentNode can be set outside the root): the filter is wrapped on the prototype, not only on the stand-in
  for (const key of ["createTreeWalker", "createNodeIterator"]) {
    const dp = proto("Document");
    const d = dp && Object.getOwnPropertyDescriptor(dp, key);
    const fn = d?.value as ((...a: unknown[]) => unknown) | undefined;
    if (!dp || !d?.configurable || typeof fn !== "function") continue;
    Object.defineProperty(dp, key, {
      value(this: unknown, root: unknown, show?: number, filter?: unknown) {
        return safe(rApply(fn, this, [real(root), show, filtered(filter)]));
      },
      writable: false,
      configurable: false,
    });
  }
  safeGet(proto("TreeWalker"), ["root", "currentNode"]);
  safeCall(proto("TreeWalker"), ["parentNode", "firstChild", "lastChild", "previousSibling", "nextSibling"]);
  safeCall(proto("TreeWalker"), ["previousNode", "nextNode"]);
  safeGet(proto("NodeIterator"), ["root", "referenceNode"]);
  safeCall(proto("NodeIterator"), ["nextNode", "previousNode"]);
  safeGet(proto("XPathResult"), ["singleNodeValue"]);
  safeCall(proto("XPathResult"), ["iterateNext", "snapshotItem"]);
  safeCall(proto("XPathExpression"), ["evaluate"]);
  safeGet(proto("Document"), ["defaultView"]);
  for (const name of ["Event", "UIEvent", "MessageEvent"])
    safeGet(proto(name), ["view", "source", "target", "currentTarget"]);
  // a frame reached by its name (WindowProperties, the Window prototype's prototype) is a window `safe` never sees: the
  // names are taken off the chain
  try {
    const windowProto = proto("Window");
    const named = windowProto && (Object.getPrototypeOf(windowProto) as object | null);
    if (windowProto && named) Object.setPrototypeOf(windowProto, Object.getPrototypeOf(named) as object | null);
  } catch {} // a prototype the browser won't let go of keeps it
  // the stand-ins read through the real document and window as their own receiver, so a getter or method a read adds to
  // anything on their prototype chains (Document.prototype, Object.prototype, ...) would get the real one as `this`:
  // those prototypes can take nothing new, and neither can the real ones be given another prototype or properties
  for (const start of [realDoc, realWin]) {
    for (let p = rProto(start) as object | null; p; p = rProto(p) as object | null) {
      try {
        Object.freeze(p);
      } catch {} // a prototype the browser won't let go of keeps it
    }
  }
  // The read's global names, as `with` gives them to it: each is the window's own, made safe (a window, a Location or a
  // browsing context's document comes back undefined) and a function of the window's is called on the window. Nothing
  // can be set or defined through it.
  const CTOR = /^[A-Z]/; // a constructor (Array, Node, ...) is passed as it is
  const globals = new Proxy(Object.create(null) as object, {
    has: (_t, k) => typeof k === "string",
    get: (_t, k) => {
      if (typeof k !== "string") return undefined; // Symbol.unscopables among them: nothing is unscopable
      if (k === "Window" || k === "__drexScope") return undefined; // Window.prototype is the way up to the frames' names (standInWin)
      const v: unknown = rGet(realWin, k);
      if (typeof v === "function" && !rApply(reTest, CTOR, [k]))
        return (...a: unknown[]): unknown => safe(rApply(v as (...a: unknown[]) => unknown, realWin, realArgs(a)));
      return safe(v);
    },
    set: (_t, k) => {
      throw new Error(`${String(k)} is read-only in a read`);
    },
    defineProperty: (_t, k) => {
      throw new Error(`${String(k)} is read-only in a read`);
    },
    deleteProperty: (_t, k) => {
      throw new Error(`${String(k)} is read-only in a read`);
    },
  });
  // the read has the real Object and Reflect (constructors pass as they are): a method it replaced there would be called
  // by the next read's seal and wrapper with the real global, so neither can change
  for (const o of [Object, Reflect]) {
    try {
      Object.freeze(o);
    } catch {} // one the browser won't let go of keeps its own behaviour
  }
  Object.defineProperty(g, "__drexScope", {
    value: Object.freeze({
      // the read's code, compiled as the body of a strict function whose names for the window, the document and its
      // address are the stand-ins: as a body of its own, it can't close that function and run outside it
      compile: (code: string) => {
        // array literals and Reflect, kept above, never the iterator or `call` of the page's prototypes: a read can
        // replace those, and a function compiled without the names would see the real window
        const body = `"use strict";\n{\n${code}\n}\n`;
        // compiled on its own first: a body that doesn't compile throws here, and one that does can't close the function
        // it is put in below, so the read's code runs inside it, nowhere else
        rConstruct(AsyncFunction, [READ_PARAMS, body]);
        // inside `with (globals)`: every global name the code reads goes through readGlobal, so a name that is a frame's
        // (<iframe name=k>: `k` is that frame's window) or the window's comes back safe, never the window itself
        const make = rConstruct(PlainFunction, [
          "__drexGlobals",
          `with (__drexGlobals) { return async function (${READ_PARAMS}) {\n${body}}; }`,
        ]) as (globals: object) => (...a: unknown[]) => Promise<unknown>;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- as above
        const run = rApply(make, standInWin, [globals]) as (...a: unknown[]) => Promise<unknown>;
        return async (): Promise<unknown> => {
          reading = true;
          try {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- as above
            return await (rApply(run, undefined, [
              standInWin,
              standInWin,
              standInWin,
              standInWin,
              standInWin,
              standInWin,
              null,
              address(),
              standInDoc,
            ]) as Promise<unknown>);
          } finally {
            end(); // the read is over: what it set to run later doesn't
          }
        };
      },
      // the host gave up on a read still waiting: the same, so nothing it set runs after
      end,
    }),
    writable: false,
    configurable: false,
  });
}

/** The code that seals a read's world, run before the read's own code. */
export const READ_SEAL = `(${sealReadWorld.toString()})();`;

// the names a read's code gets for the window, the document and its address (sealReadWorld keeps its own copy)
const READ_NAMES_TEXT = "window, self, globalThis, top, parent, frames, opener, location, document";

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
  // The code is never pasted into this script: it goes to __drexScope.compile as a string, which compiles it as the body of
  // a strict function whose window, document and location are sealReadWorld's stand-ins. A body can't close its function
  // early, so the code can't run outside it. A body that doesn't compile throws here, at once (an "Uncaught"
  // SyntaxError, as Chrome reports a script that doesn't compile). With no page (the tests' Node) the code is compiled
  // the same way with the real names; a page without the scope reads nothing. Every name here starts with __drex.
  const body = JSON.stringify(form === "expression" ? `return (${code}\n);` : code);
  return `((__drexF) => (async () => {
const __drexV = await __drexF();
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
})())((() => {
const __drexS = Object.getOwnPropertyDescriptor(globalThis, "__drexScope")?.value;
if (__drexS) return __drexS.compile(${body});
if (typeof Document === "function" && globalThis.document instanceof Document) throw new Error("the read's sandbox is missing: nothing was run");
const __drexRun = new (Object.getPrototypeOf(async function () {}).constructor)(${JSON.stringify(READ_NAMES_TEXT)}, ${JSON.stringify('"use strict";\n{\n')} + ${body} + "\\n}");
return () => __drexRun.call(undefined, globalThis.window, globalThis.window, globalThis, globalThis.window, globalThis.window, globalThis.window, null, globalThis.location, globalThis.document);
})())`;
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
