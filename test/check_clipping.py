"""Real Chromium regression for nested clipping and native multiselects. No model calls. Run with a Playwright Python."""
import asyncio, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright
ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
HTML = """<style>body{margin:0}button{width:100px;height:30px}.pane{position:absolute;overflow:auto;width:160px;height:100px;border:5px solid black}</style>
<div id="outer" class="pane" style="top:20px;left:20px"><div id="inner" class="pane" style="top:30px;left:10px;height:80px"><div style="height:180px"></div><button id="target" onclick="window.clicked=true">Book flight</button></div><div style="height:300px"></div></div>
<div class="pane" style="left:240px;top:20px;overflow:hidden"><button id="partial" style="position:absolute;top:85px">Partial</button></div>
<button id="covered" style="position:absolute;top:200px;left:20px">Covered</button><div style="position:fixed;top:190px;left:10px;width:150px;height:60px;background:white;z-index:5">Banner</div>
<select id="groups" multiple size="3" style="position:absolute;top:300px;left:20px" aria-label="Customer groups"><option selected>Guest</option><option>General</option><option>Wholesale</option></select>
<span style="position:absolute;left:600px;top:100px;width:1px;height:1px;overflow:hidden"><input id="tiny" type="checkbox" style="width:1px;height:1px"></span><label for="tiny" style="position:absolute;left:600px;top:150px;width:120px;height:30px">Agree</label>
<div style="position:absolute;top:400px;left:20px;width:30px;height:30px;overflow:hidden"><button id="fixed" style="position:fixed;top:500px;left:20px">Fixed outside</button></div>
"""
async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width":1280,"height":800})
        page, ctrl = await context.new_page(), await context.new_page()
        session = await context.new_cdp_session(page)
        await ctrl.expose_binding("sendCDP", lambda _, method, args: session.send(method,args))
        cdp = "\n".join(line for line in js_source(ROOT,"cdp").splitlines() if not line.startswith("import "))
        source = (js_source(ROOT,"candidates") + "\n" + cdp).replace("export ", "")
        await ctrl.evaluate("()=>{" + source + ";globalThis.tab=new Tab(1);tab.overlay=false;tab.send=(m,p={})=>sendCDP(m,p);}")
        await page.set_content(HTML)
        async def node(selector):
            doc = await session.send("DOM.getDocument", {"depth":0})
            got = await session.send("DOM.querySelector", {"nodeId":doc["root"]["nodeId"],"selector":selector})
            return (await session.send("DOM.describeNode", {"nodeId":got["nodeId"]}))["node"]["backendNodeId"]
        target, partial, covered, groups, fixed = [await node(s) for s in ["#target","#partial","#covered","#groups","#fixed"]]
        elements = await ctrl.evaluate("async()=>await tab.elements()")
        tiny = await node("#tiny")
        tiny_point = await ctrl.evaluate("n=>tab.centre(n)",tiny)
        assert tiny_point is not None, "a hidden checkbox must use its visible label geometry"
        await ctrl.evaluate("([x,y])=>tab.click(x,y)",tiny_point)
        assert await page.is_checked("#tiny")
        assert target not in [e["node"] for e in elements["els"]], "clipped button offered as on-screen"
        assert target in [e["node"] for e in elements["off"]], "clipped button must remain scrollable"
        assert await ctrl.evaluate("n=>tab.centre(n)", target) is None
        assert await ctrl.evaluate("n=>tab.centre(n)", covered) is None
        assert fixed in [e["node"] for e in elements["els"]], "viewport-fixed child escapes ordinary ancestor clipping"
        point = await ctrl.evaluate("n=>tab.centre(n)", partial)
        assert point is not None and await page.evaluate("([x,y])=>document.elementFromPoint(x,y).id",point) == "partial"
        await ctrl.evaluate("n=>tab.scrollIntoView(n)",target)
        point = await ctrl.evaluate("n=>tab.centre(n)",target)
        assert point is not None
        await ctrl.evaluate("([x,y])=>tab.click(x,y)",point)
        assert await page.evaluate("window.clicked") is True
        await ctrl.evaluate("n=>tab.selectValues(n,['General','Wholesale'])",groups)
        state = await ctrl.evaluate("n=>tab.fieldValue(n)",groups)
        assert state["selectedOptions"] == ["General","Wholesale"], state
        before = state["selectedOptions"]
        assert await ctrl.evaluate("n=>tab.selectValues(n,['Missing'])",groups) is False
        assert (await ctrl.evaluate("n=>tab.fieldValue(n)",groups))["selectedOptions"] == before
        await ctrl.evaluate("n=>tab.selectOption(n,1)",groups)
        assert (await ctrl.evaluate("n=>tab.fieldValue(n)",groups))["selectedOptions"] == before
        elements = await ctrl.evaluate("async()=>await tab.elements()")
        options = await page.query_selector_all("#groups option")
        option_nodes = [await node(f"#groups option:nth-child({i+1})") for i in range(len(options))]
        assert not set(option_nodes) & {e["node"] for e in elements["els"]}, "raw option clicks would clear a multiselect"
        print(json.dumps({"status":"pass","checks":["nested clipping","scroll then click","partial visible hit","sticky overlay","fixed escape","exact multiselect set","invalid option leaves state","additive selection","native options not clicked","external label of clipped checkbox"]}))
        await browser.close()
asyncio.run(main())
