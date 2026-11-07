/**
 * The check mark a copy button shows next to "Copied". It draws itself stroke
 * first each time it mounts (`.check-draw` in globals.css), so the label
 * change reads as a confirmation rather than a word swap.
 */
export function CopiedCheck({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
      <path className="check-draw" d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
