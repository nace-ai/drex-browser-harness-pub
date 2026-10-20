"""Real Chromium: a generic ARIA slider (role=slider, aria-valuenow) and a native range input are found as sliders and set
by cdp.ts setValue. Inline page, no model calls. Run: python3 test/check_slider.py [REPO]"""
import asyncio, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright
ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
PAGE = '''<label for=range>Volume</label><input id=range type=range min=0 max=20 step=2 value=4>
<div id=aria role=slider tabindex=0 aria-label="Temperature" aria-valuemin=-10 aria-valuemax=10 aria-valuenow=0
  style="width:200px;height:20px;background:#ddd;margin:20px"></div>
<div id=price role=slider tabindex=0 aria-label="Max price" aria-valuemin=0 aria-valuemax=5000 aria-valuenow=5000
  style="width:200px;height:20px;background:#ddd;margin:20px"></div>
<script>
// a price slider in steps of 1 over thousands (student.com): Page keys move 100, Home and End go to the ends
const price=document.getElementById('price');
price.addEventListener('keydown',e=>{const v=Number(price.getAttribute('aria-valuenow'));
  const d={ArrowRight:1,ArrowUp:1,ArrowLeft:-1,ArrowDown:-1,PageUp:100,PageDown:-100}[e.key];
  const next=e.key==='Home'?0:e.key==='End'?5000:d?Math.max(0,Math.min(5000,v+d)):v;
  price.setAttribute('aria-valuenow',String(next));});
const aria=document.getElementById('aria');
aria.addEventListener('keydown',e=>{const v=Number(aria.getAttribute('aria-valuenow'));
  const next=e.key==='ArrowRight'||e.key==='ArrowUp'?Math.min(10,v+1):e.key==='ArrowLeft'||e.key==='ArrowDown'?Math.max(-10,v-1):v;
  aria.setAttribute('aria-valuenow',String(next));});
document.getElementById('range').addEventListener('change',e=>e.target.dataset.changed=e.target.value);
</script>'''
async def main():
  async with async_playwright() as p:
    browser = await p.chromium.launch(headless=True)
    page = await browser.new_page(viewport={'width': 1280, 'height': 800})
    await page.set_content(PAGE)
    session = await page.context.new_cdp_session(page)
    async def send(_source, method, params): return await session.send(method, params)
    await page.expose_binding('sendCDP', send)
    source = '\n'.join(x for x in js_source(ROOT, 'cdp').splitlines() if not x.startswith('import '))
    source = js_source(ROOT, 'candidates') + '\n' + source
    source = source.replace('export ', '') + '\nglobalThis.tab=new Tab(1);tab.overlay=false;tab.send=(m,p={})=>sendCDP(m,p);'
    await page.evaluate('()=>{' + source + '\n}')
    els = await page.evaluate('async()=> (await tab.elements()).els')
    sliders = {e['name']: e for e in els if e.get('slider')}
    assert set(sliders) >= {'Volume', 'Temperature', 'Max price'}, list(sliders)
    assert sliders['Temperature']['slider']['min'] == -10 and sliders['Temperature']['slider']['max'] == 10
    native = await page.evaluate('(n)=>tab.setValue(n,12)', sliders['Volume']['node'])
    assert native['ok'] and await page.locator('#range').get_attribute('data-changed') == '12', native
    aria = await page.evaluate('(n)=>tab.setValue(n,-3)', sliders['Temperature']['node'])
    assert aria['ok'] and await page.locator('#aria').get_attribute('aria-valuenow') == '-3', aria
    # 3,800 steps away: no longer refused as beyond a safe key bound, reached by Page keys then arrows
    far = await page.evaluate('(n)=>tab.setValue(n,1200)', sliders['Max price']['node'])
    assert far['ok'] and await page.locator('#price').get_attribute('aria-valuenow') == '1200', far
    assert far['steps'] < 60, far
    low = await page.evaluate('(n)=>tab.setValue(n,0)', sliders['Max price']['node'])
    assert low['ok'] and await page.locator('#price').get_attribute('aria-valuenow') == '0', low
    outside = await page.evaluate('(n)=>tab.setValue(n,30)', sliders['Volume']['node'])
    assert not outside['ok'], outside
    print(json.dumps({'status': 'pass', 'native': native, 'aria': aria, 'far': far, 'low': low, 'outside': outside}))
    await browser.close()
asyncio.run(main())
