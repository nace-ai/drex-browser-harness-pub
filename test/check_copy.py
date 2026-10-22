"""Real Chromium: the copyMove mechanic on MiniWoB's copy-paste and copy-paste-2 pages. Tab.copyInto copies a textarea's
text into the answer box without the clipboard: the box then holds exactly the textarea's text (trailing space and
all), and pressing Submit scores 1 on the page's own check, on ten problems of each page (copy-paste-2 names which of
its three textareas to copy: the one the query says). No model calls.
The MiniWoB pages are served by eval/miniwob_serve.py (started here on port 8794, stopped at the end) from the cached
clone under eval/.cache. Run: python3 test/check_copy.py [REPO]; when python3 has no Playwright, with a Python
that has it (Playwright 1.58):
    python3 -m venv .venv-pw && .venv-pw/bin/pip install playwright==1.58.0 && .venv-pw/bin/playwright install chromium
    .venv-pw/bin/python test/check_copy.py"""
import asyncio, json, socket, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
HTML = ROOT / 'eval/.cache/miniwob-33c3b4ddef8c/miniwob/html'
PORT = 8794
BASE = f'http://127.0.0.1:{PORT}/miniwob'
ORDINALS = {'1st': 1, '2nd': 2, '3rd': 3}


def tab_source():
    cdp = '\n'.join(x for x in js_source(ROOT, 'cdp').splitlines() if not x.startswith('import '))
    return (js_source(ROOT, 'candidates') + '\n' + cdp).replace('export ', '')


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
            # as under chrome.debugger: no command-line API in the page's evaluations
            await ctrl.expose_binding('sendCDP', lambda _, m, a: session.send(m, {**a, 'includeCommandLineAPI': False} if m == 'Runtime.evaluate' else a))
            await ctrl.evaluate('()=>{' + tab_source() + ';globalThis.tab=new Tab(1);tab.overlay=false;tab.send=(m,p={})=>sendCDP(m,p);}')

            async def node(selector):
                doc = await session.send('DOM.getDocument', {'depth': 0})
                found = await session.send('DOM.querySelector', {'nodeId': doc['root']['nodeId'], 'selector': selector})
                return (await session.send('DOM.describeNode', {'nodeId': found['nodeId']}))['node']['backendNodeId']

            async def run(page, source_selector_of):
                """One problem: copy the textarea into the answer box, compare, submit; returns (equal, chars, scored)"""
                await t.goto(f'{BASE}/{page}')
                await t.evaluate("localStorage.removeItem('wob-result')")  # the page keeps the first episode's score
                await t.wait_for_selector('#answer-input')
                selector = await source_selector_of()
                source, target = await node(selector), await node('#answer-input')
                listed = {e['node'] for e in await ctrl.evaluate('async()=>(await tab.elements()).els')}
                assert source in listed and target in listed, (selector, listed)
                chars = (await ctrl.evaluate('async([a,z])=>await tab.copyInto(a,z)', [source, target]))['chars']
                want, got = await t.input_value(selector), await t.input_value('#answer-input')
                await t.click('#subbtn')
                result = json.loads(await t.evaluate("localStorage.getItem('wob-result')") or 'null')
                return got == want and chars == len(want) > 0, chars, bool(result and result['reward'] > 0)

            out = {}
            for page, seeds in (('copy-paste.html', 'single'), ('copy-paste-2.html', 'named')):
                passed = scored = 0
                for seed in range(1, 11):
                    async def named():
                        if seeds == 'single': return '#to-copy'
                        query = await t.inner_text('#query')
                        return f"#text-{next(n for o, n in ORDINALS.items() if o in query)}"
                    same, chars, ok = await run(f'{page}?seed={seed}', named)
                    passed += same
                    scored += ok
                    print(f'{page}?seed={seed}: equal={same} chars={chars} scored={ok}')
                assert passed == 10 and scored == 10, (page, passed, scored)
                out[page] = {'seeds_1_10_equal': passed, 'seeds_1_10_scored': scored}
            print(json.dumps({'status': 'pass', **out}))
            await b.close()
    finally:
        server.kill()
        server.wait()


asyncio.run(main())
