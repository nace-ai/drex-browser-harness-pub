"""A browser for coding-agent tests: loads dist/ into Playwright's Chromium with "Let coding agents use Drex" on and
a pairing code set, and keeps it open so mcp/server.mjs (started by the coding agent with that code) can reach it.
The panel page is opened in a tab so every row it logs is printed here; --no-panel leaves it closed (runs happen in
the extension's service worker either way).

Usage: python e2e/agent_bridge.py [--start URL] [--minutes 30] [--headed] [--no-plan] [--no-approvals] [--storage FILE]
                                  [--code CODE] [--no-panel]
It prints the pairing code; then, in another shell:
  claude -p "..." --mcp-config '{"mcpServers":{"drex":{"command":"node","args":["mcp/server.mjs"],"env":{"DREX_PAIRING_CODE":"<code>"}}}}'"""
import argparse, json, pathlib, subprocess, tempfile, time
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--start", default="about:blank")
ap.add_argument("--minutes", type=float, default=30)
ap.add_argument("--headed", action="store_true")
ap.add_argument("--no-plan", action="store_true", help="turn LLM planning off by default (a call's `plan` still wins)")
ap.add_argument("--no-approvals", action="store_true", help="test pages only: risky clicks go ahead without asking")
ap.add_argument("--dist", default="dist")
ap.add_argument("--storage", default="", help="keep saving the test site's localStorage to this file (the mailbox keeps its state there; grade with e2e/grade_mail.py)")
ap.add_argument("--code", default="", help="the pairing code to use (default: a new one, printed)")
ap.add_argument("--no-panel", action="store_true", help="don't open the panel page: the run's rows aren't printed, the link state is")
a = ap.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
code = a.code or subprocess.check_output(["node", "-e", "import('./src/pairing.ts').then((m) => console.log(m.newCode()))"], cwd=root, text=True).strip()

with sync_playwright() as p:
    # a real window and no viewport emulation: under emulation the extension's screenshots of the front tab are
    # cropped (headless) or stale (headed), and coding-agent runs start in a tab in front
    ctx = p.chromium.launch_persistent_context(
        tempfile.mkdtemp(prefix="drex-bridge-"), channel="chromium", headless=not a.headed, no_viewport=True,
        args=[f"--disable-extensions-except={a.dist}", f"--load-extension={a.dist}", "--window-size=1280,939"])
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
    ext = sw.url.split("/")[2]
    ctx.pages[0].goto(a.start)
    settings = {"bridge": True, "bridgeCode": code, "cursor": False}
    if a.no_plan:
        settings["planning"] = False
    if a.no_approvals:
        settings["approvals"] = False
    sw.evaluate("(s) => chrome.storage.local.set(s)", settings)
    panel = None
    if not a.no_panel:
        panel = ctx.new_page()
        panel.goto(f"chrome-extension://{ext}/sidepanel.html")
    print(f"extension {ext} loaded; waiting for the coding agent", flush=True)
    print(f"DREX_PAIRING_CODE={code}", flush=True)
    print("mcp config: " + json.dumps({"mcpServers": {"drex": {"command": "node", "args": ["mcp/server.mjs"], "env": {"DREX_PAIRING_CODE": code}}}}), flush=True)
    seen, state, t0 = 0, "", time.time()
    while time.time() - t0 < a.minutes * 60:
        now = sw.evaluate("globalThis.drexState().bridge")
        if now != state:
            state = now
            print(f"[bridge] {state}", flush=True)
        rows = panel.eval_on_selector_all("#log li", "els => els.map(e => e.innerText.replace(/\\n/g, ' | '))") if panel else []
        if len(rows) < seen:
            seen = 0  # a new run cleared the log
        for r in rows[seen:]:
            print(f"[{time.time() - t0:6.1f}s] {r}", flush=True)
        seen = len(rows)
        if a.storage:
            for pg in ctx.pages:
                if pg.url.startswith("http://127.0.0.1:8765/"):
                    try:
                        dump = pg.evaluate("JSON.stringify(Object.fromEntries(Object.entries(localStorage)))")
                        pathlib.Path(a.storage).parent.mkdir(parents=True, exist_ok=True)
                        pathlib.Path(a.storage).write_text(dump)
                    except Exception:
                        pass  # mid-navigation
        ctx.pages[0].wait_for_timeout(500)
    ctx.close()
