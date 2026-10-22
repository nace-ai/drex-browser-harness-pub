"""Real Chromium: the dragTo mechanic on MiniWoB's own pages. Tab.elements() tags drag-box's two jQuery UI boxes and
drag-items-grid's sortable items as draggable (the items had no tag before: jQuery UI drives them from their list), and
Tab.dragTo moves them: the small box ends inside the large one by the page's own smallBoxContained(), a grid item
lands in another cell, and the task's own drag scores on ten problems of each page. On the e2e site's pages, which
have no drag markers, the scan's drag rule adds no tag. No model calls.
The MiniWoB pages are served by eval/miniwob_serve.py (started here on port 8791, stopped at the end) from the cached
clone under eval/.cache. Run: python3 test/check_drag.py [REPO]; when python3 has no Playwright, with a Python
that has it (Playwright 1.58):
    python3 -m venv .venv-pw && .venv-pw/bin/pip install playwright==1.58.0 && .venv-pw/bin/playwright install chromium
    .venv-pw/bin/python test/check_drag.py"""
import asyncio, json, re, socket, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
HTML = ROOT / 'eval/.cache/miniwob-33c3b4ddef8c/miniwob/html'
PORT = 8791
BASE = f'http://127.0.0.1:{PORT}/miniwob'
# the candidates rule's selector: replaced by one that matches nothing, it gives the scan as it was without the rule
MARKERS = '[draggable="true"],.ui-draggable,.ui-sortable-handle,[aria-grabbed]'
CELLS = ['top left', 'top center', 'top right', 'center left', 'center', 'center right', 'bottom left', 'bottom center', 'bottom right']


def tab_source(candidates):
    cdp = '\n'.join(x for x in js_source(ROOT, 'cdp').splitlines() if not x.startswith('import '))
    return (candidates + '\n' + cdp).replace('export ', '')


def wait_port():
    for _ in range(100):
        try:
            socket.create_connection(('127.0.0.1', PORT), timeout=0.2).close()
            return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f'the MiniWoB server did not start on port {PORT}')


async def main():
    assert HTML.is_dir(), f'no cached MiniWoB clone at {HTML}'
    server = subprocess.Popen([sys.executable, '-I', str(ROOT / 'eval/miniwob_serve.py'), str(HTML), str(PORT)])
    try:
        wait_port()
        async with async_playwright() as p:
            b = await p.chromium.launch(headless=True)
            c = await b.new_context(viewport={'width': 1280, 'height': 800})
            t, ctrl = await c.new_page(), await c.new_page()
            session = await c.new_cdp_session(t)
            # as under chrome.debugger: no command-line API (getEventListeners) in the page's evaluations
            await ctrl.expose_binding('sendCDP', lambda _, m, a: session.send(m, {**a, 'includeCommandLineAPI': False} if m == 'Runtime.evaluate' else a))
            candidates = js_source(ROOT, 'candidates')
            assert candidates.count(MARKERS) == 1, 'the drag rule selector is not in candidates.ts as expected'
            for name, src in (('tab', candidates), ('base', candidates.replace(MARKERS, '[data-drex-no-such-marker]'))):
                await ctrl.evaluate('()=>{' + tab_source(src) + f';globalThis.{name}=new Tab(1);{name}.overlay=false;{name}.send=(m,p={{}})=>sendCDP(m,p);}}')

            async def els(which='tab'):
                return (await ctrl.evaluate(f'async()=>(await {which}.elements()).els'))

            async def nodes(selector):
                doc = await session.send('DOM.getDocument', {'depth': 0})
                found = await session.send('DOM.querySelectorAll', {'nodeId': doc['root']['nodeId'], 'selector': selector})
                return [(await session.send('DOM.describeNode', {'nodeId': n}))['node']['backendNodeId'] for n in found['nodeIds']]

            async def drag(a, z):
                return await ctrl.evaluate('async([a,z])=>await tab.dragTo(a,z)', [a, z])

            out = {}
            # drag-box: two jQuery UI draggables; the task is to put the small one inside the large one
            await t.goto(f'{BASE}/drag-box.html?seed=1')
            await t.wait_for_selector('#draggableSmall')
            [small], [large] = await nodes('#draggableSmall'), await nodes('#draggableLarge')
            listed = {e['node']: e for e in await els()}
            assert listed.get(small, {}).get('draggable') is True and listed.get(large, {}).get('draggable') is True, list(listed.values())
            assert sum(1 for e in listed.values() if e.get('draggable')) == 2, list(listed.values())
            assert await t.evaluate('smallBoxContained()') is False
            changed = await drag(small, large)
            contained = await t.evaluate('smallBoxContained()')
            assert changed is True and contained is True, (changed, contained)
            # and on other problems of the page: the boxes start elsewhere
            solved = []
            for seed in range(2, 11):
                await t.goto(f'{BASE}/drag-box.html?seed={seed}')
                await t.wait_for_selector('#draggableSmall')
                [small], [large] = await nodes('#draggableSmall'), await nodes('#draggableLarge')
                if await drag(small, large) and await t.evaluate('smallBoxContained()'): solved.append(seed)
            assert solved == list(range(2, 11)), solved
            out['drag-box'] = {'tagged': len(listed), 'draggable': 2, 'changed': changed, 'smallBoxContained': contained,
                               'seeds_2_10_contained': len(solved)}

            # drag-items-grid: a jQuery UI sortable whose <li> items get ui-sortable-handle; their listeners are the list's
            await t.goto(f'{BASE}/drag-items-grid.html?seed=1')
            await t.wait_for_selector('#sortable li.ui-sortable-handle')
            items = await nodes('#sortable li')
            listed = {e['node']: e for e in await els()}
            before = {e['node'] for e in await els('base')}
            assert len(items) == 9 and all(listed.get(n, {}).get('draggable') is True for n in items), list(listed.values())
            assert not any(n in before for n in items), 'the items were tagged without the drag rule'
            order = lambda: t.evaluate("[...document.querySelectorAll('#sortable li')].map(li => li.textContent)")
            names = await order()
            changed = await drag(items[0], items[4])  # the first item onto the centre cell
            after = await order()
            assert changed is True and after.index(names[0]) != 0 and sorted(after) == sorted(names), (changed, names, after)
            # the task's own drag ("Drag Jinny to the center.", "... up by one."), scored by the page: half of them go up or
            # left, which a sortable takes only once the pointer has crossed the target's middle
            scored = []
            for seed in range(1, 11):
                await t.evaluate("localStorage.removeItem('wob-result')")  # the page keeps the first episode's score
                await t.goto(f'{BASE}/drag-items-grid.html?seed={seed}')
                await t.wait_for_selector('#sortable li.ui-sortable-handle')
                m = re.match(r'Drag (.+) (to the (.+)|(up|down|left|right) by one)\.$', await t.inner_text('#query'))
                ix = (await order()).index(m.group(1)) + 1
                cell = CELLS.index(m.group(3)) + 1 if m.group(3) else ix + {'up': -3, 'down': 3, 'left': -1, 'right': 1}[m.group(4)]
                items = await nodes('#sortable li')
                await drag(items[ix - 1], items[cell - 1])
                result = json.loads(await t.evaluate("localStorage.getItem('wob-result')") or 'null')
                if result and result['reward'] > 0: scored.append(seed)
            assert scored == list(range(1, 11)), scored
            out['drag-items-grid'] = {'items': len(items), 'tagged_without_rule': 0, 'changed': changed,
                                      'moved_to_cell': after.index(names[0]) + 1, 'seeds_1_10_scored': len(scored)}

            # plain pages with no drag markers (form, menu and store among the e2e site's): the same tags with the rule
            # as without it, none draggable
            plain = {}
            for page in sorted(x.name for x in (ROOT / 'e2e/site').glob('*.html')):
                await t.goto((ROOT / 'e2e/site' / page).as_uri() + ('?s=panda' if page == 'store.html' else ''))
                now, was = await els(), await els('base')
                assert [e['text'] for e in now] == [e['text'] for e in was], (page, [e['text'] for e in now], [e['text'] for e in was])
                assert not any(e.get('draggable') for e in now), page
                plain[page] = len(now)
            out['test_no_new_tags_on_plain_pages'] = plain
            print(json.dumps({'status': 'pass', **out}))
            await b.close()
    finally:
        server.kill()
        server.wait()


asyncio.run(main())
