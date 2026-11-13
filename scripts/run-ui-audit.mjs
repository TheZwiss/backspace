import fs from 'node:fs/promises';
import { connect } from './ui-audit-cdp.mjs';

const repetitions = Number(process.env.AUDIT_REPETITIONS ?? 20);
const output = process.env.AUDIT_OUTPUT ?? 'tests/.tmp/ui-audit';
await fs.mkdir(output,{recursive:true});
const session = await connect();
const results=process.env.AUDIT_RESUME==='1'?JSON.parse(await fs.readFile(`${output}/results.json`,'utf8')):[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const setup = `async()=>{
  window.__auditUI??=(await import('/src/stores/uiStore.ts')).useUIStore;
  window.__auditSpace??=(await import('/src/stores/spaceStore.ts')).useSpaceStore;
  window.__auditAuth??=(await import('/src/stores/authStore.ts')).useAuthStore;
  window.__auditTasks=[];window.__auditShifts=[];window.__auditMutation=performance.now();
  window.__auditObserver?.disconnect();window.__auditObserver=new MutationObserver(()=>window.__auditMutation=performance.now());window.__auditObserver.observe(document.body,{subtree:true,childList:true,characterData:true});
  try{new PerformanceObserver(list=>window.__auditTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:false});}catch{}
  try{new PerformanceObserver(list=>window.__auditShifts.push(...list.getEntries().map(e=>({start:e.startTime,value:e.value,recentInput:e.hadRecentInput})))).observe({type:'layout-shift',buffered:false});}catch{}
  return {url:location.href,user:window.__auditAuth.getState().user.username,admin:window.__auditAuth.getState().user.isAdmin};
}`;
const snapshot = `(()=>{
 const modals=[...document.querySelectorAll('.glass-modal')].filter(e=>e.getBoundingClientRect().width>0); const root=modals.at(-1)??document.body;
 const blocked=[],disabled=[]; let visible=0;
 for(const e of root.querySelectorAll('button,input,select,textarea,a,[role="button"]')){
 const r=e.getBoundingClientRect();const s=getComputedStyle(e);if(r.width<2||r.height<2||s.visibility==='hidden'||s.display==='none')continue;
 const x=r.x+r.width/2,y=r.y+r.height/2;if(x<0||x>=innerWidth||y<0||y>=innerHeight)continue;
 let clipped=false;for(let p=e.parentElement;p&&p!==document.body;p=p.parentElement){const st=getComputedStyle(p);if(/hidden|auto|scroll|clip/.test(st.overflow+st.overflowX+st.overflowY)){const pr=p.getBoundingClientRect();if(x<pr.left||x>pr.right||y<pr.top||y>pr.bottom){clipped=true;break;}}}if(clipped)continue;
 const label=(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||e.placeholder||e.tagName).slice(0,100);visible++;
 if(e.disabled||e.getAttribute('aria-disabled')==='true'){disabled.push(label);continue;}
 const hit=document.elementFromPoint(x,y);if(hit!==e&&!e.contains(hit)){blocked.push({label,by:hit?.outerHTML.slice(0,220),pointerEvents:s.pointerEvents});}
 }
 return {url:location.pathname,title:root.querySelector('h1,h2,h3')?.textContent,body:root.innerText.slice(0,650),modalCount:modals.length,visibleControls:visible,blocked,disabled,statuses:[...root.querySelectorAll('[role="status"],[aria-busy="true"]')].map(e=>e.textContent),mutationAge:performance.now()-window.__auditMutation,now:performance.now(),tasks:window.__auditTasks,shifts:window.__auditShifts};
})()`;

async function measure(name,action,metadata={}){
 if(process.env.AUDIT_FILTER&&!new RegExp(process.env.AUDIT_FILTER).test(name))return;
 if(results.some(result=>result.name===name))return;
 const samples=[];
 for(let i=0;i<repetitions+1;i++){
  await session.evaluate(`window.__auditUI.getState().closeModal()`);
  if(metadata.trigger==='router-navigation'){
   const baseline=name==='page:friends'?windowFixturePath:'/channels/@me';
   await session.evaluate(`history.pushState({},'',${JSON.stringify(baseline)});dispatchEvent(new PopStateEvent('popstate'))`);
  }
  await pause(350);
  const start=await session.evaluate('performance.now()');
  const eventStart=session.events.length;
  if(typeof action==='function')await action();else await session.evaluate(action);
  const painted=await session.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()))))');
  const deadline=Date.now()+6000;let state;
  do{await pause(80);state=await session.evaluate(snapshot);}while((state.mutationAge<250||state.now-start<350)&&Date.now()<deadline);
  if(name.startsWith('page:')&&state.modalCount>0)throw new Error(`Unexpected overlay prevents page audit: ${state.title}`);
  const sample={firstPaintMs:painted-start,settledMs:state.now-start,timeout:state.mutationAge<250,modalCount:state.modalCount,title:state.title,visibleControls:state.visibleControls,blocked:state.blocked,disabled:state.disabled,statuses:state.statuses,longTasks:state.tasks.filter(t=>t.start>=start),layoutShifts:state.shifts.filter(t=>t.start>=start),exceptions:session.events.slice(eventStart).filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.text)};
  if(i===0)sample.body=state.body;
  samples.push(sample);
 }
 const warm=samples.slice(1);const percentile=(key,p)=>{const sorted=warm.map(s=>s[key]).sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)];};
 const result={name,...metadata,first:samples[0],warm:{count:warm.length,paintP50:percentile('firstPaintMs',.5),paintP95:percentile('firstPaintMs',.95),settledP50:percentile('settledMs',.5),settledP95:percentile('settledMs',.95),max:Math.max(...warm.map(s=>s.settledMs))},samples};
 results.push(result);await fs.writeFile(`${output}/results.json`,JSON.stringify(results,null,2));
 const screenshot=await session.send('Page.captureScreenshot',{format:'png'});
 await fs.writeFile(`${output}/${name.replaceAll(':','-')}.png`,Buffer.from(screenshot.data,'base64'));
 console.log(JSON.stringify({name,firstPaint:result.first.firstPaintMs,p95:result.warm.paintP95,settledP95:result.warm.settledP95,modalCount:result.first.modalCount,blocked:result.first.blocked.map(b=>b.label),title:result.first.title}));
}

let windowFixturePath;
try{
 await session.send('Page.bringToFront');
 const environment=await session.evaluate(`(${setup})()`);
 await fs.writeFile(`${output}/environment.json`,JSON.stringify({...environment,startedAt:new Date().toISOString(),repetitions},null,2));
 const fixture=await session.evaluate(`(async()=>{const s=window.__auditSpace;await s.getState().loadSpaces();let space=s.getState().spaces.find(s=>s.name==='UI Audit — disposable');if(!space)space=await s.getState().createSpace({name:'UI Audit — disposable',visibility:'private'});s.getState().setCurrentSpace(space.id);await s.getState().loadSpaceDetail(space.id);const state=s.getState();return {id:space.id,channels:state.channels,categories:state.categories,user:window.__auditAuth.getState().user.id};})()`);
 await fs.writeFile(`${output}/fixture.json`,JSON.stringify(fixture,null,2));
 const channel=fixture.channels.find(c=>c.type==='text'&&c.spaceId===fixture.id)??fixture.channels.find(c=>c.type==='text');
 const category=fixture.categories.find(c=>c.spaceId===fixture.id)??fixture.categories[0];
 windowFixturePath=`/channels/${fixture.id}/${channel.id}`;
 const navigate=path=>`history.pushState({},'',${JSON.stringify(path)});dispatchEvent(new PopStateEvent('popstate'))`;
 for(const [name,path] of [['page:friends','/channels/@me'],['page:explore','/explore'],['page:backspace','/backspace'],['page:text-channel',`/channels/${fixture.id}/${channel.id}`]])await measure(name,navigate(path),{trigger:'router-navigation'});
 await session.evaluate(navigate(`/channels/${fixture.id}/${channel.id}`));await pause(500);
 for(const modal of ['createSpace','joinSpace','createChannel','createCategory','invite','newDm','bookmarks','spaceProfile','soundboard','channelSettings','categorySettings','userProfile','memberRoles']){
  const data={spaceId:fixture.id,channelId:channel.id,categoryId:category?.id,userId:fixture.user};
  await measure(`modal:${modal}`,`window.__auditUI.getState().openModal(${JSON.stringify(modal)},${JSON.stringify(data)})`,{trigger:'store-open'});
 }
 for(const tab of ['account','appearance','voice','privacy','stickers','connections','keybinds','desktop'])await measure(`settings:${tab}`,`window.__auditUI.getState().openModal('userSettings',{tab:${JSON.stringify(tab)}})`,{trigger:'store-deep-link'});
 for(const tab of ['overview','discovery','members','roles','bans','soundboard','stickers'])await measure(`space-settings:${tab}`,`window.__auditUI.getState().openModal('spaceSettings',{tab:${JSON.stringify(tab)}})`,{trigger:'store-deep-link'});
 if(environment.admin){
  for(const label of ['Geral','Cadastro','Federação','Transmissão','Armazenamento','Usuários','Atualizações','Oi'])await measure(`admin:${label}`,async()=>{
   await session.evaluate(`window.__auditUI.getState().openModal('userSettings',{tab:'instance'})`);
   let point;
   for(let attempt=0;attempt<60;attempt++){
    point=await session.evaluate(`(async()=>{const e=[...document.querySelectorAll('.glass-modal button')].find(e=>e.innerText.trim()===${JSON.stringify(label)});if(!e)return null;e.scrollIntoView({block:'nearest',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))return null;return {x,y}})()`);
    if(point)break;await pause(50);
   }
   if(!point)throw new Error('Admin tab unavailable: '+label);
   await session.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
   await session.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
  },{trigger:'real-pointer-after-open'});
 }
 await session.evaluate('window.__auditUI.getState().closeModal()');await pause(400);
 await fs.writeFile(`${output}/network-errors.json`,JSON.stringify(session.events.filter(e=>['Network.loadingFailed','Runtime.exceptionThrown','Log.entryAdded'].includes(e.method)),null,2));
 console.log(JSON.stringify({complete:true,surfaces:results.length,output}));
} finally{session.close();}
