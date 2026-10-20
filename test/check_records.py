"""Real Chromium: a store account page's order table is its list of records, not the longer menu of short account links
beside it (cdp.ts items), and a star rating made of visually hidden radios (clip: rect(0,0,0,0), 1x1 px) gets a click
point on its own star label that sets that rating and no other (cdp.ts elements). Inline page, no model calls.
Run: python3 test/check_records.py [REPO]"""
import asyncio, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright
ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
MENU = ''.join(f'<li><a href="#m{i}">Menu {i}</a></li>' for i in range(11))
ROWS = ''.join(f'<tr><td>0000001{i:02}</td><td>{i + 1}/2/23</td><td>${i}5.99</td><td>Complete</td>'
               f'<td><a href="#o{i}">View Order</a> <a href="#r{i}">Reorder</a></td></tr>' for i in range(10))
STARS = ''.join(f'<input type=radio name="ratings[4]" id=r{n} value={n} class=hide aria-labelledby="lab r{n}l">'
                f'<label for=r{n} id=r{n}l class=star style="width:{18 * n}px;z-index:{10 - n}"><span>{n} star</span></label>'
                for n in range(1, 6))
PAGE = f'''<style>.hide{{position:absolute;clip:rect(0,0,0,0);width:1px;height:1px;margin:-1px;overflow:hidden}}
.vote{{position:relative;height:28px;width:200px}} .star{{position:absolute;left:0;top:0;height:28px;background:#fc0;
display:block}} .star span{{position:absolute;clip:rect(0,0,0,0);width:1px;height:1px;overflow:hidden}}</style>
<main><div style="display:flex"><ul style="width:200px">{MENU}</ul>
<table><thead><tr><th>Order #</th><th>Date</th><th>Total</th><th>Status</th><th>Action</th></tr></thead>
<tbody>{ROWS}</tbody></table></div>
<form><span id=lab>Rating</span><div class=vote>{STARS}</div></form></main>'''
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
    items = await page.evaluate('async()=> (await tab.items()).map(i=>i.text)')
    assert len(items) == 10 and all('View Order' in t for t in items), items
    els = await page.evaluate('async()=> (await tab.elements()).els')
    four = [e for e in els if e.get('role') == 'radio' and '4 star' in (e.get('name') or '')]
    assert len(four) == 1, [e.get('name') for e in els if e.get('role') == 'radio']
    x1, y1, x2, y2 = four[0]['box']  # left, top, right, bottom
    await page.evaluate('([x,y])=>tab.click(x,y)', [(x1 + x2) / 2, (y1 + y2) / 2])
    checked = await page.evaluate('()=>[...document.querySelectorAll("input[type=radio]")].filter(r=>r.checked).map(r=>r.id)')
    assert checked == ['r4'], checked
    await browser.close()
  print(json.dumps({'status': 'pass', 'order_rows': len(items), 'hidden_radio_set': checked}))
asyncio.run(main())
