"""End-to-end check of the coding-agent link and of runs in the service worker, in Playwright's Chromium with the
built extension (never your Chrome). Uses port 47615 and the test site on 127.0.0.1:8765 (python3 e2e/serve.py).

  1-2  two impostors on the port (no handshake; a made-up proof): the extension answers nothing and calls it impostor
  3-4  the real MCP server with another pairing code, and with none: refused, with a clear error for the coding agent
  5    the real MCP server with your code: drex_tabs and a drex_run on the test form, with no panel open anywhere
  6    a panel opened afterwards shows that run
  7    a run started in the panel keeps going after the panel is closed
  8    an approval asked while the panel was closed is answered from a panel opened later

Usage: python e2e/pairing_e2e.py [--dist dist] [--headed]"""
import argparse, json, os, pathlib, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = "http://127.0.0.1:8765"
ap = argparse.ArgumentParser()
ap.add_argument("--dist", default=str(ROOT / "dist"))
ap.add_argument("--headed", action="store_true")
a = ap.parse_args()

results = []
def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  - ' + detail if detail else ''}", flush=True)

def new_code():
    return subprocess.check_output(["node", "-e", "import('./src/pairing.ts').then((m) => console.log(m.newCode()))"], cwd=ROOT, text=True).strip()

def mcp_call(code, tool, args, wait=6):
    env = {**os.environ, "DREX_PAIRING_CODE": code}
    out = subprocess.run(["node", "e2e/mcp_call.mjs", tool, json.dumps(args), str(wait)], cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
    return json.loads(out.stdout.strip().splitlines()[-1])

CODE, OTHER = new_code(), new_code()
FORM_TASK = "Register for the meetup with made-up details (name Test Person, email test.person@example.com, Kazakhstan, the student ticket) and submit the form."

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        tempfile.mkdtemp(prefix="drex-pairing-"), channel="chromium", headless=not a.headed, no_viewport=True,
        args=[f"--disable-extensions-except={a.dist}", f"--load-extension={a.dist}", "--window-size=1280,939"])
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
    ext = sw.url.split("/")[2]
    state = lambda: sw.evaluate("globalThis.drexState()")
    def wait_for(pred, seconds):
        t0 = time.time()
        while time.time() - t0 < seconds:
            s = state()
            if pred(s):
                return s
            time.sleep(0.25)
        return state()
    user = ctx.pages[0]
    user.goto(f"{SITE}/form.html")
    sw.evaluate(f"chrome.storage.local.set({{bridge: true, bridgeCode: {json.dumps(CODE)}, cursor: false}})")
    s = wait_for(lambda s: s["bridge"] == "waiting", 5)
    check("the link waits for a server, with no panel open", s["bridge"] == "waiting" and s["panels"] == 0, s["bridge"])

    # 1-2: impostors
    # after refusing an impostor the extension tries again in 12 s, so each one runs long enough for a retry
    for mode, secs in (("skip", 14), ("fake-welcome", 30)):
        imp = subprocess.Popen(["node", "e2e/impostor.mjs", mode, str(secs)], cwd=ROOT, stdout=subprocess.PIPE, text=True)
        s = wait_for(lambda s: s["bridge"] == "impostor", secs)
        out = json.loads(imp.communicate()[0].strip())
        check(f"impostor ({mode}): no request answered, link marked impostor",
              out["connections"] >= 1 and out["answered"] == 0 and s["bridge"] == "impostor", f"{out}, state {s['bridge']}")

    # 3: the real server with another code
    r = mcp_call(OTHER, "drex_tabs", {}, wait=16)
    s = state()
    check("server with another code: tool call refused with a clear error", r["isError"] and "doesn't match" in r["text"], r["text"][:90])
    check("server with another code: the extension shows wrong-code", s["bridge"] in ("wrong-code", "waiting"), s["bridge"])

    # 4: the real server with no code
    r = mcp_call("", "drex_tabs", {}, wait=16)
    check("server without a code: tool call refused", r["isError"] and "no pairing code" in r["text"], r["text"][:90])

    # 5: the real server with your code, no panel anywhere
    r = mcp_call(CODE, "drex_tabs", {}, wait=16)
    check("paired: drex_tabs answers", not r["isError"] and "form.html" in r["text"], r["text"][:90])
    r = mcp_call(CODE, "drex_run", {"task": FORM_TASK, "url": f"{SITE}/form.html", "expect": "The page confirms the registration was received."}, wait=6)
    run = json.loads(r["text"]) if not r["isError"] else {}
    check("paired: drex_run on the form, no panel open", run.get("status") == "done" and run.get("expect", {}).get("p", 0) > 0.8,
          f"{run.get('status')}, {run.get('drex_moves')} Drex moves, ${run.get('cost_usd')}, expect p={run.get('expect', {}).get('p')}" if run else r["text"][:120])
    check("no panel was open during that run", state()["panels"] == 0)

    # 6: a panel opened afterwards shows the run
    panel = ctx.new_page()
    panel.goto(f"chrome-extension://{ext}/sidepanel.html")
    panel.wait_for_timeout(800)
    rows = panel.eval_on_selector_all("#log li", "els => els.length")
    status = panel.inner_text("#statusText")
    check("a panel opened later shows the finished run", rows >= 6 and status.startswith("Done"), f"{rows} rows, '{status}'")

    # 7: a run from the panel survives the panel closing
    user.goto(f"{SITE}/form.html")
    user.bring_to_front()
    panel.fill("#task", f"On {SITE}/form.html: {FORM_TASK}")
    panel.evaluate("document.getElementById('taskForm').requestSubmit()")
    for _ in range(120):
        if panel.eval_on_selector_all("#log li", "els => els.filter((e) => e.className.startsWith('drex')).length") >= 1:
            break
        panel.wait_for_timeout(250)
    panel.close()
    s = wait_for(lambda s: not s["running"], 180)
    check("a panel run finishes after the panel is closed", s["status"] == "done" and s["panels"] == 0, f"status {s['status']}")
    panel = ctx.new_page()
    panel.goto(f"chrome-extension://{ext}/sidepanel.html")
    panel.wait_for_timeout(800)
    rows = panel.eval_on_selector_all("#log li", "els => els.length")
    check("reopened panel shows the whole run", rows >= 6 and panel.inner_text("#statusText").startswith("Done"), f"{rows} rows")

    # 8: an approval asked with no panel open, answered from a panel opened later
    user.goto("about:blank")
    user.bring_to_front()
    panel.fill("#task", f"On {SITE}/checkout.html order a classic burger and a diet coke for delivery on Tuesday morning to Cambridge Ave, and place the order.")
    panel.evaluate("document.getElementById('taskForm').requestSubmit()")
    panel.wait_for_timeout(1500)
    panel.close()
    s = wait_for(lambda s: s["ask"] == "approve" or not s["running"], 240)
    check("the run asks for approval with the panel closed", s["ask"] == "approve", f"ask {s['ask']}, running {s['running']}")
    if s["ask"] == "approve":
        panel = ctx.new_page()
        panel.goto(f"chrome-extension://{ext}/sidepanel.html")
        panel.wait_for_timeout(800)
        card = panel.query_selector(".ask")
        check("a panel opened later shows the waiting approval card", bool(card) and "Approval needed" in card.inner_text())
        panel.evaluate("[...document.querySelectorAll('.ask button')].find((b) => b.textContent === 'Allow once').click()")
        s = wait_for(lambda s: not s["running"], 120)
        confirmed = any("confirmed" in pg.inner_text("body").lower() for pg in ctx.pages if pg.url.startswith(f"{SITE}/checkout"))
        check("the answer from that panel lets the run place the order", s["status"] == "done" and confirmed, f"status {s['status']}, confirmed {confirmed}")
    ctx.close()

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed" + (f"; failed: {failed}" if failed else ""))
sys.exit(1 if failed else 0)
