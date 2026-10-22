"""Real Chromium: at the end of a run, evidence.ts revealAnswer closes a newsletter pop-up over the answer (not one
that reports an added cart item) and scrolls the answer into view; revealFacts (the revealEvidence switch) finds a fact
split across elements, scrolls one at the screen's edge or under a sticky banner to the middle, and reports a date
picker left open over it (closed with Escape) but never an "Added to your cart" dialog; inline pages modelled on the
reveal diagnostic's runs, no paid calls. Usage: python test/check_evidence.py [REPO]"""
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

# revealEvidence fixtures (docs/research/2026-10-21-reveal-diagnostic.md). The number and its unit in separate elements,
# below the fold (2207bb4f-1: no single text node holds "13 km")
SPLIT = """<h1>Calgary</h1><div style="height:1500px">Hourly forecast</div>
<div id="wind"><div>Wind</div><div><span>13</span><div>km/h</div></div><div>S</div></div>
<div style="height:1500px">Seven-day forecast</div>"""
# the travel time's row at ~88% of the screen, its route below the edge (ba01ea55-1)
EDGE = """<div style="height:700px">Routes from the hotel</div><div id="row" style="height:40px">12:09 AM (Wednesday) 42 min</div>
<div style="height:40px">Q70-SBS</div><div style="height:1500px">More routes</div>"""
# the price row inside the viewport but under a sticky banner (c7c07ec1-2)
STICKY = """<div id="banner" style="position:sticky;top:0;height:140px;background:#fc0;z-index:5">Switch and save today</div>
<div style="height:900px">Plans</div><div id="price" style="font-size:24px">$180 /mo</div><div style="height:1500px">FAQ</div>"""
# the fact ($180) under the sticky banner while a minor value ($35) shows in the band (the Verizon run)
MINOR = """<div id="banner" style="position:sticky;top:0;height:140px;background:#fc0;z-index:5">Switch and save today</div>
<div style="height:900px">Plans</div><div id="price" style="font-size:24px">$180 /mo</div><div id="minor" style="margin-top:300px">$35 activation</div><div style="height:1500px">FAQ</div>"""
# a date picker the run's last moves opened over the notice, its field focused; Escape in the field closes it (c09721cc-1)
NOTICE = "Availability is not yet released. Check back on January 10, 2027"
PICKER = f"""<label>Start date <input id="start" aria-label="month, Start Date"></label><div style="height:200px"></div>
<p id="notice">{NOTICE}</p><button disabled>Next Available</button>
<div id="cal" role="dialog" aria-label="Choose a date" style="position:absolute;left:60px;top:150px;width:520px;height:380px;background:#fff">
  <table role="grid"><tr><td>1</td><td>2</td><td>3</td></tr></table></div>
<script>document.getElementById('start').addEventListener('keydown', (e) => {{
  if (e.key === 'Escape') document.getElementById('cal').remove(); }}); document.getElementById('start').focus();</script>"""
# an "Added to your cart" dialog and a listbox both open: the cart dialog is evidence, and Escape (which this page lets
# close both) is never sent while it is open
CART_DIALOG = f"""<p id="notice">{NOTICE}</p>
<div id="cart" role="dialog" style="position:fixed;left:300px;top:200px;width:600px;height:300px;background:#fff">
  Added to your cart! Boston clog, size 10</div>
<div id="menu" role="listbox" style="position:absolute;left:200px;top:300px;width:300px;height:200px;background:#eee">Sort by</div>
<script>document.addEventListener('keydown', (e) => {{ if (e.key === 'Escape')
  for (const id of ['cart', 'menu']) document.getElementById(id).remove(); }});</script>"""
# the same picker open beside the notice, which is in view: it hides nothing, so the agent sends no Escape
PICKER_ASIDE = f"""<div style="height:180px">Campground</div><p id="notice">{NOTICE}</p><div style="height:1200px"></div>
<div id="cal" role="dialog" aria-label="Choose a date" style="position:absolute;left:700px;top:250px;width:420px;height:380px;background:#fff">
  <table role="grid"><tr><td>1</td><td>2</td></tr></table></div>"""
# an "Added to your cart" pop-up with no dialog role (a fixed box, as revealAnswer's overlays) beside a floating listbox,
# the notice hidden below: the pop-up is evidence, so no picker is reported and no Escape sent
CART_FIXED = f"""<div style="height:1200px">Clogs</div><p id="notice">{NOTICE}</p>
<div id="cart" style="position:fixed;left:300px;top:200px;width:600px;height:300px;background:#fff">
  Added to your cart! Boston clog, size 10</div>
<div id="menu" role="listbox" style="position:absolute;left:200px;top:300px;width:300px;height:200px;background:#eee">Sort by</div>
<script>document.addEventListener('keydown', (e) => {{ if (e.key === 'Escape')
  for (const id of ['cart', 'menu']) document.getElementById(id).remove(); }});</script>"""
# focus inside a modal holding the answer (no cart or order words) and a listbox floating beside it: Escape would close
# the modal, not the listbox, so none is reported while the focus is there
MODAL_FOCUS = """<div style="height:1200px">Plans</div><p id="faq">$180 /mo without Auto Pay</p>
<div id="modal" role="dialog" style="position:fixed;left:150px;top:120px;width:500px;height:300px;background:#fff">
  Unlimited, 4 lines: $180 /mo <button id="ok">Got it</button></div>
<div id="menu" role="listbox" style="position:absolute;left:700px;top:250px;width:300px;height:200px;background:#eee">Lines</div>
<script>document.getElementById('ok').focus();</script>"""
# suggestions open under a search field holding the run's query: Escape would clear the query, so none is reported
SEARCH = """<input id="q" type="search" value="brown clogs"><ul role="listbox" style="position:absolute;left:100px;top:150px;
  width:600px;height:300px;background:#eee"><li>brown clogs men</li></ul><script>document.getElementById('q').focus();</script>"""


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

        # revealEvidence: revealFacts as cdp.ts REVEAL_FN calls it (logic.ts normalizeLiteral, revealAnswer as the
        # pop-up closer), its literals from logic.ts revealLiterals on the final read's evidence
        logic = js_source(R, "logic").replace("export ", "")
        scope = "const L = (() => {" + logic + "\nreturn { normalizeLiteral, revealLiterals }; })();\n" + source
        async def close_if_needed(look):
            """The agent's revealCited: Escape and a blur only for a picker the page reports while a literal is on the
            page but not in view (every one in view, or none on the page: the picker stays)."""
            if look["picker"] and any(w in ("occluded", "off_screen") for w in look["found"].values()):
                await page.keyboard.press("Escape")  # Tab.key: to the focused element
                await facts([], blur=True)
                return True
            return False
        literals = lambda evidence, answer="": page.evaluate(
            f"(() => {{ {scope}; return L.revealLiterals({json.dumps(evidence)}, {json.dumps(answer)}); }})()")
        facts = lambda lits, scroll=False, blur=False, main=None: page.evaluate(
            f"(() => {{ {scope}; return revealFacts({json.dumps(lits)}, {{ scroll: {str(scroll).lower()}, "
            f"blur: {str(blur).lower()}" + (f", main: {json.dumps(main)}" if main else "") + f" }}, L.normalizeLiteral, revealAnswer); }})()")
        middle = lambda id: page.evaluate(
            f"(() => {{ const r = document.getElementById('{id}').getBoundingClientRect(); return r.top >= 120 && r.bottom <= 680; }})()")
        out = {}

        # test_split_node_literal_found_and_scrolled
        await page.set_content(SPLIT)
        lits = await literals("Today's Conditions shows 'Wind 13 km/h S'.", "The wind is 13 km/h from the south.")
        assert lits == ["Wind 13 km/h S", "13 km/h", "13 km"], lits
        old = await reveal(["13 km"], True)
        assert old["scrolled"] == "" and old["found"] == {"13 km": "none"}, old  # the diagnosed cause: no single node
        split = out["split"] = await facts(lits, scroll=True)
        assert split["found"] == {l: "off_screen" for l in lits} and split["scrolled"] == lits[0], split
        assert await middle("wind")
        again = out["split_again"] = await facts(lits, scroll=True)
        assert again["found"]["13 km/h"] == "in_view" and again["scrolled"] == "", again

        # test_literal_at_88_percent_scrolled_to_centre
        await page.set_content(EDGE)
        await page.evaluate("scrollTo(0, 0)")  # a new page's content keeps the last one's scroll
        lits = await literals("The fastest route shows '42 min' on the Q70-SBS bus")
        assert lits == ["42 min"], lits
        top = await page.evaluate("document.getElementById('row').getBoundingClientRect().top / innerHeight")
        assert 0.85 < top < 0.9, top
        old = await reveal(lits, True)
        assert old["visible"] and old["scrolled"] == "", old  # the diagnosed cause: in the viewport counted as shown
        edge = out["edge"] = await facts(lits, scroll=True)
        assert edge["found"] == {"42 min": "off_screen"} and edge["scrolled"] == "42 min", edge
        centre = await page.evaluate("(() => { const r = document.getElementById('row').getBoundingClientRect(); return (r.top + r.bottom) / 2 / innerHeight; })()")
        assert 0.45 < centre < 0.55, centre

        # test_literal_under_sticky_banner_occluded_and_scrolled_clear
        await page.set_content(STICKY)
        await page.evaluate("scrollTo(0, 0)")
        await page.evaluate("scrollTo(0, document.getElementById('price').getBoundingClientRect().top + scrollY - 60)")
        lits = await literals("Without Auto Pay the price row shows $180/mo")
        assert lits == ["$180"], lits
        old = await reveal(lits, True)
        assert old["visible"] and old["scrolled"] == "", old  # the diagnosed cause: under the banner counted as shown
        sticky = out["sticky"] = await facts(lits, scroll=True)
        assert sticky["found"] == {"$180": "occluded"} and sticky["scrolled"] == "$180", sticky
        assert await middle("price")
        clear = await facts(lits)
        assert clear["found"] == {"$180": "in_view"}, clear

        # test_main_literal_occluded_scrolled_though_minor_in_view
        await page.set_content(MINOR)
        await page.evaluate("scrollTo(0, 0)")
        await page.evaluate("scrollTo(0, document.getElementById('price').getBoundingClientRect().top + scrollY - 60)")
        lits = ["$180", "$35"]
        before = await facts(lits)
        assert before["found"] == {"$180": "occluded", "$35": "in_view"}, before
        stuck = await facts(lits, scroll=True)
        assert stuck["scrolled"] == "", stuck  # no main named: a literal in view stops the scroll, as before
        main = out["main"] = await facts(lits, scroll=True, main="$180")
        assert main["scrolled"] == "$180", main
        assert await middle("price")
        assert (await facts(lits))["found"]["$180"] == "in_view"
        again = await facts(lits, scroll=True, main="$180")
        assert again["scrolled"] == "", again

        # test_open_picker_closed_with_escape_cart_dialog_kept
        await page.set_content(PICKER)
        await page.evaluate("scrollTo(0, 0)")
        lits = await literals(f'The info notice says "{NOTICE}" and the Next Available button is disabled')
        assert lits == [NOTICE], lits
        look = out["picker"] = await facts(lits)
        assert look["picker"] == "dialog 'Choose a date'" and look["found"] == {NOTICE: "occluded"}, look
        assert await close_if_needed(look)  # the notice is on the page but under the picker
        closed = out["picker_closed"] = await facts(lits, scroll=True)
        assert closed["picker"] == "" and closed["found"] == {NOTICE: "in_view"} and closed["scrolled"] == "", closed
        assert await page.evaluate("document.activeElement === document.body")
        # the picker beside a notice in view: reported, but it hides nothing, so no Escape and it stays open
        await page.set_content(PICKER_ASIDE)
        await page.evaluate("scrollTo(0, 0)")
        aside = out["picker_aside"] = await facts(lits)
        assert aside["picker"] == "dialog 'Choose a date'" and aside["found"] == {NOTICE: "in_view"}, aside
        assert not await close_if_needed(aside)
        assert await page.evaluate("!!document.getElementById('cal')")
        # cart pop-ups are evidence, with a dialog role or as a fixed box: the notice is hidden, yet no picker is
        # reported beside them, no Escape is sent, and both stay
        await page.set_content(CART_DIALOG)
        await page.evaluate("scrollTo(0, 0)")
        kept = out["cart_dialog"] = await facts(lits, scroll=True)
        assert kept["picker"] == "", kept
        # the notice at the top of a page too short to scroll: outside the band, but no scroll is claimed
        assert kept["found"] == {NOTICE: "off_screen"} and kept["scrolled"] == "", kept
        assert not await close_if_needed(kept)
        assert await page.evaluate("!!document.getElementById('cart') && !!document.getElementById('menu')")
        await page.set_content(CART_FIXED)
        await page.evaluate("scrollTo(0, 0)")
        fixed = out["cart_fixed"] = await facts(lits)
        assert fixed["picker"] == "" and fixed["found"] == {NOTICE: "off_screen"}, fixed
        assert not await close_if_needed(fixed)
        assert await page.evaluate("!!document.getElementById('cart') && !!document.getElementById('menu')")
        # focus in a modal holding the answer: no picker while it is there (the hidden FAQ line makes one needed)
        await page.set_content(MODAL_FOCUS)
        await page.evaluate("scrollTo(0, 0)")
        lits = await literals("The modal says '$180 /mo' for 4 lines; the FAQ says '$180 /mo without Auto Pay'")
        modal = out["modal_focus"] = await facts(lits)
        assert modal["picker"] == "" and "off_screen" in modal["found"].values(), modal
        assert not await close_if_needed(modal)
        assert await page.evaluate("!!document.getElementById('modal')")
        await page.evaluate("document.getElementById('ok').blur()")
        assert (await facts(lits))["picker"] == "listbox 'Lines'"  # the same listbox, the focus on the page
        await page.set_content(SEARCH)
        search = await facts([])
        assert search["picker"] == "", search
        await page.evaluate("document.getElementById('q').blur()")
        assert (await facts([]))["picker"] == "listbox 'brown clogs men'"  # the same listbox, the field not focused
        await b.close()
    print(json.dumps({"status": "pass", "first": first, "second": second, "cart": cart, **out}))


asyncio.run(main())
