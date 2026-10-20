"""Real Chromium: what the approval gate finds under a screen point (point-target.ts, read with the mouse already
there) and what logic.ts pointRisk makes of it; no paid calls. Usage: python test/check_point_target.py [REPO]"""
import asyncio, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright

R = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw=="
HTML = f"""<style>
div,button,span{{box-sizing:border-box}} .row{{position:absolute;left:10px;height:40px}}
#reveal button{{display:none}} #reveal:hover button{{display:block}}
</style>
<ul role="listbox" class="row" style="top:10px;margin:0;padding:0"><li role="option" style="list-style:none;width:120px;height:30px"><span>1 year</span></li></ul>
<a class="row" href="#quiz" style="top:60px;display:block;width:120px;height:30px"><img src="{GIF}" alt="" style="width:20px;height:20px"><span>Multiplication</span></a>
<div class="row" style="top:110px;width:120px;height:60px;cursor:pointer;background:url({GIF})"><button aria-label="Delete photo" style="position:absolute;left:50px;top:20px;width:20px;height:20px"></button></div>
<div id="reveal" class="row" style="top:180px;width:120px;height:60px;cursor:pointer;background:url({GIF})"><button aria-label="Delete" style="position:absolute;left:50px;top:20px;width:20px;height:20px"></button></div>
<button class="row btn-trash" style="top:250px;width:30px;height:30px"><svg width="16" height="16"><rect width="16" height="16"/></svg></button>
<form class="row" style="top:290px" onsubmit="return false"><input type="email" value="someone@example.com" style="width:150px"><button style="width:30px;height:30px">&rarr;</button></form>
<form class="row" style="top:340px" onsubmit="return false"><input type="search" value="mp4" style="width:150px"><button style="width:30px;height:30px">Go</button></form>
<iframe class="row" style="top:390px;width:120px;height:40px" srcdoc="<button>Pay</button>"></iframe>
<button class="row filter-chip-remove" style="top:440px;width:120px;height:30px" aria-label="Remove filter">x</button>
<iframe class="row" style="top:520px;left:10px;width:300px;height:40px;border:0" srcdoc="<body style='margin:0'><button style='width:140px;height:30px'>Multiplication</button><button aria-label='Delete account' style='width:140px;height:30px'>&#128465;</button></body>"></iframe>
<div class="row" style="top:480px;width:200px;height:30px"><button>Check in / Check out Anytime</button></div>
<div class="row" style="top:570px;width:300px;height:30px">
<button class="MuiIconButton-root js-sortable" style="position:absolute;left:0;width:30px;height:30px"><svg data-testid="DeleteIcon" width="16" height="16"><rect width="16" height="16"/></svg></button>
<div class="tile" style="position:absolute;left:40px;width:30px;height:30px"><svg class="fa-trash" width="30" height="30"><rect width="30" height="30"/></svg></div>
<form onsubmit="return false" style="position:absolute;left:80px"><input type="submit" value="Place your order" style="width:150px;height:30px"></form>
<button class="css-1x9ab" style="position:absolute;left:240px;width:30px;height:30px"><svg width="16" height="16"><rect width="16" height="16"/></svg></button>
</div>
<a class="row" href="#photo/1" style="top:610px;display:block;width:120px;height:80px;background:url({GIF})"><span>Photo, Oct 3</span><div class="x9f2" style="position:absolute;right:4px;top:4px;width:20px;height:20px"><svg width="20" height="20"><rect width="20" height="20"/></svg></div></a>
<div class="row" style="top:10px;left:400px;width:120px;height:80px;background:url({GIF})"><a href="#photo/4" style="display:block;width:120px;height:80px">Photo, Oct 4</a><div class="x9f" style="position:absolute;right:4px;top:4px;width:24px;height:24px"><svg width="24" height="24"><rect width="24" height="24"/></svg></div></div>
<a class="row" href="#photo/5" style="top:100px;left:400px;display:block;width:200px;height:80px"><span>Photo, Oct 5</span><div style="position:absolute;left:0;top:0;width:200px;height:32px"><div class="k3q" style="width:24px;height:24px"><svg width="24" height="24"><rect width="24" height="24"/></svg></div></div></a>
<div class="row" style="top:190px;left:400px;width:120px;height:80px"><span>Photo, Oct 6</span><div onclick="" style="position:absolute;right:4px;top:4px;width:24px;height:24px"><svg width="16" height="16"><rect width="16" height="16"/></svg></div></div>
<div class="row" style="top:280px;left:400px;width:200px;height:120px;background:url({GIF})"><canvas width="200" height="120"></canvas></div>
<a class="row" href="#photo/7" style="top:410px;left:400px;display:block;width:120px;height:80px"><span>Photo, Oct 7</span><span style="position:absolute;right:4px;top:4px;width:24px;height:24px">&#128465;</span></a>
<a class="row" href="#photo/8" style="top:500px;left:400px;display:block;width:120px;height:80px"><span>Photo, Oct 8</span><span class="material-icons" style="position:absolute;right:4px;top:4px;width:24px;height:24px;overflow:hidden;font-size:8px">delete_outline</span></a>
<table class="row" style="top:590px;left:400px;width:300px;border-collapse:collapse"><tr onclick="" style="height:30px"><td>Report.pdf</td><td style="width:30px"><div class="z8" style="width:24px;height:24px"><svg width="24" height="24"><rect width="24" height="24"/></svg></div></td></tr></table>
<a class="row" href="#photo/9" style="top:630px;left:400px;display:grid;width:120px;height:80px"><img src="{GIF}" alt="" style="grid-area:1/1;width:120px;height:80px"><div class="q1" style="grid-area:1/1;justify-self:end;width:24px;height:24px"><svg width="24" height="24"><rect width="24" height="24"/></svg></div></a>
<form class="row" style="top:700px" method="post" onsubmit="return false"><input type="hidden" name="id" value="42"><button style="width:120px;height:30px">Confirm</button></form>
<div role="dialog" style="position:fixed;left:750px;top:10px;width:300px;height:80px;background:#fff">We use cookies to improve your visit. <button style="position:absolute;right:10px;top:10px;width:24px;height:24px"></button></div>
<div class="row" aria-label="Back" style="top:110px;left:750px;width:40px;height:40px"><svg width="24" height="24"><rect width="24" height="24"/></svg></div>
<div class="row" role="application" aria-label="Map" style="top:170px;left:750px;width:200px;height:120px"><div style="position:absolute;left:50px;top:50px;width:16px;height:16px;background:#c00"></div></div>
<a class="row" href="#results" style="top:320px;left:750px;width:120px;height:40px;display:block">Results</a>
<div data-drex="cursor" style="position:fixed;left:750px;top:320px;width:40px;height:40px;background:#000"><span>Drex</span></div>
<uc-layer style="position:fixed;display:block;left:750px;top:500px;width:300px;height:60px"></uc-layer>
<script>const ucHost=document.querySelector('uc-layer').attachShadow({{mode:'open'}});ucHost.innerHTML='<div style="position:relative;width:300px;height:60px">We use cookies. <uc-button style="position:absolute;left:10px;top:20px;display:block;width:120px;height:24px"><p style="margin:0">Required Only</p></uc-button></div>';</script>
<div role="dialog" style="position:fixed;left:750px;top:400px;width:300px;height:80px;background:#fff">We use cookies. <button aria-label="Delete my account" style="position:absolute;right:10px;top:10px;width:24px;height:24px"></button></div>
<div style="position:fixed;left:750px;top:600px;width:300px;height:60px;background:#fff">Your cart: Chocolate chip cookies $5.00 <button class="k9" style="position:absolute;right:10px;top:10px;width:24px;height:24px"><svg width="16" height="16"><rect width="16" height="16"/></svg></button></div>
<ul role="listbox" style="position:absolute;left:750px;top:680px;margin:0;padding:0"><li role="option" style="list-style:none;width:160px;height:30px">Delete conversation</li></ul>
<a class="row" href="#item/2" style="top:700px;left:200px;display:block;width:120px;height:80px"><span>Lamp</span><span style="position:absolute;right:4px;top:4px">New</span></a>
"""
CARD = """<input autocomplete="cc-number" style="position:absolute;left:10px;top:10px"><button style="position:absolute;left:10px;top:50px;width:120px;height:30px">Continue</button>"""


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        page = await b.new_page(viewport={"width": 1280, "height": 800})
        await page.route("http://fixture.test/**", lambda route: route.fulfill(
            content_type="text/html", body=CARD if route.request.url.endswith("/card") else HTML))
        probe = js_source(R, "point-target").replace("export ", "")
        risk = js_source(R, "logic")
        await page.goto("http://fixture.test/")

        async def at(x, y):  # as Tab.pointTarget: the mouse goes there first, then the page is read
            await page.mouse.move(x, y)
            await page.wait_for_timeout(100)
            t = await page.evaluate(f"(() => {{ {probe}; return pointTargetAt({x}, {y}); }})()")
            return t

        async def gate(t):  # logic.ts's own pointRisk, loaded as a module
            return await page.evaluate(
                "async ([src, t]) => (await import('data:text/javascript,' + encodeURIComponent(src))).pointRisk(t)", [risk, t])

        out = {}
        for name, (x, y) in {"range option": (40, 25), "quiz tile": (60, 75), "photo delete": (70, 140),
                             "hover-revealed delete": (70, 210), "trash icon": (25, 265), "newsletter submit": (175, 305),
                             "search submit": (175, 355), "iframe": (60, 410), "remove filter": (60, 455),
                             "date picker": (60, 495), "same-origin frame tile": (80, 535),
                             "same-origin frame delete": (220, 535), "camelCase icon delete": (15, 585),
                             "icon class on the way up": (55, 585), "submit input": (150, 585),
                             "nameless icon button": (255, 585), "icon over a photo tile": (116, 624),
                             "labelled badge on a tile": (305, 714), "post confirm": (60, 715),
                             "icon beside a photo link": (502, 26), "icon in a hover toolbar": (412, 112),
                             "nameless onclick icon": (502, 206), "map canvas": (500, 340),
                             "emoji delete over a tile": (504, 424), "ligature delete over a tile": (504, 514),
                             "icon in a clickable row": (685, 605), "icon stacked in a grid tile": (504, 640),
                             "consent banner close": (1028, 32), "named back icon": (770, 130),
                             "map marker": (808, 228), "link under the agent's cursor": (765, 335),
                             "consent banner delete": (1028, 422), "consent manager in a shadow root": (820, 532), "cookie mini cart trash": (1028, 622), "delete option": (800, 695)}.items():
            t = await at(x, y)
            out[name] = {"target": t, "risk": await gate(t)}
        await page.goto("http://fixture.test/card")
        t = await at(60, 65)
        out["card page"] = {"target": t, "risk": await gate(t)}
        await b.close()
    harmless = ["consent manager in a shadow root", "consent banner close", "named back icon", "map marker", "link under the agent's cursor", "range option", "quiz tile", "search submit", "remove filter", "date picker", "same-origin frame tile",
                "labelled badge on a tile", "map canvas"]
    risky = ["cookie mini cart trash", "delete option", "consent banner delete", "photo delete", "hover-revealed delete", "trash icon", "newsletter submit", "iframe", "card page",
             "same-origin frame delete", "camelCase icon delete", "icon class on the way up", "submit input",
             "nameless icon button", "post confirm", "icon over a photo tile", "icon beside a photo link", "icon in a hover toolbar",
             "nameless onclick icon", "emoji delete over a tile", "ligature delete over a tile",
             "icon in a clickable row", "icon stacked in a grid tile"]
    bad = {k: v for k, v in out.items() if (k in harmless and v["risk"]) or (k in risky and not v["risk"])}
    assert not bad, json.dumps(bad, indent=1)
    print(json.dumps({"status": "pass", "risks": {k: v["risk"] for k, v in out.items()}}, indent=1))


asyncio.run(main())
