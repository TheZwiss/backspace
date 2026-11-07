interface StrikeLineProps {
  /** The state the icon stands for is off (muted, deafened, camera off). */
  active: boolean;
  /** Distance of the stroke's ends from the 24×24 box's corners. */
  inset?: number;
}

/**
 * The diagonal stroke across a mute, deafen or camera icon. It stays mounted
 * in both states, so turning the state off draws it in from the top-left
 * corner and turning it back on retracts it (`.strike-line` in globals.css),
 * instead of the line popping in and out. Place it inside a 24×24 viewBox SVG.
 */
export function StrikeLine({ active, inset = 3 }: StrikeLineProps) {
  const end = 24 - inset;
  return (
    <line
      className="strike-line"
      data-active={active}
      x1={inset}
      y1={inset}
      x2={end}
      y2={end}
      pathLength={1}
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    />
  );
}
