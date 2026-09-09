import { useId, type CSSProperties, type ReactNode } from 'react';
import { Mascot, type MascotState } from './Mascot';
import { SCENE_PALETTE as P } from '../telemetry/scene/palette';
import './CrewEmptyState.css';

/**
 * The reasons a list of people can be empty. Each is a different beat in
 * open space (scene bible row 3, second pass): Nori alone under a different
 * patch of sky.
 */
export type CrewEmptyVariant =
  | 'nobodyOnline' // friends exist, none are here right now
  | 'noFriends' // no friends yet at all
  | 'noPending' // no friend requests in either direction
  | 'noActivity' // nobody is doing anything worth showing (mobile activity tab)
  | 'noDms' // no direct messages yet (sidebar and mobile list)
  | 'noSpaces'; // no channels in this space yet (mobile spaces screen)

interface CrewEmptyStateProps {
  variant: CrewEmptyVariant;
  /** `hero` fills a page column at 128px; `compact` sits in a sidebar at 80px. */
  size: 'hero' | 'compact';
  /** The line of copy, already translated by the caller. */
  children: ReactNode;
}

/** Nori's mood, and which patch of sky is overhead. */
interface Beat {
  mood: MascotState;
  /** Selects the deterministic star field, so no two beats share one sky. */
  sky: number;
}

const BEATS: Record<CrewEmptyVariant, Beat> = {
  nobodyOnline: { mood: 'idle', sky: 0 },
  noFriends: { mood: 'lonely', sky: 1 },
  noPending: { mood: 'sleeping', sky: 2 },
  noActivity: { mood: 'sleeping', sky: 3 },
  noDms: { mood: 'sleeping', sky: 4 },
  noSpaces: { mood: 'idle', sky: 5 },
};

// ── THE STAR FIELD ──
// Deterministic, like the telemetry hello scene's: the same sky on every
// render, so a screenshot differs only by what changed on purpose.
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

/** One star. `x`/`y` are pixels in a tile or percentages of the frame, depending on where it is used. */
interface Star {
  x: number;
  y: number;
  /** Radius in CSS pixels: stars are one to two pixels across, never more. */
  r: number;
  /** Resting brightness. */
  a: number;
  /** `star` is warm starlight; `dust` is the cold, faint end of the range. */
  tone: 'star' | 'dust';
}

/** A twinkling star also carries its own period and phase, so the group never beats in step. */
interface Twinkler extends Star {
  period: number;
  phase: number;
}

const TONE: Record<Star['tone'], string> = { star: P.star, dust: P.dust };

function pickStar(next: () => number): Pick<Star, 'r' | 'a' | 'tone'> {
  const roll = next();
  // Most of the sky is small and clear; a few points are bright. Every star
  // is bright enough to read as a one-pixel point on --bg-chat, and nothing
  // blooms.
  if (roll < 0.5) return { r: 0.7, a: 0.62 + next() * 0.18, tone: next() < 0.4 ? 'dust' : 'star' };
  if (roll < 0.85) return { r: 0.9, a: 0.74 + next() * 0.18, tone: next() < 0.25 ? 'dust' : 'star' };
  return { r: 1.1, a: 0.94 + next() * 0.06, tone: 'star' };
}

/**
 * The tile that fills a large frame: 960 x 640 pixels holding forty-eight
 * stars, one per ~12,800 square pixels. One star per cell of an eight-by-six
 * grid, jittered across its cell, so the field is random but never leaves a
 * quarter of a column blank. The tile is wider than any column the app lays
 * out, so a sky never shows the same constellation twice. Integer coordinates
 * keep every point on the pixel grid, which is what "crisp" means at one
 * pixel.
 */
const TILE = { w: 960, h: 640 } as const;
const GRID = { cols: 8, rows: 6 } as const;
const FIELD: ReadonlyArray<Star> = (() => {
  const next = mulberry32(2026);
  const cell = { w: TILE.w / GRID.cols, h: TILE.h / GRID.rows };
  const stars: Star[] = [];
  for (let row = 0; row < GRID.rows; row += 1) {
    for (let col = 0; col < GRID.cols; col += 1) {
      stars.push({
        x: Math.round(col * cell.w + next() * cell.w),
        y: Math.round(row * cell.h + next() * cell.h),
        ...pickStar(next),
      });
    }
  }
  return stars;
})();

/**
 * The centre of the frame, as percentages, where Nori and the line of copy
 * sit. The bright percent-placed stars stay out of it so none ever touches a
 * letter; the tile's faint points still pass through, so it is never a hole.
 */
const CENTRE = { x: [24, 76], y: [22, 78] } as const;

function inCentre(x: number, y: number): boolean {
  return x > CENTRE.x[0] && x < CENTRE.x[1] && y > CENTRE.y[0] && y < CENTRE.y[1];
}

/** Stars placed as percentages of the frame, for the few points a sky adds on top of the tile or on their own. */
function scatterPercent(next: () => number, count: number): Star[] {
  const stars: Star[] = [];
  while (stars.length < count) {
    const x = Math.round(3 + next() * 94);
    const y = Math.round(4 + next() * 92);
    if (inCentre(x, y)) continue;
    stars.push({ x, y, ...pickStar(next) });
  }
  return stars;
}

interface Sky {
  /** Where the tile is shifted to, so each sky shows a different cut of the same field. */
  offset: { x: number; y: number };
  /** Static points placed by percentage. Only small frames use these; large frames have the tile. */
  still: ReadonlyArray<Star>;
  /** The handful that twinkle. Bright, so the breathing reads at all. */
  twinkle: ReadonlyArray<Twinkler>;
}

const SKIES = new Map<string, Sky>();

function skyFor(seed: number, density: 'field' | 'few'): Sky {
  const key = `${density}:${seed}`;
  const cached = SKIES.get(key);
  if (cached) return cached;
  const next = mulberry32(97 + seed * 31);
  const offset = { x: Math.round(next() * TILE.w), y: Math.round(next() * TILE.h) };
  // A small frame holds six stars at most: five still, one that breathes.
  const still = density === 'few' ? scatterPercent(next, 5) : [];
  const twinkle = scatterPercent(next, density === 'few' ? 1 : 7).map<Twinkler>((star) => ({
    ...star,
    r: 1,
    a: 0.8 + next() * 0.15,
    tone: 'star',
    period: 14 + Math.round(next() * 8),
    phase: Math.round(next() * 20),
  }));
  const sky: Sky = { offset, still, twinkle };
  SKIES.set(key, sky);
  return sky;
}

function Point({ star, unit }: { star: Star; unit: 'px' | '%' }) {
  const cx = unit === '%' ? `${star.x}%` : star.x;
  const cy = unit === '%' ? `${star.y}%` : star.y;
  return <circle cx={cx} cy={cy} r={star.r} fill={TONE[star.tone]} fillOpacity={star.a} />;
}

interface OpenSpaceProps {
  /** Which patch of sky. Any integer; the same number always draws the same sky. */
  sky: number;
  /** `field` tiles a large frame at one star per ~12,000 px²; `few` puts a handful in a small one. */
  density: 'field' | 'few';
  className?: string;
}

/**
 * Open space: a sparse field of crisp distant stars over the surface the host
 * already has. It paints no background of its own; the page's surface is the
 * sky (--bg-chat in a column, --bg-channel in a sidebar). One layer, the
 * stars, in one inline SVG that the host positions absolutely behind its
 * content and never lets past its own box. Sized by CSS, so the same sky
 * fills any frame without scaling a single star.
 *
 * The twinkle group is the one infinite animation this layer spends: a few
 * bright points easing between two opacities over fourteen seconds or more,
 * each on its own period and phase.
 */
export function OpenSpace({ sky, density, className }: OpenSpaceProps) {
  // React's ids carry colons, which are not safe inside url(#…) references.
  const uid = useId().replace(/:/g, '');
  const patternId = `open-space-${uid}`;
  const patch = skyFor(sky, density);
  return (
    <svg className={`open-space${className ? ` ${className}` : ''}`} aria-hidden="true" focusable="false">
      {density === 'field' && (
        <defs>
          <pattern
            id={patternId}
            width={TILE.w}
            height={TILE.h}
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${patch.offset.x} ${patch.offset.y})`}
          >
            {FIELD.map((star, i) => <Point key={i} star={star} unit="px" />)}
          </pattern>
        </defs>
      )}
      {density === 'field' && <rect width="100%" height="100%" fill={`url(#${patternId})`} />}
      {patch.still.map((star, i) => <Point key={i} star={star} unit="%" />)}
      <g className="open-space__twinkle">
        {patch.twinkle.map((star, i) => {
          const timing: CSSProperties = { animationDuration: `${star.period}s`, animationDelay: `-${star.phase}s` };
          return (
            <circle key={i} cx={`${star.x}%`} cy={`${star.y}%`} r={star.r} fill={TONE[star.tone]} fillOpacity={star.a} style={timing} />
          );
        })}
      </g>
    </svg>
  );
}

/**
 * One component for every "no one is here" state: Nori alone in open space,
 * small in a large dark frame. The caller owns the copy and the strings; this
 * owns the picture. Owned by the UI soul pass (scene bible row 3).
 *
 * Layout never moves for the scene: space is an absolutely positioned layer
 * behind a flex column that centres a stage box the exact size of Nori and
 * the line of copy under it.
 */
export function CrewEmptyState({ variant, size, children }: CrewEmptyStateProps) {
  const hero = size === 'hero';
  const beat = BEATS[variant];
  return (
    <div className={`crew-empty crew-empty--${variant} crew-empty--${size} flex flex-col items-center ${hero ? 'justify-center h-full' : 'py-6'}`}>
      <OpenSpace sky={beat.sky} density={hero ? 'field' : 'few'} className="crew-empty__space" />
      <div className={`crew-empty__stage ${hero ? 'w-32 h-32 mb-4' : 'w-20 h-20 mb-2'}`}>
        <Mascot state={beat.mood} className="w-full h-full" />
      </div>
      <p className={`crew-empty__copy ${hero ? 'text-sm' : 'text-[13px]'} text-center`}>{children}</p>
    </div>
  );
}
