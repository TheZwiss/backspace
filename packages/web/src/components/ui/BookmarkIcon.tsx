interface BookmarkIconProps {
  /** A saved message shows the filled mark. */
  filled?: boolean;
  size?: number;
}

/** The bookmark mark: outlined when a message is not saved, filled when it is. */
export function BookmarkIcon({ filled = false, size = 20 }: BookmarkIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path
        d="M7 4h10a1 1 0 011 1v15l-6-4-6 4V5a1 1 0 011-1z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  );
}
