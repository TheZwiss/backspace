import fs from 'node:fs/promises';
import {connect} from './ui-audit-cdp.mjs';
const s=await connect();const out='tests/.tmp/ui-audit/production/extras';await fs.mkdir(out,{recursive:true});
const fixture=JSON.parse(await fs.readFile('tests/.tmp/ui-audit/production/measurements/fixture.json','utf8'));
const extra=JSON.parse(await fs.readFile('tests/.tmp/ui-audit/production/extra-fixtures.json','utf8'));
const channel=fixture.channels.find(c=>c.type==='text');const filter=process.env.AUDIT_EXTRA_FILTER?new RegExp(process.env.AUDIT_EXTRA_FILTER):null;const results=filter?(JSON.parse(await fs.readFile(`${out}/results.json`,'utf8'))).filter(r=>!filter.test(r.name)):[];const pause=ms=>new Promise(r=>setTimeout(r,ms));
const navigate=async(path,settle=true)=>{await s.evaluate(`history.pushState({},'',${JSON.stringify(path)});dispatchEvent(new PopStateEvent('popstate'))`);if(settle)await pause(250);};
const open=async(modal,data={})=>s.evaluate(`window.__auditUI.getState().openModal(${JSON.stringify(modal)},${JSON.stringify(data)})`);
async function click(label,prefix=false){
 const p=await s.evaluate(`(async()=>{const e=[...document.querySelectorAll('button,[role="button"]')].find(e=>${prefix?`e.innerText.trim().startsWith(${JSON.stringify(label)})`:`e.innerText.trim()===${JSON.stringify(label)}`}||e.title===${JSON.stringify(label)}||e.getAttribute('aria-label')===${JSON.stringify(label)});if(!e)return {error:'missing'};e.scrollIntoView({block:'nearest',behavior:'instant'});await new Promise(r=>requestAnimationFrame(r));const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);return {x,y,blocked:!e.contains(hit),disabled:e.disabled,hit:hit?.outerHTML.slice(0,150)}})()`);
 if(p.error||p.disabled||p.blocked)throw new Error(JSON.stringify({label,...p}));
 for(const type of ['mousePressed','mouseReleased'])await s.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:p.x,y:p.y});
}
async function inspect(name,prepare,action){
 if(filter&&!filter.test(name))return;
 const samples=[];
 for(let round=0;round<5;round++){
  for(const type of ['keyDown','keyUp'])await s.send('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await s.evaluate(`window.__auditUI.getState().closeModal()`);await pause(250);
  try{
   await prepare();const start=await s.evaluate('performance.now()');await action();
   const painted=await s.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(performance.now()))))');await pause(400);
   const state=await s.evaluate(`(()=>{const modal=[...document.querySelectorAll('.glass-modal')].at(-1);return {url:location.pathname,modalCount:document.querySelectorAll('.glass-modal').length,title:modal?.querySelector('h1,h2,h3')?.textContent,text:(modal??document.body).innerText.slice(-1900),buttons:[...(modal??document.body).querySelectorAll('button')].map(e=>({text:e.innerText.trim(),title:e.title,aria:e.getAttribute('aria-label')})),images:[...(modal??document.body).querySelectorAll('img')].map(i=>({complete:i.complete,width:i.naturalWidth})),fields:[...(modal??document.body).querySelectorAll('input')].map(e=>({type:e.type,disabled:e.disabled}))}})()`);
   samples.push({twoFrameMs:painted-start,state});
  }catch(error){samples.push({error:error.message});break;}
 }
 const entry={name,samples};results.push(entry);await fs.writeFile(`${out}/results.json`,JSON.stringify(results,null,2));
 const image=await s.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(`${out}/${name.replaceAll(':','-')}.png`,Buffer.from(image.data,'base64'));
 console.log(JSON.stringify({name,count:samples.length,error:samples.find(r=>r.error)?.error,title:samples[0]?.state?.title,twoFrameMs:samples[0]?.twoFrameMs}));
}
try{
 await s.send('Page.bringToFront');
 const spacePath=`/channels/${fixture.id}/${channel.id}`;
 for(const [name,id] of [['dm',extra.dm.id],['group',extra.group.id]])await inspect('page:'+name,()=>navigate(spacePath),()=>navigate(`/channels/@me/${id}`,false));
 for(const tab of ['overview','members'])await inspect('group-settings:'+tab,()=>navigate(`/channels/@me/${extra.group.id}`),()=>open('groupDmSettings',{dmChannelId:extra.group.id,initialTab:tab}));
 await inspect('modal:addDmMember',()=>navigate(`/channels/@me/${extra.group.id}`),()=>open('addDmMember',{dmChannelId:extra.group.id}));
 for(const [modal,data] of [['channelSettings',{channelId:channel.id}],['categorySettings',{categoryId:fixture.categories[0].id}]])await inspect(modal+':permissions',async()=>{await navigate(spacePath);await open(modal,data);await pause(250);},()=>click('Permissões'));
 for(const tab of ['Amigos em comum','Espaços em comum'])await inspect('profile:'+tab,async()=>{await open('userProfile',{userId:fixture.user});await pause(300);},()=>click(tab,true));
 await inspect('modal:imagePreview',()=>navigate(spacePath),()=>s.evaluate(`(()=>{const c=document.createElement('canvas');c.width=c.height=512;const ctx=c.getContext('2d');ctx.fillStyle='#7563ec';ctx.fillRect(0,0,512,512);ctx.fillStyle='white';ctx.font='48px sans-serif';ctx.fillText('UI AUDIT',100,260);window.__auditImage=c.toDataURL();window.__auditUI.getState().openImagePreview(window.__auditImage)})()`));
 await inspect('modal:avatarCrop',async()=>{await open('userSettings',{tab:'account'});await pause(300);},()=>s.evaluate(`new Promise(resolve=>{const c=document.createElement('canvas');c.width=c.height=512;const ctx=c.getContext('2d');ctx.fillStyle='#7563ec';ctx.fillRect(0,0,512,512);c.toBlob(blob=>{const input=document.querySelector('.glass-modal input[type="file"]');const files=new DataTransfer();files.items.add(new File([blob],'ui-audit.png',{type:'image/png'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));resolve(true);});})`));
 await inspect('popover:notifications',()=>navigate(spacePath),()=>click('Configurações de notificação'));
 await inspect('modal:transfers',()=>navigate(spacePath),()=>click('Transferências'));
 await inspect('modal:ownerTitle',()=>navigate(spacePath),()=>click('Editar título do dono'));
 await s.evaluate(`window.__auditUI.getState().closeModal()`);await navigate(spacePath);
 console.log(JSON.stringify({complete:true,cases:results.length}));
}finally{s.close();}
