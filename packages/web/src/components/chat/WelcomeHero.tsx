import { useId, type ReactNode } from 'react';
import { SCENE_PALETTE as P } from '../telemetry/scene/palette';
import './WelcomeHero.css';

export type WelcomeHeroKind = 'channel' | 'dm' | 'group';

interface WelcomeHeroProps {
  kind: WelcomeHeroKind;
  /** The 68px hash disc, the 80px ProfileAvatar, or the AvatarStack, rendered by the caller. */
  figure: ReactNode;
  title: string;
  /** Copy lines and the optional button row, rendered by the caller in its own markup. */
  children: ReactNode;
}

/**
 * Where the in-flow parts of the hero land, in px from the hero's own top-left.
 * These mirror the utility classes on the root, the figure and the title
 * (`px-4 pt-8`, `mb-4` / `mb-2`, `mt-2`, `leading-10`); the scene is drawn
 * against them, so a change to those classes is a change here too.
 */
interface HeroGeometry {
  /** Edge of the figure's slot: 68 for the hash disc, 80 for an avatar or a stack. */
  port: number;
  /** Vertical centre of the title's first line. */
  titleY: number;
}
const CONTENT_LEFT = 16;
const CONTENT_TOP = 32;
const TITLE_LINE = 40;
const GEOMETRY: Record<WelcomeHeroKind, HeroGeometry> = {
  channel: { port: 68, titleY: CONTENT_TOP + 68 + 16 + TITLE_LINE / 2 },
  dm: { port: 80, titleY: CONTENT_TOP + 80 + 8 + TITLE_LINE / 2 },
  group: { port: 80, titleY: CONTENT_TOP + 80 + 8 + 8 + TITLE_LINE / 2 },
};
/** How far the porthole's frame stands outside the figure. Stays inside the root's padding on every side. */
const FRAME = 13;
/** How far past the frame the porthole's shadow and spill reach. The spill layer is sized from it so its gradients scale with the figure. */
const SPILL_REACH = 30;
/** Where the course leaves the frame, measured clockwise from three o'clock. */
const DEPARTURE_DEG = 34;
/** The course settles just under the title's baseline, so the name sits on the line rather than being struck through. */
const COURSE_BELOW_TITLE = 11;

/** A point on the porthole's outer edge. */
function onRim(diameter: number, degrees: number): { x: number; y: number } {
  const c = diameter / 2;
  const a = (degrees * Math.PI) / 180;
  return { x: c + c * Math.cos(a), y: c + c * Math.sin(a) };
}

/**
 * The porthole: the void seen through it, the frame around it, and the key
 * light on the frame's top-left. Exactly `port` wide where the figure sits,
 * with the frame standing `FRAME` px outside that box, so the figure covers
 * the glass and only the ring of space between figure and frame is seen.
 * For the group stack, whose tiles leave gaps, the stars behind the tiles
 * show through too.
 */
function Porthole({ uid, port }: { uid: string; port: number }) {
  const d = port + FRAME * 2;
  const c = d / 2;
  const glass = c - 4.5;
  const ids = {
    void: `wh-void-${uid}`,
    nebula: `wh-nebula-${uid}`,
    grain: `wh-grain-${uid}`,
    cabin: `wh-cabin-${uid}`,
    lip: `wh-lip-${uid}`,
    body: `wh-body-${uid}`,
    rim: `wh-rim-${uid}`,
    clip: `wh-clip-${uid}`,
  };
  // Stars sit in the ring of space the figure leaves uncovered, one or two
  // further in for the stack's gaps. Angles clockwise from three o'clock.
  const ring = (deg: number, k: number) => {
    const a = (deg * Math.PI) / 180;
    const rr = port / 2 + (glass - port / 2) * k;
    return { cx: c + rr * Math.cos(a), cy: c + rr * Math.sin(a) };
  };
  const s1 = ring(212, 0.55);
  const s2 = ring(126, 0.4);
  const s3 = ring(300, 0.62);
  const s4 = ring(20, 0.7);
  const s5 = ring(258, 0.35);
  const inner1 = { cx: c - port * 0.08, cy: c - port * 0.3 };
  const inner2 = { cx: c + port * 0.27, cy: c + port * 0.1 };
  return (
    <svg
      className="welcome-hero__porthole"
      style={{ left: CONTENT_LEFT - FRAME, top: CONTENT_TOP - FRAME, width: d, height: d }}
      viewBox={`0 0 ${d} ${d}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* Deep space, darker than the lit room around the porthole so the
            glass reads as a hole and not as a disc. A little of the key
            caught on the glass toward the upper left, falling to the base
            colour (a token, set in the stylesheet) everywhere else. */}
        <radialGradient id={ids.void} cx="0.3" cy="0.24" r="0.9">
          <stop offset="0" stopColor={P.deck} />
          <stop offset="0.5" className="welcome-hero__void-far" />
          <stop offset="1" className="welcome-hero__void-far" />
        </radialGradient>
        {/* One nebula wash, lavender, biased to the lower left so it does not
            fight the key. */}
        <radialGradient id={ids.nebula} cx="0.24" cy="0.76" r="0.74">
          <stop offset="0" stopColor={P.nebulaA} stopOpacity="0.9" />
          <stop offset="0.4" stopColor={P.nebulaA} stopOpacity="0.5" />
          <stop offset="1" stopColor={P.nebulaA} stopOpacity="0" />
        </radialGradient>
        {/* The scene's one filter: the nebula's grain, so the wash reads as
            cloud rather than as a soft spot. */}
        <filter id={ids.grain} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="3" seed="5" result="noise" />
          <feColorMatrix in="noise" type="luminanceToAlpha" result="alpha" />
          <feComponentTransfer in="alpha" result="shaped">
            <feFuncA type="table" tableValues="0 0.3 0.85 1" />
          </feComponentTransfer>
          <feComposite in="SourceGraphic" in2="shaped" operator="in" />
        </filter>
        {/* The cabin light behind the figure. Hot at its centre, most of it
            hidden by the figure, the rest leaking into the ring lower right. */}
        <radialGradient id={ids.cabin} cx="0.7" cy="0.7" r="0.5">
          <stop offset="0" stopColor={P.windowLit} stopOpacity="0.7" />
          <stop offset="0.5" stopColor={P.window} stopOpacity="0.3" />
          <stop offset="1" stopColor={P.window} stopOpacity="0" />
        </radialGradient>
        {/* The frame's inner wall. A recess is dark on the side nearest the
            light and lit on the far side, which is what makes it a recess. */}
        <linearGradient id={ids.lip} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={P.pilot} stopOpacity="0.92" />
          <stop offset="0.5" stopColor={P.pilot} stopOpacity="0.25" />
          <stop offset="1" stopColor={P.dust} stopOpacity="0.4" />
        </linearGradient>
        {/* The frame's face: caught by the key on the top-left, the bulkhead's
            own colour across the top, and turning to lavender as it turns
            away, never to black. */}
        <linearGradient id={ids.body} x1="0.08" y1="0.02" x2="0.92" y2="0.98">
          <stop offset="0" stopColor={P.dust} stopOpacity="0.6" />
          <stop offset="0.28" stopColor={P.bulkhead} />
          <stop offset="0.62" stopColor={P.deck} />
          <stop offset="1" stopColor={P.seat} stopOpacity="0.72" />
        </linearGradient>
        {/* The rim hairline: warm white where the key lands, a whisper of
            mint along the top, near nothing lower right, lavender coming back. */}
        <linearGradient id={ids.rim} x1="0.08" y1="0" x2="0.92" y2="1">
          <stop offset="0" stopColor={P.star} stopOpacity="0.95" />
          <stop offset="0.2" stopColor={P.star} stopOpacity="0.4" />
          <stop offset="0.36" stopColor={P.signal} stopOpacity="0.22" />
          <stop offset="0.62" stopColor={P.star} stopOpacity="0.06" />
          <stop offset="1" stopColor={P.seat} stopOpacity="0.6" />
        </linearGradient>
        <clipPath id={ids.clip}>
          <circle cx={c} cy={c} r={glass} />
        </clipPath>
      </defs>

      {/* the glass, and everything seen through it */}
      <g clipPath={`url(#${ids.clip})`}>
        <circle cx={c} cy={c} r={glass} fill={`url(#${ids.void})`} />
        <circle cx={c} cy={c} r={glass} fill={`url(#${ids.nebula})`} filter={`url(#${ids.grain})`} />
        <circle className="welcome-hero__cabin" cx={c} cy={c} r={glass} fill={`url(#${ids.cabin})`} />
        <g className="welcome-hero__stars">
          <circle cx={s1.cx} cy={s1.cy} r="1.1" fill={P.star} fillOpacity="0.85" />
          <circle cx={s2.cx} cy={s2.cy} r="0.8" fill={P.dust} fillOpacity="0.7" />
          <circle cx={s3.cx} cy={s3.cy} r="1.5" fill={P.star} fillOpacity="0.12" />
          <circle className="welcome-hero__star-breath" cx={s3.cx} cy={s3.cy} r="1.15" fill={P.star} />
          <circle cx={s4.cx} cy={s4.cy} r="0.75" fill={P.console} fillOpacity="0.75" />
          <circle cx={s5.cx} cy={s5.cy} r="0.6" fill={P.star} fillOpacity="0.5" />
          <circle cx={inner1.cx} cy={inner1.cy} r="1" fill={P.star} fillOpacity="0.8" />
          <circle cx={inner2.cx} cy={inner2.cy} r="0.7" fill={P.dust} fillOpacity="0.6" />
        </g>
        {/* the recess: the frame's own shadow on the glass */}
        <circle cx={c} cy={c} r={glass - 1} fill="none" stroke={`url(#${ids.lip})`} strokeWidth="2" />
      </g>

      {/* the frame */}
      <circle cx={c} cy={c} r={c - 2.75} fill="none" stroke={`url(#${ids.body})`} strokeWidth="3.5" />
      <circle cx={c} cy={c} r={c - 0.75} fill="none" stroke={`url(#${ids.rim})`} strokeWidth="1.25" />
      {/* the key itself, caught on the top-left shoulder of the rim: a bloom
          the width of the frame under a hairline the width of the rim */}
      <g className="welcome-hero__key">
        <path
          d={`M ${onRim(d - 3, 192).x + 1.5} ${onRim(d - 3, 192).y + 1.5} A ${c - 1.5} ${c - 1.5} 0 0 1 ${onRim(d - 3, 258).x + 1.5} ${onRim(d - 3, 258).y + 1.5}`}
          fill="none"
          stroke={P.star}
          strokeOpacity="0.16"
          strokeWidth="4.5"
          strokeLinecap="round"
        />
        <path
          d={`M ${onRim(d - 1.5, 200).x + 0.75} ${onRim(d - 1.5, 200).y + 0.75} A ${c - 0.75} ${c - 0.75} 0 0 1 ${onRim(d - 1.5, 252).x + 0.75} ${onRim(d - 1.5, 252).y + 0.75}`}
          fill="none"
          stroke={P.star}
          strokeOpacity="0.9"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

/**
 * The plotted course: it leaves the frame at the lower right, settles onto
 * the title's line and runs out toward the right edge. The line is drawn to a
 * fixed far x and the stylesheet fades it against the hero's own width, so it
 * is gone before the edge at every width. The title is painted above it.
 * A short solid run at the frame is the heading being laid; past that it is
 * dashed, with waypoints plotted along it as hollow marks, further apart and
 * larger as they go, the way a chart plots what has not been reached yet.
 */
function Course({ port, titleY }: HeroGeometry) {
  const d = port + FRAME * 2;
  const start = onRim(d, DEPARTURE_DEG);
  const sx = CONTENT_LEFT - FRAME + start.x;
  const sy = CONTENT_TOP - FRAME + start.y;
  const lineY = titleY + COURSE_BELOW_TITLE;
  const settleX = sx + 150;
  // The departure runs along the same tangent the curve leaves on.
  const departure = { x: sx + 9, y: sy + 4.9 };
  const path = `M ${sx} ${sy} C ${sx + 44} ${sy + 24}, ${settleX - 70} ${lineY}, ${settleX} ${lineY} L 2400 ${lineY}`;
  const waypoints = [
    { x: settleX + 72, r: 1.6 },
    { x: settleX + 196, r: 2 },
    { x: settleX + 372, r: 2.6 },
  ];
  return (
    <svg className="welcome-hero__course" aria-hidden="true" focusable="false">
      <path className="welcome-hero__course-line" d={path} fill="none" strokeWidth="1.25" strokeLinecap="round" />
      <path className="welcome-hero__departure" d={`M ${sx} ${sy} L ${departure.x} ${departure.y}`} fill="none" strokeWidth="1.5" strokeLinecap="round" />
      {waypoints.map((w) => (
        <circle key={w.x} className="welcome-hero__waypoint" cx={w.x} cy={lineY} r={w.r} fill="none" strokeWidth="1" />
      ))}
    </svg>
  );
}

/**
 * The block at the top of a conversation's history: the figure, the title, the
 * caller's copy and buttons, and the rule under it. Owned by the UI soul pass
 * (scene bible row 7, plan in docs/superpowers/plans/2026-09-09-welcome-hero.md).
 *
 * This component never reads a store and never handles a click; MessageList
 * builds the figure, the title and the children per branch and passes them in.
 *
 * Its rendered height for a given kind and title is part of the message list's
 * scroll contract (docs/systems/message-list.md, "Top-of-list reservation
 * slot"): it is measured once when the last page loads and must never change
 * on its own afterwards. Decoration is therefore absolutely positioned inside
 * this box and clipped by it; nothing in flow may move, grow or reflow.
 */
export function WelcomeHero({ kind, figure, title, children }: WelcomeHeroProps) {
  const uid = useId().replace(/:/g, '');
  const geometry = GEOMETRY[kind];
  return (
    <div className={`welcome-hero welcome-hero--${kind} px-4 pt-8 pb-4`}>
      {/* scene, back to front; every layer is absolute, inert and painted under the flow */}
      <div className="welcome-hero__light" />
      <div
        className="welcome-hero__spill"
        style={{
          left: CONTENT_LEFT - FRAME - SPILL_REACH,
          top: CONTENT_TOP - FRAME - SPILL_REACH,
          width: geometry.port + FRAME * 2 + SPILL_REACH * 2,
          height: geometry.port + FRAME * 2 + SPILL_REACH * 2,
        }}
      />
      <Course port={geometry.port} titleY={geometry.titleY} />
      <Porthole uid={uid} port={geometry.port} />

      <div className={kind === 'channel' ? 'welcome-hero__figure mb-4' : 'welcome-hero__figure mb-2'}>{figure}</div>
      <h3 className={`welcome-hero__title text-[32px] leading-10 font-bold text-txt-primary${kind === 'group' ? ' mt-2' : ''}`}>{title}</h3>
      {children}
      <div className="mt-6 border-b border-interactive-muted" />
    </div>
  );
}
