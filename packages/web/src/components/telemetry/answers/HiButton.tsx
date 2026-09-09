import { useId, type ReactNode } from 'react';
import { SCENE_PALETTE as P } from '../scene/palette';
import './HiButton.css';

interface HiButtonProps {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * The craft, drawn at the size a 42px button can hold. It is the same ship as
 * the letter's illustration — same hull gradient, same lavender shade under the
 * belly, same amber porthole — reduced to the parts that still read at 26px of
 * hull: body, two fins, engine bell, porthole, pilot, beacon, plume.
 *
 * The whole drawing assumes one key light, up and to the left, the same light
 * the button's rim and the planet use. Only the porthole, the beacon and the
 * plume emit; everything else is lit.
 */
function Craft({ uid }: { uid: string }) {
  const hull = `hi-hull-${uid}`;
  const cabin = `hi-cabin-${uid}`;
  const plume = `hi-plume-${uid}`;
  const soft = `hi-soft-${uid}`;
  const form = `hi-form-${uid}`;
  const port = `hi-port-${uid}`;
  return (
    <svg className="hi-button__craft-art" viewBox="0 0 40 24" aria-hidden="true" focusable="false">
      <defs>
        {/* Hull shading: mint holds the top-left face, lavender takes the
            turn-away on the lower right. Same two stops as the scene's hull. */}
        <linearGradient id={hull} x1="0.18" y1="0" x2="0.78" y2="1">
          <stop offset="0" stopColor={P.hull} />
          <stop offset="0.34" stopColor={P.hull} />
          <stop offset="1" stopColor={P.hullShade} />
        </linearGradient>
        {/* Cabin: hot centre, cooling to the ring. */}
        <radialGradient id={cabin} cx="0.4" cy="0.36" r="0.74">
          <stop offset="0" stopColor={P.windowLit} />
          <stop offset="1" stopColor={P.window} />
        </radialGradient>
        {/* Form shadow. It shades with the hull's own lavender rather than with
            the dark, because a green hull shaded toward black goes olive — the
            colour has to stay in the family the whole way round the form. */}
        <linearGradient id={form} x1="0.26" y1="0.06" x2="0.7" y2="1">
          <stop offset="0" stopColor={P.hullShade} stopOpacity="0" />
          <stop offset="0.52" stopColor={P.hullShade} stopOpacity="0.1" />
          <stop offset="1" stopColor={P.hullShade} stopOpacity="0.6" />
        </linearGradient>
        {/* The porthole clips the pilot, exactly as the scene's does. */}
        <clipPath id={port}>
          <circle cx="26.6" cy="12" r="2.9" />
        </clipPath>
        {/* Plume: brightest where it leaves the bell, gone by the tail. */}
        <linearGradient id={plume} x1="3" y1="0" x2="11.5" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={P.beam} stopOpacity="0" />
          <stop offset="0.45" stopColor={P.window} stopOpacity="0.5" />
          <stop offset="1" stopColor={P.windowLit} stopOpacity="0.95" />
        </linearGradient>
        {/* One blur, shared by every emitting part, so all the bloom matches. */}
        <filter id={soft} x="-160%" y="-160%" width="420%" height="420%">
          <feGaussianBlur stdDeviation="1.1" />
        </filter>
      </defs>

      {/* Exhaust, behind the hull. Bloom first, then a sharp core inside it. */}
      <g className="hi-button__plume">
        <g className="hi-button__plume-burn">
          {/* Three passes: a wide haze, the body of the flame, then a hot core.
              One shape would read as a stripe; the falloff is what makes it burn. */}
          <ellipse cx="8" cy="12" rx="5.6" ry="3.4" fill={P.window} opacity="0.34" filter={`url(#${soft})`} />
          <path
            d="M11.4 8.7 C8.6 10 6 11.2 3.4 12 C6 12.8 8.6 14 11.4 15.3 C13.1 13.7 13.1 10.3 11.4 8.7 Z"
            fill={`url(#${plume})`}
            filter={`url(#${soft})`}
          />
          <path
            d="M11.3 10.4 C9 11 7 11.6 5.2 12 C7 12.4 9 13 11.3 13.6 Z"
            fill={`url(#${plume})`}
          />
          {/* The hot mouth. A flame is brightest where it is still being made. */}
          <ellipse cx="10.6" cy="12" rx="1.5" ry="1.5" fill={P.windowLit} opacity="0.9" filter={`url(#${soft})`} />
        </g>
      </g>

      {/* Fins and bell: edge-on to the key, so they stay in the shade colour.
          Every point is the scene's own hull geometry at one eighth scale. */}
      <path d="M21.6 7.2 C19.6 6 17.6 4.7 15.4 3.6 C15.1 5.3 15.3 6.4 16.2 7.9 Z" fill={P.hullShade} />
      <path d="M21.6 16.8 C19.6 18 17.6 19.3 15.4 20.4 C15.1 18.7 15.3 17.6 16.2 16.1 Z" fill={P.hullShade} />
      {/* Fin roots, in the dark: without them the two fins, the bell and the
          tail merge into one lavender mass at the back of the ship. */}
      <path
        d="M19.8 6.4 C18.4 5.6 17 4.8 15.6 4 M19.8 17.6 C18.4 18.4 17 19.2 15.6 20"
        stroke={P.pilot}
        strokeOpacity="0.22"
        strokeWidth="0.6"
        strokeLinecap="round"
        fill="none"
      />
      <ellipse cx="11.6" cy="12" rx="1.3" ry="2.5" fill={P.hullShade} />
      <ellipse cx="11.1" cy="12" rx="0.6" ry="1.5" fill={P.pilot} opacity="0.4" />

      {/* Hull. */}
      <path
        d="M12.25 12 C12.25 9 15 7 19.5 7 L25.75 7 C32 7 35.75 9.75 36.25 12 C35.75 14.25 32 17 25.75 17 L19.5 17 C15 17 12.25 15 12.25 12 Z"
        fill={`url(#${hull})`}
      />
      {/* The belly turns away from the key, so it carries the shade colour. */}
      <path
        d="M13.25 13.5 C16.25 15.5 20.5 16 25.75 16 C31.5 16 34.75 14.25 36 12 C35.25 14.25 32 17 25.75 17 L19.5 17 C15 17 12.75 15.25 13.25 13.5 Z"
        fill={P.hullShade}
        opacity="0.45"
      />
      {/* One more pass over the hull, unlit corner to lit: this is what stops
          the craft reading as a bright cut-out shape. */}
      <path
        d="M12.25 12 C12.25 9 15 7 19.5 7 L25.75 7 C32 7 35.75 9.75 36.25 12 C35.75 14.25 32 17 25.75 17 L19.5 17 C15 17 12.25 15 12.25 12 Z"
        fill={`url(#${form})`}
      />
      {/* Specular: the one stroke that says where the light is. It stops short
          of the nose, because past there the hull has turned away from it. */}
      <path
        d="M13.4 10.6 C14.4 8.6 16.6 7.6 19.8 7.5 L25 7.5"
        fill="none"
        stroke={P.star}
        strokeOpacity="0.45"
        strokeWidth="0.9"
        strokeLinecap="round"
      />
      {/* and the same light continuing over the shoulder, giving out as the
          hull turns toward the nose. */}
      <path
        d="M25 7.6 C28.6 7.8 31 8.8 32.6 10.2"
        fill="none"
        stroke={P.star}
        strokeOpacity="0.2"
        strokeWidth="0.8"
        strokeLinecap="round"
      />

      {/* Nose seam. The nose faces away from the key, so it is drawn with a
          shadow line, not a highlight — a lavender ring on a lavender nose is
          invisible, which is exactly what the first attempt got wrong. */}
      <path
        d="M33.2 8.6 C34.6 9.6 35.5 10.8 35.9 12 C35.5 13.2 34.6 14.4 33.2 15.4"
        fill="none"
        stroke={P.pilot}
        strokeOpacity="0.16"
        strokeWidth="0.7"
        strokeLinecap="round"
      />

      {/* Beacon on the dorsal mast: the ship's own slow heartbeat. */}
      <path d="M30.4 7.5 L31.6 5.6" stroke={P.hullShade} strokeWidth="0.9" strokeLinecap="round" />
      <circle className="hi-button__beacon" cx="31.8" cy="5.3" r="1.5" fill={P.window} filter={`url(#${soft})`} />
      <circle className="hi-button__beacon" cx="31.8" cy="5.3" r="0.7" fill={P.windowLit} />

      {/* Porthole: bloom, ring, cabin, and the overlay that brings the light up. */}
      <circle cx="26.6" cy="12" r="4.6" fill={P.window} opacity="0.34" filter={`url(#${soft})`} />
      <circle cx="26.6" cy="12" r="3.5" fill={P.hullShade} />
      <circle cx="26.6" cy="12" r="2.9" fill={`url(#${cabin})`} />
      <g className="hi-button__cabin-lift">
        <circle className="hi-button__cabin" cx="26.6" cy="12" r="2.9" fill={P.windowLit} />
      </g>
      {/* The pilot, still waving. Head, shoulders and a raised arm: the arm is
          the mark that stops the porthole reading as an eye, and stops the
          silhouette reading as an account glyph. */}
      <g clipPath={`url(#${port})`} opacity="0.8">
        <circle cx="25.7" cy="12.2" r="0.72" fill={P.pilot} />
        <path d="M24.4 15.2 C24.6 13.9 25 13.3 25.8 13.3 C26.5 13.3 26.9 13.9 27.1 15.2 Z" fill={P.pilot} />
        {/* Shoulder to hand, raised clear above the head. One joint, so the
            wave swings instead of a mitten floating beside a bust. */}
        <g className="hi-button__wave">
          <path d="M26.4 13.5 L27.3 11.2" stroke={P.pilot} strokeWidth="0.5" strokeLinecap="round" fill="none" />
          <circle cx="27.4" cy="10.9" r="0.5" fill={P.pilot} />
        </g>
      </g>
    </svg>
  );
}

/**
 * The course the craft is holding: a plotted line running out of the frame,
 * past the label, to the world. It is the reason the middle of the button is
 * not empty — the space between the ship and the planet is the journey, and
 * a dotted heading is how a chart says so. The viewBox is stretched to the
 * button so the curve always spans it, and the stroke is non-scaling so the
 * dots stay round dots at 150px and at 280px.
 */
function Course() {
  return (
    <svg className="hi-button__course" viewBox="0 0 200 42" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path
        className="hi-button__course-line"
        d="M30 22 C64 12 106 10 142 17 C154 19.4 162 22.6 168 26"
        fill="none"
        stroke="rgb(var(--accent-mint))"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeDasharray="0.1 7"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * The sending answer. A porthole onto the run the instance is being asked to
 * make: the craft holding station on the left, a new world coming up on the
 * right, and the label between them. Pressing it is the departure.
 *
 * Everything decorative is an absolutely positioned layer inside a clipped
 * pane, so the glow can spill past the button without ever moving the row it
 * shares with the other answer.
 */
export function HiButton({ children, disabled = false, onClick }: HiButtonProps) {
  // React's ids carry colons, which are not safe inside url(#…) references.
  const uid = useId().replace(/:/g, '');
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="hi-button">
      <span className="hi-button__aura" aria-hidden="true" />
      <span className="hi-button__pane" aria-hidden="true">
        <span className="hi-button__void" />
        <span className="hi-button__stars hi-button__stars--far" />
        <span className="hi-button__stars hi-button__stars--near" />
        <span className="hi-button__world" />
        <Course />
        <span className="hi-button__craft">
          <span className="hi-button__craft-drift">
            <Craft uid={uid} />
          </span>
        </span>
        <span className="hi-button__scrim" />
        <span className="hi-button__gloss" />
        <span className="hi-button__sheen" />
        <span className="hi-button__rim" />
      </span>
      <span className="hi-button__label">{children}</span>
    </button>
  );
}
