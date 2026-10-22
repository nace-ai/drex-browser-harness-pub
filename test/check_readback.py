"""Real Chromium: cdp.ts Tab.readBack finds where a page shows a setting step's values applied (a filter chip with a
remove control, a pressed sort button, a select's chosen option, a query value of the address, a category heading) and
misses the ones it doesn't show (a combobox holding another value, a word inside a longer query value, a state only a
Tailwind variant class names, a link next to "Clearance", a class that only starts with a state word: current-price);
a state class counts whole (active, is-active, tab--selected); inline pages modelled on the failing runs and on review
round 1, no model calls. Run: python3 test/check_readback.py [REPO]"""
import asyncio, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright
ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
SITE = 'http://readback.test'
# a job search with the Legal category applied as a chip (and Legal in a result's text, which is not a chip)
CHIP = '''<p>Jobs</p><div class="filters"><span class="chip">Legal<button aria-label="Remove">×</button></span></div>
<ul><li>Remote paralegal at Acme</li></ul>'''
SORT = '''<div role="group" aria-label="Sort by"><button aria-pressed="false">Relevance</button>
<button aria-pressed="true">Price ascending</button></div>'''
SELECT = '''<label>Unit size <select><option>Small (studio)</option><option selected>Medium (1-2 bedroom)</option>
<option>Large (3+ bedroom)</option></select></label>'''
RESULTS = '<p>Results for cookies</p>'
CATEGORY = '<nav><a href="/">Home</a></nav><h1>Cabinets, Racks &amp; Shelves</h1><p>24 products</p>'
# "Legal" typed into the category combobox but not picked: the box holds another value, the option is in a closed list
COMBO = '''<label for="c">Category</label><input id="c" role="combobox" value="Business and Financial Operations">
<ul role="listbox" hidden><li role="option">Legal</li><li role="option">Business and Financial Operations</li></ul>'''
# not applied, though a class or a neighbour's word reads so: Tailwind variant classes (data-[state=active]:,
# peer-checked:, active:) style a state the element is not in, and "Clearance" or "Closet" removes nothing
NOT_APPLIED = [
  ('radix tab', '''<div role="tablist"><button role="tab" aria-selected="false" data-state="inactive"
    class="px-3 data-[state=active]:bg-white">Reviews</button><button role="tab" aria-selected="true"
    data-state="active">Details</button></div>''', 'Reviews'),
  ('peer-checked label', '''<input type="checkbox" id="ft" class="peer"><label for="ft"
    class="rounded peer-checked:bg-blue-500">Full-time</label>''', 'Full-time'),
  ('active: button', '<button class="px-2 py-1 active:bg-gray-100">Newest</button>', 'Newest'),
  ('clearance link', '<nav><a href="/men">Men</a><a href="/clearance">Clearance</a></nav>', 'Men'),
  ('closet link', '''<nav><a href="/c/cabinets">Cabinets, Racks &amp; Shelves</a><a href="/c/closet">Closet
    Organizers</a></nav>''', 'Cabinets, Racks & Shelves'),
  # a state word starting a longer class name names a part, not a state: the current price, a selected-item card
  ('current-price', '<div class="product"><span class="current-price">$180</span></div>', '$180'),
  ('selected-item', '<div class="selected-item">Full-time</div>', 'Full-time'),
  ('active-tab-content', '<section class="active-tab-content"><p>Newest</p></section>', 'Newest'),
]
# applied by a class that is the state itself: a bare state word, is-/has- before it, a BEM modifier after it
STATE_CLASS = [
  ('active', '<nav><a href="/new" class="tab active">Newest</a><a href="/top" class="tab">Top</a></nav>', 'Newest'),
  ('is-active', '<ul><li class="facet is-active">Full-time</li><li class="facet">Part-time</li></ul>', 'Full-time'),
  ('tab--selected', '''<div><span class="tab tab--selected">Reviews</span><span class="tab">Details</span>
    </div>''', 'Reviews'),
]


async def main():
  async with async_playwright() as p:
    browser = await p.chromium.launch(headless=True)
    page = await browser.new_page(viewport={'width': 1280, 'height': 800})
    served = {}
    await page.route(SITE + '/**', lambda route: route.fulfill(content_type='text/html; charset=utf-8', body=served['html']))
    session = await page.context.new_cdp_session(page)
    async def send(_source, method, params): return await session.send(method, params)
    await page.expose_binding('sendCDP', send)
    # cdp.ts as the extension runs it: normalizeLiteral from logic.ts (in a scope of its own), candidates.ts and
    # evidence.ts (as check_evidence.py loads it), a Tab whose CDP calls go to this page
    logic = js_source(ROOT, 'logic').replace('export ', '')
    cdp = '\n'.join(x for x in js_source(ROOT, 'cdp').splitlines() if not x.startswith('import '))
    source = ('globalThis.normalizeLiteral = (() => {' + logic + '\nreturn normalizeLiteral; })();\n' +
              js_source(ROOT, 'candidates') + '\n' + js_source(ROOT, 'evidence') + '\n' + cdp).replace('export ', '')
    source += '\nglobalThis.tab=new Tab(1);tab.overlay=false;tab.send=(m,p={})=>sendCDP(m,p);'

    async def read_back(html, literals, path='/page'):
      served['html'] = html
      await page.goto(SITE + path)
      await page.evaluate('()=>{' + source + '\n}')
      return await page.evaluate('(l)=>tab.readBack(l)', literals)

    out = {}

    async def test_readback_chip():
      r = out['chip'] = await read_back(CHIP, ['Legal', 'Remote'])
      assert r == {'found': {'Legal': 'chip'}, 'missing': ['Remote']}, r

    async def test_readback_sort_pressed():
      r = out['sort'] = await read_back(SORT, ['Price ascending', 'Relevance'])
      assert r == {'found': {'Price ascending': 'aria-pressed'}, 'missing': ['Relevance']}, r

    async def test_readback_select():
      r = out['select'] = await read_back(SELECT, ['Medium (1-2 bedroom)', 'Large (3+ bedroom)'])
      assert r == {'found': {'Medium (1-2 bedroom)': 'select'}, 'missing': ['Large (3+ bedroom)']}, r

    async def test_readback_url_value_not_substring():
      r = out['url'] = await read_back(RESULTS, ['price', 'price_asc', 'cookies'], '/search?sort=price_asc&q=cookies')
      assert r == {'found': {'price_asc': 'url', 'cookies': 'url'}, 'missing': ['price']}, r

    async def test_readback_heading():
      r = out['heading'] = await read_back(CATEGORY, ['Cabinets, Racks & Shelves'], '/c/cabinets-racks-shelves')
      assert r == {'found': {'Cabinets, Racks & Shelves': 'heading'}, 'missing': []}, r

    async def test_readback_combobox_other_value():
      r = out['combobox'] = await read_back(COMBO, ['Legal', 'Business and Financial Operations'])
      assert r == {'found': {'Business and Financial Operations': 'field value'}, 'missing': ['Legal']}, r

    async def test_readback_state_class():
      out['state_class'] = {}
      for name, html, literal in STATE_CLASS:
        r = out['state_class'][name] = await read_back(html, [literal])
        assert r == {'found': {literal: 'state'}, 'missing': []}, (name, r)

    async def test_readback_not_applied():
      out['not_applied'] = {}
      for name, html, literal in NOT_APPLIED:
        r = out['not_applied'][name] = await read_back(html, [literal])
        assert r == {'found': {}, 'missing': [literal]}, (name, r)

    for check in (test_readback_chip, test_readback_sort_pressed, test_readback_select,
                  test_readback_url_value_not_substring, test_readback_heading, test_readback_combobox_other_value,
                  test_readback_state_class, test_readback_not_applied):
      await check()
    await browser.close()
  print(json.dumps({'status': 'pass', **out}))
asyncio.run(main())
