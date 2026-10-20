"""Real Chromium: at the end of a run, evidence.ts revealAnswer closes a newsletter pop-up over the answer (not one
that reports an added cart item) and scrolls the answer into view; no paid calls. Usage: python test/check_evidence.py [REPO]"""
import asyncio, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright

R = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
ARTICLE = """<h1>Vivitrol dosage</h1><div style="height:2400px">Long introduction</div>
<p id="dose">The usual dose is 380 mg once a month.</p>
<div id="pop" style="position:fixed;left:200px;top:150px;width:600px;height:400px;background:#fff">
  Sign up for our newsletter <input type="email"><button aria-label="Close">x</button></div>"""
CART = """<p>Item 380 mg</p><div style="position:fixed;left:200px;top:150px;width:600px;height:400px;background:#fff" role="dialog">
  Added to cart! <button>Close</button></div>"""
# a "No thanks" that submits the newsletter form, and a "Close" that is a link to another page, are not closers
FORM = """<p>380 mg</p><div style="position:fixed;left:200px;top:150px;width:600px;height:400px;background:#fff">
  <form>Sign up for our newsletter <input type="email"><button>No thanks</button><a href="/other">Close</a></form></div>"""
# a fixed page shell full of the page's own text is not a pop-up, and an invitation's Decline is not a consent's
SHELL = ("<div style='position:fixed;inset:0;overflow:auto'>Notifications " + "Calendar entry text. " * 100 +
         "<button>Decline</button></div>")
# an invitation's pop-up links its Privacy Policy too: its Decline answers the invitation
INVITE = """<p>380 mg</p><div role="dialog" style="position:fixed;left:200px;top:150px;width:600px;height:400px;background:#fff">
  Join our team on Acme. See our Privacy Policy. <button>Accept</button><button>Decline</button></div>"""

# a second pop-up laid over the newsletter's Close would take the click: the Close is not offered
COVERED = """<p>380 mg</p><div style="position:fixed;left:200px;top:150px;width:600px;height:400px;background:#fff">
  Sign up for our newsletter <button aria-label="Close" style="position:absolute;right:0;top:0">x</button></div>
  <div style="position:fixed;left:100px;top:100px;width:800px;height:500px;background:#eee">
  Delete your account? <button>Delete</button></div>"""


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        page = await b.new_page(viewport={"width": 1280, "height": 800})
        source = js_source(R, "evidence").replace("export ", "")
        reveal = lambda tokens, scroll: page.evaluate(f"(() => {{ {source}; return revealAnswer({json.dumps(tokens)}, {str(scroll).lower()}); }})()")
        await page.set_content(ARTICLE)
        first = await reveal(["380 mg"], False)
        assert first["closer"] and first["closerName"] == "Close" and not first["visible"], first
        await page.mouse.click(*first["closer"])
        await page.evaluate("document.getElementById('pop').remove()")  # the site's close handler
        second = await reveal(["380 mg"], True)
        assert second["closer"] is None and second["scrolled"] == "380 mg", second
        top = await page.evaluate("document.getElementById('dose').getBoundingClientRect().top")
        assert 0 < top < 800, top
        again = await reveal(["380 mg"], True)
        assert again["visible"] and again["scrolled"] == "", again
        await page.set_content(CART)
        cart = await reveal(["380 mg"], True)
        assert cart["closer"] is None, cart  # a pop-up that reports what the run did is evidence
        await page.set_content(FORM)
        form = await reveal(["380 mg"], False)
        assert form["closer"] is None, form
        await page.set_content(SHELL)
        shell = await reveal([], False)
        assert shell["closer"] is None, shell
        await page.set_content(INVITE)
        invite = await reveal([], False)
        assert invite["closer"] is None, invite
        await page.set_content(COVERED)
        covered = await reveal([], False)
        assert covered["closer"] is None, covered
        await b.close()
    print(json.dumps({"status": "pass", "first": first, "second": second, "cart": cart}))


asyncio.run(main())
