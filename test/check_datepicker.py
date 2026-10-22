"""Real Chromium: the datePicker mechanic on MiniWoB's date pages. choose-date's field (#datepicker) is read-only and
opens a jQuery UI calendar at December 2016 (clamped to its max date); the task asks for a date in 2016 ("Select
04/08/2016 as the date and hit submit."). The field is found among Tab.elements() (tagged read-only), and Tab.setDate
clicks it, clicks Prev until the calendar shows the month, clicks the day and checks the field: its value must then
equal the task's date string. Ten problems each of choose-date, choose-date-medium and choose-date-nodelay, and ten of
book-flight ("... on 12/03/2016."), with the passes per page; then choose-date with two months shown. Last, a
calendar of plain markup (no jQuery UI: the month and the year in two elements side by side, Prev and Next named by
aria-label, other months' days and a disabled day among the cells) is set the same way; asked for a date before its
first month, the Prev that changes nothing there ends the routine, with no day clicked. Then a table calendar on a
page with its own Back link and a form's Next button: with arrows nothing marks as the calendar's, no calendar is found
and nothing but the field is clicked; with bootstrap's arrows (<th>, the pointer cursor) it is set, the page's controls
untouched; and choose-date with date-like text, Back and Next before jQuery UI's popup still sets the date. No model
calls.
The MiniWoB pages are served by eval/miniwob_serve.py (started here on port 8793, stopped at the end) from the cached
clone under eval/.cache. Run: python3 test/check_datepicker.py [REPO]; when python3 has no Playwright, with a Python
that has it."""
import asyncio, json, re, socket, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
HTML = ROOT / 'eval/.cache/miniwob-33c3b4ddef8c/miniwob/html'
PORT = 8793
BASE = f'http://127.0.0.1:{PORT}/miniwob'

# a calendar of plain markup: April 2016 is its first month (its Prev answers nothing), December 2016 its last
PLAIN = '''<!doctype html><meta charset="utf-8"><title>Plain calendar</title>
<label>Departure <input id="when" readonly></label>
<div id="cal" style="display:none;position:absolute;top:60px;left:20px;border:1px solid #888;padding:6px;width:260px">
  <div style="display:flex;justify-content:space-between">
    <button type="button" id="back" aria-label="Previous month">&lsaquo;</button>
    <h2 style="font-size:14px;margin:0"><span id="mon"></span><span id="yr" style="margin-left:4px"></span></h2>
    <button type="button" id="fwd" aria-label="Next month">&rsaquo;</button>
  </div>
  <div id="grid" role="grid" style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-top:6px"></div>
</div>
<script>
(() => { // a function: set_content again on the same window would declare these twice
const NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
let y = 2016, m = 11; // shown month (0-based); opens at December 2016
const field = document.getElementById("when"), cal = document.getElementById("cal"), grid = document.getElementById("grid");
function draw() {
  document.getElementById("mon").textContent = NAMES[m];
  document.getElementById("yr").textContent = String(y);
  grid.replaceChildren();
  const lead = new Date(y, m, 1).getDay(), last = new Date(y, m + 1, 0).getDate(), before = new Date(y, m, 0).getDate();
  const cell = (d, cls, onPick) => { const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "gridcell");
    b.className = cls; b.textContent = String(d); if (onPick) b.onclick = onPick; grid.appendChild(b); return b; };
  for (let i = lead - 1; i >= 0; i--) cell(before - i, "day other-month"); // last month's days, greyed
  for (let d = 1; d <= last; d++) {
    const b = cell(d, "day", () => { field.value = NAMES[m] + " " + d + ", " + y; cal.style.display = "none"; });
    if (d === 1 && m === 11) b.setAttribute("aria-disabled", "true"); // one disabled day
  }
}
field.addEventListener("click", () => { draw(); cal.style.display = "block"; });
document.getElementById("back").onclick = () => { if (y === 2016 && m === 3) return; m--; draw(); }; // April 2016 is the first
document.getElementById("fwd").onclick = () => { if (m === 11) return; m++; draw(); };
})();
</script>'''


# a table calendar (bootstrap-datepicker's shape: <th class="prev">«</th>, handled by listeners, marked by the pointer
# cursor) on a page that has its own Back link and a form's Next button; with arrows=False the calendar's arrows are
# drawn ◀ ▶ with no pointer, so nothing says they are its controls. Clicks on Back and Next are counted, not followed.
def table_page(arrows=True):
    prev, nxt = ('«', '»') if arrows else ('◀', '▶')
    point = 'cursor:pointer' if arrows else 'cursor:default'
    return f"""<!doctype html><meta charset="utf-8"><title>Table calendar</title>
<style>.arrow {{ {point} }} td.day {{ cursor:pointer; width:28px; text-align:center }}</style>
<a id="pageback" href="#back">Back</a>
<p><label>Check-in <input id="when" readonly></label></p>
<table id="cal" style="display:none"><thead><tr><th class="arrow prev">{prev}</th><th colspan="5" id="title"></th>
<th class="arrow next">{nxt}</th></tr></thead><tbody id="days"></tbody></table>
<form id="wizard" action="?submitted=1"><button id="pagenext" type="submit">Next</button></form>
<script>
(() => {{
const NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
let y = 2016, m = 11;
window.pageClicks = [];
for (const id of ["pageback", "pagenext"])
  document.getElementById(id).addEventListener("click", (e) => {{ e.preventDefault(); window.pageClicks.push(id); }});
const field = document.getElementById("when"), cal = document.getElementById("cal"), body = document.getElementById("days");
const pad = (n) => String(n).padStart(2, "0");
function draw() {{
  document.getElementById("title").textContent = NAMES[m] + " " + y;
  body.replaceChildren();
  let row = document.createElement("tr");
  for (let i = 0; i < new Date(y, m, 1).getDay(); i++) row.appendChild(document.createElement("td"));
  for (let d = 1, last = new Date(y, m + 1, 0).getDate(); d <= last; d++) {{
    if (row.children.length === 7) {{ body.appendChild(row); row = document.createElement("tr"); }}
    const td = document.createElement("td"); td.className = "day"; td.textContent = String(d);
    td.addEventListener("click", () => {{ field.value = pad(m + 1) + "/" + pad(d) + "/" + y; cal.style.display = "none"; }});
    row.appendChild(td);
  }}
  body.appendChild(row);
}}
field.addEventListener("click", () => {{ draw(); cal.style.display = "table"; }});
cal.querySelector(".prev").addEventListener("click", () => {{ m--; if (m < 0) {{ m = 11; y--; }} draw(); }});
cal.querySelector(".next").addEventListener("click", () => {{ m++; if (m > 11) {{ m = 0; y++; }} draw(); }});
}})();
</script>"""


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


def date_of(text):
    """m/d/yyyy as MiniWoB writes it -> {y, m, d}"""
    m, d, y = (int(x) for x in text.split('/'))
    return {'y': y, 'm': m, 'd': d}


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
            # the Tab's clicks are recorded, to see what the routine did
            await ctrl.evaluate('()=>{' + tab_source() + ''';globalThis.tab=new Tab(1);tab.overlay=false;tab.send=(m,p={})=>sendCDP(m,p);
              globalThis.acts=[];const click=tab.click.bind(tab);tab.click=(x,y)=>(acts.push([Math.round(x),Math.round(y)]),click(x,y));}''')

            async def node(selector):
                doc = await session.send('DOM.getDocument', {'depth': 0})
                found = await session.send('DOM.querySelector', {'nodeId': doc['root']['nodeId'], 'selector': selector})
                return (await session.send('DOM.describeNode', {'nodeId': found['nodeId']}))['node']['backendNodeId']

            async def set_date(selector, date):
                """The field as Tab.elements() lists it, then Tab.setDate on its node: its element, the answer, the
                clicks made and the ms it took."""
                n = await node(selector)
                return await ctrl.evaluate('''async([n,date])=>{
                  const el=(await tab.elements()).els.find((e)=>e.node===n)||null; acts.length=0; const t0=performance.now();
                  const r=await tab.setDate(n,date); return {el, r, acts:[...acts], ms:Math.round(performance.now()-t0)}; }''', [n, date])

            out, problems = {}, []
            # the choose-date pages: the task's date, set through the calendar, is the field's value
            for name in ('choose-date', 'choose-date-medium', 'choose-date-nodelay'):
                passed, runs = 0, []
                for seed in range(1, 11):
                    await t.goto(f'{BASE}/{name}.html?seed={seed}')
                    await t.wait_for_selector('#datepicker')
                    want = re.search(r'Select (\S+) as the date', await t.inner_text('#query')).group(1)
                    got = await set_date('#datepicker', date_of(want))
                    value = await t.evaluate("document.querySelector('#datepicker').value")
                    ok = bool(got['el'] and got['el'].get('readOnly') is True and got['r']['ok'] and value == want)
                    passed += ok
                    runs.append({'seed': seed, 'date': want, 'value': value, 'r': got['r'], 'ms': got['ms']})
                    if not ok: problems.append({'page': name, 'seed': seed, 'want': want, 'value': value, 'got': got})
                out[f'{name} seeds 1-10'] = {'passed': passed, 'runs': runs}
                print(f'{name}: {passed}/10', flush=True)
            # seed 1 of choose-date in full: the field as tagged, and the clicks (the field, Prev to April, the day)
            await t.goto(f'{BASE}/choose-date.html?seed=1')
            await t.wait_for_selector('#datepicker')
            want = re.search(r'Select (\S+) as the date', await t.inner_text('#query')).group(1)
            got = await set_date('#datepicker', date_of(want))
            out['choose-date seed 1'] = {'query': await t.inner_text('#query'), 'element': {k: got['el'][k] for k in ('label', 'role', 'state', 'readOnly')},
                                         'r': got['r'], 'clicks': got['acts'], 'value': await t.evaluate("document.querySelector('#datepicker').value")}

            # book-flight: the departure date is the task's
            passed, runs = 0, []
            for seed in range(1, 11):
                await t.goto(f'{BASE}/book-flight.html?seed={seed}')
                await t.wait_for_selector('#datepicker')
                want = re.search(r' on (\d{2}/\d{2}/\d{4})', await t.inner_text('#query')).group(1)
                got = await set_date('#datepicker', date_of(want))
                value = await t.evaluate("$('#datepicker').val()")
                ok = bool(got['el'] and got['el'].get('readOnly') is True and got['r']['ok'] and value == want)
                passed += ok
                runs.append({'seed': seed, 'date': want, 'value': value, 'r': got['r'], 'ms': got['ms']})
                if not ok: problems.append({'page': 'book-flight', 'seed': seed, 'want': want, 'value': value, 'got': got})
            out['book-flight seeds 1-10'] = {'passed': passed, 'runs': runs}
            print(f'book-flight: {passed}/10', flush=True)

            # two months shown (booking sites): the leftmost header is the calendar's, the other month's days are skipped
            await t.goto(f'{BASE}/choose-date-nodelay.html?seed=1')
            await t.wait_for_selector('#datepicker')
            await t.evaluate("$('#datepicker').datepicker('option', 'numberOfMonths', 2)")
            got = await set_date('#datepicker', {'y': 2016, 'm': 4, 'd': 8})
            value = await t.evaluate("document.querySelector('#datepicker').value")
            if not (got['r']['ok'] and value == '04/08/2016'): problems.append({'page': 'two months', 'value': value, 'got': got})
            out['choose-date-nodelay seed 1, two months shown'] = {'r': got['r'], 'value': value}

            # a calendar of plain markup: found without jQuery UI's classes; the 8th of April 2016 skips the greyed cells
            await t.set_content(PLAIN)
            got = await set_date('#when', {'y': 2016, 'm': 4, 'd': 8})
            value = await t.evaluate("document.querySelector('#when').value")
            plain_ok = got['r'] == {'ok': True, 'clicks': 9} and value == 'April 8, 2016'
            if not plain_ok: problems.append({'page': 'plain', 'value': value, 'got': got})
            out['plain calendar, Dec 2016 -> April 8, 2016'] = {'r': got['r'], 'value': value, 'clicks': got['acts']}
            # its first month: a date before it gets one Prev click that changes nothing, and no day click
            await t.set_content(PLAIN)
            got = await set_date('#when', {'y': 2016, 'm': 3, 'd': 8})
            # (from December: 8 Prev to April, then the one that does nothing)
            static_ok = got['r'] == {'ok': False, 'clicks': 9} and await t.evaluate("document.querySelector('#when').value") == ''
            if not static_ok: problems.append({'page': 'plain static', 'got': got})
            out['plain calendar, a date before its first month'] = {'r': got['r'], 'clicks': len(got['acts'])}

            # the calendar's own arrows not recognised, the page's Back and Next on the page: no calendar, nothing clicked
            # but the field (the page's Back or Next would have stood in for Prev and Next)
            await t.set_content(table_page(arrows=False))
            url = t.url
            got = await set_date('#when', {'y': 2016, 'm': 4, 'd': 8})
            page_clicks = await t.evaluate("window.pageClicks")
            quiet_ok = got['r'] == {'ok': False, 'clicks': 0} and len(got['acts']) == 1 and page_clicks == [] and t.url == url
            if not quiet_ok: problems.append({'page': 'unrecognised arrows', 'page_clicks': page_clicks, 'url': t.url, 'got': got})
            out["unrecognised arrows beside the page's Back and Next"] = {'r': got['r'], 'clicks': got['acts'], 'page_clicks': page_clicks,
                                                                          'navigated': t.url != url}
            # bootstrap's arrows (<th>, the pointer cursor, listeners): recognised; the page's Back and Next untouched
            await t.set_content(table_page(arrows=True))
            got = await set_date('#when', {'y': 2016, 'm': 4, 'd': 8})
            value = await t.evaluate("document.querySelector('#when').value")
            page_clicks = await t.evaluate("window.pageClicks")
            table_ok = got['r'] == {'ok': True, 'clicks': 9} and value == '04/08/2016' and page_clicks == []
            if not table_ok: problems.append({'page': 'table arrows', 'value': value, 'page_clicks': page_clicks, 'got': got})
            out['table calendar (th arrows), Dec 2016 -> 04/08/2016'] = {'r': got['r'], 'value': value, 'page_clicks': page_clicks}
            # choose-date with date-like text, a Back link and a Next button earlier on the page than jQuery UI's popup
            # (appended to the end of the body): the popup is still the calendar, and the page's controls are not clicked
            await t.goto(f'{BASE}/choose-date.html?seed=1')
            await t.wait_for_selector('#datepicker')
            await t.evaluate("""() => { const d = document.createElement('div');
              d.innerHTML = '<h3>October 2026</h3><table><tr><td>2016-12-03</td></tr></table><a id="pageback" href="#back">Back</a> <button id="pagenext">Next</button>';
              document.body.prepend(d); window.pageClicks = [];
              for (const id of ['pageback', 'pagenext']) document.getElementById(id).addEventListener('click', (e) => { e.preventDefault(); window.pageClicks.push(id); }); }""")
            got = await set_date('#datepicker', {'y': 2016, 'm': 4, 'd': 8})
            value = await t.evaluate("document.querySelector('#datepicker').value")
            page_clicks = await t.evaluate("window.pageClicks")
            if not (got['r'] == {'ok': True, 'clicks': 9} and value == '04/08/2016' and page_clicks == []):
                problems.append({'page': 'stray dates', 'value': value, 'page_clicks': page_clicks, 'got': got})
            out['choose-date seed 1 with stray date text, Back and Next before it'] = {'r': got['r'], 'value': value, 'page_clicks': page_clicks}

            pages = {k: v['passed'] for k, v in out.items() if isinstance(v, dict) and 'passed' in v}
            print(json.dumps({'status': 'pass' if not problems else 'fail', 'passes': pages, **out, 'problems': problems}, indent=1))
            await b.close()
            assert not problems, f'{len(problems)} problem(s)'
    finally:
        server.kill()
        server.wait()


asyncio.run(main())
