import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { SceneIds } from '../telemetry/scene/HelloScene';
import { SCENE_PALETTE as P } from '../telemetry/scene/palette';
import { PORT, Ship } from '../telemetry/scene/Ship';
import { StarField, scatterStars, type StarFieldSpec, type Streak } from '../telemetry/scene/StarField';
import './VoiceEmptyPanel.css';

interface VoiceEmptyPanelProps {
  channelName: string;
  onJoin: () => void;
}

/* ── STARS ──
 * The shared sky (telemetry/scene/StarField), drawn once at the largest size
 * the app gives the panel; the panel's overflow crops it, and a smaller panel
 * simply sees the top left of the same sky. Roughly one star per 12,000
 * square pixels: sparse enough that each one is a point you could name,
 * never a texture. One in five breathes.
 */
const FIELD: StarFieldSpec = {
  seed: 2026,
  width: 1400,
  height: 920,
  perStar: 12000,
  bright: 0.22,
  dust: 0.28,
  twinkleEvery: 5,
};
const STARS = scatterStars(FIELD);

/* ── STERNSCHNUPPEN ── three, high in the frame and clear of the craft,
 * on periods that share no factor: one every half minute or so between
 * them, each gone in under a second. */
const STREAKS: ReadonlyArray<Streak> = [
  { left: '48cqw', top: '4px', period: 41, delay: 9 },
  { left: '72cqw', top: '10px', period: 59, delay: 33 },
  { left: '34cqw', top: '2px', period: 73, delay: 50 },
];

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
        <StarField stars={STARS} width={FIELD.width} height={FIELD.height} streaks={STREAKS} />
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
