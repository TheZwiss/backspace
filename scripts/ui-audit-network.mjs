import fs from 'node:fs/promises';
import {connect} from './ui-audit-cdp.mjs';
const output=process.env.AUDIT_OUTPUT??'tests/.tmp/ui-audit';
await fs.mkdir(output,{recursive:true});
const session=await connect();
const requests=new Map();let cursor=0;let running=true;
process.on('SIGINT',()=>running=false);process.on('SIGTERM',()=>running=false);
const started=Date.now();
while(running&&Date.now()-started<900000){
 for(const event of session.events.slice(cursor)){
  const p=event.params;
  if(event.method==='Network.requestWillBeSent'){
   const url=new URL(p.request.url);
   requests.set(p.requestId,{id:p.requestId,url:url.origin+url.pathname,method:p.request.method,type:p.type,start:p.timestamp,at:new Date(p.wallTime*1000).toISOString(),initiator:p.initiator.stack?.callFrames?.slice(0,3).map(f=>({function:f.functionName,line:f.lineNumber,url:f.url.split('?')[0]}))});
  }else if(event.method==='Network.responseReceived'){
   const r=requests.get(p.requestId);if(r){r.status=p.response.status;r.responseMs=(p.timestamp-r.start)*1000;r.cache=p.response.fromDiskCache??false;}
  }else if(event.method==='Network.loadingFinished'||event.method==='Network.loadingFailed'){
   const r=requests.get(p.requestId);if(r){r.durationMs=(p.timestamp-r.start)*1000;r.bytes=p.encodedDataLength;r.error=p.errorText;}
  }
 }
 cursor=session.events.length;
 await fs.writeFile(`${output}/requests.json`,JSON.stringify([...requests.values()],null,2));
 await new Promise(resolve=>setTimeout(resolve,1000));
}
session.close();console.log(JSON.stringify({requests:requests.size,output}));
