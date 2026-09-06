import type { SceneIds } from './HelloScene';
import { SCENE_PALETTE as P } from './palette';
import { PORT } from './Ship';

// The beam is drawn pointing right from the porthole and the layer turns it
// toward the upper right; the ray inside scales along its own length. A soft
// wide cone carries the light, a narrow core gives it a spine.
export function Beam({ ids }: { ids: SceneIds }) {
  const { cx, cy } = PORT;
  return (
    <>
      <defs>
        <linearGradient id={ids.beam} x1={cx} y1="0" x2="600" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={P.beam} stopOpacity="1" />
          <stop offset="0.3" stopColor={P.beam} stopOpacity="0.55" />
          <stop offset="1" stopColor={P.beam} stopOpacity="0" />
        </linearGradient>
      </defs>
      <g data-layer="beam" transform={`rotate(-42 ${cx} ${cy})`}>
        <g data-part="ray" className="hs-ray">
          <path d={`M${cx} ${cy - 8} L600 ${cy - 90} L600 ${cy + 90} L${cx} ${cy + 8} Z`} fill={`url(#${ids.beam})`} filter={`url(#${ids.glow})`} />
          <path d={`M${cx} ${cy - 3} L600 ${cy - 36} L600 ${cy + 36} L${cx} ${cy + 3} Z`} fill={`url(#${ids.beam})`} opacity="0.55" filter={`url(#${ids.glow})`} />
        </g>
      </g>
    </>
  );
}
