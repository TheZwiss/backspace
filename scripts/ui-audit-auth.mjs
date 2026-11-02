import fs from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {connect} from './ui-audit-cdp.mjs';
const session=await connect();const records=[];const pause=ms=>new Promise(r=>setTimeout(r,ms));
let savedToken;
try{
 savedToken=await session.evaluate(`localStorage.getItem('backspace_token')`);
 await session.evaluate('window.__auditAuth.getState().logout()');await pause(350);
 for(const route of ['/register','/login']){
  const samples=[];
  for(let round=0;round<20;round++){
   const other=route==='/login'?'/register':'/login';await session.evaluate(`history.pushState({},'',${JSON.stringify(other)});dispatchEvent(new PopStateEvent('popstate'))`);await pause(50);
   const start=await session.evaluate('performance.now()');await session.evaluate(`history.pushState({},'',${JSON.stringify(route)});dispatchEvent(new PopStateEvent('popstate'))`);
   const paint=await session.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(performance.now()))))');
   samples.push({twoFrameMs:paint-start,state:await session.evaluate(`({url:location.pathname,inputs:[...document.querySelectorAll('input')].map(e=>({type:e.type,disabled:e.disabled})),text:document.body.innerText.slice(-1000)})`)});
  }
  records.push({route,samples});const image=await session.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(`tests/.tmp/ui-audit/production/auth-${route.slice(1)}.png`,Buffer.from(image.data,'base64'));
 }
 const password=randomBytes(20).toString('base64url');const username='audit_login_'+Date.now();
 const response=await fetch('http://127.0.0.1:3006/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});if(!response.ok)throw new Error('Disposable registration: '+response.status);
 await session.evaluate(`(()=>{const fields=[...document.querySelectorAll('input')];const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;[${JSON.stringify(username)},${JSON.stringify(password)}].forEach((value,i)=>{setter.call(fields[i],value);fields[i].dispatchEvent(new Event('input',{bubbles:true}));});fields[0].closest('form').requestSubmit()})()`);await pause(1000);
 const signedIn=await session.evaluate('({user:window.__auditAuth.getState().user?.username,admin:window.__auditAuth.getState().user?.isAdmin,url:location.pathname})');records.push({phase:'actual-login',...signedIn});
 if(signedIn.user!==username)throw new Error('Login did not reach the disposable account');
 records.push({phase:'admin-access-denied',status:await session.evaluate(`fetch('/api/admin/storage/stats',{headers:{Authorization:'Bearer '+localStorage.getItem('backspace_token')}}).then(r=>r.status)`)});
 await session.evaluate(`history.pushState({},'','/join/ui_audit_invalid');dispatchEvent(new PopStateEvent('popstate'))`);await pause(500);records.push({phase:'invalid-invite',state:await session.evaluate(`({url:location.pathname,text:document.body.innerText.slice(-1000)})`)});
 await fs.writeFile('tests/.tmp/ui-audit/production/auth.json',JSON.stringify(records,null,2));console.log(JSON.stringify(records.map(r=>r.samples?{route:r.route,count:r.samples.length,last:r.samples.at(-1)}:r),null,2));
}finally{
 if(savedToken){await session.evaluate(`localStorage.setItem('backspace_token',${JSON.stringify(savedToken)})`);await session.send('Page.navigate',{url:'http://127.0.0.1:5180/channels/@me'});await pause(1000);}
 session.close();
}
