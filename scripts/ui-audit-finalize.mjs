import fs from 'node:fs/promises';
import {connect} from './ui-audit-cdp.mjs';
const s=await connect();const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function click(label){const p=await s.evaluate(`(()=>{const es=[...document.querySelectorAll('button')].filter(e=>e.innerText.trim()===${JSON.stringify(label)}||e.title===${JSON.stringify(label)}).reverse();const e=es.find(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);if(!p)throw new Error('Unavailable '+label);for(const type of ['mousePressed','mouseReleased'])await s.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...p});await pause(200);}
try{
 await s.send('Page.bringToFront');await s.send('Emulation.setDeviceMetricsOverride',{width:1280,height:500,deviceScaleFactor:1,mobile:false});await pause(250);
 if(!await s.evaluate(`!!document.querySelector('button[aria-label="Áudio do sistema"]')`))await click('Opções de compartilhamento de tela');
 const proof=await s.evaluate(`(()=>{const audio=document.querySelector('button[aria-label="Áudio do sistema"]');const stop=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Parar de compartilhar');return {viewport:{width:innerWidth,height:innerHeight},audio:audio?.getBoundingClientRect().toJSON(),stop:stop?.getBoundingClientRect().toJSON(),rootOverflow:getComputedStyle(document.documentElement).overflow,bodyOverflow:getComputedStyle(document.body).overflow,panelOverflow:audio?getComputedStyle(audio.closest('.glass')).overflow:null}})()`);
 await fs.writeFile('tests/.tmp/ui-audit/screen-share/minimum-window-proof.json',JSON.stringify(proof,null,2));
 await s.send('Emulation.clearDeviceMetricsOverride');await pause(250);
 if(!await s.evaluate(`!!document.querySelector('button[aria-label="Áudio do sistema"]')`))await click('Opções de compartilhamento de tela');
 await click('Parar de compartilhar');await click('Desconectar');await pause(300);
 const productionFinal=await s.evaluate(`({videos:document.querySelectorAll('video').length,liveBadge:document.body.innerText.includes('AO VIVO'),connected:document.body.innerText.includes('Voz conectada')})`);
 await s.send('Page.navigate',{url:'http://localhost:5175/channels/@me'});await pause(1000);
 const original=await s.evaluate(`(async()=>{const v=(await import('/src/stores/voiceStore.ts')).useVoiceStore;v.getState().setScreenShareConfig({height:720,fps:60,mode:'gaming',codec:'vp9',shareAudio:false,customBitrateKbps:null,previewMode:'normal'});if(window.__auditOriginalDisplayMedia)navigator.mediaDevices.getDisplayMedia=window.__auditOriginalDisplayMedia;return {url:location.href,user:(await import('/src/stores/authStore.ts')).useAuthStore.getState().user?.username,connected:v.getState().isLiveKitConnected,sharing:v.getState().isScreenSharing}})()`);
 await fs.writeFile('tests/.tmp/ui-audit/final-state.json',JSON.stringify({minimumWindow:proof,productionFinal,original},null,2));console.log(JSON.stringify({minimumWindow:proof,productionFinal,original},null,2));
}finally{await s.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});s.close();}
