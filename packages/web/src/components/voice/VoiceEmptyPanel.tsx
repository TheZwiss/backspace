import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { SceneIds } from '../telemetry/scene/HelloScene';
import { SCENE_PALETTE as P } from '../telemetry/scene/palette';
import { PORT, Ship } from '../telemetry/scene/Ship';
import './VoiceEmptyPanel.css';

interface VoiceEmptyPanelProps {
  channelName: string;
  onJoin: () => void;
}

/* ── STARS ──
 * A deterministic field in panel pixels, not viewBox units: the SVG has no
 * viewBox, so a 1px star is one CSS pixel at every panel size and the density
 * is the same per square pixel whether the panel is 560 or 1320 wide. The
 * field is drawn once at the largest size the app gives the panel and the
 * panel's overflow crops it; a smaller panel simply sees the top-left of the
 * same sky. Roughly one star per 12,000 square pixels: sparse enough that each
 * one is a point you could name, never a texture.
 */
const FIELD = { w: 1400, h: 920 } as const;
const STAR_COUNT = Math.round((FIELD.w * FIELD.h) / 12000);

interface Star {
  x: number;
  y: number;
  /** 1 or 2: the only two sizes a distant star has. */
  size: 1 | 2;
  /** Resting opacity; distance, in the only way a flat point can show it. */
  a: number;
  dust: boolean;
  /** Phase offset in seconds for the few that twinkle; undefined for the rest. */
  twinkle?: number;
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

function scatter(seed: number): Star[] {
  const next = mulberry32(seed);
  const stars: Star[] = [];
  for (let i = 0; i < STAR_COUNT; i += 1) {
    const x = Math.floor(next() * FIELD.w);
    const y = Math.floor(next() * FIELD.h);
    const size: 1 | 2 = next() < 0.22 ? 2 : 1;
    // The large ones are the clear ones: they live in the brighter half.
    const a = Math.round((size === 2 ? 0.6 + next() * 0.4 : 0.3 + next() * 0.6) * 100) / 100;
    const dust = next() < 0.28;
    // One star in eleven breathes, each on its own phase of the shared loop.
    const twinkle = i % 11 === 4 ? Math.round(next() * 18 * 10) / 10 : undefined;
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
  const twinkle = star.twinkle === undefined ? undefined : { animationDelay: `-${star.twinkle}s` };
  const className = twinkle === undefined ? undefined : 'voice-empty__star--tw';
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
    <svg className="voice-empty__stars" width={FIELD.w} height={FIELD.h} aria-hidden="true" focusable="false">
      {STARS.map((s, i) => (
        <StarPoint key={i} star={s} />
      ))}
    </svg>
  );
}

/* ── NORI ──
 * The mascot, seen through the porthole. The hello scene's pilot is a
 * silhouette with two lit eyes, which at panel size reads as a skull; Nori is
 * the idle face from Mascot.tsx drawn flat, at the proportions the porthole
 * needs: the eyes about a third of the way down and wide apart, the smile
 * small and centred, the blush outboard. The body is one mint disc lit at its
 * upper left; the eyes are solid dark dots, each with one catchlight, because
 * at five pixels an eye is a dot or it is nothing. Clipped by the porthole, so
 * the cabin's amber stays around the face.
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
 * The hello scene's ship, drawn from its own parts at its own coordinates,
 * with Nori in the porthole, plus what a ship under way has that a ship
 * holding station does not: a plume. Two soft fills, no filter. The cabin's
 * warmth is one radial in the same SVG so it rides the bob with the hull.
 * Nothing else emits and nothing is shaded further than the scene already
 * shades it.
 */
function Craft({ ids, uid }: { ids: SceneIds; uid: string }) {
  const warmth = `ve-warmth-${uid}`;
  const plumeSoft = `ve-plume-soft-${uid}`;
  const plumeCore = `ve-plume-core-${uid}`;
  const noriBody = `ve-nori-${uid}`;
  return (
    <svg className="voice-empty__craft-art" viewBox="100 96 240 160" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={warmth}>
          <stop offset="0" stopColor={P.window} stopOpacity="0.09" />
          <stop offset="0.5" stopColor={P.window} stopOpacity="0.025" />
          <stop offset="1" stopColor={P.window} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={plumeSoft}>
          <stop offset="0" stopColor={P.windowLit} stopOpacity="0.55" />
          <stop offset="0.55" stopColor={P.window} stopOpacity="0.2" />
          <stop offset="1" stopColor={P.window} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={plumeCore}>
          <stop offset="0" stopColor={P.beam} stopOpacity="0.95" />
          <stop offset="0.6" stopColor={P.windowLit} stopOpacity="0.45" />
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

      {/* The cabin's warmth: the one light the void is allowed. */}
      <ellipse cx={PORT.cx} cy={PORT.cy} rx="120" ry="96" fill={`url(#${warmth})`} />

      {/* The plume, behind the bell, along the ship's axis. It lengthens on hover. */}
      <g className="voice-empty__plume">
        <ellipse cx="92" cy="176" rx="42" ry="15" fill={`url(#${plumeSoft})`} />
        <ellipse cx="112" cy="176" rx="22" ry="6.5" fill={`url(#${plumeCore})`} />
      </g>

      <Ship ids={ids} />
      <Nori clip={ids.clip} body={noriBody} />
    </svg>
  );
}

/**
 * The body of a voice channel nobody is in yet. Deep dark space, a small
 * craft left of centre on its way toward the lower right, where a large world
 * sits mostly off-frame on its night side; sparse crisp stars at distance;
 * the channel's name and the Join button in the dark between them. That
 * emptiness is the subject: it is vast, and it is waiting. Pressing Join is
 * the arrival.
 *
 * Every decorative layer is absolutely positioned inside the panel, which
 * clips them, so nothing here moves the header above it. Owned by the UI soul
 * pass (scene bible row 1, second pass, under the darkness rule).
 */
export function VoiceEmptyPanel({ channelName, onJoin }: VoiceEmptyPanelProps) {
  const { t } = useTranslation(['spaces']);
  // React ids carry colons, which are not safe inside url(#…) references.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const ids: SceneIds = {
    hull: `ve-${uid}-hull`,
    cabin: `ve-${uid}-cabin`,
    beam: `ve-${uid}-beam`,
    glow: `ve-${uid}-glow`,
    nebula: `ve-${uid}-nebula`,
    fade: `ve-${uid}-fade`,
    maskA: `ve-${uid}-maskA`,
    maskB: `ve-${uid}-maskB`,
    clip: `ve-${uid}-clip`,
  };

  return (
    <div className="voice-empty flex-1 flex flex-col items-center justify-center relative">
      <div className="voice-empty__scene" aria-hidden="true">
        <Stars />
        <div className="voice-empty__world" />
        <div className="voice-empty__craft">
          <Craft ids={ids} uid={uid} />
        </div>
      </div>

      <div className="voice-empty__content">
        <h2 className="voice-empty__title text-[28px] font-bold text-txt-primary">{channelName}</h2>
        <p className="voice-empty__copy text-txt-secondary text-[15px]">{t('spaces:main.voice.empty')}</p>
        <button type="button" onClick={onJoin} className="voice-empty__join cta-primary relative px-8 py-3 rounded-full text-[15px]">
          {t('spaces:main.voice.join')}
        </button>
      </div>
    </div>
  );
}
