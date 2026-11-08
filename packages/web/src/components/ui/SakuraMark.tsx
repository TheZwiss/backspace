import type { JSX } from 'react';

/**
 * Five-petal cherry blossom that takes the text colour. It stands in for the
 * Backspace glyph on the sidebar home tile while the Anime theme is active.
 * Decorative: the tile's button carries the accessible name.
 */
export function SakuraMark(props: { size?: number; className?: string }): JSX.Element {
  const { size = 24, className } = props;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className} data-anime="sakura-mark">
      {[0, 72, 144, 216, 288].map(angle => (
        <path key={angle} transform={`rotate(${angle} 12 12)`}
          d="M12 12 C8.6 9.6, 8.4 4.6, 10.6 2.6 C11.2 3.4, 11.6 3.6, 12 3.2 C12.4 3.6, 12.8 3.4, 13.4 2.6 C15.6 4.6, 15.4 9.6, 12 12Z" />
      ))}
      <circle cx="12" cy="12" r="1.6" fill="#ffe27a" />
    </svg>
  );
}
