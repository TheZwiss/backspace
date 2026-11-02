import fs from 'node:fs/promises';
import {connect} from './ui-audit-cdp.mjs';
const s=await connect();const out='tests/.tmp/ui-audit/production/contexts';await fs.mkdir(out,{recursive:true});
const fixture=JSON.parse(await fs.readFile('tests/.tmp/ui-audit/production/measurements/fixture.json','utf8'));
const extra=JSON.parse(await fs.readFile('tests/.tmp/ui-audit/production/extra-fixtures.json','utf8'));
const pt=JSON.parse(await fs.readFile('packages/web/src/locales/pt/chat.json','utf8'));const voiceOnly=process.env.AUDIT_CONTEXT_START==='voice';const records=voiceOnly?(JSON.parse(await fs.readFile(`${out}/results.json`,'utf8'))).filter(r=>!/^voice-|^text-voice|^soundboard|^staged-|^live-/.test(r.name)):[];const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function point(expression,button='left'){
 const p=await s.evaluate(`(async()=>{const e=${expression};if(!e)return {error:'missing'};e.scrollIntoView({block:'nearest',behavior:'instant'});await new Promise(r=>requestAnimationFrame(r));const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);return {x,y,blocked:!e.contains(hit),disabled:e.disabled,by:hit?.outerHTML.slice(0,150)}})()`);
 if(p.error||p.blocked||p.disabled)throw new Error(JSON.stringify(p));for(const type of ['mousePressed','mouseReleased'])await s.send('Input.dispatchMouseEvent',{type,button,clickCount:1,x:p.x,y:p.y});await pause(200);
}
const click=(label,prefix=false)=>point(`(()=>{const matches=[...document.querySelectorAll('button,[role="button"]')].filter(e=>${prefix?`e.innerText.trim().startsWith(${JSON.stringify(label)})`:`e.innerText.trim()===${JSON.stringify(label)}`}||e.title===${JSON.stringify(label)}||e.getAttribute('aria-label')===${JSON.stringify(label)}).reverse();return matches.find(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})??matches[0]})()`);
async function escape(){for(const type of ['keyDown','keyUp'])await s.send('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await pause(200);}
async function reset(){await escape();await escape();await s.evaluate('window.__auditUI.getState().closeModal()');for(const type of ['mousePressed','mouseReleased'])await s.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:1270,y:790});await pause(200);}
async function record(name){const state=await s.evaluate(`({url:location.pathname,text:document.body.innerText.slice(-2400),headings:[...document.querySelectorAll('h1,h2,h3')].map(e=>e.textContent),buttons:[...document.querySelectorAll('button')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height}).map(e=>({text:e.innerText,aria:e.getAttribute('aria-label'),title:e.title}))})`);records.push({name,state});const image=await s.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(`${out}/${name}.png`,Buffer.from(image.data,'base64'));await fs.writeFile(`${out}/results.json`,JSON.stringify(records,null,2));console.log(JSON.stringify({name,headings:state.headings.slice(-3)}));}
const navigate=async path=>{await s.evaluate(`history.pushState({},'',${JSON.stringify(path)});dispatchEvent(new PopStateEvent('popstate'))`);await pause(400);};
const spacePath=`/channels/${fixture.id}/${fixture.channels.find(c=>c.type==='text').id}`;
try{
 await s.send('Page.bringToFront');await navigate(spacePath);
 if(!voiceOnly){
 for(const [label,name] of [[pt.composer.emojiPicker,'emoji-picker'],[pt.composer.gifPicker,'gif-picker'],[pt.stickers.title,'sticker-picker']]){
  await reset();
  try{await click(label);await record(name);await escape();}catch(error){records.push({name,error:error.message});}
 }
 try{
  await click(pt.stickers.title);await click(pt.stickers.store);await record('sticker-store');
  for(const label of [pt.stickers.myPacks,pt.stickers.reviews]){await click(label);await record('sticker-store-'+label);}
  await click(pt.stickers.myPacks);await click(pt.stickers.createPack);await record('sticker-pack-editor');await escape();await escape();await escape();
 }catch(error){records.push({name:'sticker-store-details',error:error.message});await s.send('Page.reload');await pause(1000);}
 await navigate(spacePath);
 const spaceButton=`[...document.querySelectorAll('button')].find(e=>{const r=e.getBoundingClientRect();return r.x<72&&r.width>=38&&e.innerText.trim()==='U'})`;
 for(const [label,name] of [['Transferir propriedade','space-transfer-ownership'],['Configurações de notificação','space-notifications']]){
  await reset();
  try{await point(spaceButton,'right');await click(label);await record(name);await escape();}catch(error){records.push({name,error:error.message});await escape();}
 }
 await navigate(`/channels/@me/${extra.group.id}`);
 for(const [label,name] of [['Transferir propriedade','group-transfer-confirmation'],['Remover do grupo','group-kick-confirmation']]){
  await reset();
  try{
   await s.evaluate(`window.__auditUI.getState().openModal('groupDmSettings',{dmChannelId:${JSON.stringify(extra.group.id)},initialTab:'members'})`);await pause(400);
   await point(`document.querySelector('.glass-modal [data-dm-member-row][data-user-id="${extra.members[0].id}"]')`,'right');await click(label);await record(name);await escape();await escape();
  }catch(error){records.push({name,error:error.message});await escape();await s.evaluate('window.__auditUI.getState().closeModal()');}
 }
 await s.evaluate('window.__auditUI.getState().closeModal()');await navigate(spacePath);
 }
 await reset();await navigate(spacePath);await click('voice',true);await pause(1500);
 for(const [label,name] of [['Informações da conexão','voice-connection-info'],['Dispositivos de entrada','voice-input-devices'],['Dispositivos de saída','voice-output-devices'],['Voz por texto','text-voice-composer'],['Efeitos sonoros','soundboard-picker']]){
  await reset();
  try{await click(label);await record(name);await escape();}catch(error){records.push({name,error:error.message});await escape();}
 }
 await reset();await click('Compartilhar tela');
 for(let i=0;i<100;i++){if(await s.evaluate(`!![...document.querySelectorAll('button')].find(e=>/^Janelas[0-9]+$/.test(e.innerText.trim()))`))break;await pause(50);}
 await click('Janelas',true);await click('Backspace');
 for(let i=0;i<100;i++){if(await s.evaluate(`!![...document.querySelectorAll('video')].find(v=>v.readyState>=2&&!v.paused)`))break;await pause(50);}
 await click('Configurações da transmissão');await click('45');
 records.push({name:'staged-fps-controller',state:await s.evaluate(`(()=>{const t=document.querySelector('video')?.srcObject?.getVideoTracks()[0];return {fpsOption:[...document.querySelectorAll('button')].filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.innerText),fps:t?.getSettings().frameRate,canvasController:typeof t?.setDestination}})()`)});
 await click('60');await escape();await click('Iniciar transmissão');await pause(600);await click('Opções de compartilhamento de tela');
 await s.send('Emulation.setDeviceMetricsOverride',{width:1280,height:500,deviceScaleFactor:1,mobile:false});await pause(400);
 // Resizing closes the popover; reopen through the same voice-bar control.
 if(!await s.evaluate(`!!document.querySelector('button[aria-label="Áudio do sistema"]')`))await click('Opções de compartilhamento de tela');
 records.push({name:'live-popover-minimum-window',state:await s.evaluate(`(()=>{const audio=document.querySelector('button[aria-label="Áudio do sistema"]');const stop=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Parar de compartilhar');return {height:innerHeight,audio:audio?.getBoundingClientRect().toJSON(),stop:stop?.getBoundingClientRect().toJSON(),bodyOverflow:getComputedStyle(document.body).overflowY,scrollParents:[...function*(e){for(let p=e?.parentElement;p;p=p.parentElement)yield p}(audio)].map(e=>({overflow:getComputedStyle(e).overflowY,scroll:e.scrollHeight,client:e.clientHeight}))}})()`)});
 await record('live-popover-500px');await s.send('Emulation.clearDeviceMetricsOverride');await pause(250);
 if(!await s.evaluate(`!!document.querySelector('button[aria-label="Áudio do sistema"]')`))await click('Opções de compartilhamento de tela');
 await click('Parar de compartilhar');await click('Desconectar');await record('voice-cleanup');
}finally{
 await s.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});
 await fs.writeFile(`${out}/results.json`,JSON.stringify(records,null,2));s.close();
}
