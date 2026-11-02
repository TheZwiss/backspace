import fs from 'node:fs/promises';
import {connect} from './ui-audit-cdp.mjs';
const s=await connect();const records=[];const pause=ms=>new Promise(r=>setTimeout(r,ms));
const output=process.env.AUDIT_OUTPUT??'tests/.tmp/ui-audit';await fs.mkdir(output,{recursive:true});
async function click(label){
 const p=await s.evaluate(`(async()=>{const es=[...document.querySelectorAll('button,[role="button"]')];const e=es.find(e=>e.innerText.trim()===${JSON.stringify(label)}||e.getAttribute('aria-label')===${JSON.stringify(label)}||e.title===${JSON.stringify(label)});if(!e)return {error:'missing'};e.scrollIntoView({block:'nearest',behavior:'instant'});await new Promise(r=>requestAnimationFrame(r));const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);return {x,y,blocked:!e.contains(hit),disabled:e.disabled,hit:hit?.outerHTML.slice(0,200)}})()`);
 if(p.error||p.blocked||p.disabled){records.push({action:label,...p});return false;}
 await s.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:p.x,y:p.y});await s.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:p.x,y:p.y});await pause(350);return true;
}
async function key(key,code){await s.send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code});await s.send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code});await pause(200);}
async function state(){return s.evaluate(`(()=>{const a=document.activeElement;return {activeModal:window.__auditUI.getState().activeModal,dialogRoles:document.querySelectorAll('[role="dialog"],[aria-modal="true"]').length,modalCount:document.querySelectorAll('.glass-modal').length,focus:{tag:a?.tagName,text:(a?.getAttribute('aria-label')||a?.getAttribute('title')||a?.textContent||'').slice(0,100),insideModal:!!a?.closest('.glass-modal')},body:document.body.innerText.slice(-1600),buttons:[...document.querySelectorAll('.glass-modal button')].map(e=>e.innerText.trim()).filter(Boolean)}})()`);}
try{
 await s.send('Page.bringToFront');await s.evaluate('window.__auditUI.getState().closeModal()');await pause(300);
 await click('Configurações');records.push({phase:'settings-open-real-pointer',state:await state()});
 await key('Tab',9);records.push({phase:'settings-first-tab',state:await state()});
 await click('Excluir conta');records.push({phase:'nested-delete-account-open',state:await state()});
 await key('Escape',27);records.push({phase:'nested-delete-account-escape',state:await state()});
 await s.evaluate('window.__auditUI.getState().closeModal()');await pause(300);
 await s.evaluate(`history.pushState({},'','/channels/@me');dispatchEvent(new PopStateEvent('popstate'))`);await pause(350);
 const screens=[['Adicionar um espaço','Criar um espaço'],['Entrar em um espaço','Entrar em um espaço'],['Nova mensagem direta','Nova mensagem direta']];
 for(const [button,expected] of screens){await click(button);records.push({phase:'real-entrypoint',button,expected,state:await state()});await key('Escape',27);}
 const fixture=JSON.parse(await fs.readFile(process.env.AUDIT_FIXTURE??'tests/.tmp/ui-audit/fixture.json','utf8'));
 const text=fixture.channels.find(c=>c.type==='text');const category=fixture.categories[0];
 await s.evaluate(`history.pushState({},'',${JSON.stringify(`/channels/${fixture.id}/${text.id}`)});dispatchEvent(new PopStateEvent('popstate'))`);await pause(400);
 for(const [modal,data,label] of [['channelSettings',{channelId:text.id},'Excluir canal'],['categorySettings',{categoryId:category.id},'Excluir categoria']]){
  await s.evaluate(`window.__auditUI.getState().openModal(${JSON.stringify(modal)},${JSON.stringify(data)})`);await pause(400);await click(label);records.push({phase:modal+'-confirmation',state:await state()});await key('Escape',27);records.push({phase:modal+'-after-escape',state:await state()});await s.evaluate('window.__auditUI.getState().closeModal()');await pause(250);
 }
 await fs.writeFile(`${output}/interactions.json`,JSON.stringify(records,null,2));console.log(JSON.stringify(records.map(r=>({...r,state:r.state?{activeModal:r.state.activeModal,dialogRoles:r.state.dialogRoles,modalCount:r.state.modalCount,focus:r.state.focus,body:r.state.body.slice(-350)}:undefined})),null,2));
}finally{s.close();}
