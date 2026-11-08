import type { MascotState } from './Mascot';

/** Sakura palettes for the Anime theme; same four moods as the default set. */
export const ANIME_MASCOT_PALETTES = {
  idle:     { from: '#ffe0ee', to: '#f08fc0', shadow: 'rgba(255,160,210,0.16)', blush: '#ff6fa8' },
  sleeping: { from: '#eadfff', to: '#b49be6', shadow: 'rgba(190,160,240,0.13)', blush: '#e48ac0' },
  excited:  { from: '#ffe8d6', to: '#ff9e8a', shadow: 'rgba(255,150,130,0.16)', blush: '#ff6f8f' },
  lonely:   { from: '#d6e6ff', to: '#8fb0e8', shadow: 'rgba(130,170,230,0.13)', blush: '#a8a8d0' },
} as const satisfies Record<MascotState, { from: string; to: string; shadow: string; blush: string }>;

type Point = readonly [number, number];

interface EarGeometry {
  baseOuter: Point;
  tip: Point;
  baseInner: Point;
}

/** Ear triangles per mascot pose; the pose's body is drawn over their bases. */
const EAR_GEOMETRY: Record<'upright' | 'resting', { left: EarGeometry; right: EarGeometry }> = {
  upright: {
    left: { baseOuter: [42, 76], tip: [48, 12], baseInner: [92, 34] },
    right: { baseOuter: [158, 76], tip: [152, 12], baseInner: [108, 34] },
  },
  resting: {
    left: { baseOuter: [34, 62], tip: [50, 6], baseInner: [96, 26] },
    right: { baseOuter: [186, 62], tip: [170, 6], baseInner: [124, 26] },
  },
};

function toward(from: Point, to: Point, amount: number): Point {
  return [from[0] + (to[0] - from[0]) * amount, from[1] + (to[1] - from[1]) * amount];
}

function trianglePath(a: Point, b: Point, c: Point): string {
  return `M${a[0]} ${a[1]} L${b[0]} ${b[1]} L${c[0]} ${c[1]} Z`;
}

function Ear({ geometry, color, inner }: { geometry: EarGeometry; color: string; inner: string }) {
  const { baseOuter, tip, baseInner } = geometry;
  const centroid: Point = [(baseOuter[0] + tip[0] + baseInner[0]) / 3, (baseOuter[1] + tip[1] + baseInner[1]) / 3];
  const innerTriangle = trianglePath(
    toward(baseOuter, centroid, 0.4),
    toward(tip, centroid, 0.4),
    toward(baseInner, centroid, 0.4),
  );
  return (
    <g data-anime="ear">
      <path d={trianglePath(baseOuter, tip, baseInner)} fill={color} stroke={color} strokeWidth="7" strokeLinejoin="round" />
      <path d={innerTriangle} fill={inner} opacity="0.7" stroke={inner} strokeWidth="3" strokeLinejoin="round" />
    </g>
  );
}

/** Cat ears, drawn before the body so the body covers their bases. */
export function NekoEars({ pose, color, inner }: { pose: 'upright' | 'resting'; color: string; inner: string }) {
  const geometry = EAR_GEOMETRY[pose];
  return (
    <>
      <Ear geometry={geometry.left} color={color} inner={inner} />
      <Ear geometry={geometry.right} color={color} inner={inner} />
    </>
  );
}

/** The single curled hair tuft on top of the head. */
export function Ahoge({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <path
      data-anime="ahoge"
      d={`M${x} ${y} C${x - 7} ${y - 14}, ${x + 6} ${y - 24}, ${x + 16} ${y - 18} C${x + 22} ${y - 14}, ${x + 14} ${y - 8}, ${x + 10} ${y - 12}`}
      fill="none"
      stroke={color}
      strokeWidth="4.5"
      strokeLinecap="round"
    />
  );
}

/** Four-point twinkle star; the `anime-twinkle` class is animated in globals.css. */
export function Sparkle({ x, y, size, color, delay = 0 }: { x: number; y: number; size: number; color: string; delay?: number }) {
  return (
    <path
      data-anime="sparkle"
      className="anime-twinkle"
      style={{ animationDelay: `${delay}s`, transformOrigin: `${x}px ${y}px` }}
      d={`M${x} ${y - size} Q${x + size * 0.18} ${y - size * 0.18} ${x + size} ${y} Q${x + size * 0.18} ${y + size * 0.18} ${x} ${y + size} Q${x - size * 0.18} ${y + size * 0.18} ${x - size} ${y} Q${x - size * 0.18} ${y - size * 0.18} ${x} ${y - size}Z`}
      fill={color}
    />
  );
}

/** Whisker strokes and cheek hatching on both cheeks. */
export function CheekMarks({ leftX, rightX, y, color }: { leftX: number; rightX: number; y: number; color: string }) {
  const hatch = (x: number) => [0, 5, 10].map(offset => (
    <line key={offset} x1={x + offset} y1={y + 4} x2={x + offset + 3} y2={y - 3} stroke={color} strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
  ));
  const whiskers = (x: number, direction: 1 | -1) => [-4, 2].map(dy => (
    <line key={dy} x1={x} y1={y + 10 + dy} x2={x + direction * 14} y2={y + 12 + dy * 2.2} stroke={color} strokeWidth="1.4" strokeLinecap="round" opacity="0.45" />
  ));
  return (
    <g data-anime="cheeks">
      {hatch(leftX - 6)}
      {hatch(rightX - 6)}
      {whiskers(leftX - 4, -1)}
      {whiskers(rightX + 4, 1)}
    </g>
  );
}

/** Big star-shaped catchlights laid over the default eyes. */
export function EyeShine({ leftX, rightX, y }: { leftX: number; rightX: number; y: number }) {
  return (
    <g data-anime="eye-shine">
      <Sparkle x={leftX + 4} y={y - 5} size={5.5} color="rgba(255,255,255,0.95)" />
      <Sparkle x={rightX + 4} y={y - 5} size={5.5} color="rgba(255,255,255,0.95)" delay={0.4} />
    </g>
  );
}
