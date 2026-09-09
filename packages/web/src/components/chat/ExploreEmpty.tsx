import { useId, type ReactNode } from 'react';
import { Mascot } from '../ui/Mascot';
import { SCENE_PALETTE as P } from '../telemetry/scene/palette';
import './ExploreEmpty.css';

interface ExploreEmptyProps {
  /** True when a search produced nothing, false when the instance has nothing discoverable at all. */
  searched: boolean;
  /** The line of copy, already translated by the caller. */
  children: ReactNode;
}

/** The sheet's own coordinate space: 1400 units wide, one unit per pixel, anchored to the right edge. */
const SHEET_W = 1400;
const SHEET_H = 256;
/** Where the rose sits on the sheet: 110px in from the right edge, on the centre line. */
const ROSE = { cx: SHEET_W - 110, cy: SHEET_H / 2 } as const;

/** Degrees to radians, with 0° pointing up the sheet and angles running clockwise, as a bearing does. */
function bearing(deg: number, r: number): { x: number; y: number } {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: ROSE.cx + r * Math.cos(a), y: ROSE.cy + r * Math.sin(a) };
}

/** One point of the rose: a thin diamond split along its length into the face the key lands on and the face turned away. */
function RosePoint({ deg, length, halfWidth, lit, shade, litOpacity, shadeOpacity }: {
  deg: number;
  length: number;
  halfWidth: number;
  lit: string;
  shade: string;
  litOpacity: number;
  shadeOpacity: number;
}) {
  const tip = bearing(deg, length);
  const left = bearing(deg - 90, halfWidth);
  const right = bearing(deg + 90, halfWidth);
  const root = bearing(deg + 180, halfWidth * 0.9);
  // The key is upper left, so the face that turns toward 315° is lit. A point
  // aimed at the key gets both faces lit but the right one less; a point aimed
  // away has its left face in shade too, only fainter.
  const keySide = (((deg - 315) % 360) + 360) % 360;
  const leftFacesKey = keySide > 180;
  return (
    <g>
      <path
        d={`M${tip.x} ${tip.y} L${left.x} ${left.y} L${root.x} ${root.y} Z`}
        fill={leftFacesKey ? lit : shade}
        opacity={leftFacesKey ? litOpacity : shadeOpacity}
      />
      <path
        d={`M${tip.x} ${tip.y} L${right.x} ${right.y} L${root.x} ${root.y} Z`}
        fill={leftFacesKey ? shade : lit}
        opacity={leftFacesKey ? shadeOpacity : litOpacity}
      />
    </g>
  );
}

/**
 * A reference star as a chart draws one: a dot, and for the brighter ones the
 * four fine rays of the chart's star symbol. `pulse` marks the one star the
 * scene lets breathe.
 */
function ChartStar({ x, y, r, rays, pulse, color }: {
  x: number;
  y: number;
  r: number;
  rays?: number;
  pulse?: boolean;
  color: string;
}) {
  return (
    <g className={pulse ? 'explore-empty__star explore-empty__star--pulse' : 'explore-empty__star'}>
      {rays !== undefined && (
        <path
          d={`M${x - rays} ${y} H${x + rays} M${x} ${y - rays} V${y + rays}`}
          stroke={color}
          strokeOpacity="0.45"
          strokeWidth="0.7"
          strokeLinecap="round"
        />
      )}
      <circle cx={x} cy={y} r={r} fill={color} />
    </g>
  );
}

/**
 * The chart sheet: graticule, rhumb lines, reference stars and the rose. It is
 * drawn at one unit per pixel and pinned to the right edge of the block, so
 * the rose always sits the same distance in from the edge, the stars are
 * always the same size, and a narrower block simply shows less of the sheet's
 * left side. Everything on it is lit from the upper left; the rose is a
 * console instrument on standby, so it is the only thing drawn in `console`.
 */
function ChartSheet({ uid, searched }: { uid: string; searched: boolean }) {
  const fade = `explore-fade-${uid}`;
  const bloom = `explore-bloom-${uid}`;
  const sweep = `explore-sweep-${uid}`;
  const sweepEdge = `explore-sweep-edge-${uid}`;
  const boss = `explore-boss-${uid}`;
  const dial = `explore-dial-${uid}`;
  const standby = `explore-standby-${uid}`;

  // The rings of the graticule, out from the rose, each fainter than the last.
  const rings: ReadonlyArray<{ r: number; opacity: number }> = [
    { r: 110, opacity: 0.09 },
    { r: 168, opacity: 0.06 },
    { r: 236, opacity: 0.04 },
  ];
  // Rhumb lines: the rose's bearings drawn out across the whole sheet, the way
  // a portolan chart does it. They start clear of the rose and run off the
  // sheet, and the mask takes them down to nothing before they get there.
  const rhumbs = [200, 222, 248, 270, 292, 318].map((deg) => {
    const from = bearing(deg, 116);
    const to = bearing(deg, 1200);
    return `M${from.x} ${from.y} L${to.x} ${to.y}`;
  });
  // The projection's parallels. The pole sits far above the sheet, so each
  // parallel of end height y0 sags by s at the middle (a quadratic through
  // y0 + 2s). No meridians: Nori is pinned to the left edge and the sheet to
  // the right, so at some width any vertical line would run through the
  // figure. The rhumbs and the rings carry the other axis of the chart.
  const parallels = [
    { y0: 34, sag: 46 },
    { y0: 128, sag: 52 },
    { y0: 214, sag: 58 },
  ].map(({ y0, sag }) => `M0 ${y0} Q${SHEET_W / 2} ${y0 + 2 * sag} ${SHEET_W} ${y0}`);
  // Ticks on the inner ring: every 10°, longer at every 30°.
  const ticks: string[] = [];
  for (let deg = 0; deg < 360; deg += 10) {
    const major = deg % 30 === 0;
    const a = bearing(deg, 54);
    const b = bearing(deg, major ? 48 : 51);
    ticks.push(`M${a.x} ${a.y} L${b.x} ${b.y}`);
  }
  // The arc the key catches on the outer ring: from north-west round to
  // north-east, brightest at 315°.
  const litFrom = bearing(250, 64);
  const litTo = bearing(20, 64);
  const shadeFrom = bearing(90, 64);
  const shadeTo = bearing(200, 64);

  // The scanner's parked arc: it swept out over the chart, found nothing, and
  // stopped. The leading edge is the brighter side; the trail behind it fades.
  const sweepStart = bearing(238, 232);
  const sweepEnd = bearing(282, 232);
  const sweepEdgeEnd = bearing(238, 232);

  return (
    <svg
      className="explore-empty__sheet"
      viewBox={`0 0 ${SHEET_W} ${SHEET_H}`}
      width={SHEET_W}
      height={SHEET_H}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* The sheet fades out away from the rose, so the graticule never
            reaches the edge of the block as a hard grid. */}
        <radialGradient id={fade} cx={ROSE.cx} cy={ROSE.cy} r="620" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={P.star} />
          <stop offset="0.3" stopColor={P.star} stopOpacity="0.75" />
          <stop offset="0.7" stopColor={P.star} stopOpacity="0.2" />
          <stop offset="1" stopColor={P.star} stopOpacity="0" />
        </radialGradient>
        <mask id={`${fade}-m`}>
          <rect width={SHEET_W} height={SHEET_H} fill={`url(#${fade})`} />
        </mask>
        {/* Bloom under the brightest star: a gradient, not a blur, so the
            sheet spends no filter on it. */}
        <radialGradient id={bloom} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={P.star} stopOpacity="0.55" />
          <stop offset="0.4" stopColor={P.star} stopOpacity="0.12" />
          <stop offset="1" stopColor={P.star} stopOpacity="0" />
        </radialGradient>
        {/* The scanner's light, strongest at the rose, gone by the range ring. */}
        <radialGradient id={sweep} cx={ROSE.cx} cy={ROSE.cy} r="232" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={P.console} stopOpacity="0.22" />
          <stop offset="0.5" stopColor={P.console} stopOpacity="0.07" />
          <stop offset="1" stopColor={P.console} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={sweepEdge} x1={ROSE.cx} y1={ROSE.cy} x2={sweepEdgeEnd.x} y2={sweepEdgeEnd.y} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={P.console} stopOpacity="0.6" />
          <stop offset="1" stopColor={P.console} stopOpacity="0" />
        </linearGradient>
        {/* The dial face: a disc of the sheet's own dark, lit at its upper
            left by the key and turning to lavender at the lower right, so the
            points have a face to lie on. */}
        <radialGradient id={dial} cx="0.34" cy="0.3" r="0.82">
          <stop offset="0" stopColor={P.star} stopOpacity="0.09" />
          <stop offset="0.55" stopColor={P.console} stopOpacity="0.05" />
          <stop offset="1" stopColor={P.seat} stopOpacity="0.14" />
        </radialGradient>
        {/* The standby light: the rose is the one emitter on the sheet, and
            its light lands on the chart around it. A gradient, not a blur. */}
        <radialGradient id={standby} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={P.console} stopOpacity="0.16" />
          <stop offset="0.55" stopColor={P.console} stopOpacity="0.05" />
          <stop offset="1" stopColor={P.console} stopOpacity="0" />
        </radialGradient>
        {/* The centre boss: a small dome, lit where everything else is lit. */}
        <radialGradient id={boss} cx="0.36" cy="0.32" r="0.8">
          <stop offset="0" stopColor={P.star} />
          <stop offset="0.5" stopColor={P.console} />
          <stop offset="1" stopColor={P.seat} />
        </radialGradient>
      </defs>

      {/* ── GRATICULE ── the sheet's projection: a conic with its pole far
          above the top edge, so the parallels bow downward across the whole
          width. It is what makes the middle of the sheet a chart rather than
          a gap, drawn faint enough to be felt before it is seen. */}
      <g stroke={P.dust} fill="none" strokeLinecap="round" strokeWidth="1">
        {parallels.map((d) => (
          <path key={d} d={d} strokeOpacity="0.08" />
        ))}
      </g>

      {/* ── THE ROSE'S LINES ── rings and rhumbs, under one mask that takes
          them to nothing before they reach the far side of the sheet. */}
      <g mask={`url(#${fade}-m)`} stroke={P.dust} fill="none" strokeLinecap="round">
        {/* Rhumb lines, out from the rose. */}
        <path d={rhumbs.join(' ')} strokeOpacity="0.055" strokeWidth="1" />
        {/* Range rings. */}
        {rings.map((ring) => (
          <circle key={ring.r} cx={ROSE.cx} cy={ROSE.cy} r={ring.r} strokeOpacity={ring.opacity} strokeWidth="1" />
        ))}
      </g>

      {/* ── SCANNER ── the searched state only: one arc, parked and dim. */}
      {searched && (
        <g className="explore-empty__sweep">
          <path
            d={`M${ROSE.cx} ${ROSE.cy} L${sweepStart.x} ${sweepStart.y} A232 232 0 0 1 ${sweepEnd.x} ${sweepEnd.y} Z`}
            fill={`url(#${sweep})`}
          />
          <path
            d={`M${ROSE.cx} ${ROSE.cy} L${sweepEdgeEnd.x} ${sweepEdgeEnd.y}`}
            stroke={`url(#${sweepEdge})`}
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </g>
      )}

      {/* ── REFERENCE STARS ── fixed stars a navigator would take a sight on.
          Nothing is plotted between them: that is the point of the picture. */}
      <g className="explore-empty__stars">
        <circle cx="862" cy="58" r="9" fill={`url(#${bloom})`} />
        <ChartStar x={862} y={58} r={1.9} rays={5} pulse color={P.star} />
        <ChartStar x={1182} y={42} r={1.5} rays={4} color={P.star} />
        <ChartStar x={1012} y={192} r={1.2} color={P.star} />
        <ChartStar x={1124} y={222} r={1} color={P.dust} />
        <ChartStar x={704} y={150} r={1.1} rays={3.5} color={P.star} />
        <ChartStar x={562} y={40} r={1.4} color={P.star} />
        <ChartStar x={1364} y={214} r={1} color={P.dust} />
        <ChartStar x={952} y={112} r={0.9} color={P.star} />
        <ChartStar x={422} y={212} r={1.2} rays={3.5} color={P.star} />
        <ChartStar x={302} y={92} r={1.5} color={P.star} />
        <ChartStar x={1262} y={28} r={0.9} color={P.dust} />
        <ChartStar x={140} y={170} r={1.1} color={P.star} />
      </g>

      {/* ── THE ROSE ── the page's compass glyph made real: a ringed instrument
          with eight points and the glyph's own diagonal needle, lit like a
          thing, not printed like an icon. */}
      <g className="explore-empty__rose">
        {/* Standby light on the sheet, then the dial face. */}
        <circle cx={ROSE.cx} cy={ROSE.cy} r="104" fill={`url(#${standby})`} />
        <circle cx={ROSE.cx} cy={ROSE.cy} r="63" fill={`url(#${dial})`} />
        {/* The outer ring: one hairline that turns hue with the light. */}
        <circle cx={ROSE.cx} cy={ROSE.cy} r="64" fill="none" stroke={P.console} strokeOpacity="0.24" strokeWidth="1" />
        <path
          d={`M${litFrom.x} ${litFrom.y} A64 64 0 0 1 ${litTo.x} ${litTo.y}`}
          fill="none"
          stroke={P.star}
          strokeOpacity="0.5"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
        <path
          d={`M${shadeFrom.x} ${shadeFrom.y} A64 64 0 0 1 ${shadeTo.x} ${shadeTo.y}`}
          fill="none"
          stroke={P.seat}
          strokeOpacity="0.3"
          strokeWidth="1"
          strokeLinecap="round"
        />
        {/* The tick ring. */}
        <circle cx={ROSE.cx} cy={ROSE.cy} r="54" fill="none" stroke={P.console} strokeOpacity="0.16" strokeWidth="0.8" />
        <path d={ticks.join(' ')} stroke={P.console} strokeOpacity="0.32" strokeWidth="0.8" strokeLinecap="round" fill="none" />
        {/* Intercardinal points, short, in the shade colours. Only the two the
            needle does not lie along: north-west and south-east. */}
        {[135, 315].map((deg) => (
          <RosePoint key={deg} deg={deg} length={40} halfWidth={4.5} lit={P.console} shade={P.seat} litOpacity={0.42} shadeOpacity={0.26} />
        ))}
        {/* Cardinal points, long. North is longest: a rose says which way is up. */}
        {[90, 180, 270].map((deg) => (
          <RosePoint key={deg} deg={deg} length={50} halfWidth={5.5} lit={P.console} shade={P.seat} litOpacity={0.6} shadeOpacity={0.34} />
        ))}
        <RosePoint deg={0} length={58} halfWidth={5.5} lit={P.star} shade={P.seat} litOpacity={0.62} shadeOpacity={0.36} />
        {/* The needle from the page's own glyph: north-east to south-west. Its
            north end is the lit one; the tail turns away into lavender. */}
        <RosePoint deg={45} length={40} halfWidth={7.5} lit={P.console} shade={P.seat} litOpacity={0.95} shadeOpacity={0.55} />
        <RosePoint deg={225} length={40} halfWidth={7.5} lit={P.seat} shade={P.seat} litOpacity={0.55} shadeOpacity={0.38} />
        {/* The boss. */}
        <circle cx={ROSE.cx} cy={ROSE.cy} r="5" fill={`url(#${boss})`} />
        <circle cx={ROSE.cx} cy={ROSE.cy} r="1.6" fill={P.pilot} opacity="0.7" />
      </g>
    </svg>
  );
}

/**
 * The explore page with nothing to show: a star chart with nothing plotted
 * yet. Owned by the UI soul pass (scene bible row 8). The caller owns the copy.
 *
 * Nori sits at the chart table on the left, the copy sits in a well at the
 * centre, and the rose waits on the right with no course drawn to it. When a
 * search found nothing the same chart carries the scanner's arc, parked.
 */
export function ExploreEmpty({ searched, children }: ExploreEmptyProps) {
  // React's ids carry colons, which are not safe inside url(#…) references.
  const uid = useId().replace(/:/g, '');
  return (
    <div className={`explore-empty ${searched ? 'explore-empty--searched' : 'explore-empty--bare'} relative flex items-center justify-center h-64 overflow-hidden`}>
      <div className="explore-empty__void" aria-hidden="true" />
      <ChartSheet uid={uid} searched={searched} />
      <div className="explore-empty__pool" aria-hidden="true" />
      <div className="explore-empty__nori" aria-hidden="true">
        <Mascot state="lonely" className="explore-empty__nori-art" />
      </div>
      <div className="explore-empty__scrim" aria-hidden="true" />
      <p className="explore-empty__copy text-sm text-center">{children}</p>
    </div>
  );
}
