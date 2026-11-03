import fs from 'node:fs/promises';
import {connect} from './ui-audit-cdp.mjs';
const s=await connect();const records=[];const output='tests/.tmp/ui-audit/screen-share';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function snapshot(){return s.evaluate(`(async()=>{const v=(await import('/src/stores/voiceStore.ts')).useVoiceStore.getState();const setup=(await import('/src/stores/screenShareSetupStore.ts')).useScreenShareSetupStore.getState();return {open:setup.isOpen,config:v.screenShareConfig,sharing:v.isScreenSharing,drawer:document.querySelector('[data-testid="stream-settings-drawer"]')?.getAttribute('aria-hidden'),videos:[...document.querySelectorAll('video')].map(e=>({time:e.currentTime,paused:e.paused,ready:e.readyState,frames:e.getVideoPlaybackQuality().totalVideoFrames,width:e.videoWidth,height:e.videoHeight,track:e.srcObject?.getVideoTracks()[0]?.id,state:e.srcObject?.getVideoTracks()[0]?.readyState,settings:e.srcObject?.getVideoTracks()[0]?.getSettings()})),captures:window.__auditCaptures?.map(c=>({start:c.start,end:c.end,error:c.error,tracks:c.stream?.getTracks().map(t=>({kind:t.kind,state:t.readyState,id:t.id}))})),text:document.body.innerText.slice(-700)}})()`);}
async function click(text,index=0){
 const point=await s.evaluate(`(async()=>{const e=[...document.querySelectorAll('button')].filter(e=>(e.innerText.trim()===${JSON.stringify(text)}||e.title===${JSON.stringify(text)}||e.getAttribute('aria-label')===${JSON.stringify(text)})&&!e.closest('[inert]'))[${index}];if(!e)return {error:'missing'};e.scrollIntoView({block:'nearest',behavior:'instant'});await new Promise(r=>requestAnimationFrame(r));const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);return {x,y,disabled:e.disabled,blocked:!e.contains(hit),hit:hit?.outerHTML.slice(0,150)}})()`);
 if(point.error||point.blocked||point.disabled){records.push({click:text,...point});return false;}
 const start=performance.now();
 await s.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:point.x,y:point.y});
 await s.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:point.x,y:point.y});
 records.push({click:text,index,dispatchMs:performance.now()-start});return true;
}
try{
 await s.send('Page.bringToFront');
 await s.evaluate(`(()=>{if(!window.__auditOriginalDisplayMedia){window.__auditOriginalDisplayMedia=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);window.__auditCaptures=[];navigator.mediaDevices.getDisplayMedia=async(...args)=>{const c={start:performance.now()};window.__auditCaptures.push(c);try{c.stream=await window.__auditOriginalDisplayMedia(...args);c.end=performance.now();return c.stream;}catch(e){c.error=e.name;c.end=performance.now();throw e;}};}})()`);
 records.push({phase:'initial',state:await snapshot()});
 for(let round=0;round<3;round++){
  for(const label of ['540p','1080p','720p','30','60','45','H264','VP9','Texto','Jogos']){await click(label);await sleep(40);}
  await sleep(300);records.push({phase:'rapid-quality',round,state:await snapshot()});
 }
 if(process.env.AUDIT_RAPID_MODE==='live'){
  await sleep(3000);records.push({phase:'live-settled',state:await snapshot()});
  await fs.writeFile(`${output}/rapid-live.json`,JSON.stringify(records,null,2));
  console.log(JSON.stringify(records.filter(r=>r.phase||r.blocked||r.error),null,2));
  process.exitCode=0;
 }else{
 // Close the drawer with Escape without closing the capture setup.
 await s.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await s.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(350);
 for(let round=0;round<5;round++){
  for(const index of [0,1,0,1]){await click('Backspace',index);await sleep(40);}
  await sleep(800);records.push({phase:'rapid-sources',round,state:await snapshot()});
 }
 for(let round=0;round<5;round++){
  await click('Backspace',round%2);await sleep(30);await click('Cancelar');await sleep(40);await click('Compartilhar tela');await sleep(180);records.push({phase:'cancel-reopen',round,state:await snapshot()});
  // Auto-selected last source may change the source tab.
  await s.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/^Janelas[0-9]+$/.test(e.innerText.trim()));b?.click()})()`);await sleep(80);
 }
 await click('Cancelar');await sleep(1000);records.push({phase:'final-cancelled',state:await snapshot()});
 await fs.writeFile(`${output}/rapid.json`,JSON.stringify(records,null,2));
 console.log(JSON.stringify(records.filter(r=>r.phase||r.blocked||r.error).map(r=>r.phase?{phase:r.phase,round:r.round,open:r.state.open,sharing:r.state.sharing,config:r.state.config,videos:r.state.videos,liveCaptures:r.state.captures?.filter(c=>c.tracks?.some(t=>t.state==='live')).length}:r),null,2));
 }
}finally{s.close();}
