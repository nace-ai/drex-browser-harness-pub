from pathlib import Path
import json, sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_types import js_source
from playwright.sync_api import sync_playwright
r=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page()
    result=page.evaluate("""async source => {
      const mod=await import(URL.createObjectURL(new Blob([source],{type:'text/javascript'})));
      const original=document.createElement('canvas');original.width=1200;original.height=1200;
      const ctx=original.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1200,1200);
      ctx.fillStyle='red';ctx.fillRect(300,300,600,600);
      const data=original.toDataURL('image/png').split(',')[1];
      const reduced=await mod.smallerObservation({type:'image',source:{type:'base64',media_type:'image/png',data}});
      const bitmap=await createImageBitmap(await (await fetch('data:image/jpeg;base64,'+reduced.image.source.data)).blob());
      const out=document.createElement('canvas');out.width=640;out.height=400;const draw=out.getContext('2d');draw.drawImage(bitmap,0,0);
      const center=Array.from(draw.getImageData(320,200,1,1).data);
      const bar=Array.from(draw.getImageData(20,200,1,1).data);
      return {width:bitmap.width,height:bitmap.height,transform:reduced.transform,center,bar};
    }""",js_source(r, 'context'))
    browser.close()
assert result["width"]==640 and result["height"]==400
assert abs(result["transform"]["scale"]-1/3)<1e-10
assert result["transform"]["offset_x"]==120 and result["transform"]["offset_y"]==0
assert result["center"][0]>240 and result["center"][1]<20
assert max(result["bar"][:3])<10
print(json.dumps(result))
