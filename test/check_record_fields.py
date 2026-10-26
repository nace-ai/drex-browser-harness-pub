"""Real Chromium: the rows Tab.items() finds read as records by Tab.records() (cdp.ts RECORD_FN): an admin table's
cells paired with its head's column names, with the row's link; a storefront table's cells named by their data-th; a
review list's labelled parts and percentage ratings; a card's dt/dd pairs; column names kept over their own cells when a
head starts with a blank corner cell or the rows start with a row header, and taken from a head's headings row rather
than the row of filters under it, even filters that are all selects or headings that are all buttons; and a row gone
from the page read as empty.
One inline page per list, no model calls. Prints ok; a failed assertion exits non-zero.
Run: python3 test/check_record_fields.py [REPO]"""
import asyncio, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright
ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
ORDERS = [('000000129', 'Jun 5, 2023 10:14:22 AM', 'Julia Williams', '$1,234.56', 'Canceled'),
          ('000000128', 'May 1, 2023 9:02:10 AM', 'Jane Doe', '$40.00', 'Complete'),
          ('000000127', 'Apr 2, 2023 4:45:01 PM', 'Grace Nguyen', '$12.50', 'Pending')]
ADMIN = ('<main><table><thead><tr><th>ID</th><th>Purchase Date</th><th>Bill-to Name</th><th>Grand Total (Base)</th>'
         '<th>Status</th></tr></thead><tbody>'
         + ''.join('<tr>' + ''.join(f'<td>{c}</td>' for c in o) + f'<td><a href="/order/{int(o[0])}">View</a></td></tr>'
                   for o in ORDERS)
         + '</tbody></table></main>')
# a table with no head and no header cell is a layout table to Chromium, its rows no rows, unless something else marks it
# as data: here its caption, as a store's order table has
STORE = ('<main><table><caption>My Orders</caption><tbody>'
         + ''.join(f'<tr><td data-th="Order #">{n}</td> <td data-th="Order Total">{t}</td> <td data-th="Status">{s}</td></tr>'
                   for n, t, s in [('000000148', '$65.32', 'Complete'), ('000000147', '$18.00', 'Pending'),
                                   ('000000146', '$7.99', 'Canceled')])
         + '</tbody></table></main>')
REVIEW = ('<li class="review-item"><div class="rating-result" title="{pct}"><span><span>{pct}</span></span></div>'
          '<div class="review-title">{title}</div><p class="review-author"><strong class="review-details-label">Review by'
          '</strong> <strong class="review-details-value">{author}</strong></p><p class="review-date">{date}</p>'
          '<div class="review-content">{body}</div></li>')
REVIEWS = ('<main><ol class="review-items">'
           + REVIEW.format(pct='80%', title='Great case', author='Amanda', date='1/2/23', body='Fits well')
           + REVIEW.format(pct='20%', title='Too small', author='Evelyn Kurver', date='2/9/23', body='Runs small')
           + '</ol></main>')
CARDS = ('<main><ul class="cards">'
         + ''.join(f'<li><a href="/p/{i}">{name}</a><dl><dt>Price</dt><dd>{price}</dd><dt>SKU</dt><dd>{sku}</dd></dl></li>'
                   for i, (name, price, sku) in enumerate([('Hooded Sweatshirt', '$12.00', 'WSH09'),
                                                           ('Running Tee', '$8.50', 'MT07'),
                                                           ('Yoga Pants', '$30.00', 'WP12')]))
         + '</ul></main>')
FRUIT = [('Apple', '$1.00', '12'), ('Pear', '$2.50', '4'), ('Plum', '$0.80', '30')]
# a head with a blank corner cell over the rows' own labels
CORNER = ('<main><table><thead><tr><td></td><th>Price</th><th>Qty</th></tr></thead><tbody>'
          + ''.join(f'<tr><td>{n}</td><td>{p}</td><td>{q}</td></tr>' for n, p, q in FRUIT)
          + '</tbody></table></main>')
# a grid whose rows start with a row header under a column header of its own
GRID = ('<main><div role="grid"><div role="row"><span role="columnheader">Name</span> '
        '<span role="columnheader">Price</span> <span role="columnheader">Qty</span></div>'
        + ''.join(f'<div role="row"><span role="rowheader">{n}</span> <span role="gridcell">{p}</span> '
                  f'<span role="gridcell">{q}</span></div>' for n, p, q in FRUIT)
        + '</div></main>')
# an older admin grid's head: its headings, then a row of filters (blank inputs, a select of the statuses)
FILTERS = ('<main><table><thead><tr><th>ID</th><th>Status</th></tr><tr><td><input></td><td><select><option></option>'
           '<option>Pending</option><option>Complete</option><option>Canceled</option></select></td></tr></thead><tbody>'
           + ''.join(f'<tr><td>{n}</td><td>{s}</td></tr>' for n, s in [('000000129', 'Canceled'), ('000000128', 'Complete'),
                                                                        ('000000127', 'Pending')])
           + '</tbody></table></main>')
# a head whose filters are all selects: their options' text names no column. Four data rows, not one: a single row is
# no list to items(), which would read the filter row instead
SELECTS = ('<main><table><thead><tr><th>Type</th><th>Status</th></tr><tr><td><select><option>Simple</option>'
           '<option>Bundle</option></select></td><td><select><option>Enabled</option><option>Disabled</option></select>'
           '</td></tr></thead><tbody>'
           + '<tr><td>Simple</td><td>Enabled</td></tr><tr><td>Bundle</td><td>Disabled</td></tr>' * 2
           + '</tbody></table></main>')
# sortable headings: buttons that carry the column names, over a row of input filters
BUTTONS = ('<main><table><thead><tr><th><button>Name</button></th><th><button>Price</button></th></tr>'
           '<tr><td><input></td><td><input></td></tr></thead><tbody>'
           + ''.join(f'<tr><td>{n}</td><td>{p}</td></tr>' for n, p, _ in FRUIT + [('Quince', '$3.10', '7')])
           + '</tbody></table></main>')
READ = 'async()=>{const items=await tab.items();return [items.map(i=>i.text), await tab.records(items)]}'
# the first row is removed after items() found it, so records() reads a node that is gone
READ_GONE = 'async()=>{const items=await tab.items();document.querySelector("tbody tr").remove();return await tab.records(items)}'

async def main():
  async with async_playwright() as p:
    browser = await p.chromium.launch(headless=True)
    page = await browser.new_page(viewport={'width': 1280, 'height': 800})
    session = await page.context.new_cdp_session(page)
    async def send(_source, method, params): return await session.send(method, params)
    await page.expose_binding('sendCDP', send)
    source = '\n'.join(x for x in js_source(ROOT, 'cdp').splitlines() if not x.startswith('import '))
    source = js_source(ROOT, 'candidates') + '\n' + source
    source = source.replace('export ', '') + '\nglobalThis.tab=new Tab(1);tab.overlay=false;tab.send=(m,p={})=>sendCDP(m,p);'
    async def load(html):
      await page.set_content(html)
      await page.evaluate('()=>{' + source + '\n}')
    # (a) an admin grid: the head names the columns, the row's link is its View link, no rating
    await load(ADMIN)
    texts, raw = await page.evaluate(READ)
    assert len(texts) == 3 and len(raw) == 3, texts
    cells = [tuple(c) for c in raw[0]['cells']]
    assert ('ID', '000000129') in cells, cells
    assert ('Bill-to Name', 'Julia Williams') in cells, cells
    assert ('Status', 'Canceled') in cells, cells
    assert raw[0]['href'].endswith('/order/129'), raw[0]['href']
    assert raw[0]['rating'] is None, raw[0]['rating']
    assert [r['index'] for r in raw] == [0, 1, 2] and [r['text'] for r in raw] == texts, raw
    gone = await page.evaluate(READ_GONE)
    assert gone[0] == {'index': 0, 'text': texts[0], 'cells': [], 'rating': None, 'href': ''}, gone[0]
    assert ('Bill-to Name', 'Jane Doe') in [tuple(c) for c in gone[1]['cells']], gone[1]
    # (b) a storefront table with no head: each cell's data-th names it
    await load(STORE)
    texts, raw = await page.evaluate(READ)
    assert len(raw) == 3, texts
    cells = [tuple(c) for c in raw[0]['cells']]
    assert ('Order #', '000000148') in cells, cells
    assert ('Order Total', '$65.32') in cells, cells
    # (c) a review list: parts named by their class, the label left in the cell, the rating from its title
    await load(REVIEWS)
    texts, raw = await page.evaluate(READ)
    assert len(raw) == 2, texts
    cells = [tuple(c) for c in raw[0]['cells']]
    assert raw[0]['rating'] == '80%', raw[0]
    assert ('author', 'Review by Amanda') in cells, cells
    assert ('date', '1/2/23') in cells, cells
    assert ('title', 'Great case') in cells, cells
    assert raw[1]['rating'] == '20%', raw[1]
    # (d) a card list: a definition list's terms name its details
    await load(CARDS)
    texts, raw = await page.evaluate(READ)
    assert len(raw) == 3, texts
    cells = [tuple(c) for c in raw[0]['cells']]
    assert ('Price', '$12.00') in cells, cells
    assert ('SKU', 'WSH09') in cells, cells
    # (e) a blank corner cell in the head: every cell of the head's row counts, so each name stays over its column
    await load(CORNER)
    texts, raw = await page.evaluate(READ)
    assert len(raw) == 3, texts
    assert raw[0]['cells'] == [['col1', 'Apple'], ['Price', '$1.00'], ['Qty', '12']], raw[0]['cells']
    # (f) a grid whose rows start with a row header: it is a cell of the row like any other
    await load(GRID)
    texts, raw = await page.evaluate(READ)
    assert len(raw) == 3, texts
    assert raw[0]['cells'] == [['Name', 'Apple'], ['Price', '$1.00'], ['Qty', '12']], raw[0]['cells']
    assert raw[2]['cells'] == [['Name', 'Plum'], ['Price', '$0.80'], ['Qty', '30']], raw[2]['cells']
    # (g) a head with a row of filters under its headings: the headings name the columns
    await load(FILTERS)
    texts, raw = await page.evaluate(READ)
    assert len(raw) == 3, texts
    assert raw[0]['cells'] == [['ID', '000000129'], ['Status', 'Canceled']], raw[0]['cells']
    # (h) a head whose filters are all selects: the selects' options count as no text, so the headings name the columns
    await load(SELECTS)
    texts, raw = await page.evaluate(READ)
    assert len(raw) == 4, texts
    assert raw[0]['cells'] == [['Type', 'Simple'], ['Status', 'Enabled']], raw[0]['cells']
    assert raw[1]['cells'] == [['Type', 'Bundle'], ['Status', 'Disabled']], raw[1]['cells']
    # (i) headings that are buttons over input filters: a heading's button text is its column's name
    await load(BUTTONS)
    texts, raw = await page.evaluate(READ)
    assert len(raw) == 4, texts
    assert raw[0]['cells'] == [['Name', 'Apple'], ['Price', '$1.00']], raw[0]['cells']
    await browser.close()
  print('ok')

if __name__ == '__main__':
  asyncio.run(main())
