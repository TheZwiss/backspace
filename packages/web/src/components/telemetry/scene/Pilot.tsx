import type { SceneIds } from './HelloScene';
import { SCENE_PALETTE as P } from './palette';
import { PORT } from './Ship';

// The shoulder is the pivot of the wave; the hook and the stylesheet both
// rotate the arm around this point.
export const SHOULDER = { x: 256, y: 189 } as const;
// Where the arm settles after the farewell wave, in degrees clockwise: folded
// down into the body silhouette.
export const ARM_REST_DEG = 172;

// Upper arm out to the elbow, forearm up to the hand.
function Arm() {
  return (
    <>
      <path
        d={`M${SHOULDER.x} ${SHOULDER.y} L272 181 L269 166`}
        fill="none"
        stroke={P.pilot}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="268.5" cy="163.5" r="3.4" fill={P.pilot} />
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
        <path d="M239 208 C239 194 244 184 252 184 C260 184 265 194 265 208 Z" fill={P.pilot} />
        <rect x="248.5" y="176" width="7" height="9" rx="2" fill={P.pilot} />
        <circle cx="252" cy="171" r="8" fill={P.pilot} />
        <g data-part="eyes">
          <circle cx="249.2" cy="171.5" r="1.5" fill={P.windowLit} />
          <circle cx="254.8" cy="171.5" r="1.5" fill={P.windowLit} />
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
