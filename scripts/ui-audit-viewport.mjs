import fs from 'node:fs/promises';
import {connect} from './ui-audit-cdp.mjs';
const s=await connect();const rows=[];
try{
 for(const height of [800,600]){
  await s.send('Emulation.setDeviceMetricsOverride',{width:1280,height,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,500));
  if(!await s.evaluate(`!!document.querySelector('button[aria-label="Áudio do sistema"]')`)){
   const p=await s.evaluate(`(()=>{const r=document.querySelector('video').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
   for(const type of ['mousePressed','mouseReleased'])await s.send('Input.dispatchMouseEvent',{type,button:'right',clickCount:1,...p});await new Promise(r=>setTimeout(r,150));
   const q=await s.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>/^[0-9]+p [0-9]+fps$/.test(e.innerText.trim()));if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
   if(q){for(const type of ['mousePressed','mouseReleased'])await s.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...q});await new Promise(r=>setTimeout(r,250));}
  }
  if(height===600){await s.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.innerText.trim()==='Personalizada');b?.click()})()`);await new Promise(r=>setTimeout(r,250));}
  rows.push(await s.evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')==='Áudio do sistema');if(!button)return {missing:true};const panel=button.closest('.glass');return {height:innerHeight,panel:panel?.getBoundingClientRect().toJSON(),audio:button.getBoundingClientRect().toJSON(),scrollParents:[...function*(e){for(let p=e.parentElement;p;p=p.parentElement)yield p}(button)].map(e=>({tag:e.tagName,overflow:getComputedStyle(e).overflowY,client:e.clientHeight,scroll:e.scrollHeight})).filter(e=>e.scroll>e.client||e.overflow!=='visible')}})()`));
  const screenshot=await s.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(`tests/.tmp/ui-audit/screen-share/viewport-${height}.png`,Buffer.from(screenshot.data,'base64'));
 }
 await fs.writeFile('tests/.tmp/ui-audit/screen-share/viewport.json',JSON.stringify(rows,null,2));console.log(JSON.stringify(rows,null,2));
}finally{await s.send('Emulation.clearDeviceMetricsOverride');s.close();}
