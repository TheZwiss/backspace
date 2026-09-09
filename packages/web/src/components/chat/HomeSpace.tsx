import { useId } from 'react';
import type { SceneIds } from '../telemetry/scene/HelloScene';
import { SCENE_PALETTE as P } from '../telemetry/scene/palette';
import { PORT, Ship } from '../telemetry/scene/Ship';
import './HomeSpace.css';

/* ── THE SKY ──
 * One deterministic field in column pixels, not viewBox units: the SVG has no
 * viewBox, so a 1px star is one CSS pixel at every column size and the sky is
 * the same sky on every visit, on every tab. It is drawn once at the widest
 * column the app can give the page and the column crops it; a narrower column
 * simply sees the left of the same sky.
 *
 * The field has structure so it reads as a sky and not as dots: a soft
 * density band runs along one gentle diagonal, from the upper left toward the
 * world in the lower right. The band is only more points; it has no colour and
 * no gradient. Away from the band the field thins to about a quarter.
 */
const FIELD = { w: 2000, h: 1200 } as const;
/** The band's centre line, from the upper left toward the lower right. */
const BAND = { x0: 0, y0: 0.05, x1: 1, y1: 0.56, sigma: 0.1 } as const;
/** About one point per 7,000 square pixels overall: most of them on the band, a quarter of that off it. */
const STAR_COUNT = Math.round((FIELD.w * FIELD.h) / 7000);

interface Star {
  x: number;
  y: number;
  /** 1 or 2: the only two sizes a distant star has. Few are 2. */
  size: 1 | 2;
  /** Resting opacity; distance, in the only way a flat point can show it. */
  a: number;
  dust: boolean;
  /** Period and phase for the small ones that breathe; undefined for the rest. */
  twinkle?: { period: number; phase: number };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How far a point (as fractions of the field) sits from the band's centre line, in field heights. */
function bandDistance(fx: number, fy: number): number {
  const dx = BAND.x1 - BAND.x0;
  const dy = BAND.y1 - BAND.y0;
  const t = ((fx - BAND.x0) * dx + (fy - BAND.y0) * dy) / (dx * dx + dy * dy);
  const px = BAND.x0 + t * dx;
  const py = BAND.y0 + t * dy;
  // The field is wider than tall; distances are measured in its height so the
  // band's width is the same number of pixels in both axes.
  return Math.hypot((fx - px) * (FIELD.w / FIELD.h), fy - py);
}

/* The twinkle periods, all between 14 and 22 seconds and none a multiple of
 * another, so the breathing stars never fall into step. */
const PERIODS = [14, 15.5, 17, 18.5, 20, 22] as const;

function scatter(seed: number): Star[] {
  const next = mulberry32(seed);
  const stars: Star[] = [];
  let placed = 0;
  while (stars.length < STAR_COUNT) {
    const fx = next();
    const fy = next();
    // Rejection sampling against the band: a point on its centre line is
    // always kept, a point far from it is kept one time in four.
    const d = bandDistance(fx, fy);
    const keep = 0.25 + 0.75 * Math.exp(-(d * d) / (2 * BAND.sigma * BAND.sigma));
    if (next() > keep) continue;
    const x = Math.floor(fx * FIELD.w);
    const y = Math.floor(fy * FIELD.h);
    const size: 1 | 2 = next() < 0.15 ? 2 : 1;
    // The large ones are the clear ones: they live in the brighter half. The
    // small ones start at 0.4, because the void is dark enough that a fainter
    // point is not there at all.
    const a = Math.round((size === 2 ? 0.7 + next() * 0.3 : 0.4 + next() * 0.55) * 100) / 100;
    const dust = next() < 0.3;
    placed += 1;
    // One small star in seven breathes, each on its own period and phase.
    // Few enough that the glass over them has little to re-blur.
    const breathes = size === 1 && placed % 7 === 2;
    const twinkle = breathes
      ? { period: PERIODS[Math.floor(next() * PERIODS.length)] ?? 17, phase: Math.round(next() * 220) / 10 }
      : undefined;
    stars.push(twinkle === undefined ? { x, y, size, a, dust } : { x, y, size, a, dust, twinkle });
  }
  return stars;
}

const STARS = scatter(2026);

/* A 1px star is a crisp-edged pixel: a true point. A 2px star is a round dot
 * centred on a pixel, because a 2px square at 2x is a visible square and a
 * square is not a star. */
function StarPoint({ star }: { star: Star }) {
  const fill = star.dust ? P.dust : P.star;
  const twinkle =
    star.twinkle === undefined ? undefined : { animationDuration: `${star.twinkle.period}s`, animationDelay: `-${star.twinkle.phase}s` };
  const className = twinkle === undefined ? undefined : 'home-space__star--tw';
  // Resting opacity goes on fill-opacity for the twinklers so the loop's
  // opacity multiplies it instead of replacing it.
  const rest = twinkle === undefined ? { opacity: star.a } : { fillOpacity: star.a };
  if (star.size === 1) {
    return <rect className={className} x={star.x} y={star.y} width={1} height={1} fill={fill} shapeRendering="crispEdges" style={twinkle} {...rest} />;
  }
  return <circle className={className} cx={star.x + 0.5} cy={star.y + 0.5} r={1} fill={fill} style={twinkle} {...rest} />;
}

function Stars() {
  return (
    <svg className="home-space__stars" width={FIELD.w} height={FIELD.h} aria-hidden="true" focusable="false">
      {STARS.map((s, i) => (
        <StarPoint key={i} star={s} />
      ))}
    </svg>
  );
}

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
 * each fall once a minute or so. Everything
 * moves by transform and opacity only, and nothing moves continuously except
 * the twinkle, because the page's glass re-blurs whatever moves behind it.
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
      <Stars />
      <div className="home-space__craft">
        <Craft ids={ids} uid={uid} />
      </div>
      <div className="home-space__world" />
      <div className="home-space__streak home-space__streak--a" />
      <div className="home-space__streak home-space__streak--b" />
      <div className="home-space__streak home-space__streak--c" />
    </div>
  );
}
