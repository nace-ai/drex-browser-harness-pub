"""End-to-end check: loads dist/ into Playwright's Chromium, opens the side panel page in a tab, runs one task and
prints every move as it happens. The panel normally lives in Chrome's side panel; as a tab it runs the same code.

Usage: python e2e/run.py "task" [--out runs/NAME] [--start URL] [--model claude-haiku-5-5] [--headed] [--realistic]
                          [--storage URL] [--foreground]
--realistic: a visible window with Chrome's normal background-tab behavior (Playwright otherwise turns off the
             throttling of hidden tabs), to test working in a background tab honestly.
--storage URL: after the run, save that origin's localStorage to OUT/storage.json (the test mailbox keeps its state there).
--stop-when-stored KEY: end the run as soon as a page on the --storage origin has KEY in its localStorage (a benchmark
             page recording its score: like a benchmark environment, the attempt is over then).
--har PATH: record the traffic to the --start URL's origin into a HAR file (a benchmark grades from it), apart from
             its /static/ and /media/ files.
--site-header "Name: value": send this header with every request to the --start URL's origin, and nowhere else (a
             benchmark site's login: WebArena's shop signs in its customer on each request that carries it).
--site-only: no host name but the --start URL's resolves (an IP address still connects), apart from the APIs the extension's manifest grants (its own
             calls), so pages can't reach the internet.
--run-limits JSON: the agent's run limits for this run, e.g. '{"maxHaikuCalls": 40}' (the extension keeps only known,
             valid keys: maxHaikuCalls, maxCostUsd, maxSeconds; limitsFrom in src/run-budget.ts).
--shots DIR: save a 1280x800 screenshot of the agent's tab into DIR (0000.jpg, 0001.jpg, ...) whenever the run log grows,
             at least every 10 s, and at the end, skipping one identical to the last; DIR/shots.json lists them (time, URL).
             A benchmark judge that grades a run from its screenshots reads them."""
import argparse, contextlib, hashlib, json, pathlib, re, shutil, signal, sys, tempfile, time
from urllib.parse import urlsplit
from playwright.sync_api import TimeoutError as PlaywrightTimeout, sync_playwright
from run_artifact import initial_run_artifact, panel_run_artifact, save_download_artifact, write_run_artifact

ap = argparse.ArgumentParser()
ap.add_argument("task")
ap.add_argument("--out", default=f"runs/e2e-{time.strftime('%H%M%S')}")
ap.add_argument("--start", default="https://example.com/")
ap.add_argument("--model", default="")
ap.add_argument("--headed", action="store_true")
ap.add_argument("--timeout", type=int, default=900)
ap.add_argument("--realistic", action="store_true")
ap.add_argument("--storage", default="")
ap.add_argument("--foreground", action="store_true", help="turn the extension's background-tab mode off")
ap.add_argument("--approve", action="store_true", help="answer approval cards with 'Allow for this task' (test pages only)")
ap.add_argument("--dark", action="store_true", help="dark color scheme (to check the panel's dark theme)")
ap.add_argument("--no-cursor", action="store_true", help="turn the visible cursor off")
ap.add_argument("--frames", type=int, default=0, help="save a panel screenshot every 0.5 s for this many seconds (OUT/frames/)")
ap.add_argument("--no-approvals", action="store_true", help="turn the 'ask before risky actions' setting off")
ap.add_argument("--dist", default="", help="the unpacked extension to load (default: dist/ of this checkout)")
ap.add_argument("--plan", default="", help="a plan JSON to run instead of asking the LLM (replays a real run's plan)")
ap.add_argument("--no-plan", action="store_true", help="turn LLM planning off: Drex works on the task as written")
ap.add_argument("--stop-when-stored", default="", help="end the run once a page on the --storage origin stores this localStorage key")
ap.add_argument("--har", default="", help="record the --start origin's traffic into this HAR file")
ap.add_argument("--site-header", action="append", default=[], help="'Name: value' sent with every request to the --start origin")
ap.add_argument("--run-limits", default="", help='run limits for the agent as JSON, e.g. {"maxHaikuCalls": 40}')
ap.add_argument("--site-only", action="store_true", help="resolve no host but --start's and the extension's APIs")
ap.add_argument("--shots", default="", help="save a screenshot of the agent's tab here whenever the run log grows (see above)")
a = ap.parse_args()
if a.stop_when_stored and not a.storage:
    ap.error("--stop-when-stored needs --storage (the origin whose localStorage is watched)")
watched = "{0.scheme}://{0.netloc}/".format(urlsplit(a.storage)) if a.storage else ""
site = re.compile("^" + re.escape("{0.scheme}://{0.netloc}".format(urlsplit(a.start))) + "(/|$)")  # the --start origin
# the HAR keeps what a grader reads (pages, forms, API calls), not the shop's /static/ and /media/ files: with their
# bodies embedded a HAR outgrows the longest string V8 can hold, and Playwright fails to write it
har_filter = re.compile("^" + re.escape("{0.scheme}://{0.netloc}".format(urlsplit(a.start))) + "(/(?!static/|media/)|$)")
site_headers = dict((k.strip(), v.strip()) for k, v in (h.split(":", 1) for h in a.site_header))
root = pathlib.Path(__file__).resolve().parent.parent
dist, out = (pathlib.Path(a.dist).resolve() if a.dist else root / "dist"), root / a.out
out.mkdir(parents=True, exist_ok=True)
resolver = []
if a.site_only:
    apis = [urlsplit(u).hostname for u in json.loads((dist / "manifest.json").read_text()).get("host_permissions", [])]
    resolver = ["--host-resolver-rules=MAP * ~NOTFOUND, " + ", ".join(f"EXCLUDE {h}" for h in [urlsplit(a.start).hostname, *apis])]
write_run_artifact(out, initial_run_artifact())
# a SIGTERM (a timeout in a batch script) unwinds like Ctrl-C, so the profile below is removed on that way out too
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))

# closing the context writes the HAR: closed on the way out of an error too (a second close() does nothing)
with sync_playwright() as p, contextlib.ExitStack() as closing:
    # The agent's screenshots come from the real window, not from Playwright's viewport emulation: under emulation a
    # front tab's screenshot is cropped to the window (headless) or stale (headed), and the panel's own 420x900
    # viewport below shrinks that shared window, so a planned run that works in the start tab (every MiniWoB task) saw
    # a 420x761 corner of its 1280x800 page with every element box drawn at a third of its place. So no emulation: a
    # real window of a 1280x800 page plus the toolbar, whose screenshots always match the page's innerWidth/innerHeight.
    # Planned runs keep the 2x pixel ratio they had under emulation; --no-plan runs keep 1x.
    profile = tempfile.mkdtemp(prefix="drex-e2e-")
    closing.callback(shutil.rmtree, profile, ignore_errors=True)  # after ctx.close() below: the profile goes with the run
    ctx = p.chromium.launch_persistent_context(
        profile, channel="chromium", headless=not (a.headed or a.realistic),
        no_viewport=True, color_scheme="dark" if a.dark else "light",
        ignore_default_args=["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
                             "--disable-renderer-backgrounding"] if a.realistic else None,
        args=[f"--disable-extensions-except={dist}", f"--load-extension={dist}", *resolver, "--window-size=1280,939"]
        + ([] if a.no_plan else ["--force-device-scale-factor=2"]),
        **({"record_har_path": a.har, "record_har_content": "embed",
            "record_har_url_filter": har_filter} if a.har else {}))
    closing.callback(ctx.close)
    # 60 s: with ten Chromiums and their shops starting on one machine, the extension's worker can take over 15 s
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=60000)
    ext = sw.url.split("/")[2]
    # the extension's own worker, the newest: ctx.service_workers is a set in no order and lists a website's workers
    # too, so a restarted worker is caught as it attaches (from here, before the slow start page and panel setup)
    ext_worker = {"newest": sw}
    ctx.on("serviceworker", lambda w: w.url.startswith(f"chrome-extension://{ext}/") and ext_worker.update(newest=w))
    user = ctx.pages[0]

    def add_site_headers(route):
        try:  # all_headers: the cookies too, which route.request.headers leaves out
            route.continue_(headers={**route.request.all_headers(), **site_headers})
        except Exception:  # the tab closed or the request was cancelled meanwhile: an error here would end the run
            try:  # any other failure: abort the request rather than leave it hanging until --timeout
                route.abort()
            except Exception:
                pass
    if site_headers:
        ctx.route(site, add_site_headers)
    try:
        user.goto(a.start)
    except PlaywrightTimeout:  # a live site whose ads or trackers never let "load" fire: its page is there all the same
        print(f"the start page did not fire load in 30 s; going on with what it has", flush=True)
    panel = ctx.new_page()
    panel.set_viewport_size({"width": 420, "height": 900})
    panel.goto(f"chrome-extension://{ext}/sidepanel.html")
    if a.model:
        panel.evaluate(f"chrome.storage.local.set({{model: {json.dumps(a.model)}}})")
    if a.run_limits:  # the extension keeps only known, valid keys (limitsFrom in src/run-budget.ts)
        panel.evaluate(f"chrome.storage.local.set({{runLimits: {json.dumps(json.loads(a.run_limits))}}})")
    if a.no_cursor:
        panel.evaluate("chrome.storage.local.set({cursor: false})")
    if a.no_approvals:
        panel.evaluate("chrome.storage.local.set({approvals: false})")
    if a.no_plan:
        panel.evaluate("chrome.storage.local.set({planning: false})")
    if a.plan:
        panel.evaluate(f"chrome.storage.local.set({{testPlan: {pathlib.Path(a.plan).read_text()}}})")
    if a.foreground:
        panel.evaluate("chrome.storage.local.set({background: false})")
    panel.wait_for_timeout(500)
    if a.realistic:
        panel.bring_to_front()  # the panel stays visible (as the side panel would); the agent's tab opens hidden behind it
    else:
        user.bring_to_front()  # the user's tab is the active one when the task starts, as in real use
    panel.fill("#task", a.task)
    # the panel is a background tab when the agent's tab is in front, and Playwright's real clicks wait for frames a
    # background tab never paints: the panel's buttons are clicked through the DOM instead
    press = lambda selector, text="": panel.evaluate(
        "([s, t]) => [...document.querySelectorAll(s)].find((b) => !t || b.textContent === t).click()", [selector, text])
    panel.evaluate("document.getElementById('taskForm').requestSubmit()")
    seen, t0 = 0, time.time()
    last_snapshot = 0
    shots, shot_state = [], {"rows": -1, "at": 0.0, "hash": "", "live": None, "tab": None}
    page_targets = {}  # Playwright page -> its DevTools target id, which chrome.debugger.getTargets() pairs with a tab id
    # the target of the agent's tab: the one of its newest screen event (a screen names its tab by id, not just by URL)
    agent_target = """async () => {
      const id = globalThis.drexState?.().agentTab;
      if (id == null) return null;
      return (await chrome.debugger.getTargets()).find((t) => t.tabId === id)?.id ?? null;
    }"""

    def target_of(pg):
        if pg not in page_targets:
            cdp = ctx.new_cdp_session(pg)
            try:
                page_targets[pg] = cdp.send("Target.getTargetInfo")["targetInfo"]["targetId"]
            finally:
                cdp.detach()
        return page_targets[pg]

    def agent_page(pages):
        """The page of the tab the newest screen event came from; None when that can't be told (no screen yet, an
        extension build without drexState().agentTab, a worker restarting) and the panel's #liveUrl has to do."""
        try:
            target = ext_worker["newest"].evaluate(agent_target)  # a closed worker raises: #liveUrl has to do
            return next((pg for pg in pages if target and target_of(pg) == target), None)
        except Exception:
            return None

    def shoot(rows):
        """The agent's tab now: the tab of its newest screen event, found by tab id (two tabs can show one address).
        Without that, by #liveUrl, which lags a navigation until the next screen, so the tab it last named is kept (by
        identity, not by its address: the user's tab may still show that address) until #liveUrl names another;
        then the page at that address (the kept one first, else the newest), else the newest page that isn't the panel."""
        shot_state.update(rows=rows, at=time.monotonic())
        try:
            live = panel.evaluate("() => document.getElementById('liveUrl')?.textContent || ''")
            pages = [pg for pg in ctx.pages if not pg.url.startswith("chrome-extension://")]
            kept = shot_state["tab"] if shot_state["tab"] in pages else None
            named = [pg for pg in reversed(pages) if live and pg.url == live]
            tab = agent_page(pages)
            if tab is None and live and kept and (live == shot_state["live"] or kept in named or not named):
                tab = kept
            elif tab is None:
                tab = named[0] if named else pages[-1] if pages else None
            if tab is None:
                return
            if live:  # before the first screen #liveUrl is empty and the newest page may still be the user's tab
                shot_state.update(live=live, tab=tab)
            data = tab.screenshot(type="jpeg", quality=75, scale="css", timeout=5000)
        except Exception as exc:  # a tab mid-navigation or closing: the next round takes one
            print("screenshot skipped:", type(exc).__name__, flush=True)
            return
        digest = hashlib.sha1(data).hexdigest()
        if digest == shot_state["hash"]:
            return
        shot_state["hash"] = digest
        name = f"{len(shots):04d}.jpg"
        (shot_dir / name).write_bytes(data)
        shots.append({"file": name, "t": round(time.time() - t0, 1), "url": tab.url, "log_rows": rows})
        (shot_dir / "shots.json").write_text(json.dumps(shots, indent=1) + "\n")
    shot_dir = pathlib.Path(a.shots).resolve() if a.shots else None
    if shot_dir:
        shot_dir.mkdir(parents=True, exist_ok=True)

    def stored():
        for pg in ctx.pages:
            if pg.url.startswith(watched):
                try:
                    if pg.evaluate("k => localStorage.getItem(k) !== null", a.stop_when_stored):
                        return True
                except Exception:  # a page mid-navigation: look again next round
                    pass
        return False
    while time.time() - t0 < a.timeout:
        if time.monotonic() - last_snapshot >= 2:
            try:
                write_run_artifact(out, panel_run_artifact(panel))
            except Exception as exc:
                print("public snapshot unavailable:", type(exc).__name__, flush=True)
            last_snapshot = time.monotonic()
        rows = panel.eval_on_selector_all("#log li", "els => els.map(e => e.innerText.replace(/\\n/g, ' | '))")
        for r in rows[seen:]:
            print(f"[{time.time() - t0:6.1f}s] {r}", flush=True)
        seen = len(rows)
        if shot_dir and (seen != shot_state["rows"] or time.monotonic() - shot_state["at"] >= 10):
            shoot(seen)
        if a.stop_when_stored and stored():
            print(f"[{time.time() - t0:6.1f}s] SCORED: the page stored {a.stop_when_stored}; the attempt is over", flush=True)
            break
        if panel.is_visible("#asks .ask"):
            text = panel.inner_text("#asks .ask")
            allow = panel.locator("#asks .ask button", has_text="Allow for this task")
            if a.approve and allow.count():
                print(f"[{time.time() - t0:6.1f}s] APPROVED: " + text.split(chr(10))[0], flush=True)
                press("#asks .ask button", "Allow for this task")
                panel.wait_for_timeout(300)
                continue
            print("ASK:", text, flush=True)
            (out / "ask.json").write_text(json.dumps({"t": round(time.time() - t0, 1), "approval": bool(allow.count()), "text": text}) + "\n")
            if shot_dir:
                shoot(seen)
            panel.screenshot(path=str(out / "ask.png"))
            # answer Stop so the run finishes and its log can be downloaded below
            press("#asks .ask button", "Stop")
            panel.wait_for_selector("#stop", state="hidden", timeout=30000)
            break
        if not panel.is_visible("#stop") and seen:
            break
        if a.frames and time.time() - t0 < a.frames:
            (out / "frames").mkdir(exist_ok=True)
            panel.screenshot(path=str(out / "frames" / f"{int((time.time() - t0) * 10):04d}.png"))
        panel.wait_for_timeout(500)  # not time.sleep: Playwright runs the --site-header route only while it is called
    if panel.is_visible("#stop"):  # --timeout ran out: stop the agent so the run log can be saved
        press("#stop")
        panel.wait_for_selector("#stop", state="hidden", timeout=30000)
    write_run_artifact(out, panel_run_artifact(panel))
    if shot_dir:
        shoot(seen)
    status = panel.inner_text("#status")
    answer = panel.inner_text("#answerText") if panel.is_visible("#answer") else ""
    meter = panel.inner_text(".meter")
    plan = panel.inner_text("#plan") if panel.is_visible("#planBox") else ""
    print("\nPLAN:\n" + plan + "\n\nSTATUS: " + status + "\n\nMETER:\n" + meter + "\n\nANSWER:\n" + answer)
    try:
        panel.screenshot(path=str(out / "panel.png"), full_page=True)
    except Exception as e:  # a background panel tab can refuse a screenshot; the run log below matters more
        print("panel screenshot failed:", e)
    if a.storage:
        pg = ctx.new_page()
        pg.goto(a.storage)
        (out / "storage.json").write_text(pg.evaluate("JSON.stringify(Object.fromEntries(Object.entries(localStorage)))"))
        pg.close()
    for i, pg in enumerate(ctx.pages):
        if not pg.url.startswith("chrome-extension://"):
            try:
                pg.screenshot(path=str(out / f"tab{i}.png"))
            except Exception:
                pass
    if not panel.is_disabled("#download"):
        with panel.expect_download() as dl:
            press("#download")
        save_download_artifact(out, dl.value)
    ctx.close()
