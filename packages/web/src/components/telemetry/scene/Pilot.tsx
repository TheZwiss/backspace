import type { SceneIds } from './HelloScene';
import { SCENE_PALETTE as P } from './palette';
import { PORT } from './Ship';

// The shoulder is the pivot of the wave; the hook and the stylesheet both
// rotate the arm around this point.
export const SHOULDER = { x: 262, y: 186 } as const;
// Where the arm settles after the farewell wave, in degrees clockwise.
export const ARM_REST_DEG = 118;

function Arm() {
  return (
    <>
      <line x1={SHOULDER.x} y1={SHOULDER.y} x2="273" y2="167" stroke={P.pilot} strokeWidth="5" strokeLinecap="round" />
      <circle cx="274" cy="165" r="3.6" fill={P.pilot} />
    </>
  );
}

export function Pilot({ ids }: { ids: SceneIds }) {
  return (
    <>
      <defs>
        <clipPath id={ids.clip}>
          <circle cx={PORT.cx} cy={PORT.cy} r={PORT.r} />
        </clipPath>
      </defs>
      <g data-layer="pilot" clipPath={`url(#${ids.clip})`}>
        <path d="M238 208 C238 192 243 183 252 183 C261 183 266 192 266 208 Z" fill={P.pilot} />
        <circle cx="252" cy="170" r="8.5" fill={P.pilot} />
        <g data-part="eyes">
          <circle cx="249" cy="169.5" r="1.6" fill={P.windowLit} />
          <circle cx="255" cy="169.5" r="1.6" fill={P.windowLit} />
        </g>
        <g data-part="arm" className="hs-arm">
          <Arm />
        </g>
        <g data-part="arm-rest" className="hs-rest" transform={`rotate(${ARM_REST_DEG} ${SHOULDER.x} ${SHOULDER.y})`} opacity="0">
          <Arm />
        </g>
      </g>
    </>
  );
}
