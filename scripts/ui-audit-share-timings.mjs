import fs from 'node:fs/promises';
import {connect} from './ui-audit-cdp.mjs';
const s=await connect();const results=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function click(label){const p=await s.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.innerText.trim()===${JSON.stringify(label)}||e.title===${JSON.stringify(label)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);if(!p)throw new Error('Missing '+label);await s.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await s.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});}
async function state(){return s.evaluate(`(()=>({now:performance.now(),sources:[...document.querySelectorAll('button')].filter(b=>/^Telas[0-9]+|^Janelas[0-9]+/.test(b.innerText.trim())).length,preview:!![...document.querySelectorAll('video')].find(v=>v.readyState>=2&&!v.paused&&v.videoWidth>0),videos:document.querySelectorAll('video').length,live:window.__auditCaptures?.filter(c=>c.stream?.getTracks().some(t=>t.readyState==='live')).length,errors:document.body.innerText.includes('Não foi possível')}))()`);}
try{
 await s.send('Page.bringToFront');
 for(let round=0;round<10;round++){
  const start=await s.evaluate('performance.now()');await click('Compartilhar tela');
  const r={round,dispatchMs:(await s.evaluate('performance.now()'))-start};const deadline=Date.now()+10000;
  while(Date.now()<deadline){const st=await state();if(st.sources&&r.sourcesMs===undefined)r.sourcesMs=st.now-start;if(st.preview){r.previewMs=st.now-start;break;}await sleep(30);}
  r.beforeCancel=await state();const close=await s.evaluate('performance.now()');await click('Cancelar');await sleep(100);r.afterCancel=await state();r.closeMs=r.afterCancel.now-close;results.push(r);
  // Five fast open/cancel pairs after each normal capture cycle.
  if(round===4){for(let i=0;i<5;i++){await click('Compartilhar tela');await sleep(40);await click('Cancelar');await sleep(40);}results.push({rapidOpenCancelPairs:5,state:await state()});}
 }
 await sleep(1000);results.push({final:await state()});await fs.writeFile('tests/.tmp/ui-audit/screen-share/timings.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{s.close();}
