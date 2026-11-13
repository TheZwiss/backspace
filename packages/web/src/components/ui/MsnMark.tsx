import type { JSX } from 'react';

/**
 * Two-figure "buddy" silhouette that takes the text colour. It stands in for the
 * Backspace glyph on the sidebar home tile while the MSN theme is active.
 * Decorative: the tile's button carries the accessible name.
 */
export function MsnMark(props: { size?: number; className?: string }): JSX.Element {
  const { size = 24, className } = props;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className} data-msn="msn-mark">
      <circle cx="12" cy="6.2" r="3.3" />
      <path d="M5.2 20.5c0-4 2.6-7 6.8-7s6.8 3 6.8 7c0 .6-.4 1-1 1H6.2c-.6 0-1-.4-1-1Z" />
      <circle cx="4.6" cy="9.2" r="2.2" opacity="0.7" />
      <circle cx="19.4" cy="9.2" r="2.2" opacity="0.7" />
    </svg>
  );
}
