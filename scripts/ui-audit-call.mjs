import fs from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {connect} from './ui-audit-cdp.mjs';
const s=await connect();let adminToken;let callerSocket;const records=[];const pause=ms=>new Promise(r=>setTimeout(r,ms));
const api=async(route,token,body,method='POST')=>{const r=await fetch('http://127.0.0.1:3006/api'+route,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw new Error(route+' '+r.status);return r.json();};
async function button(label){const p=await s.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.innerText.trim()===${JSON.stringify(label)}||e.title===${JSON.stringify(label)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);if(!p)throw new Error('Missing '+label);for(const type of ['mousePressed','mouseReleased'])await s.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...p});}
try{
 const admin=await s.evaluate('window.__auditAuth.getState().user');adminToken=await s.evaluate(`localStorage.getItem('backspace_token')`);
 await s.evaluate('window.__auditAuth.getState().logout()');await pause(300);await s.send('Page.navigate',{url:'http://127.0.0.1:5180/register'});await pause(700);
 const username='audit_caller_'+Date.now(),password=randomBytes(20).toString('base64url');
 await s.evaluate(`(()=>{const inputs=[...document.querySelectorAll('input')];const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;[${JSON.stringify(username)},${JSON.stringify(password)},${JSON.stringify(password)}].forEach((value,i)=>{setter.call(inputs[i],value);inputs[i].dispatchEvent(new Event('input',{bubbles:true}));})})()`);await pause(600);await button('Continuar');await pause(400);
 records.push({phase:'registration-step-two',state:await s.evaluate(`({text:document.body.innerText,fields:[...document.querySelectorAll('input')].map(e=>({type:e.type}))})`)});
 const translations=JSON.parse(await fs.readFile('packages/web/src/locales/pt/auth.json','utf8'));await button(translations.register.submit);await pause(1000);
 const caller=await s.evaluate('window.__auditAuth.getState().user');if(caller?.username!==username)throw new Error('Registration did not authenticate the test caller');
 const token=await s.evaluate(`localStorage.getItem('backspace_token')`);
 records.push({phase:'registration-complete',username:caller.username,admin:caller.isAdmin});
 const denied=await fetch('http://127.0.0.1:3006/api/admin/storage/stats',{headers:{Authorization:'Bearer '+token}});records.push({phase:'admin-access-denied',status:denied.status});
 const authPath='tests/.tmp/ui-audit/production/auth.json';const auth=JSON.parse(await fs.readFile(authPath,'utf8'));const denial=auth.find(r=>r.phase==='admin-access-denied');denial.status=denied.status;denial.endpoint='/api/admin/storage/stats';await fs.writeFile(authPath,JSON.stringify(auth,null,2));
 const request=await api('/social/requests',token,{username:admin.username});await api('/social/requests/'+request.requestId,adminToken,{status:'accepted'},'PATCH');
 const dm=await api('/dm',token,{userId:admin.id});
 await s.evaluate(`localStorage.setItem('backspace_token',${JSON.stringify(adminToken)})`);await s.send('Page.navigate',{url:'http://127.0.0.1:5180/channels/@me'});await pause(1200);
 callerSocket=new WebSocket('ws://127.0.0.1:3006/ws');let ready=false;const events=[];
 callerSocket.addEventListener('message',e=>{const packet=JSON.parse(e.data);events.push({type:packet.type,code:packet.code});if(packet.type==='ready')ready=true;});
 await new Promise((resolve,reject)=>{callerSocket.addEventListener('open',resolve,{once:true});callerSocket.addEventListener('error',reject,{once:true});});callerSocket.send(JSON.stringify({type:'auth',token,client:'web'}));
 for(let i=0;i<40&&!ready;i++)await pause(100);if(!ready)throw new Error('Caller WebSocket did not authenticate');
 const started=Date.now();callerSocket.send(JSON.stringify({type:'dm_call_start',dmChannelId:dm.id}));let visible=false;
 for(let i=0;i<100;i++){visible=await s.evaluate(`!!document.querySelector('button[title="Recusar"]')`);if(visible)break;await pause(50);}
 records.push({phase:'incoming-call',visible,latencyMs:Date.now()-started,events});if(!visible)throw new Error('Incoming call did not appear');
 const image=await s.send('Page.captureScreenshot',{format:'png'});await fs.writeFile('tests/.tmp/ui-audit/production/incoming-call.png',Buffer.from(image.data,'base64'));
 await button('Recusar');await pause(300);records.push({phase:'call-declined',visible:await s.evaluate(`!!document.querySelector('button[title="Recusar"]')`)});
 await fs.writeFile('tests/.tmp/ui-audit/production/call.json',JSON.stringify(records,null,2));console.log(JSON.stringify(records,null,2));
}finally{callerSocket?.close();if(adminToken){await s.evaluate(`localStorage.setItem('backspace_token',${JSON.stringify(adminToken)})`);await s.send('Page.navigate',{url:'http://127.0.0.1:5180/channels/@me'});}s.close();}
