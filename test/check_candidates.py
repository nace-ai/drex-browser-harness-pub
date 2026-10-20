"""Real Chromium: what Tab.elements() lists on a page whose click targets the accessibility tree misses; no paid calls.
The extension reads pages through chrome.debugger, which has no DevTools command-line API (getEventListeners), so the
check withholds it too. Usage: python test/check_candidates.py [REPO]"""
import asyncio, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright

R = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
HTML = """<style>
.tile{display:inline-block;width:12px;height:12px;margin:12px} .plain{width:12px;height:12px;background:#c33}
#menu li{cursor:pointer;list-style:none;width:80px} #menu ul{display:none} #menu li:hover>ul{display:block}
</style>
<div id="tiles"><span class="tile" style="background:#e33"></span><span class="tile" style="background:#3a3"></span><span class="tile" style="background:#33e"></span></div>
<div class="plain"></div>
<div id="toggle" style="cursor:pointer;width:30px;height:14px"><input type="checkbox" style="position:absolute;opacity:0;width:0;height:0"></div>
<div id="switch" style="cursor:pointer;width:30px;height:14px"><input type="checkbox" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"></div>
<div id="away" style="cursor:pointer;width:30px;height:14px"><input type="checkbox" style="position:absolute;left:-9999px"></div>
<div id="hidden" style="cursor:pointer;width:30px;height:14px;position:relative"><input type="checkbox" aria-hidden="true" style="position:absolute;inset:0;margin:0;opacity:0;width:30px;height:14px"></div>
<div id="glass" style="background:blue;width:40px;padding:6px"><div style="cursor:pointer;width:16px;height:16px;background:rgba(255,0,0,0.5)"></div></div>
<div id="pick" style="cursor:pointer;padding:6px;width:60px;position:relative"><button>Pick</button><div style="position:absolute;top:100%;left:0"><button>Ash</button></div></div>
<div id="size" style="cursor:pointer;padding:6px;width:90px">Medium <button aria-label="Clear">x</button><ul style="display:none"><li role="option">Medium</li></ul></div>
<div id="photo" style="cursor:pointer;width:120px;height:60px;position:relative;background:url(data:image/gif;base64,R0lGODlhAQABAIAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==)"><button style="position:absolute;top:0;right:0">Delete</button></div>
<div id="photo2" style="cursor:pointer;width:120px;height:60px;position:relative;background:url(data:image/gif;base64,R0lGODlhAQABAIAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==)"><button aria-label="Delete photo" style="position:absolute;left:50px;top:20px;width:20px;height:20px"></button></div>
<div id="tinted" style="filter:hue-rotate(120deg)"><span style="display:inline-block;width:12px;height:12px;background:#ff0000;cursor:pointer"></span></div>
<div id="shade" style="filter:hue-rotate(120deg)"></div>
<button id="close" style="cursor:pointer"><span style="cursor:pointer;display:inline-block;width:10px;height:10px;background:#000"></span></button>
<ul id="menu" role="menu">
  <li><div role="menuitem" aria-haspopup="true" tabindex="-1">Jinny<span class="caret" style="cursor:pointer;display:inline-block;width:8px;height:8px;background:#000"></span></div>
    <ul role="menu"><li><div role="menuitem" tabindex="-1">Lynett</div></li></ul></li>
  <li><div role="menuitem" tabindex="-1">Olwen</div></li>
</ul>
<script>document.getElementById('shade').attachShadow({mode:'open'}).innerHTML='<span style="display:inline-block;width:12px;height:12px;background:#ff0000;cursor:pointer"></span>';
for (const t of document.querySelectorAll('.tile')) t.addEventListener('click', () => t.classList.toggle('on'));</script>"""


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        c = await b.new_context(viewport={"width": 1280, "height": 800})
        t, ctrl = await c.new_page(), await c.new_page()
        await t.route("http://fixture.test/**", lambda route: route.fulfill(content_type="text/html", body=HTML))
        await t.goto("http://fixture.test/")
        session = await c.new_cdp_session(t)
        # as under chrome.debugger: no command-line API in the page's evaluations
        await ctrl.expose_binding("sendCDP", lambda _, m, a: session.send(m, {**a, "includeCommandLineAPI": False} if m == "Runtime.evaluate" else a))
        source = js_source(R, "candidates") + "\n" + "\n".join(x for x in js_source(R, "cdp").splitlines() if not x.startswith("import "))
        await ctrl.evaluate("()=>{" + source.replace("export ", "") + ";globalThis.tab=new Tab(1);tab.overlay=false;tab.send=(m,p={})=>sendCDP(m,p);}")
        els = (await ctrl.evaluate("async()=>await tab.elements()"))["els"]
        texts = [e["text"] + (e.get("context") and f" ({e['context']})" or "") for e in els]
        tiles = [e for e in els if e["role"] == "button" and not e.get("name") and e["box"][1] < 40]
        assert len(tiles) == 3, texts  # listener-only spans, found through DOMDebugger
        assert sorted(e["grid"]["column"] for e in tiles) == [1, 2, 3], texts
        # an unlabeled tile is known by its paint: #e33 is a red hue
        assert "(color: red, hsl(0 85% 57%))" in min(tiles, key=lambda e: e["box"][0])["state"], [e["state"] for e in tiles]
        # a painted div without a listener (.plain, #c33) is not a target
        assert not any("hsl(0 60% 50%)" in e.get("state", "") for e in els) and len(els) == 19, texts
        # a padded wrapper around a button and its open popup below is not a third target named after the popup
        assert not any("Pick" in e["text"] and "Ash" in e["text"] for e in els), texts
        # a closed list's hidden option does not erase the wrapper's own label: the select stays a target beside its Clear
        assert any(e.get("name", "").startswith("Medium") for e in els), texts
        # a nameless icon button is not in the accessibility tree's list: its pointer-styled icon is the click target
        assert any(e["role"] != "menuitem" and "black" in e.get("state", "") for e in els), texts
        # a toggle wrapper whose checkbox is 0x0, an sr-only 1x1 or moved off screen gets no box for the checkbox: the wrapper
        # is the target, and so is one whose checkbox covers it but is aria-hidden; a translucent swatch has no color named
        assert sum(1 for e in els if e["role"] != "menuitem" and not e.get("name")) == 11, texts
        # a photo tile around its Delete button is that button again, not a second target: listed under its own name or
        # none, a click on its centre could land on the Delete (#photo2: an icon-only one in the middle) with no approval
        assert sum(1 for e in els if e.get("name") == "Delete") == 1, texts
        assert sum(1 for e in els if e.get("name") == "Delete photo") == 1, texts
        # nothing else listed covers either button's centre
        for d in [e for e in els if e.get("name") in ("Delete", "Delete photo")]:
            cx, cy = (d["box"][0] + d["box"][2]) / 2, (d["box"][1] + d["box"][3]) / 2
            assert not any(e is not d and e["box"][0] <= cx <= e["box"][2] and e["box"][1] <= cy <= e["box"][3] for e in els), texts
        # a red swatch under a hue-rotate filter shows green: no color is named, nor inside a filtered shadow host
        assert not any("hsl(0 100% 50%)" in e.get("state", "") for e in els), texts
        assert not any("hsl(0 100% 50%)" in e.get("state", "") for e in els), texts
        menu = {e["name"]: e for e in els if e["role"] == "menuitem"}
        assert set(menu) == {"Jinny", "Olwen"}, texts  # no pointer-styled <li> or caret as a second "Jinny"
        assert menu["Jinny"].get("submenu") is True and "(has a submenu)" in menu["Jinny"]["state"], menu["Jinny"]
        assert not menu["Olwen"].get("submenu"), menu["Olwen"]
        x0, y0, x1, y1 = menu["Jinny"]["box"]
        await ctrl.evaluate("async([x,y])=>await tab.hover(x,y)", [(x0 + x1) / 2, (y0 + y1) / 2])
        after = [e["name"] for e in (await ctrl.evaluate("async()=>await tab.elements()"))["els"] if e["role"] == "menuitem"]
        assert "Lynett" in after, after  # pointing at it opened the submenu
        print(json.dumps({"status": "pass", "tiles": len(tiles), "menu": sorted(menu), "after_hover": after}))
        await b.close()


asyncio.run(main())
