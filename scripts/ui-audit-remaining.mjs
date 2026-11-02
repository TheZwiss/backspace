import fs from 'node:fs/promises';
import {connect} from './ui-audit-cdp.mjs';
const s=await connect();const fixture=JSON.parse(await fs.readFile('tests/.tmp/ui-audit/fixture.json','utf8'));const channel=fixture.channels.find(c=>c.type==='text');const records=[];const pause=ms=>new Promise(r=>setTimeout(r,ms));let oldTopic;
async function press(expression,button='left'){const p=await s.evaluate(`(()=>{const e=${expression};if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);if(!p)throw new Error('Control missing');for(const type of ['mousePressed','mouseReleased'])await s.send('Input.dispatchMouseEvent',{type,button,clickCount:1,...p});await pause(250);}
async function record(name){const state=await s.evaluate(`({text:document.body.innerText.slice(-1300),headings:[...document.querySelectorAll('h1,h2,h3')].map(e=>e.textContent)})`);records.push({name,state});const image=await s.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(`tests/.tmp/ui-audit/${name}.png`,Buffer.from(image.data,'base64'));}
try{
 await s.send('Page.bringToFront');await s.evaluate(`history.pushState({},'','/channels/${fixture.id}/${channel.id}');dispatchEvent(new PopStateEvent('popstate'))`);await pause(400);
 oldTopic=await s.evaluate(`(async()=>{const state=(await import('/src/stores/spaceStore.ts')).useSpaceStore;window.__auditSpace=state;await state.getState().loadSpaceDetail('${fixture.id}');return state.getState().channels.find(c=>c.id==='${channel.id}').topic})()`);
 const topic='UI Audit — tópico de teste\nSegunda linha';await s.evaluate(`window.__auditSpace.getState().updateChannel('${channel.id}',{topic:${JSON.stringify(topic)}})`);await pause(200);
 await press(`[...document.querySelectorAll('button')].find(e=>e.title===${JSON.stringify(topic)})`);await record('channel-topic-dialog');
 for(const type of ['keyDown','keyUp'])await s.send('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await pause(200);
 await press(`[...document.querySelectorAll('span,div')].find(e=>e.textContent.trim()==='Test Bob'&&e.getBoundingClientRect().x>1000)`,'right');
 await press(`[...document.querySelectorAll('button')].reverse().find(e=>e.innerText.trim()==='Alterar apelido no espaço…')`);await record('member-nickname-dialog');
 console.log(JSON.stringify(records,null,2));
}finally{
 await s.evaluate(`window.__auditSpace?.getState().updateChannel('${channel.id}',{topic:${JSON.stringify(oldTopic??'')}})`).catch(()=>{});
 for(const type of ['keyDown','keyUp'])await s.send('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27}).catch(()=>{});
 await s.evaluate(`history.pushState({},'','/channels/@me');dispatchEvent(new PopStateEvent('popstate'))`).catch(()=>{});
 await fs.writeFile('tests/.tmp/ui-audit/remaining.json',JSON.stringify(records,null,2));s.close();
}
