import type { SceneIds } from './HelloScene';
import { SCENE_PALETTE as P } from './palette';
import { PORT } from './Ship';

// The beam is drawn pointing right from the porthole and the layer turns it
// toward the upper right; the ray inside scales along its own length.
export function Beam({ ids }: { ids: SceneIds }) {
  const y0 = PORT.cy - 10;
  const y1 = PORT.cy + 10;
  return (
    <>
      <defs>
        <linearGradient id={ids.beam} x1={PORT.cx} y1="0" x2="580" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={P.beam} stopOpacity="0.9" />
          <stop offset="0.35" stopColor={P.beam} stopOpacity="0.5" />
          <stop offset="1" stopColor={P.beam} stopOpacity="0" />
        </linearGradient>
      </defs>
      <g data-layer="beam" transform={`rotate(-36 ${PORT.cx} ${PORT.cy})`}>
        <g data-part="ray" className="hs-ray">
          <path d={`M${PORT.cx} ${y0} L580 92 L580 260 L${PORT.cx} ${y1} Z`} fill={`url(#${ids.beam})`} filter={`url(#${ids.glow})`} />
        </g>
      </g>
    </>
  );
}
