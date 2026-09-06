import type { SceneIds } from './HelloScene';
import { SCENE_PALETTE as P } from './palette';

interface Star {
  x: number;
  y: number;
  r: number;
  k: number;
}

// Deterministic star field: the same sky on every render, so the contact
// sheets of two rounds differ only by what changed on purpose.
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

function scatter(seed: number, count: number, rMin: number, rMax: number): Star[] {
  const next = mulberry32(seed);
  const stars: Star[] = [];
  for (let i = 0; i < count; i += 1) {
    stars.push({
      x: Math.round(8 + next() * 464),
      y: Math.round(8 + next() * 304),
      r: Math.round((rMin + next() * (rMax - rMin)) * 10) / 10,
      k: i % 3,
    });
  }
  return stars;
}

const FAR = scatter(11, 28, 0.8, 1.3);
const NEAR = scatter(23, 14, 1.5, 2.3);
// The six stars that pulse when the beam goes out; they sit along its path.
const PULSE: Star[] = [
  { x: 306, y: 118, r: 2.4, k: 0 },
  { x: 348, y: 70, r: 2.1, k: 1 },
  { x: 372, y: 98, r: 2.6, k: 2 },
  { x: 392, y: 34, r: 2.2, k: 0 },
  { x: 420, y: 62, r: 2.4, k: 1 },
  { x: 442, y: 22, r: 2.0, k: 2 },
];

function StarDot({ star, index, pulse }: { star: Star; index: number; pulse?: boolean }) {
  return (
    <circle
      cx={star.x}
      cy={star.y}
      r={star.r}
      fill={P.star}
      className={`hs-tw${star.k}${pulse ? ' hs-pulse' : ''}`}
      style={{ animationDelay: `-${((index * 0.37) % 3).toFixed(2)}s` }}
      data-part={pulse ? 'pulse' : undefined}
    />
  );
}

export function Void({ ids }: { ids: SceneIds }) {
  return (
    <>
      <defs>
        <radialGradient id={ids.fade}>
          <stop offset="0" stopColor={P.star} stopOpacity="1" />
          <stop offset="1" stopColor={P.star} stopOpacity="0" />
        </radialGradient>
        <filter id={ids.nebula} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.007 0.011" numOctaves="3" seed="7" result="noise" />
          <feColorMatrix in="noise" type="luminanceToAlpha" result="alpha" />
          <feComponentTransfer in="alpha" result="shaped">
            <feFuncA type="table" tableValues="0 0 0.35 0.8 1" />
          </feComponentTransfer>
          <feGaussianBlur in="shaped" stdDeviation="7" result="soft" />
          <feComposite in="SourceGraphic" in2="soft" operator="in" />
        </filter>
        <mask id={ids.maskA}>
          <ellipse cx="380" cy="60" rx="230" ry="150" fill={`url(#${ids.fade})`} />
        </mask>
        <mask id={ids.maskB}>
          <ellipse cx="90" cy="270" rx="220" ry="140" fill={`url(#${ids.fade})`} />
        </mask>
      </defs>
      <g data-layer="void">
        <rect width="480" height="320" fill={P.void} />
      </g>
      <g data-layer="nebula">
        <rect width="480" height="320" fill={P.nebulaA} opacity="0.22" filter={`url(#${ids.nebula})`} mask={`url(#${ids.maskA})`} />
        <rect width="480" height="320" fill={P.nebulaB} opacity="0.15" filter={`url(#${ids.nebula})`} mask={`url(#${ids.maskB})`} />
      </g>
      <g data-layer="stars">
        <g data-part="far" className="hs-far" opacity="0.55">
          {FAR.map((star, i) => <StarDot key={i} star={star} index={i} />)}
        </g>
        <g data-part="near" className="hs-near">
          {NEAR.map((star, i) => <StarDot key={i} star={star} index={i + 7} />)}
          {PULSE.map((star, i) => <StarDot key={`p${i}`} star={star} index={i + 3} pulse />)}
        </g>
      </g>
    </>
  );
}
