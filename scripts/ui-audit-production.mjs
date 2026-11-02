import fs from 'node:fs/promises';
import {openSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {connect} from './ui-audit-cdp.mjs';

const root=process.cwd(),web=path.join(root,'packages/web'),out=path.join(root,'tests/.tmp/ui-audit/production');
await fs.mkdir(out,{recursive:true});
const config=path.join(out,'vite.config.mts');
const base=path.join(web,'vite.config.ts').replaceAll('\\','/');
await fs.writeFile(config,`import base from ${JSON.stringify(base)};
export default {...base,plugins:[...base.plugins,{name:'audit-only-observation',transformIndexHtml:{order:'pre',handler(){return [{tag:'script',attrs:{type:'module'},injectTo:'head',children:'import {useUIStore} from "/src/stores/uiStore.ts";import {useSpaceStore} from "/src/stores/spaceStore.ts";import {useAuthStore} from "/src/stores/authStore.ts";window.__auditUI=useUIStore;window.__auditSpace=useSpaceStore;window.__auditAuth=useAuthStore;'}]}}}],build:{...base.build,outDir:${JSON.stringify(path.join(out,'dist').replaceAll('\\','/'))},emptyOutDir:true},preview:{host:'127.0.0.1',port:5180,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:3006',changeOrigin:true},'/ws':{target:'ws://127.0.0.1:3006',ws:true}}}};`);
const vite=path.join(web,'node_modules/vite/bin/vite.js');
const reuse=process.argv.includes('--reuse-build');
if(!reuse){
await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[vite,'build','--config',config],{cwd:web,stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Vite build failed: '+code)));});
}
const launch=(args,cwd,env,name,runtime=process.execPath)=>{const stdout=openSync(path.join(out,name+'.log'),'a');const stderr=openSync(path.join(out,name+'.err.log'),'a');const child=spawn(runtime,args,{cwd,env:{...process.env,...env},stdio:['ignore',stdout,stderr],detached:true,windowsHide:true});child.unref();return child.pid;};
const electron=createRequire(path.join(root,'packages/desktop/package.json'))('electron');
const server=launch(['--import','tsx/esm','src/index.ts'],path.join(root,'packages/server'),{ELECTRON_RUN_AS_NODE:'1',PORT:'3006',HOST:'127.0.0.1',DB_PATH:path.join(out,'backspace.db'),UPLOAD_DIR:path.join(out,'uploads'),REGISTRATION_OPEN:'true',PUBLIC_ORIGIN:'http://127.0.0.1:3006',DIRECTORY_ENDPOINT:'',BACKSPACE_UPDATE_CHECK:'false'},'server',electron);
const preview=reuse?JSON.parse(await fs.readFile(path.join(out,'processes.json'),'utf8')).preview:launch([vite,'preview','--config',config],web,{},'preview');
await fs.writeFile(path.join(out,'processes.json'),JSON.stringify({server,preview,database:path.join(out,'backspace.db')},null,2));
for(let attempt=0;attempt<40;attempt++){try{const response=await fetch('http://127.0.0.1:5180/api/health');if(response.ok)break;}catch{}await new Promise(r=>setTimeout(r,500));}
const password=randomBytes(20).toString('base64url');
const registration=await fetch('http://127.0.0.1:3006/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'production_audit_admin',displayName:'UI Audit Admin',password})});
if(!registration.ok)throw new Error('Isolated registration failed: '+registration.status);
const account=await registration.json();
if(!account.user.isAdmin)throw new Error('Fresh audit database did not produce an administrator');
const api=async(route,token,body,method='POST')=>{const response=await fetch('http://127.0.0.1:3006/api'+route,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});if(!response.ok)throw new Error(route+' '+response.status);return response.json();};
const members=[];
for(let i=1;i<=2;i++){
 const member=await api('/auth/register','',{username:'production_audit_member'+i,password,displayName:'Audit Member '+i});
 const request=await api('/social/requests',account.token,{username:member.user.username});
 await api('/social/requests/'+request.requestId,member.token,{status:'accepted'},'PATCH');members.push(member.user);
}
const dm=await api('/dm',account.token,{userId:members[0].id});
const group=await api('/dm/group',account.token,{users:members.map(m=>({id:m.id}))});
await fs.writeFile(path.join(out,'extra-fixtures.json'),JSON.stringify({members,dm,group},null,2));
const session=await connect();
try{
 await session.send('Page.navigate',{url:'http://127.0.0.1:5180/login'});
 for(let attempt=0;attempt<40;attempt++){await new Promise(r=>setTimeout(r,300));try{if(await session.evaluate('document.querySelectorAll("input").length>=2'))break;}catch{}}
 await session.evaluate(`(()=>{const fields=[...document.querySelectorAll('input')];const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [i,value] of [${JSON.stringify(account.user.username)},${JSON.stringify(password)}].entries()){setter.call(fields[i],value);fields[i].dispatchEvent(new Event('input',{bubbles:true}));}fields[0].closest('form').requestSubmit();})()`);
 await new Promise(r=>setTimeout(r,1500));
 console.log(JSON.stringify(await session.evaluate('({url:location.href,user:window.__auditAuth?.getState().user?.username,admin:window.__auditAuth?.getState().user?.isAdmin})')));
}finally{session.close();}
