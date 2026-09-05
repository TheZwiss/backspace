import { useId, useRef } from 'react';
import { Beam } from './Beam';
import { Pilot, SHOULDER } from './Pilot';
import { PORT, Ship } from './Ship';
import { useSceneAnimation } from './useSceneAnimation';
import { Void } from './Void';

export type SceneMood = 'idle' | 'happy' | 'farewell';

export interface HelloSceneProps {
  mood: SceneMood;
  className?: string;
}

// Ids for gradients, filters, masks and clips, unique per mounted scene.
export interface SceneIds {
  hull: string;
  cabin: string;
  beam: string;
  glow: string;
  nebula: string;
  fade: string;
  maskA: string;
  maskB: string;
  clip: string;
}

const ID_KEYS: readonly (keyof SceneIds)[] = ['hull', 'cabin', 'beam', 'glow', 'nebula', 'fade', 'maskA', 'maskB', 'clip'];

// Ambient loops and the reduced-motion still frames. Only transform and
// opacity move. The choreography of happy and farewell lives in the hook.
const STYLE = `
@keyframes hs-tw0{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes hs-tw1{0%,100%{opacity:.4}50%{opacity:1}}
@keyframes hs-tw2{0%{opacity:.75}40%{opacity:1}70%{opacity:.25}100%{opacity:.75}}
@keyframes hs-far{to{transform:translateX(-12px)}}
@keyframes hs-near{to{transform:translateX(-20px)}}
@keyframes hs-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes hs-wave{0%,100%{transform:rotate(-14deg)}50%{transform:rotate(18deg)}}
.hs-root .hs-tw0{animation:hs-tw0 3.1s ease-in-out infinite}
.hs-root .hs-tw1{animation:hs-tw1 4.7s ease-in-out infinite}
.hs-root .hs-tw2{animation:hs-tw2 6.3s ease-in-out infinite}
.hs-root .hs-far{animation:hs-far 70s ease-in-out infinite alternate}
.hs-root .hs-near{animation:hs-near 40s ease-in-out infinite alternate}
.hs-root .hs-craft{animation:hs-bob 4s ease-in-out infinite}
.hs-root .hs-arm{transform-origin:${SHOULDER.x}px ${SHOULDER.y}px;animation:hs-wave 1.2s cubic-bezier(.45,.05,.55,.95) infinite}
.hs-root:not([data-mood=idle]) .hs-arm{animation-play-state:paused}
.hs-root .hs-glow{transform-origin:${PORT.cx}px ${PORT.cy}px}
.hs-root .hs-pulse{transform-box:fill-box;transform-origin:center}
.hs-root .hs-ray{transform-origin:${PORT.cx}px ${PORT.cy}px;transform:scaleX(0);opacity:0}
@media (prefers-reduced-motion:reduce){
.hs-root .hs-tw0,.hs-root .hs-tw1,.hs-root .hs-tw2,.hs-root .hs-far,.hs-root .hs-near,.hs-root .hs-craft,.hs-root .hs-arm{animation:none}
.hs-root[data-mood=happy] .hs-ray{transform:scaleX(1);opacity:.6}
.hs-root[data-mood=happy] [data-part=lit]{opacity:1}
.hs-root[data-mood=happy] .hs-glow{opacity:1;transform:scale(1.3)}
.hs-root[data-mood=farewell] .hs-arm{opacity:0}
.hs-root[data-mood=farewell] .hs-rest{opacity:1}
}`;

export function HelloScene({ mood, className }: HelloSceneProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const ids = Object.fromEntries(ID_KEYS.map((key) => [key, `hs-${uid}-${key}`])) as Record<keyof SceneIds, string>;
  const svgRef = useRef<SVGSVGElement>(null);
  useSceneAnimation(svgRef, mood);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 480 320"
      width="100%"
      height="100%"
      aria-hidden="true"
      focusable="false"
      data-mood={mood}
      className={className ? `hs-root ${className}` : 'hs-root'}
    >
      <style>{STYLE}</style>
      <defs>
        <filter id={ids.glow} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>
      <Void ids={ids} />
      <g data-part="craft" className="hs-craft">
        <g transform="rotate(-8 230 176)">
          <Ship ids={ids} />
          <Pilot ids={ids} />
          <Beam ids={ids} />
        </g>
      </g>
    </svg>
  );
}
