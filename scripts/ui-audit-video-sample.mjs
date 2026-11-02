import fs from 'node:fs/promises';
import {connect} from './ui-audit-cdp.mjs';
const session=await connect(Number(process.env.AUDIT_PORT??9224));const samples=[];const start=Date.now();
try{
 while(Date.now()-start<15000){samples.push({elapsed:Date.now()-start,state:await session.evaluate(`[...document.querySelectorAll('video')].map(v=>({time:v.currentTime,ready:v.readyState,paused:v.paused,frames:v.getVideoPlaybackQuality().totalVideoFrames,dropped:v.getVideoPlaybackQuality().droppedVideoFrames,width:v.videoWidth,height:v.videoHeight,track:v.srcObject?.getVideoTracks()[0]?.id}))`)});await new Promise(r=>setTimeout(r,100));}
 await fs.writeFile('tests/.tmp/ui-audit/screen-share/remote-cadence.json',JSON.stringify(samples,null,2));console.log(JSON.stringify({count:samples.length,first:samples[0],last:samples.at(-1)}));
}finally{session.close();}
