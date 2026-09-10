import type { CSSProperties } from 'react';
import { SCENE_PALETTE as P } from './palette';
import './StarField.css';

/* ── THE SKY ──
 * One deterministic field of crisp distant stars, shared by every scene that
 * looks out on space (the empty voice channel, the home backdrop). It is
 * drawn in CSS pixels, not viewBox units, so a 1px star is one device-
 * independent pixel at every host size; the host crops it, and a smaller host
 * simply sees the top left of the same sky.
 *
 * Scenes that place their stars by percentage of a frame rather than in
 * pixels (the login backdrop, open space) keep their own still stars and
 * take only `Breath`, the breathing star, from here.
 *
 * Two layers, for one reason: cost. The still stars are one inline SVG,
 * painted once. The few that breathe are HTML spans, one each, animated on
 * the compositor thread. A CSS animation on an element inside an SVG runs on
 * the main thread and repaints the whole SVG every frame, which held the
 * first version of these scenes at a full redraw sixty times a second at
 * rest and multiplied through every frosted surface over them. A span with
 * an opacity animation costs one small layer and no paint at all.
 */

export interface StarBand {
  /** The band's centre line, as fractions of the field, from (x0, y0) to (x1, y1). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The band's half-width, in field heights. */
  sigma: number;
}

export interface StarFieldSpec {
  /** Any integer; the same seed always draws the same sky. */
  seed: number;
  width: number;
  height: number;
  /** Square pixels per star, over the whole field. */
  perStar: number;
  /** The share of stars drawn as 2px dots; the rest are 1px points. */
  bright: number;
  /** The share of stars in the cool dust tone; the rest are warm. */
  dust: number;
  /** One star in this many breathes. */
  twinkleEvery: number;
  /**
   * A soft band of density along a line, so the field reads as a sky and not
   * as noise. Only more points: no colour, no gradient. Away from the band the
   * field thins to a quarter.
   */
  band?: StarBand;
}

export interface Star {
  x: number;
  y: number;
  /** 1 or 2: the only two sizes a distant star has. */
  size: 1 | 2;
  /** Resting opacity; distance, in the only way a flat point can show it. */
  a: number;
  dust: boolean;
  /** Period and phase, in seconds, for the ones that breathe. */
  twinkle?: { period: number; phase: number };
}

/** A shooting star: where it starts, in the host's units, and its timing. */
export interface Streak {
  left: string;
  top: string;
  /** Seconds between falls. */
  period: number;
  /** Seconds into the period at mount, so the first fall is not on cue. */
  delay: number;
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
function bandDistance(spec: StarFieldSpec, band: StarBand, fx: number, fy: number): number {
  const dx = band.x1 - band.x0;
  const dy = band.y1 - band.y0;
  const t = ((fx - band.x0) * dx + (fy - band.y0) * dy) / (dx * dx + dy * dy);
  const px = band.x0 + t * dx;
  const py = band.y0 + t * dy;
  // Distances are measured in field heights so the band is the same number of
  // pixels wide in both axes of a field that is wider than tall.
  return Math.hypot((fx - px) * (spec.width / spec.height), fy - py);
}

/* The breath periods. A real star's light wavers on a scale of seconds; the
 * soothing version of that is a slow breath, four to nine seconds each way,
 * and no two periods a multiple of another, so the breathing stars never fall
 * into step. Slower than this and the sky reads as still. Every scene picks
 * from this list, so the whole app breathes at one pace. */
export const BREATH_PERIODS: ReadonlyArray<number> = [4.2, 5.1, 5.9, 6.8, 7.7, 8.9];
const PERIODS = BREATH_PERIODS;

export function scatterStars(spec: StarFieldSpec): Star[] {
  const next = mulberry32(spec.seed);
  const count = Math.round((spec.width * spec.height) / spec.perStar);
  const stars: Star[] = [];
  let placed = 0;
  while (stars.length < count) {
    const fx = next();
    const fy = next();
    if (spec.band !== undefined) {
      // Rejection sampling against the band: a point on its centre line is
      // always kept, a point far from it one time in four.
      const d = bandDistance(spec, spec.band, fx, fy);
      const keep = 0.25 + 0.75 * Math.exp(-(d * d) / (2 * spec.band.sigma * spec.band.sigma));
      if (next() > keep) continue;
    }
    const x = Math.floor(fx * spec.width);
    const y = Math.floor(fy * spec.height);
    const size: 1 | 2 = next() < spec.bright ? 2 : 1;
    // The large ones are the clear ones: they live in the brighter half. The
    // small ones start at 0.4, because the void is dark enough that a fainter
    // point is not there at all.
    const a = Math.round((size === 2 ? 0.7 + next() * 0.3 : 0.4 + next() * 0.55) * 100) / 100;
    const dust = next() < spec.dust;
    placed += 1;
    const breathes = placed % spec.twinkleEvery === 1;
    const twinkle = breathes
      ? { period: PERIODS[Math.floor(next() * PERIODS.length)] ?? 5.9, phase: Math.round(next() * 90) / 10 }
      : undefined;
    stars.push(twinkle === undefined ? { x, y, size, a, dust } : { x, y, size, a, dust, twinkle });
  }
  return stars;
}

/** The palette's star and dust as channels, so a rest brightness can ride in the colour's alpha. */
function channels(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}
const STAR_RGB = channels(P.star);
const DUST_RGB = channels(P.dust);

/* A 1px star is a crisp-edged pixel: a true point. A 2px star is a round dot
 * centred on a pixel, because a 2px square at 2x is a visible square and a
 * square is not a star. */
function StillStar({ star }: { star: Star }) {
  const fill = star.dust ? P.dust : P.star;
  if (star.size === 1) {
    return <rect x={star.x} y={star.y} width={1} height={1} fill={fill} opacity={star.a} shapeRendering="crispEdges" />;
  }
  return <circle cx={star.x + 0.5} cy={star.y + 0.5} r={1} fill={fill} opacity={star.a} />;
}

export interface BreathProps {
  /** Where the star sits, in the host's units: a pixel number or any CSS length. */
  left: number | string;
  top: number | string;
  /** 1 for a crisp point, 2 for a round dot. */
  size: 1 | 2;
  /** Seconds each way and seconds into the loop at mount. */
  period: number;
  phase: number;
  /** The star's colour with its resting brightness in the alpha; or leave it to `className`. */
  color?: string;
  className?: string;
}

/**
 * A breathing star on its own: one span, one compositor layer, the opacity
 * easing between a third and full on its own period and phase. Its resting
 * brightness rides in the alpha of its colour, so the animation multiplies
 * it and a dim star stays a dim star. Scenes that place stars by percentage
 * of their frame (the login backdrop, open space) use this directly.
 */
export function Breath({ left, top, size, period, phase, color, className }: BreathProps) {
  const style: CSSProperties = {
    left,
    top,
    width: size,
    height: size,
    animationDuration: `${period}s`,
    animationDelay: `-${phase}s`,
  };
  if (color !== undefined) style.backgroundColor = color;
  const classes = ['star-field__breath'];
  if (size === 2) classes.push('star-field__breath--dot');
  if (className) classes.push(className);
  return <span className={classes.join(' ')} style={style} />;
}

/* A breathing star of the field: the same point as a span. */
function BreathingStar({ star, twinkle }: { star: Star; twinkle: NonNullable<Star['twinkle']> }) {
  return (
    <Breath
      left={star.x}
      top={star.y}
      size={star.size}
      period={twinkle.period}
      phase={twinkle.phase}
      color={`rgb(${star.dust ? DUST_RGB : STAR_RGB} / ${star.a})`}
    />
  );
}

interface StarFieldProps {
  stars: ReadonlyArray<Star>;
  width: number;
  height: number;
  streaks?: ReadonlyArray<Streak>;
  className?: string;
}

/**
 * The sky: the still stars in one SVG, the breathing ones as spans over it,
 * and any shooting stars the host asks for. Fills the host's box, which must
 * be positioned and should clip; ignores the pointer; owns no string.
 * Streak positions are the host's, in the host's units: `cqw` resolves
 * against the host when the host is a size container, and this layer never
 * declares a container of its own.
 */
export function StarField({ stars, width, height, streaks = [], className }: StarFieldProps) {
  return (
    <div className={`star-field${className ? ` ${className}` : ''}`} aria-hidden="true">
      <svg className="star-field__still" width={width} height={height} focusable="false">
        {stars.map((star, i) => (star.twinkle === undefined ? <StillStar key={i} star={star} /> : null))}
      </svg>
      {stars.map((star, i) => (star.twinkle === undefined ? null : <BreathingStar key={i} star={star} twinkle={star.twinkle} />))}
      {streaks.map((streak, i) => (
        <span
          key={i}
          className="star-field__streak"
          style={{ left: streak.left, top: streak.top, animationDuration: `${streak.period}s`, animationDelay: `-${streak.delay}s` }}
        />
      ))}
    </div>
  );
}
