"""Real Chromium public pagination discovery; no paid calls or study site."""
import asyncio,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.async_api import async_playwright
R=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[1]
async def main():
 async with async_playwright() as p:
  b=await p.chromium.launch(headless=True);c=await b.new_context(viewport={"width":1280,"height":800});t=await c.new_page();ctrl=await c.new_page()
  html='<style>button{display:block;height:24px}nav a{display:inline-block;padding:8px}</style>'+''.join('<button>Action '+str(i)+'</button>' for i in range(180))+'<nav aria-label="pagination"><a href="?p=2">2</a><a rel="next" href="?p=3">Next</a><a href="http://foreign.test/?p=4">4</a><a href="/delete?p=5">5</a><a aria-current="page" href="?p=1">1</a><a style="display:none" href="?p=6">6</a><a aria-disabled="true" href="?p=7">7</a></nav>'
  await t.route('http://fixture.test/**',lambda route:route.fulfill(content_type='text/html',body=html))
  await t.goto('http://fixture.test/list?p=1');session=await c.new_cdp_session(t)
  await ctrl.expose_binding('sendCDP',lambda _,m,a:session.send(m,a))
  source=js_source(R,'candidates')+'\n'+'\n'.join(x for x in js_source(R,'cdp').splitlines() if not x.startswith('import '))
  await ctrl.evaluate('()=>{'+source.replace('export ','')+';globalThis.tab=new Tab(1);tab.send=(m,p={})=>sendCDP(m,p);}')
  before=await ctrl.evaluate('async()=>await tab.elements()')
  links=[x for x in before['off'] if x.get('paginationURL')]
  assert len(links)==2,[(x['name'],x.get('paginationURL')) for x in before['off']]
  assert {x['name'] for x in links}=={'2','Next'}
  assert all(x['label'].startswith('D') for x in links)
  await t.evaluate('scrollTo(0,document.body.scrollHeight)')
  after=await ctrl.evaluate('async()=>await tab.elements()')
  assert len([x for x in after['els'] if x.get('paginationURL')])==2
  target=next(x for x in links if x['name']=='Next')['paginationURL']
  await ctrl.evaluate('async(u)=>await tab.navigate(u)',target)
  assert t.url==target,(t.url,target)
  print(json.dumps({'status':'pass','offscreen_retained':len(links),'visible_tagged':2,'foreign_mutation_current_hidden_not_pagination':True,'navigated':t.url}))
  await b.close()
asyncio.run(main())
