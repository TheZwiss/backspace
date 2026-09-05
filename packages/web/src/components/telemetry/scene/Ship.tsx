import type { SceneIds } from './HelloScene';
import { SCENE_PALETTE as P } from './palette';

// The porthole, shared with the pilot (clip) and the beam (origin).
export const PORT = { cx: 256, cy: 176, r: 28 } as const;

export function Ship({ ids }: { ids: SceneIds }) {
  return (
    <>
      <defs>
        <radialGradient id={ids.hull} cx="0.34" cy="0.26" r="0.8">
          <stop offset="0" stopColor={P.hull} />
          <stop offset="0.5" stopColor={P.hull} />
          <stop offset="1" stopColor={P.hullShade} />
        </radialGradient>
        <radialGradient id={ids.cabin} cx="0.5" cy="0.45" r="0.6">
          <stop offset="0" stopColor={P.windowLit} />
          <stop offset="1" stopColor={P.window} />
        </radialGradient>
      </defs>
      <g data-layer="ship">
        <ellipse data-part="exhaust" cx="118" cy="176" rx="16" ry="11" fill={P.window} opacity="0.4" filter={`url(#${ids.glow})`} />
        <ellipse cx="132" cy="176" rx="11" ry="21" fill={P.hullShade} />
        <path d="M158 140 L172 104 L204 136 Z" fill={P.hullShade} />
        <path d="M158 212 L172 248 L204 216 Z" fill={P.hullShade} />
        <path
          d="M138 176 C138 152 160 136 196 136 L246 136 C296 136 326 158 330 176 C326 194 296 216 246 216 L196 216 C160 216 138 200 138 176 Z"
          fill={`url(#${ids.hull})`}
        />
        <path
          d="M146 188 C170 204 204 208 246 208 C292 208 318 194 328 176 C322 194 296 216 246 216 L196 216 C160 216 142 202 146 188 Z"
          fill={P.hullShade}
          opacity="0.45"
        />
      </g>
      <g data-layer="window">
        <circle data-part="glow" className="hs-glow" cx={PORT.cx} cy={PORT.cy} r={PORT.r + 8} fill={P.window} opacity="0.5" filter={`url(#${ids.glow})`} />
        <circle cx={PORT.cx} cy={PORT.cy} r={PORT.r + 6} fill={P.hullShade} />
        <circle cx={PORT.cx} cy={PORT.cy} r={PORT.r} fill={`url(#${ids.cabin})`} />
        <circle data-part="lit" cx={PORT.cx} cy={PORT.cy} r={PORT.r} fill={P.windowLit} opacity="0" />
      </g>
    </>
  );
}
