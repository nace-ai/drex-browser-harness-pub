"""Real Chromium: the pickSuggestion mechanic on MiniWoB's book-flight page. Typed into the From field the way typeInto
types (a click on the field, the lists on the page noted, the text typed key by key), "Emmonak, AK" opens jQuery UI's
autocomplete list and its live region says "1 result is available"; Tab.pickSuggestion clicks the suggestion and the
field holds "Emmonak, AK (EMK)". On ten problems of the page, the task's own From and To texts (a city or an airport
code) end as one of the page's airports containing them, as the page's Search checks. jQuery UI's fields carry an
autocomplete hint (the ui-autocomplete-input class); "No search results." ends the wait at once; a list already open
before the mark is no suggestion; a plain field (the e2e site's form) carries no hint, so its typing has no mark, no
wait, no click and no key. No model calls.
The MiniWoB pages are served by eval/miniwob_serve.py (started here on port 8792, stopped at the end) from the cached
clone under eval/.cache. Run: python3 test/check_autocomplete.py [REPO]; when python3 has no Playwright, with a Python
that has it (Playwright 1.58):
    python3 -m venv .venv-pw && .venv-pw/bin/pip install playwright==1.58.0 && .venv-pw/bin/playwright install chromium
    .venv-pw/bin/python test/check_autocomplete.py"""
import asyncio, json, re, socket, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
HTML = ROOT / 'eval/.cache/miniwob-33c3b4ddef8c/miniwob/html'
PORT = 8792
BASE = f'http://127.0.0.1:{PORT}/miniwob'


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
            # the Tab's clicks and keys are recorded, to see what the pick did
            await ctrl.evaluate('()=>{' + tab_source() + ''';globalThis.tab=new Tab(1);tab.overlay=false;tab.send=(m,p={})=>sendCDP(m,p);
              globalThis.acts=[];const click=tab.click.bind(tab),key=tab.key.bind(tab);
              tab.click=(x,y)=>(acts.push(["click",Math.round(x),Math.round(y)]),click(x,y));tab.key=(k)=>(acts.push(["key",k]),key(k));}''')

            async def node(selector):
                doc = await session.send('DOM.getDocument', {'depth': 0})
                found = await session.send('DOM.querySelector', {'nodeId': doc['root']['nodeId'], 'selector': selector})
                return (await session.send('DOM.describeNode', {'nodeId': found['nodeId']}))['node']['backendNodeId']

            async def type_and_pick(n, text, typing=True, ms=1500):
                """typeInto's way: click the field, read its autocomplete hint; with one, note the lists, type, pick.
                The hint, the pick's answer (None with no hint), its clicks and keys, and the ms the suggestion work took
                (the hint read, plus the pick's wait when there is one)."""
                return await ctrl.evaluate('''async([n,text,typing,ms])=>{
                  const c=await tab.centre(n); await tab.click(...c); await new Promise(r=>setTimeout(r,150));
                  let t0=performance.now(); const hinted=await tab.autocompleteHint(n); let spent=performance.now()-t0;
                  const since=hinted ? await tab.markSuggestions(n) : null; if (typing) await tab.type(text);
                  acts.length=0; t0=performance.now();
                  const r=hinted ? await tab.pickSuggestion(n,text,since,ms) : null; spent+=performance.now()-t0;
                  return {hinted, r, acts:[...acts], ms:Math.round(spent)}; }''', [n, text, typing, ms])

            out = {}
            # book-flight seed 1, the failing run's problem: From "Emmonak, AK"
            await t.goto(f'{BASE}/book-flight.html?seed=1')
            await t.wait_for_selector('#flight-from')
            frm = await node('#flight-from')
            role = next((e['role'] for e in (await ctrl.evaluate('async()=>(await tab.elements()).els')) if e['node'] == frm), None)
            got = await type_and_pick(frm, 'Emmonak, AK')
            value = await t.evaluate("$('#flight-from').val()")
            # jQuery UI's live region keeps its earlier messages, hidden: what it said, in order
            region = await t.evaluate("[...document.querySelectorAll('.ui-helper-hidden-accessible')].flatMap(e => [...e.children].map(m => m.textContent))")
            open_lists = await t.evaluate("$('ul.ui-autocomplete:visible').length")
            assert re.match(r'^Emmonak, AK \(\w{3}\)$', value), (value, got)
            assert got['hinted'] is True and got['r'] == {'ok': True, 'picked': value}, got
            assert len(got['acts']) == 1 and got['acts'][0][0] == 'click', got
            assert open_lists == 0, 'the list stayed open after the pick'
            assert region and region[0].startswith('1 result is available'), region
            assert await t.evaluate("DOMESTIC_FLIGHTS.indexOf($('#flight-from').val())") >= 0
            out['book-flight seed 1 From'] = {'role': role, 'hint': got['hinted'], 'typed': 'Emmonak, AK', 'value': value, 'pick': got['r'],
                                             'acts': got['acts'], 'pick_ms': got['ms'], 'live_region': region}

            # the task's own From and To on ten problems: each field ends as a page airport that contains the task's text
            solved = []
            for seed in range(1, 11):
                await t.goto(f'{BASE}/book-flight.html?seed={seed}')
                await t.wait_for_selector('#flight-from')
                m = re.search(r'from: (.+) to: (.+) on', await t.inner_text('#query'))
                ok = True
                for sel, text in (('#flight-from', m.group(1)), ('#flight-to', m.group(2))):
                    got = await type_and_pick(await node(sel), text)
                    v = await t.evaluate(f"$('{sel}').val()")
                    listed = await t.evaluate(f"DOMESTIC_FLIGHTS.indexOf($('{sel}').val()) >= 0")
                    ok = ok and got['hinted'] and got['r']['ok'] and listed and text in v
                if ok: solved.append(seed)
            assert solved == list(range(1, 11)), solved
            out['book-flight seeds 1-10 From and To committed'] = len(solved)

            # a list open before the mark (To, after "Bo" opened it): no suggestion, nothing clicked
            await t.goto(f'{BASE}/book-flight.html?seed=1')
            await t.wait_for_selector('#flight-to')
            to = await node('#flight-to')
            await ctrl.evaluate('async([n])=>{const c=await tab.centre(n); await tab.click(...c); await tab.type("Bo");}', [to])
            await t.wait_for_selector('ul.ui-autocomplete li', state='visible')
            shown = await t.evaluate("$('ul.ui-autocomplete:visible li').length")
            got = await type_and_pick(to, 'Bo', typing=False, ms=600)
            assert got['r'] == {'ok': False} and got['acts'] == [], got
            out['list open before the mark'] = {'items_shown': shown, 'pick': got['r'], 'acts': got['acts']}

            # text with no airport: jQuery UI's live region says "No search results.", which ends the wait at once
            await t.goto(f'{BASE}/book-flight.html?seed=1')
            await t.wait_for_selector('#flight-to')
            got = await type_and_pick(await node('#flight-to'), 'Zzqx')
            assert got['r'] == {'ok': False, 'noResults': True} and got['acts'] == [] and got['ms'] < 1000, got
            out['no airport typed (To, "Zzqx")'] = {'pick': got['r'], 'acts': got['acts'], 'pick_ms': got['ms']}

            # a plain field (the e2e site's form, autocomplete="off" set on it as login forms do): no hint, so no mark,
            # no wait, no click, no key; the suggestion work is the one hint read
            await t.goto((ROOT / 'e2e/site/form.html').as_uri())
            await t.evaluate("document.querySelector('#name').setAttribute('autocomplete', 'off')")
            got = await type_and_pick(await node('#name'), 'Alice Smith')
            assert got['hinted'] is False and got['r'] is None and got['acts'] == [], got
            assert got['ms'] < 200, got
            assert await t.evaluate("document.querySelector('#name').value") == 'Alice Smith'
            out['plain field (e2e form, Full name)'] = {'hint': got['hinted'], 'pick': got['r'], 'acts': got['acts'],
                                                        'suggestion_ms': got['ms']}
            print(json.dumps({'status': 'pass', **out}, indent=1))
            await b.close()
    finally:
        server.kill()
        server.wait()


asyncio.run(main())
