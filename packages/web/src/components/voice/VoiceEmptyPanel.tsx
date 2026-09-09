import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { SceneIds } from '../telemetry/scene/HelloScene';
import { SCENE_PALETTE as P } from '../telemetry/scene/palette';
import { Pilot } from '../telemetry/scene/Pilot';
import { PORT, Ship } from '../telemetry/scene/Ship';
import './VoiceEmptyPanel.css';

interface VoiceEmptyPanelProps {
  channelName: string;
  onJoin: () => void;
}

/* ── STARS ──
 * A deterministic field: the same sky on every mount, so two screenshots differ
 * only by what changed on purpose. Drawn once as inline SVG rather than as a
 * repeating tile because at panel width a tile's repeat is visible as a
 * pattern, and a pattern is the one thing a sky must never be.
 */
interface Star {
  x: number;
  y: number;
  r: number;
  hue: number;
  a: number;
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

function scatter(seed: number, count: number, rMin: number, rMax: number, aMin: number, aMax: number): Star[] {
  const next = mulberry32(seed);
  const stars: Star[] = [];
  for (let i = 0; i < count; i += 1) {
    stars.push({
      x: Math.round(next() * 1000),
      y: Math.round(next() * 640),
      r: Math.round((rMin + next() * (rMax - rMin)) * 10) / 10,
      hue: Math.floor(next() * 9),
      a: Math.round((aMin + next() * (aMax - aMin)) * 100) / 100,
    });
  }
  return stars;
}

// Far: many, small, soft. Near: few, sharp, occasionally coloured.
const FAR = scatter(41, 64, 0.7, 1.3, 0.22, 0.5);
const NEAR = scatter(97, 18, 1.4, 2.4, 0.55, 0.95);

// Most stars are the warm white of the palette; one in nine leans sky, one in
// nine lavender, and a single near star is amber, the way a real field has one
// red giant in it.
function starColour(hue: number, near: boolean): string {
  if (hue === 0) return P.dust;
  if (hue === 1) return P.console;
  if (near && hue === 2) return P.window;
  return P.star;
}

function Stars() {
  return (
    <svg className="voice-empty__stars" viewBox="0 0 1000 640" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <g className="voice-empty__stars-far">
        {FAR.map((s, i) => (
          <circle key={`f${i}`} cx={s.x} cy={s.y} r={s.r} fill={starColour(s.hue, false)} opacity={s.a} />
        ))}
      </g>
      <g className="voice-empty__stars-near">
        {NEAR.map((s, i) => (
          <circle key={`n${i}`} cx={s.x} cy={s.y} r={s.r} fill={starColour(s.hue, true)} opacity={s.a} />
        ))}
      </g>
    </svg>
  );
}

/* ── COURSE ──
 * The plotted heading from the ship to the beacon. The viewBox is stretched to
 * the panel so the same path always leaves the ship, passes behind the title,
 * runs through the Join button and arrives at the docking collar, whatever the
 * panel's shape; the stroke is non-scaling so the dots stay round dots. It dips
 * under the button and rises into the collar: an approach, not a straight line.
 */
function Course() {
  return (
    <svg className="voice-empty__course" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path
        className="voice-empty__course-line"
        d="M 225 242 C 380 275, 450 450, 500 588 C 545 690, 650 660, 750 600"
        fill="none"
        stroke={P.signal}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="0.1 9"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* ── THE CRAFT ──
 * The same ship as the telemetry scene, composed from its own parts (hull,
 * porthole, pilot) at their own coordinates, plus the passes the hello scene
 * does not need at 480px but a panel-sized porthole does: the exhaust plume
 * behind the bell, a form shadow so the hull is a volume rather than a bright
 * cut-out, the specular that says where the key is, and the seams that keep
 * the fins and the bell from merging into one lavender mass.
 *
 * One light, up and to the left. Only the porthole and the plume emit.
 */
function Craft({ ids, uid }: { ids: SceneIds; uid: string }) {
  const plume = `ve-plume-${uid}`;
  const form = `ve-form-${uid}`;
  const formMask = `ve-form-mask-${uid}`;
  return (
    <svg className="voice-empty__craft-art" viewBox="0 0 352 252" aria-hidden="true" focusable="false">
      <defs>
        {/* One blur, shared by everything that emits on the ship. */}
        <filter id={ids.glow} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        {/* Plume: brightest where it leaves the bell, gone by the tail. */}
        <linearGradient id={plume} x1="66" y1="0" x2="136" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={P.beam} stopOpacity="0" />
          <stop offset="0.45" stopColor={P.window} stopOpacity="0.5" />
          <stop offset="1" stopColor={P.windowLit} stopOpacity="0.95" />
        </linearGradient>
        {/* Form shadow: the hull shades with its own lavender, never with the
            dark. A green hull shaded toward black goes olive. */}
        <linearGradient id={form} x1="0.26" y1="0.06" x2="0.7" y2="1">
          <stop offset="0" stopColor={P.hullShade} stopOpacity="0" />
          <stop offset="0.52" stopColor={P.hullShade} stopOpacity="0.12" />
          <stop offset="1" stopColor={P.hullShade} stopOpacity="0.62" />
        </linearGradient>
        {/* The form pass must not dim the porthole, which is drawn before it. */}
        <mask id={formMask}>
          <rect width="352" height="252" fill={P.star} />
          <circle cx={PORT.cx} cy={PORT.cy} r={PORT.r + 7} fill={P.pilot} />
        </mask>
      </defs>

      {/* The whole ship pitched a few degrees toward the course it is holding. */}
      <g transform="rotate(7 230 176)">
        {/* Exhaust, behind the bell. Three passes: a wide haze, the body of the
            flame, then a hot mouth. One shape would read as a stripe. */}
        <g className="voice-empty__plume">
          <g className="voice-empty__plume-burn">
            <ellipse cx="104" cy="176" rx="46" ry="27" fill={P.window} opacity="0.32" filter={`url(#${ids.glow})`} />
            <path
              d="M134 150 C112 160 91 170 62 176 C91 182 112 192 134 202 C148 190 148 162 134 150 Z"
              fill={`url(#${plume})`}
              filter={`url(#${ids.glow})`}
            />
            <path d="M133 163 C115 168 99 173 82 176 C99 179 115 184 133 189 Z" fill={`url(#${plume})`} />
            <ellipse cx="126" cy="176" rx="12" ry="12" fill={P.windowLit} opacity="0.85" filter={`url(#${ids.glow})`} />
          </g>
        </g>

        <Ship ids={ids} />

        {/* Fin roots and the bell's throat: the lines that keep the back of the
            ship from being one flat lavender shape. */}
        <path
          d="M201 131 C190 125 179 118 168 112 M201 221 C190 227 179 234 168 240"
          stroke={P.pilot}
          strokeOpacity="0.24"
          strokeWidth="3.5"
          strokeLinecap="round"
          fill="none"
        />
        <ellipse cx="128" cy="176" rx="5" ry="12" fill={P.pilot} opacity="0.4" />

        {/* Form shadow over the hull, unlit corner to lit, minus the porthole. */}
        <path
          d="M138 176 C138 152 160 136 196 136 L246 136 C296 136 326 158 330 176 C326 194 296 216 246 216 L196 216 C160 216 138 200 138 176 Z"
          fill={`url(#${form})`}
          mask={`url(#${formMask})`}
        />
        {/* Specular: the one stroke that says where the light is. It stops
            short of the nose because past there the hull has turned away. */}
        <path
          d="M150 165 C158 149 176 141 202 140 L243 140"
          fill="none"
          stroke={P.star}
          strokeOpacity="0.5"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path
          d="M243 141 C272 142 291 150 304 162"
          fill="none"
          stroke={P.star}
          strokeOpacity="0.2"
          strokeWidth="4.5"
          strokeLinecap="round"
        />
        {/* Nose seam, drawn as shadow: a lavender highlight on a lavender nose
            would be invisible. */}
        <path
          d="M309 149 C320 157 327 166 330 176 C327 186 320 195 309 203"
          fill="none"
          stroke={P.pilot}
          strokeOpacity="0.18"
          strokeWidth="4"
          strokeLinecap="round"
        />

        <Pilot ids={ids} />
      </g>
    </svg>
  );
}

/* ── THE BEACON ──
 * A small rendezvous station in orbit above the world's lit limb: a hub with a
 * solar wing, a strut, and below it the docking collar, open toward the
 * incoming course, with its docking light on and nothing moored in it. The
 * collar is the subject of the whole panel. The light sits at the SVG's centre
 * so the course, which ends at the same panel coordinate, ends exactly in it.
 *
 * Structure is lit by the key like everything else: `dust` on the faces that
 * see it, `hullShade` on the ones that do not. The docking light is the only
 * emitter; the standby lamp on the hub is a lamp, not a light source.
 */
function Beacon({ uid }: { uid: string }) {
  const bloom = `ve-bloom-${uid}`;
  const hub = `ve-hub-${uid}`;
  return (
    <svg className="voice-empty__beacon-art" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <defs>
        <filter id={bloom} x="-120%" y="-120%" width="340%" height="340%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <linearGradient id={hub} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={P.dust} />
          <stop offset="0.45" stopColor={P.seat} />
          <stop offset="1" stopColor={P.hullShade} stopOpacity="0.8" />
        </linearGradient>
      </defs>

      {/* Solar wing on a short boom above the hub. Cell divisions are placed by
          hand at uneven intervals: an even repeat reads as a barcode. The top
          edge is the one face of the wing the key reaches. */}
      <path d="M95 32 L95 25" stroke={P.hullShade} strokeWidth="2.2" strokeLinecap="round" />
      <rect x="60" y="15" width="70" height="10" rx="1.2" fill={P.pilot} />
      <rect x="60" y="15" width="70" height="10" rx="1.2" fill={P.console} opacity="0.24" />
      <path d="M60.6 15.8 L129.4 15.8" stroke={P.dust} strokeOpacity="0.5" strokeWidth="1" />
      <path d="M69 15 V25 M81 15 V25 M97 15 V25 M106 15 V25 M119 15 V25" stroke={P.hullShade} strokeOpacity="0.6" strokeWidth="0.9" />
      <path d="M60 20.2 L130 20.2" stroke={P.hullShade} strokeOpacity="0.35" strokeWidth="0.7" />

      {/* Hub: the lit face top-left, turning to shade lower-right. */}
      <rect x="84" y="32" width="22" height="18" rx="3.2" fill={`url(#${hub})`} />
      <path d="M87 32.8 L102 32.8" stroke={P.star} strokeOpacity="0.6" strokeWidth="1" strokeLinecap="round" />
      <path d="M105.2 36 L105.2 46" stroke={P.pilot} strokeOpacity="0.32" strokeWidth="1" strokeLinecap="round" />
      {/* Standby lamp: the colour of "ready". A lamp, not a light source. */}
      <rect x="89" y="40" width="6" height="2.4" rx="0.7" fill={P.console} opacity="0.9" />

      {/* Strut down to the collar, with its own shadow line so it has a side. */}
      <path d="M90 50 L74 69" stroke={P.hullShade} strokeWidth="3" strokeLinecap="round" />
      <path d="M91 50.6 L75 69.6" stroke={P.pilot} strokeOpacity="0.28" strokeWidth="1" strokeLinecap="round" />

      {/* The docking collar: an open cradle around the light, the gap facing
          the incoming course. Base in shade; the arc the key reaches, top-left,
          in starlight; the arc that turns away, lower right, in the dark. Two
          clamps at the mouth, open, holding nothing. */}
      <path d="M44.6 52.8 A17 17 0 1 1 58.5 76.9" fill="none" stroke={P.hullShade} strokeWidth="5" strokeLinecap="round" />
      <path d="M46.1 50.2 A17 17 0 0 1 68.5 45.3" fill="none" stroke={P.star} strokeOpacity="0.5" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M76 65.8 A17 17 0 0 1 58.5 76.9" fill="none" stroke={P.pilot} strokeOpacity="0.35" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M40.6 51 L47.6 54.3 M58 81.5 L58.6 74.5" stroke={P.dust} strokeOpacity="0.75" strokeWidth="2.2" strokeLinecap="round" />

      {/* The docking light: bloom, body, hot centre. On, and waiting. */}
      <g className="voice-empty__dock-light">
        <circle cx="60" cy="60" r="14" fill={P.signal} opacity="0.6" filter={`url(#${bloom})`} />
        <circle cx="60" cy="60" r="4.6" fill={P.signal} />
        <circle cx="59.2" cy="59.2" r="1.9" fill={P.beam} opacity="0.92" />
      </g>
    </svg>
  );
}

/**
 * The body of a voice channel nobody is in yet: the rendezvous, and nobody is
 * moored. The same porthole as the telemetry answer at panel scale: the craft
 * holds station upper left with its cabin lit, a large world sits low right on
 * its night side, and in orbit above its lit limb a small beacon waits with its
 * docking light on and nothing in the collar. A plotted course runs from the
 * ship, behind the channel name, through Join Voice, into the collar. Pressing
 * Join is the departure; the grid that replaces this panel is the arrival.
 *
 * Every decorative layer is absolutely positioned inside the panel, which is
 * the porthole's clip, so nothing here moves the header above it. Owned by the
 * UI soul pass (scene bible row 1).
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
        <div className="voice-empty__void" />
        <div className="voice-empty__nebula" />
        <div className="voice-empty__grain" />
        <Stars />
        <div className="voice-empty__world" />
        <div className="voice-empty__orbit" />
        <Course />
        <div className="voice-empty__beacon">
          <Beacon uid={uid} />
        </div>
        <div className="voice-empty__craft">
          <div className="voice-empty__craft-drift">
            <Craft ids={ids} uid={uid} />
          </div>
        </div>
        <div className="voice-empty__scrim" />
        <div className="voice-empty__gloss" />
        <div className="voice-empty__frame" />
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
