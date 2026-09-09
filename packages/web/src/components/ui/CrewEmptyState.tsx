import { useId, type CSSProperties, type ReactNode } from 'react';
import { Mascot, type MascotState } from './Mascot';
import { SCENE_PALETTE as P } from '../telemetry/scene/palette';
import './CrewEmptyState.css';

/**
 * The reasons a list of people can be empty. Each is a different beat in the
 * crew quarters (scene bible row 3), so each gets its own scene.
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

/** What is in the room besides Nori, and which one thing is allowed to move. */
interface Beat {
  mood: MascotState;
  /** `near`: Nori is at the window. `far`: the window is across the room. */
  window: 'near' | 'far';
  /** The instrument in the room, if any. */
  station: 'none' | 'hail' | 'standby' | 'board' | 'berth';
  /** The one infinite animation this beat spends its budget on. */
  motion: 'twinkle' | 'standby' | 'cruise' | 'none';
}

/**
 * Six beats, one room. Every beat is the same quarters seen at a different
 * hour: the window and the deck are always there, the station changes, and
 * only one emitter is ever alive.
 */
const BEATS: Record<CrewEmptyVariant, Beat> = {
  // Night watch: lights dimmed, Nori at the window waiting for the next shift.
  nobodyOnline: { mood: 'idle', window: 'near', station: 'none', motion: 'twinkle' },
  // The hailing desk, nothing plotted, nobody on the board; standby light on.
  noFriends: { mood: 'lonely', window: 'far', station: 'hail', motion: 'standby' },
  // Asleep at the console, the screen on standby.
  noPending: { mood: 'sleeping', window: 'far', station: 'standby', motion: 'standby' },
  // At cruise: stars going by the window, the activity board dark.
  noActivity: { mood: 'sleeping', window: 'far', station: 'board', motion: 'cruise' },
  // The same room through a small hatch; quiet.
  noDms: { mood: 'sleeping', window: 'near', station: 'none', motion: 'twinkle' },
  // A berth with nothing in it yet.
  noSpaces: { mood: 'idle', window: 'far', station: 'berth', motion: 'none' },
};

/**
 * Where each Nori drawing touches the deck, as a fraction of its box: the
 * centre of the cast shadow in `Mascot.tsx` (idle 173/200, lonely 167/200,
 * sleeping 115/130 letterboxed into a square). The floor of the room is
 * drawn at this height so Nori stands on it rather than in front of it.
 */
const FLOOR: Record<MascotState, number> = {
  idle: 0.865,
  lonely: 0.835,
  sleeping: 0.727,
  excited: 0.87,
};

/** Star positions as fractions of the window's glass, so one sky fits every window. */
const STARS: ReadonlyArray<{ x: number; y: number; r: number; a: number; c: 'star' | 'sky' | 'dust' }> = [
  { x: 0.18, y: 0.14, r: 1.1, a: 0.85, c: 'star' },
  { x: 0.62, y: 0.09, r: 0.7, a: 0.55, c: 'star' },
  { x: 0.84, y: 0.22, r: 1.3, a: 0.9, c: 'star' },
  { x: 0.4, y: 0.3, r: 0.6, a: 0.45, c: 'dust' },
  { x: 0.09, y: 0.42, r: 0.8, a: 0.6, c: 'star' },
  { x: 0.7, y: 0.46, r: 0.9, a: 0.7, c: 'sky' },
  { x: 0.3, y: 0.56, r: 1.4, a: 0.95, c: 'star' },
  { x: 0.52, y: 0.66, r: 0.6, a: 0.5, c: 'star' },
  { x: 0.88, y: 0.6, r: 0.7, a: 0.55, c: 'dust' },
  { x: 0.16, y: 0.78, r: 0.9, a: 0.65, c: 'star' },
  { x: 0.66, y: 0.84, r: 1.1, a: 0.8, c: 'star' },
  { x: 0.42, y: 0.92, r: 0.6, a: 0.45, c: 'sky' },
  { x: 0.8, y: 0.96, r: 0.8, a: 0.6, c: 'star' },
];
const STAR_COLOUR = { star: P.star, sky: P.console, dust: P.dust } as const;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

/** The gradient and clip ids one room paints with; unique per mount. */
interface RoomIds {
  glass: string;
  nebulaA: string;
  nebulaB: string;
  frame: string;
  reveal: string;
  gloss: string;
  beam: string;
  deck: string;
  pool: string;
  rib: string;
  wall: string;
  wallMask: string;
  seam: string;
  top: string;
  face: string;
  bloom: string;
  screen: string;
  clip: string;
  hatch: string;
  soft: string;
}

function roomIds(uid: string): RoomIds {
  return {
    glass: `crew-glass-${uid}`,
    nebulaA: `crew-nebula-a-${uid}`,
    nebulaB: `crew-nebula-b-${uid}`,
    frame: `crew-frame-${uid}`,
    reveal: `crew-reveal-${uid}`,
    gloss: `crew-gloss-${uid}`,
    beam: `crew-beam-${uid}`,
    deck: `crew-deck-${uid}`,
    pool: `crew-pool-${uid}`,
    rib: `crew-rib-${uid}`,
    wall: `crew-wall-${uid}`,
    wallMask: `crew-wall-mask-${uid}`,
    seam: `crew-seam-${uid}`,
    top: `crew-top-${uid}`,
    face: `crew-face-${uid}`,
    bloom: `crew-bloom-${uid}`,
    screen: `crew-screen-${uid}`,
    clip: `crew-clip-${uid}`,
    hatch: `crew-hatch-${uid}`,
    soft: `crew-soft-${uid}`,
  };
}

/**
 * Every gradient the room shades with. The window's `glass` is the void seen
 * through it, lavender at the top-left where the nebula is. `frame` lights the
 * top-left of the window's ring like any rim; `reveal` is the opposite: the
 * inside edges of the opening that face the incoming light are the right and
 * bottom ones, so that stroke is bright lower-right and gone upper-left. `beam`
 * fades the shaft of light out along its length; `pool` is where it lands.
 * `top` and `face` are the two faces of anything built into the room: the
 * upward face catches the key at its left end, the front face falls to `seat`.
 */
function Defs({ ids, win, beamFrom, beamTo, hatch }: {
  ids: RoomIds;
  win: Box;
  beamFrom: { x: number; y: number };
  beamTo: { x: number; y: number };
  hatch?: Box;
}) {
  return (
    <defs>
      <radialGradient id={ids.glass} cx="0.3" cy="0.2" r="1">
        <stop offset="0" stopColor={P.void} stopOpacity="1" />
        <stop offset="1" stopColor={P.derelictFar} stopOpacity="1" />
      </radialGradient>
      {/* Nebula: two washes at different angles, so the sky has weather in it
          rather than a spot. Both fade to nothing well inside their ellipse. */}
      <radialGradient id={ids.nebulaA} cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stopColor={P.nebulaA} stopOpacity="0.16" />
        <stop offset="0.5" stopColor={P.nebulaA} stopOpacity="0.06" />
        <stop offset="1" stopColor={P.nebulaA} stopOpacity="0" />
      </radialGradient>
      <radialGradient id={ids.nebulaB} cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stopColor={P.nebulaB} stopOpacity="0.07" />
        <stop offset="1" stopColor={P.nebulaB} stopOpacity="0" />
      </radialGradient>
      <linearGradient id={ids.frame} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor={P.bulkhead} stopOpacity="1" />
        <stop offset="0.5" stopColor={P.deck} stopOpacity="1" />
        <stop offset="1" stopColor={P.seat} stopOpacity="0.32" />
      </linearGradient>
      <linearGradient id={ids.reveal} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0.1" stopColor={P.star} stopOpacity="0" />
        <stop offset="0.55" stopColor={P.star} stopOpacity="0.22" />
        <stop offset="1" stopColor={P.star} stopOpacity="0.55" />
      </linearGradient>
      <linearGradient id={ids.gloss} x1="0" y1="0" x2="0.7" y2="1">
        <stop offset="0" stopColor={P.star} stopOpacity="0.12" />
        <stop offset="0.5" stopColor={P.star} stopOpacity="0" />
      </linearGradient>
      <linearGradient
        id={ids.beam}
        gradientUnits="userSpaceOnUse"
        x1={beamFrom.x}
        y1={beamFrom.y}
        x2={beamTo.x}
        y2={beamTo.y}
      >
        <stop offset="0" stopColor={P.beam} stopOpacity="0.16" />
        <stop offset="0.55" stopColor={P.star} stopOpacity="0.05" />
        <stop offset="1" stopColor={P.star} stopOpacity="0" />
      </linearGradient>
      <linearGradient id={ids.deck} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={P.bulkhead} stopOpacity="0.55" />
        <stop offset="0.3" stopColor={P.deck} stopOpacity="0.9" />
        <stop offset="1" stopColor={P.seat} stopOpacity="0.12" />
      </linearGradient>
      <radialGradient id={ids.pool} cx="0.42" cy="0.5" r="0.5">
        <stop offset="0" stopColor={P.beam} stopOpacity="0.22" />
        <stop offset="0.45" stopColor={P.star} stopOpacity="0.08" />
        <stop offset="1" stopColor={P.star} stopOpacity="0" />
      </radialGradient>
      <linearGradient id={ids.rib} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={P.bulkhead} stopOpacity="0" />
        <stop offset="0.3" stopColor={P.bulkhead} stopOpacity="1" />
        <stop offset="1" stopColor={P.deck} stopOpacity="1" />
      </linearGradient>
      <linearGradient id={ids.wall} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor={P.pilot} stopOpacity="0.5" />
        <stop offset="0.3" stopColor={P.pilot} stopOpacity="0.24" />
        <stop offset="1" stopColor={P.seat} stopOpacity="0" />
      </linearGradient>
      {/* The far wall comes out of the dark from the top down, like the rib. */}
      <linearGradient id={ids.wallMask} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={P.star} stopOpacity="0" />
        <stop offset="0.4" stopColor={P.star} stopOpacity="1" />
        <stop offset="1" stopColor={P.star} stopOpacity="1" />
      </linearGradient>
      <linearGradient id={ids.seam} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor={P.pilot} stopOpacity="0" />
        <stop offset="0.3" stopColor={P.pilot} stopOpacity="0.5" />
        <stop offset="1" stopColor={P.pilot} stopOpacity="0.5" />
      </linearGradient>
      <linearGradient id={ids.top} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor={P.star} stopOpacity="0.34" />
        <stop offset="0.4" stopColor={P.bulkhead} stopOpacity="1" />
        <stop offset="1" stopColor={P.seat} stopOpacity="0.55" />
      </linearGradient>
      <linearGradient id={ids.face} x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0" stopColor={P.deck} stopOpacity="1" />
        <stop offset="1" stopColor={P.pilot} stopOpacity="1" />
      </linearGradient>
      <radialGradient id={ids.bloom} cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stopColor={P.console} stopOpacity="0.55" />
        <stop offset="0.4" stopColor={P.console} stopOpacity="0.18" />
        <stop offset="1" stopColor={P.console} stopOpacity="0" />
      </radialGradient>
      <radialGradient id={ids.screen} cx="0.5" cy="0.55" r="0.7">
        <stop offset="0" stopColor={P.console} stopOpacity="0.3" />
        <stop offset="1" stopColor={P.console} stopOpacity="0.02" />
      </radialGradient>
      <clipPath id={ids.clip}>
        <rect x={win.x} y={win.y} width={win.w} height={win.h} rx={win.r} />
      </clipPath>
      {hatch && (
        <clipPath id={ids.hatch}>
          <rect x={hatch.x} y={hatch.y} width={hatch.w} height={hatch.h} rx={hatch.r} />
        </clipPath>
      )}
      {/* The one blur, shared by the shaft of light and the standby bloom. */}
      <filter id={ids.soft} x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="4" />
      </filter>
    </defs>
  );
}

/**
 * The window: a rounded opening in the bulkhead onto the void. The frame ring
 * is lit at its top-left like every rim; the inside of the opening is lit on
 * the right and the bottom, because that is where light coming in from the
 * upper left lands. Stars sit behind the glass, in two copies so the cruise
 * beat can slide them by exactly one window without a seam.
 */
function Window({ ids, win, cruise }: { ids: RoomIds; win: Box; cruise: boolean }) {
  const sky = (dx: number) => (
    <g transform={`translate(${dx} 0)`}>
      {STARS.map((s, i) => (
        <circle
          key={i}
          className={i % 3 === 0 ? 'crew-empty__star crew-empty__star--bright' : 'crew-empty__star'}
          cx={win.x + s.x * win.w}
          cy={win.y + s.y * win.h}
          r={s.r}
          fill={STAR_COLOUR[s.c]}
          opacity={s.a}
        />
      ))}
    </g>
  );
  return (
    <g>
      {/* Frame ring, five units of bulkhead around the opening. */}
      <rect
        x={win.x - 5}
        y={win.y - 5}
        width={win.w + 10}
        height={win.h + 10}
        rx={win.r + 5}
        fill={`url(#${ids.frame})`}
      />
      {/* The void, and the sky in it. */}
      <rect x={win.x} y={win.y} width={win.w} height={win.h} rx={win.r} fill={`url(#${ids.glass})`} />
      <g clipPath={`url(#${ids.clip})`}>
        <ellipse
          cx={win.x + win.w * 0.3}
          cy={win.y + win.h * 0.2}
          rx={win.w * 0.7}
          ry={win.h * 0.3}
          fill={`url(#${ids.nebulaA})`}
          transform={`rotate(-28 ${win.x + win.w * 0.3} ${win.y + win.h * 0.2})`}
        />
        <ellipse
          cx={win.x + win.w * 0.8}
          cy={win.y + win.h * 0.62}
          rx={win.w * 0.55}
          ry={win.h * 0.22}
          fill={`url(#${ids.nebulaB})`}
          transform={`rotate(18 ${win.x + win.w * 0.8} ${win.y + win.h * 0.62})`}
        />
        <g className={cruise ? 'crew-empty__sky crew-empty__sky--cruise' : 'crew-empty__sky'} style={{ '--crew-drift': `${-win.w}px` } as CSSProperties}>
          {sky(0)}
          {cruise && sky(win.w)}
        </g>
        {/* Glass: one sheet, caught at the top-left corner. */}
        <rect x={win.x} y={win.y} width={win.w} height={win.h} fill={`url(#${ids.gloss})`} />
      </g>
      {/* The reveal: the lit inner edge, right and bottom. */}
      <rect
        x={win.x + 0.75}
        y={win.y + 0.75}
        width={win.w - 1.5}
        height={win.h - 1.5}
        rx={win.r - 0.75}
        fill="none"
        stroke={`url(#${ids.reveal})`}
        strokeWidth="1.5"
      />
    </g>
  );
}

/**
 * The shaft of light through the window, and the pool where it lands. Both
 * are the same warm white as the key; the shaft is blurred once so it reads
 * as air with light in it rather than as a shape.
 */
function Light({ ids, from, to, poolAt, rx, ry }: {
  ids: RoomIds;
  from: Box;
  to: { x: number; y: number };
  poolAt: { x: number; y: number };
  rx: number;
  ry: number;
}) {
  const shaft = [
    `${from.x + from.w * 0.4},${from.y + from.h - 4}`,
    `${from.x + from.w - 2},${from.y + from.h * 0.4}`,
    `${to.x + rx * 0.9},${to.y + ry * 0.4}`,
    `${to.x - rx * 0.75},${to.y + ry * 0.9}`,
  ].join(' ');
  return (
    <g>
      <polygon points={shaft} fill={`url(#${ids.beam})`} filter={`url(#${ids.soft})`} />
      <ellipse cx={poolAt.x} cy={poolAt.y} rx={rx} ry={ry} fill={`url(#${ids.pool})`} transform={`rotate(-6 ${poolAt.x} ${poolAt.y})`} />
    </g>
  );
}

/**
 * The corner of the room: a rib of the hull, and beyond it the next bulkhead
 * turned away from the key. The rib is the lit edge, a hairline of key on its
 * left, its face falling to deck, a dark seam where it turns; the wall past it
 * is the same lavender-dark as anything the light does not reach, fading out
 * toward the room's edge so the corner falls into the dark instead of ending.
 * One seam runs along the wall at rail height: a bulkhead is built of panels.
 */
function Corner({ ids, x, w, to, edge, seamY }: { ids: RoomIds; x: number; w: number; to: number; edge: number; seamY: number }) {
  return (
    <g>
      {/* The far wall, turned away. */}
      <mask id={`${ids.wallMask}-m`} maskUnits="userSpaceOnUse" x={x} y={0} width={edge - x} height={to + 2}>
        <rect x={x} y={0} width={edge - x} height={to + 2} fill={`url(#${ids.wallMask})`} />
      </mask>
      <rect x={x + w - 1} y={0} width={edge - x - w + 1} height={to + 2} fill={`url(#${ids.wall})`} mask={`url(#${ids.wallMask}-m)`} />
      {/* The rail seam on the near wall, lit along its top like every upward edge. */}
      <line x1={0} y1={seamY} x2={x + 1} y2={seamY} stroke={`url(#${ids.seam})`} strokeWidth="1" />
      <line x1={x * 0.3} y1={seamY + 1} x2={x + 1} y2={seamY + 1} stroke={P.star} strokeOpacity="0.05" strokeWidth="1" />
      {/* The rib. */}
      <rect x={x} y={0} width={w} height={to + 2} rx={1.5} fill={`url(#${ids.rib})`} mask={`url(#${ids.wallMask}-m)`} />
      <rect x={x + w - 3} y={to * 0.3} width={3} height={to * 0.7 + 2} fill={P.pilot} opacity="0.5" />
      <line x1={x + 0.75} y1={to * 0.3} x2={x + 0.75} y2={to + 2} stroke={P.star} strokeOpacity="0.2" strokeWidth="1" />
    </g>
  );
}

/** A standby light: the core, and one bloom in the same colour. */
function Standby({ ids, x, y, r, className }: { ids: RoomIds; x: number; y: number; r: number; className?: string }) {
  return (
    <g className={className}>
      <circle cx={x} cy={y} r={r * 7} fill={`url(#${ids.bloom})`} />
      <circle cx={x} cy={y} r={r} fill={P.console} />
    </g>
  );
}

/**
 * The console: a desk with a screen on it. `hail` is the hailing desk, a
 * plot with nothing on it and the standby light lit; `standby` is the same
 * desk with the screen dimmed to its idle glow while Nori sleeps beside it.
 */
function Console({ ids, x, floor, kind, motion }: { ids: RoomIds; x: number; floor: number; kind: 'hail' | 'standby'; motion: boolean }) {
  const top = floor - 40;
  const w = 66;
  const depth = 10;
  const sx = x + 22; // the screen
  const sy = top - 30;
  const breathing = motion ? 'crew-empty__standby crew-empty__standby--breathing' : 'crew-empty__standby';
  return (
    <g>
      {/* Its shadow on the deck, in the deck's own shade. */}
      <ellipse cx={x + w / 2 + 8} cy={floor + 2} rx={w * 0.6} ry={5} fill={P.seat} opacity="0.12" />
      {/* Front face, turned away from the key. */}
      <rect x={x + depth} y={top} width={w} height={floor - top} rx={2} fill={`url(#${ids.face})`} />
      {/* Top face, seen from a little above, lit at its left end. */}
      <polygon points={`${x},${top} ${x + w},${top} ${x + w + depth},${top + depth} ${x + depth},${top + depth}`} fill={`url(#${ids.top})`} />
      <line x1={x + 1} y1={top + 0.5} x2={x + w - 1} y2={top + 0.5} stroke={P.star} strokeOpacity="0.28" strokeWidth="1" strokeLinecap="round" />
      {/* Screen: stand, frame, glass. */}
      <rect x={sx + 14} y={sy + 24} width={5} height={8} rx={1} fill={P.seat} opacity="0.7" />
      <rect x={sx} y={sy} width={34} height={26} rx={3} fill={P.seat} opacity="0.55" />
      <rect x={sx + 2} y={sy + 2} width={30} height={22} rx={2} fill={P.pilot} />
      {kind === 'standby' ? (
        <rect className={breathing} x={sx + 2} y={sy + 2} width={30} height={22} rx={2} fill={`url(#${ids.screen})`} />
      ) : (
        <g stroke={P.console} fill="none" strokeLinecap="round">
          {/* The plot: a grid and a range ring, and nothing on it. */}
          <line x1={sx + 6} y1={sy + 13} x2={sx + 28} y2={sy + 13} strokeOpacity="0.16" strokeWidth="0.6" />
          <line x1={sx + 17} y1={sy + 5} x2={sx + 17} y2={sy + 21} strokeOpacity="0.16" strokeWidth="0.6" />
          <circle cx={sx + 17} cy={sy + 13} r={6} strokeOpacity="0.3" strokeWidth="0.7" />
          <circle cx={sx + 17} cy={sy + 13} r={2.4} strokeOpacity="0.2" strokeWidth="0.6" />
        </g>
      )}
      {/* The glass over the screen, lit top-left. */}
      <rect x={sx + 2} y={sy + 2} width={30} height={22} rx={2} fill={`url(#${ids.gloss})`} />
      {/* The standby light on the desk, meaning ready. */}
      <Standby ids={ids} x={x + depth + 8} y={top + depth + 6} r={1.6} className={kind === 'hail' ? breathing : 'crew-empty__standby crew-empty__standby--dim'} />
    </g>
  );
}

/** The activity board: a wall panel with nothing on it and one pilot light. */
function Board({ ids, x, y }: { ids: RoomIds; x: number; y: number }) {
  const w = 74;
  const h = 48;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={4} fill={`url(#${ids.frame})`} />
      <rect x={x + 4} y={y + 4} width={w - 8} height={h - 8} rx={2.5} fill={P.pilot} />
      <rect x={x + 4} y={y + 4} width={w - 8} height={h - 8} rx={2.5} fill={`url(#${ids.gloss})`} />
      {/* Rim, lit at the top-left. */}
      <rect x={x + 0.5} y={y + 0.5} width={w - 1} height={h - 1} rx={3.5} fill="none" stroke={P.star} strokeOpacity="0.1" strokeWidth="1" />
      <Standby ids={ids} x={x + w - 9} y={y + h - 9} r={1.2} className="crew-empty__standby crew-empty__standby--dim" />
    </g>
  );
}

/** A berth: a bunk pad against the bulkhead, made up and empty. */
function Berth({ ids, x, floor }: { ids: RoomIds; x: number; floor: number }) {
  const w = 52;
  const top = floor - 13;
  const depth = 7;
  return (
    <g>
      <ellipse cx={x + w / 2 + 6} cy={floor + 1} rx={w * 0.58} ry={3.5} fill={P.seat} opacity="0.14" />
      <rect x={x + depth} y={top} width={w} height={floor - top} rx={2} fill={`url(#${ids.face})`} />
      <polygon points={`${x},${top} ${x + w},${top} ${x + w + depth},${top + depth} ${x + depth},${top + depth}`} fill={`url(#${ids.top})`} />
      <line x1={x + 1} y1={top + 0.5} x2={x + w - 1} y2={top + 0.5} stroke={P.star} strokeOpacity="0.24" strokeWidth="1" strokeLinecap="round" />
      {/* The blanket, turned down: one fold across the pad, its top edge lit. */}
      <polygon points={`${x + 20},${top} ${x + w},${top} ${x + w + depth},${top + depth} ${x + 20 + depth},${top + depth}`} fill={P.seat} opacity="0.32" />
      <line x1={x + 20.5} y1={top + 0.5} x2={x + 20.5 + depth} y2={top + depth} stroke={P.star} strokeOpacity="0.18" strokeWidth="1" />
      {/* The pillow, at the head end nearest the light. */}
      <rect x={x + 2} y={top - 6} width={15} height={7} rx={3} fill={P.seat} opacity="0.6" />
      <line x1={x + 4} y1={top - 5.5} x2={x + 14} y2={top - 5.5} stroke={P.star} strokeOpacity="0.3" strokeWidth="1" strokeLinecap="round" />
    </g>
  );
}

/**
 * The hero room: 320 x 256 around a 128px Nori at (96, 72). The window is
 * up and to the left, the light comes through it onto the deck, the station
 * stands to the right, and a rib of the hull closes the room on that side.
 */
function HeroRoom({ uid, beat }: { uid: string; beat: Beat }) {
  const ids = roomIds(uid);
  const floor = 72 + 128 * FLOOR[beat.mood];
  const win: Box = beat.window === 'near' ? { x: 22, y: 26, w: 98, h: 116, r: 28 } : { x: 34, y: 10, w: 78, h: 92, r: 22 };
  const pool = { x: 166, y: floor + 3 };
  return (
    <svg className="crew-empty__room" viewBox="0 0 320 256" aria-hidden="true" focusable="false">
      <Defs ids={ids} win={win} beamFrom={{ x: win.x + win.w, y: win.y + win.h * 0.6 }} beamTo={{ x: pool.x + 20, y: pool.y }} />
      <Corner ids={ids} x={248} w={14} to={floor + 2} edge={320} seamY={floor - 96} />
      <Window ids={ids} win={win} cruise={beat.motion === 'cruise'} />
      <Light ids={ids} from={win} to={pool} poolAt={pool} rx={96} ry={21} />
      {beat.station === 'hail' && <Console ids={ids} x={190} floor={floor} kind="hail" motion={beat.motion === 'standby'} />}
      {beat.station === 'standby' && <Console ids={ids} x={190} floor={floor} kind="standby" motion={beat.motion === 'standby'} />}
      {beat.station === 'board' && <Board ids={ids} x={196} y={floor - 118} />}
      {beat.station === 'berth' && <Berth ids={ids} x={196} floor={floor} />}
    </svg>
  );
}

/**
 * The compact room: the same quarters seen through a 200 x 106 hatch around
 * an 80px Nori at (60, 22). Everything is clipped to the hatch, whose rim is
 * lit at the top-left like any rim and whose inner edge falls to shade.
 */
function HatchRoom({ uid, beat }: { uid: string; beat: Beat }) {
  const ids = roomIds(uid);
  const floor = 22 + 80 * FLOOR[beat.mood];
  const hatch: Box = { x: 1, y: 1, w: 198, h: 104, r: 34 };
  const win: Box = beat.window === 'near' ? { x: 18, y: 10, w: 48, h: 54, r: 14 } : { x: 22, y: 6, w: 40, h: 44, r: 12 };
  const pool = { x: 102, y: floor + 2 };
  return (
    <svg className="crew-empty__room" viewBox="0 0 200 106" aria-hidden="true" focusable="false">
      <Defs ids={ids} win={win} beamFrom={{ x: win.x + win.w, y: win.y + win.h * 0.6 }} beamTo={{ x: pool.x + 12, y: pool.y }} hatch={hatch} />
      <g clipPath={`url(#${ids.hatch})`}>
        {/* The room behind the hatch is darker than the sidebar it is cut in. */}
        <rect x={hatch.x} y={hatch.y} width={hatch.w} height={hatch.h} fill={P.void} />
        <rect x={hatch.x} y={hatch.y} width={hatch.w} height={hatch.h} fill={`url(#${ids.glass})`} opacity="0.5" />
        {/* The deck: a plane from the floor line to the sill of the hatch. */}
        <rect x={hatch.x} y={floor - 1} width={hatch.w} height={hatch.h - floor + 2} fill={`url(#${ids.deck})`} />
        <Corner ids={ids} x={158} w={9} to={floor} edge={hatch.x + hatch.w} seamY={floor - 52} />
        <Window ids={ids} win={win} cruise={false} />
        <Light ids={ids} from={win} to={pool} poolAt={pool} rx={54} ry={11} />
        {beat.station === 'berth' && <Berth ids={ids} x={112} floor={floor} />}
        {/* The hatch's own thickness: shade along the inside of the opening. */}
        <rect x={hatch.x} y={hatch.y} width={hatch.w} height={hatch.h} rx={hatch.r} fill="none" stroke={P.pilot} strokeOpacity="0.55" strokeWidth="5" />
      </g>
      {/* The rim, lit where the key lands. */}
      <rect x={hatch.x + 0.5} y={hatch.y + 0.5} width={hatch.w - 1} height={hatch.h - 1} rx={hatch.r} fill="none" stroke={`url(#${ids.frame})`} strokeWidth="1" />
      <rect x={hatch.x + 0.5} y={hatch.y + 0.5} width={hatch.w - 1} height={hatch.h - 1} rx={hatch.r} fill="none" stroke={P.star} strokeOpacity="0.12" strokeWidth="1" strokeDasharray={`${hatch.w * 0.6} ${hatch.w * 2 + hatch.h * 2}`} />
    </svg>
  );
}

/**
 * One component for every "no one is here" state, so they are one scene with
 * six beats rather than six mascots. The caller owns the copy and the strings;
 * this owns the picture. Owned by the UI soul pass (scene bible row 3).
 *
 * Layout never moves for the scene: the room is an absolutely positioned
 * layer around a stage box the exact size of Nori, and is drawn narrower
 * than the narrowest column it can appear in, so it spills without ever
 * overflowing a scroll container.
 */
export function CrewEmptyState({ variant, size, children }: CrewEmptyStateProps) {
  // React's ids carry colons, which are not safe inside url(#…) references.
  const uid = useId().replace(/:/g, '');
  const hero = size === 'hero';
  const beat = BEATS[variant];
  return (
    <div className={`crew-empty crew-empty--${variant} crew-empty--${size} flex flex-col items-center ${hero ? 'justify-center h-full' : 'py-6'}`}>
      {hero && <span className="crew-empty__air" aria-hidden="true" />}
      <div className={`crew-empty__stage ${hero ? 'w-32 h-32 mb-4' : 'w-20 h-20 mb-2'}`}>
        {hero ? <HeroRoom uid={uid} beat={beat} /> : <HatchRoom uid={uid} beat={beat} />}
        <Mascot state={beat.mood} className="crew-empty__nori w-full h-full" />
      </div>
      <p className={`crew-empty__copy ${hero ? 'text-sm' : 'text-[13px]'} text-center`}>{children}</p>
    </div>
  );
}
