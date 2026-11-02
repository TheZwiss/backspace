import fs from 'node:fs/promises';
import {connect} from './ui-audit-cdp.mjs';
const session=await connect(Number(process.env.AUDIT_PORT??9223));
const out='tests/.tmp/ui-audit/screen-share';await fs.mkdir(out,{recursive:true});
const action=process.argv[2]??'snapshot';
const started=Date.now();
try{
 await session.send('Page.bringToFront');
 if(action==='escape'){
  await session.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await session.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await new Promise(r=>setTimeout(r,250));
 }
 if(action==='context'){
  const point=await session.evaluate(`(()=>{const r=document.querySelector('video').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await session.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',clickCount:1,...point});
  await session.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',clickCount:1,...point});
  await new Promise(r=>setTimeout(r,350));
 }
 if(action==='join'||action==='click'){
  const query=JSON.stringify(action==='join'?'voice':process.argv[3]);
  const point=await session.evaluate(`(async()=>{const e=[...document.querySelectorAll('button,[role="button"]')].find(e=>e.innerText.trim()===${query}||e.title===${query}||e.getAttribute('aria-label')===${query});if(!e)return null;e.scrollIntoView({block:'nearest',behavior:'instant'});await new Promise(r=>requestAnimationFrame(r));const r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {x:r.x+r.width/2,y:r.y+r.height/2,blocked:!e.contains(hit)}})()`);
  if(!point)throw new Error('Button not found');
  if(point.blocked)throw new Error('Button is covered by another element');
  delete point.blocked;
  await session.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
  await session.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
  await new Promise(resolve=>setTimeout(resolve,action==='join'?4000:1500));
 }
 if(action==='open'){
  await session.evaluate(`(async()=>{await (await import('/src/utils/voiceActions.ts')).handleScreenShareAction()})()`);
  await new Promise(resolve=>setTimeout(resolve,2500));
 }
 const state=await session.evaluate(`(async()=>{const v=(await import('/src/stores/voiceStore.ts')).useVoiceStore.getState();return {url:location.pathname,status:v.voiceConnectionStatus,connected:v.isLiveKitConnected,error:v.connectionError,sharing:v.isScreenSharing,config:v.screenShareConfig,buttons:[...document.querySelectorAll('button')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height}).map(e=>({text:e.innerText,aria:e.getAttribute('aria-label'),title:e.title})),videos:[...document.querySelectorAll('video')].map(e=>({time:e.currentTime,paused:e.paused,ready:e.readyState,width:e.videoWidth,height:e.videoHeight,tracks:e.srcObject?.getVideoTracks().map(t=>({state:t.readyState,settings:t.getSettings()}))})),body:document.body.innerText.slice(-5000)}})()`);
 const result={action,elapsedMs:Date.now()-started,state};
 await fs.writeFile(`${out}/${Date.now()}-${action}.json`,JSON.stringify(result,null,2));
 const screenshot=await session.send('Page.captureScreenshot',{format:'png'});
 await fs.writeFile(`${out}/${Date.now()}-${action}.png`,Buffer.from(screenshot.data,'base64'));
 console.log(JSON.stringify({...result,state:{...state,buttons:state.buttons.slice(-25)}},null,2));
}finally{session.close();}
