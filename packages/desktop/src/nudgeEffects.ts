export type NudgeEffect = 'shake' | 'wave' | 'jelly' | 'knock' | 'confetti' | 'pulse' | import('./msnWinkCatalog').MsnWinkEffect;

export function buildNudgeAnimation(effect: NudgeEffect, start: number, shake: { transform: string }[], volume = .6): string {
  return `new Promise(resolve=>{
    const start=${start},effect=${JSON.stringify(effect)},image=document.querySelector('img');
    const animations=[];
    const animate=(element,frames)=>animations.push(element.animate(frames,{duration:2000,fill:'both',easing:'linear'}));
    setTimeout(()=>{
      if(effect==='wave'){
        const count=24,width=innerWidth/count;
        for(let i=0;i<count;i++){
          const band=document.createElement('div');
          Object.assign(band.style,{position:'absolute',left:(i*width)+'px',top:'-8px',width:(width+1)+'px',height:(innerHeight+16)+'px',overflow:'hidden',willChange:'transform'});
          const copy=image.cloneNode();Object.assign(copy.style,{position:'absolute',left:(-i*width)+'px',top:'8px',width:innerWidth+'px',height:innerHeight+'px'});
          band.append(copy);document.body.append(band);
          animate(band,Array.from({length:61},(_,frame)=>{const t=frame/60;return {transform:'translate3d(0,'+(Math.sin(i/count*Math.PI*2-t*Math.PI*6)*Math.sin(t*Math.PI)*7)+'px,0)'}}));
        }
        image.style.visibility='hidden';
      }else if(effect==='jelly'){
        animate(image,[{transform:'scale(1) skew(0deg)'},{transform:'scale(1.008,.992) skew(.5deg)'},{transform:'scale(.994,1.006) skew(-.4deg)'},{transform:'scale(1.005,.995) skew(.3deg)'},{transform:'scale(.997,1.003) skew(-.2deg)'},{transform:'scale(1) skew(0deg)'}]);
      }else if(effect==='knock'){
        const video=document.querySelector('video');
        if(video){video.style.visibility='visible';video.volume=${volume};video.currentTime=Math.max(0,(Date.now()-start)/1000);video.addEventListener('ended',resolve,{once:true});video.play().catch(resolve);return;}
        animate(image,[{transform:'scale(1)',offset:0},{transform:'scale(1.006) translateY(2px)',offset:.07},{transform:'scale(1)',offset:.15},{transform:'scale(1)',offset:.3},{transform:'scale(1.006) translateY(2px)',offset:.37},{transform:'scale(1)',offset:.45},{transform:'scale(1)',offset:1}]);
      }else if(effect==='confetti'){
        for(let i=0;i<48;i++){
          const particle=document.createElement('span');
          Object.assign(particle.style,{position:'absolute',right:'100px',top:'55px',width:'6px',height:'10px',borderRadius:'2px',background:['#7c6cf6','#c4b5fd','#86efac','#fca5a5','#fcd34d'][i%5],willChange:'transform,opacity'});
          document.body.append(particle);const angle=i*2.39996,distance=80+(i%7)*22;
          animate(particle,[{transform:'translate3d(0,0,0) rotate(0deg)',opacity:0},{offset:.08,opacity:1},{transform:'translate3d('+Math.cos(angle)*distance+'px,'+(Math.sin(angle)*distance+160)+'px,0) rotate('+(i*47)+'deg)',opacity:0}]);
        }
      }else if(effect==='pulse'){
        const border=document.createElement('div');
        Object.assign(border.style,{position:'absolute',inset:'0',border:'4px solid #7c6cf6',boxShadow:'inset 0 0 30px #7c6cf680',pointerEvents:'none'});
        document.body.append(border);animate(border,[{opacity:0},{opacity:1},{opacity:.15},{opacity:.85},{opacity:0}]);
      }else animate(image,${JSON.stringify(shake)});
      for(const animation of animations)animation.currentTime=Math.max(0,Date.now()-start);
      Promise.all(animations.map(animation=>animation.finished)).then(resolve);
    },Math.max(0,start-Date.now()));
  })`;
}
