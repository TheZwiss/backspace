import { useId, useRef } from 'react';
import { useMascotAnimation } from '../../hooks/useMascotAnimation';
import { SCENE_PALETTE as P } from '../telemetry/scene/palette';

/**
 * Nori's four moods, each a body colour taken from an Aether Drift accent:
 * `from` is the face the key light lands on (the accent lifted one step toward
 * `star`), `to` is the accent itself, and `shade` is where the form turns away
 * from the light. Every mood but sleeping shades toward the scene's
 * `hullShade`, the same lavender the ship's belly and fins carry, so Nori is
 * lit by the same light as the craft. The lavender body shades toward
 * `--accent-primary` instead, because lavender turned toward lavender does not
 * turn. Nothing here is pure black or white.
 */
export const MASCOT_PALETTES = {
  // --accent-mint, the hull's own colour.
  idle:     { from: '#9cefb7', to: '#86efac', shade: '#b3a7f3', blush: '#fda4af' },
  // --accent-lavender, shading toward --accent-primary.
  sleeping: { from: '#cdc0f8', to: '#c4b5fd', shade: '#a696f8', blush: '#fda4af' },
  // --accent-peach, shading to lavender: a warm form turning into the cool.
  excited:  { from: '#fab3b2', to: '#fca5a5', shade: '#b3a7f3', blush: '#fb923c' },
  // --accent-sky, pulled a step toward lavender so the cold mood sits back.
  lonely:   { from: '#95d8f7', to: '#86d0f4', shade: '#b3a7f3', blush: '#c4b5fd' },
} as const;

export type MascotState = keyof typeof MASCOT_PALETTES;

type MascotPalette = (typeof MASCOT_PALETTES)[MascotState];

interface MascotProps {
  state: MascotState;
  className?: string;
}

// The pupil is one step darker than the eye in the same warm family as `pilot`.
const PUPIL = '#120e1a';
// The lit crest of the eyeball, where the key catches the dome before the pupil.
const EYE_LIT = '#352d4a';

/** The gradient ids one instance paints with; unique per mount. */
interface MascotIds {
  body: string;
  form: string;
  turn: string;
  shadow: string;
  blush: string;
  spec: string;
  eye: string;
}

interface SvgProps {
  palette: MascotPalette;
  ids: MascotIds;
  svgRef: React.Ref<SVGSVGElement>;
}

/**
 * The gradients every mood shares. `body` puts the lit face upper left and
 * lets the far rim fall to the shade colour; `form` is a second pass over the
 * same silhouette, nothing at the lit corner and most of the shade at the
 * lower right, which is what makes a flat cut-out read as a rounded thing;
 * `turn` is the terminator, a third pass that only exists at the far rim, so
 * the surface goes fully into shade with a soft edge, never a seam.
 * `shadow` is the cast shadow's soft edge, done with a gradient rather than a
 * blur so the drawing stays inside the scene's filter budget. `spec` fades the
 * specular stroke out along its own length, so it ends where the surface
 * turns away rather than at a hard cap.
 */
function Defs({ palette, ids, specFrom, specTo }: {
  palette: MascotPalette;
  ids: MascotIds;
  specFrom: { x: number; y: number };
  specTo: { x: number; y: number };
}) {
  return (
    <defs>
      <radialGradient id={ids.body} cx="0.36" cy="0.28" r="0.86">
        <stop offset="0" stopColor={palette.from} />
        <stop offset="0.62" stopColor={palette.to} />
        <stop offset="1" stopColor={palette.shade} />
      </radialGradient>
      <linearGradient id={ids.form} x1="0.28" y1="0.04" x2="0.74" y2="1">
        <stop offset="0" stopColor={palette.shade} stopOpacity="0" />
        <stop offset="0.56" stopColor={palette.shade} stopOpacity="0.06" />
        <stop offset="1" stopColor={palette.shade} stopOpacity="0.5" />
      </linearGradient>
      <radialGradient id={ids.turn} cx="0.34" cy="0.26" r="0.9">
        <stop offset="0.6" stopColor={palette.shade} stopOpacity="0" />
        <stop offset="0.82" stopColor={palette.shade} stopOpacity="0.28" />
        <stop offset="1" stopColor={palette.shade} stopOpacity="0.72" />
      </radialGradient>
      <radialGradient id={ids.shadow} cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stopColor={palette.shade} stopOpacity="1" />
        <stop offset="0.55" stopColor={palette.shade} stopOpacity="0.6" />
        <stop offset="1" stopColor={palette.shade} stopOpacity="0" />
      </radialGradient>
      <linearGradient
        id={ids.spec}
        gradientUnits="userSpaceOnUse"
        x1={specFrom.x}
        y1={specFrom.y}
        x2={specTo.x}
        y2={specTo.y}
      >
        <stop offset="0" stopColor={P.star} stopOpacity="0.1" />
        <stop offset="0.3" stopColor={P.star} stopOpacity="0.5" />
        <stop offset="1" stopColor={P.star} stopOpacity="0" />
      </linearGradient>
      <radialGradient id={ids.eye} cx="0.36" cy="0.3" r="0.9">
        <stop offset="0" stopColor={EYE_LIT} />
        <stop offset="1" stopColor={P.pilot} />
      </radialGradient>
      <radialGradient id={ids.blush} cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stopColor={palette.blush} stopOpacity="0.85" />
        <stop offset="0.55" stopColor={palette.blush} stopOpacity="0.5" />
        <stop offset="1" stopColor={palette.blush} stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

/**
 * The body, layered the way the ship's hull is: the gradient fill, the
 * terminator pass where the surface has turned fully away, the form-shadow
 * pass over the whole silhouette, then the one specular stroke that says
 * where the light is. Every pass is a gradient over the same silhouette, so
 * the turn has no edge at any size.
 */
function Body({ ids, d, specular }: {
  ids: MascotIds;
  d: string;
  specular: string;
}) {
  return (
    <>
      <path data-mascot="body" d={d} fill={`url(#${ids.body})`} />
      <path d={d} fill={`url(#${ids.turn})`} />
      <path d={d} fill={`url(#${ids.form})`} />
      <path
        d={specular}
        fill="none"
        stroke={`url(#${ids.spec})`}
        strokeWidth="4.5"
        strokeLinecap="round"
      />
    </>
  );
}

/**
 * The cast shadow: offset down and to the right of the body's contact point,
 * where the key light throws it, and drawn in the body's own shade colour
 * because a shadow on the deck is the shaded body's colour, not grey. The hook
 * squashes it (rx) and fades it (opacity) while the body breathes, so the
 * fill is opaque and the element's opacity is the only alpha.
 */
function Shadow({ ids, cx, cy, rx, ry, opacity }: {
  ids: MascotIds;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  opacity: number;
}) {
  return (
    <ellipse
      data-mascot="shadow"
      cx={cx}
      cy={cy}
      rx={rx}
      ry={ry}
      fill={`url(#${ids.shadow})`}
      opacity={opacity}
    />
  );
}

interface EyeGeometry {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  pupilDx: number;
  pupilDy: number;
  pupilRx: number;
  pupilRy: number;
  catch: number;
  catchOpacity: number;
}

/**
 * One open eye. The eyeball is a dark dome lit at its upper left like
 * everything else; the pupil sits one step darker inside it; the catchlight is
 * the key light reflected off the cornea, so it lives upper left and stays put
 * when the pupil moves, as a reflection does. The hook closes the eye by
 * animating `ry` on the white and the pupil, and looks around by translating
 * the pupil, so both stay ellipses.
 */
function Eye({ ids, side, g }: { ids: MascotIds; side: 'left' | 'right'; g: EyeGeometry }) {
  const px = g.cx + g.pupilDx;
  const py = g.cy + g.pupilDy;
  return (
    <>
      <ellipse data-eye="white" data-side={side} cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} fill={`url(#${ids.eye})`} />
      <ellipse data-eye="pupil" data-side={side} cx={px} cy={py} rx={g.pupilRx} ry={g.pupilRy} fill={PUPIL} />
      <circle cx={g.cx - g.rx * 0.3} cy={g.cy - g.ry * 0.36} r={g.catch} fill={P.star} opacity={g.catchOpacity} />
    </>
  );
}

const IDLE_BODY =
  'M100 28 C132 28, 162 48, 166 84 C170 120, 152 154, 122 162 C108 166, 92 166, 78 162 C48 154, 30 120, 34 84 C38 48, 68 28, 100 28Z';
const IDLE_SPECULAR = 'M47 94 C49 66, 64 46, 90 38 C106 34, 120 36, 132 42';

function IdleSvg({ palette, ids, svgRef }: SvgProps) {
  return (
    <svg ref={svgRef} viewBox="0 0 200 200" aria-hidden="true" width="100%" height="100%">
      <Defs palette={palette} ids={ids} specFrom={{ x: 47, y: 94 }} specTo={{ x: 132, y: 42 }} />
      <Shadow ids={ids} cx={116} cy={173} rx={32} ry={9} opacity={0.13} />
      <Body ids={ids} d={IDLE_BODY} specular={IDLE_SPECULAR} />

      <ellipse cx="64" cy="108" rx="10" ry="4.5" fill={`url(#${ids.blush})`} opacity="0.9" transform="rotate(-8 64 108)" />
      <ellipse cx="136" cy="108" rx="10" ry="4.5" fill={`url(#${ids.blush})`} opacity="0.9" transform="rotate(8 136 108)" />

      <Eye ids={ids} side="left" g={{ cx: 80, cy: 92, rx: 12, ry: 13, pupilDx: 1, pupilDy: 1, pupilRx: 7.5, pupilRy: 8, catch: 3.2, catchOpacity: 0.85 }} />
      <Eye ids={ids} side="right" g={{ cx: 120, cy: 92, rx: 12, ry: 13, pupilDx: 1, pupilDy: 1, pupilRx: 7.5, pupilRy: 8, catch: 3.2, catchOpacity: 0.85 }} />

      <path
        data-mascot="mouth"
        d="M92 116 Q100 123, 108 116"
        stroke={P.pilot}
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

const SLEEP_BODY =
  'M110 24 C152 24, 190 38, 192 64 C194 86, 174 106, 142 112 C126 116, 94 116, 78 112 C46 106, 26 86, 28 64 C30 38, 68 24, 110 24Z';
const SLEEP_SPECULAR = 'M44 70 C50 48, 76 33, 104 30 C126 28, 146 32, 162 40';

function SleepingSvg({ palette, ids, svgRef }: SvgProps) {
  return (
    <svg ref={svgRef} viewBox="0 0 220 130" aria-hidden="true" width="100%" height="100%">
      <Defs palette={palette} ids={ids} specFrom={{ x: 44, y: 70 }} specTo={{ x: 162, y: 40 }} />
      <Shadow ids={ids} cx={128} cy={115} rx={58} ry={8} opacity={0.16} />
      <Body ids={ids} d={SLEEP_BODY} specular={SLEEP_SPECULAR} />

      <ellipse cx="78" cy="76" rx="10" ry="4" fill={`url(#${ids.blush})`} opacity="0.7" />
      <ellipse cx="142" cy="76" rx="10" ry="4" fill={`url(#${ids.blush})`} opacity="0.7" />

      <path
        data-eye="closed"
        data-side="left"
        d="M86 64 Q94 54, 102 64"
        stroke={P.pilot}
        strokeWidth="2.8"
        fill="none"
        strokeLinecap="round"
      />
      <path
        data-eye="closed"
        data-side="right"
        d="M118 64 Q126 54, 134 64"
        stroke={P.pilot}
        strokeWidth="2.8"
        fill="none"
        strokeLinecap="round"
      />

      <ellipse data-mascot="mouth" cx="110" cy="78" rx="4" ry="3.2" fill={P.pilot} opacity="0.35" />
    </svg>
  );
}

function ExcitedSvg({ palette, ids, svgRef }: SvgProps) {
  return (
    <svg ref={svgRef} viewBox="0 0 200 200" aria-hidden="true" width="100%" height="100%">
      <Defs palette={palette} ids={ids} specFrom={{ x: 47, y: 94 }} specTo={{ x: 132, y: 42 }} />
      {/* Lifted: the body sits higher off the deck, so the shadow is smaller and further from it. */}
      <Shadow ids={ids} cx={118} cy={175} rx={32} ry={8} opacity={0.13} />
      <g transform="translate(0 -4)">
        <Body ids={ids} d={IDLE_BODY} specular={IDLE_SPECULAR} />

        <ellipse cx="64" cy="108" rx="10" ry="4.5" fill={`url(#${ids.blush})`} opacity="0.85" transform="rotate(-8 64 108)" />
        <ellipse cx="136" cy="108" rx="10" ry="4.5" fill={`url(#${ids.blush})`} opacity="0.85" transform="rotate(8 136 108)" />

        <Eye ids={ids} side="left" g={{ cx: 80, cy: 92, rx: 12, ry: 13, pupilDx: 1, pupilDy: 1, pupilRx: 7.5, pupilRy: 8, catch: 3.4, catchOpacity: 0.9 }} />
        <Eye ids={ids} side="right" g={{ cx: 120, cy: 92, rx: 12, ry: 13, pupilDx: 1, pupilDy: 1, pupilRx: 7.5, pupilRy: 8, catch: 3.4, catchOpacity: 0.9 }} />

        <path
          data-mascot="mouth"
          d="M92 116 Q100 128, 108 116"
          stroke={P.pilot}
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

const LONELY_BODY =
  'M100 32 C130 32, 158 50, 160 86 C162 118, 146 150, 120 158 C108 162, 92 162, 80 158 C54 150, 38 118, 40 86 C42 50, 70 32, 100 32Z';
const LONELY_SPECULAR = 'M52 96 C54 70, 68 50, 90 42 C104 38, 118 40, 128 46';

function LonelySvg({ palette, ids, svgRef }: SvgProps) {
  return (
    <svg ref={svgRef} viewBox="0 0 200 200" aria-hidden="true" width="100%" height="100%">
      <Defs palette={palette} ids={ids} specFrom={{ x: 52, y: 96 }} specTo={{ x: 128, y: 46 }} />
      {/* Sunk: the body sits close to the deck, so the shadow is wide and tucked under it. */}
      <Shadow ids={ids} cx={114} cy={167} rx={36} ry={8} opacity={0.15} />
      <Body ids={ids} d={LONELY_BODY} specular={LONELY_SPECULAR} />

      <ellipse cx="64" cy="112" rx="9" ry="4" fill={`url(#${ids.blush})`} opacity="0.5" />
      <ellipse cx="136" cy="112" rx="9" ry="4" fill={`url(#${ids.blush})`} opacity="0.5" />

      <Eye ids={ids} side="left" g={{ cx: 80, cy: 96, rx: 13, ry: 14, pupilDx: -1, pupilDy: 4, pupilRx: 8, pupilRy: 8.5, catch: 2.8, catchOpacity: 0.6 }} />
      <Eye ids={ids} side="right" g={{ cx: 120, cy: 96, rx: 13, ry: 14, pupilDx: -1, pupilDy: 4, pupilRx: 8, pupilRy: 8.5, catch: 2.8, catchOpacity: 0.6 }} />

      <path
        data-mascot="mouth"
        d="M92 122 Q100 117, 108 122"
        stroke={P.pilot}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        opacity="0.6"
      />
    </svg>
  );
}

export function Mascot({ state, className }: MascotProps) {
  // React's ids carry colons, which are not safe inside url(#…) references.
  const uid = useId().replace(/:/g, '');
  const ids: MascotIds = {
    body: `mascot-body-${uid}`,
    form: `mascot-form-${uid}`,
    turn: `mascot-turn-${uid}`,
    shadow: `mascot-shadow-${uid}`,
    blush: `mascot-blush-${uid}`,
    spec: `mascot-spec-${uid}`,
    eye: `mascot-eye-${uid}`,
  };
  const palette = MASCOT_PALETTES[state];
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useMascotAnimation(svgRef, containerRef, state);

  return (
    <div ref={containerRef} role="presentation" className={`relative ${className ?? 'w-32 h-32'}`}>
      {state === 'idle' && <IdleSvg palette={palette} ids={ids} svgRef={svgRef} />}
      {state === 'sleeping' && <SleepingSvg palette={palette} ids={ids} svgRef={svgRef} />}
      {state === 'excited' && <ExcitedSvg palette={palette} ids={ids} svgRef={svgRef} />}
      {state === 'lonely' && <LonelySvg palette={palette} ids={ids} svgRef={svgRef} />}
      {state === 'sleeping' && (
        <div
          data-mascot="z-container"
          style={{
            position: 'absolute',
            top: '-15px',
            right: '8px',
            width: '50px',
            height: '90px',
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}
