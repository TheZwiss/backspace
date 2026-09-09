import { useId } from 'react';
import type { SceneIds } from '../telemetry/scene/HelloScene';
import { SCENE_PALETTE as P } from '../telemetry/scene/palette';
import { PORT, Ship } from '../telemetry/scene/Ship';
import { StarField, scatterStars, type StarFieldSpec, type Streak } from '../telemetry/scene/StarField';
import './HomeSpace.css';

/* ── THE SKY ──
 * One deterministic field in column pixels, drawn once at the widest column
 * the app can give the page; the column crops it, and a narrower column sees
 * the left of the same sky, the same on every tab and every visit. The field
 * has structure so it reads as a sky and not as dots: a soft density band
 * runs along one gentle diagonal, from the upper left toward the world in
 * the lower right. About one point per 7,000 square pixels overall, most of
 * them on the band; one star in five breathes.
 */
const FIELD: StarFieldSpec = {
  seed: 2026,
  width: 2000,
  height: 1200,
  perStar: 7000,
  bright: 0.15,
  dust: 0.3,
  twinkleEvery: 5,
  band: { x0: 0, y0: 0.05, x1: 1, y1: 0.56, sigma: 0.1 },
};
const STARS = scatterStars(FIELD);

/* ── STERNSCHNUPPEN ── three of them, starting in the top band at three
 * places, on three periods that share no factor, so the sky's timing feels
 * irregular. Each is on screen for well under a second, about once a minute
 * between them. */
const STREAKS: ReadonlyArray<Streak> = [
  { left: '56cqw', top: '2px', period: 53, delay: 20 },
  { left: '20cqw', top: '8px', period: 67, delay: 51 },
  { left: '81cqw', top: '12px', period: 83, delay: 6 },
];

/* ── NORI ──
 * The mascot, seen through the porthole: the same drawing the empty voice
 * channel makes, so the craft that passes here is the one moored there. The
 * body is one mint disc lit at its upper left; the eyes are solid dark dots,
 * each with one catchlight. Clipped by the porthole, so the cabin's amber
 * stays around the face. At the size the crossing draws it, the face is a
 * few pixels: a warm window with someone in it, which is the whole point.
 */
// The mascot's idle `from`: mint lifted one step toward star, the lit face.
const NORI_LIT = '#9cefb7';
const NORI = {
  cx: PORT.cx,
  // Seated low in the window so the cabin's amber shows above and beside
  // the head: Nori is inside the ship, not pasted on the glass.
  cy: PORT.cy + 11,
  r: 21,
  eyeDx: 6.8,
  eyeDy: -5.5,
  eyeR: 4,
  catchR: 1.35,
  blushDx: 12,
  blushDy: 1.5,
} as const;

function Nori({ clip, body }: { clip: string; body: string }) {
  const eyeY = NORI.cy + NORI.eyeDy;
  const blushY = NORI.cy + NORI.blushDy;
  return (
    <g clipPath={`url(#${clip})`}>
      <circle cx={NORI.cx} cy={NORI.cy} r={NORI.r} fill={`url(#${body})`} />
      <ellipse cx={NORI.cx - NORI.blushDx} cy={blushY} rx="3.8" ry="1.9" fill={P.nebulaB} opacity="0.4" />
      <ellipse cx={NORI.cx + NORI.blushDx} cy={blushY} rx="3.8" ry="1.9" fill={P.nebulaB} opacity="0.4" />
      <circle cx={NORI.cx - NORI.eyeDx} cy={eyeY} r={NORI.eyeR} fill={P.pilot} />
      <circle cx={NORI.cx + NORI.eyeDx} cy={eyeY} r={NORI.eyeR} fill={P.pilot} />
      <circle cx={NORI.cx - NORI.eyeDx - 1.4} cy={eyeY - 1.5} r={NORI.catchR} fill={P.star} opacity="0.92" />
      <circle cx={NORI.cx + NORI.eyeDx - 1.4} cy={eyeY - 1.5} r={NORI.catchR} fill={P.star} opacity="0.92" />
      <path
        d={`M${NORI.cx - 3.2} ${NORI.cy + 2.5} Q${NORI.cx} ${NORI.cy + 5.8} ${NORI.cx + 3.2} ${NORI.cy + 2.5}`}
        stroke={P.pilot}
        strokeWidth="1.7"
        strokeLinecap="round"
        fill="none"
      />
    </g>
  );
}

/* ── THE CRAFT ──
 * The hello scene's ship with Nori in the porthole and a plume, drawn from
 * its own parts at its own coordinates. It is far here, so the plume is
 * fainter than the voice channel's and there is no cabin warmth around it:
 * at this distance a window is a point of amber, not a glow. No filter.
 */
function Craft({ ids, uid }: { ids: SceneIds; uid: string }) {
  const plumeSoft = `hsp-plume-soft-${uid}`;
  const plumeCore = `hsp-plume-core-${uid}`;
  const noriBody = `hsp-nori-${uid}`;
  return (
    <svg className="home-space__craft-art" viewBox="100 96 240 160" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={plumeSoft}>
          <stop offset="0" stopColor={P.windowLit} stopOpacity="0.4" />
          <stop offset="0.55" stopColor={P.window} stopOpacity="0.14" />
          <stop offset="1" stopColor={P.window} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={plumeCore}>
          <stop offset="0" stopColor={P.beam} stopOpacity="0.8" />
          <stop offset="0.6" stopColor={P.windowLit} stopOpacity="0.35" />
          <stop offset="1" stopColor={P.windowLit} stopOpacity="0" />
        </radialGradient>
        {/* Nori's body: the lit mint upper left, the hull's mint everywhere else. */}
        <radialGradient id={noriBody} cx="0.36" cy="0.3" r="0.8">
          <stop offset="0" stopColor={NORI_LIT} />
          <stop offset="0.55" stopColor={P.hull} />
          <stop offset="1" stopColor={P.hull} />
        </radialGradient>
        <clipPath id={ids.clip}>
          <circle cx={PORT.cx} cy={PORT.cy} r={PORT.r} />
        </clipPath>
      </defs>

      {/* The plume, behind the bell, along the ship's axis. Faint: it is far. */}
      <g>
        <ellipse cx="92" cy="176" rx="42" ry="15" fill={`url(#${plumeSoft})`} />
        <ellipse cx="112" cy="176" rx="22" ry="6.5" fill={`url(#${plumeCore})`} />
      </g>

      <Ship ids={ids} />
      <Nori clip={ids.clip} body={noriBody} />
    </svg>
  );
}

/**
 * The living space behind the friends page: the void, one sky, the world,
 * and rare life. Owned by the UI soul pass (scene bible section 13). It is an
 * absolutely positioned layer behind the page's glass controls and panel,
 * ignores the pointer, and owns no string.
 *
 * Back to front: the void, the star field with its density band, the craft
 * that crosses low from the left edge every three minutes, the world low
 * right that it arrives behind, and three shooting stars in the top band that
 * each fall once a minute or so. Everything moves by transform and opacity
 * only, on the compositor; the page's rows over this are tinted, not frosted,
 * because a frosted row re-blurs whatever moves behind it every frame.
 */
export function HomeSpace() {
  // React ids carry colons, which are not safe inside url(#…) references.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const ids: SceneIds = {
    hull: `hsp-${uid}-hull`,
    cabin: `hsp-${uid}-cabin`,
    beam: `hsp-${uid}-beam`,
    glow: `hsp-${uid}-glow`,
    nebula: `hsp-${uid}-nebula`,
    fade: `hsp-${uid}-fade`,
    maskA: `hsp-${uid}-maskA`,
    maskB: `hsp-${uid}-maskB`,
    clip: `hsp-${uid}-clip`,
  };

  return (
    <div className="home-space absolute inset-0 pointer-events-none" aria-hidden="true">
      <StarField stars={STARS} width={FIELD.width} height={FIELD.height} streaks={STREAKS} />
      <div className="home-space__craft">
        <Craft ids={ids} uid={uid} />
      </div>
      <div className="home-space__world" />
    </div>
  );
}
