import { replaceEmojiShortcodes } from '../../utils/emojiShortcodes';

interface ProfileThoughtBubbleProps {
  /** The person's custom status. Nothing is drawn while it is empty. */
  text: string | null | undefined;
  /** The avatar's geometry in the positioned parent's coordinates (px). `avatarTop` is negative: the avatar rises over the banner. */
  avatarLeft: number;
  avatarTop: number;
  avatarSize: number;
  /** Free space between the avatar's right edge and the bubble, where the tail runs. */
  gap?: number;
  /** Top edge of the bubble in the parent; keep it just below the banner edge (0). */
  top?: number;
  /** Space kept free on the right of the parent. */
  rightGap?: number;
}

/** Where the tail leaves the avatar: below the horizontal, so it starts under the banner. */
const TAIL_START_ANGLE_DEG = 15;
/** The tail's two dots, as fractions of the way from the avatar's edge to the bubble, and their diameters. */
const TAIL_DOTS = [{ at: 0.24, size: 11 }, { at: 0.62, size: 17 }] as const;
/** Height of the bubble's first text line, to aim the tail at it. */
const FIRST_LINE_CENTER = 18;

/**
 * A person's custom status as a thought bubble beside their profile picture.
 * It sits just below the banner's lower edge (the parent's top), so it never
 * covers the banner, and it grows downward, capped at two lines. A tail of two
 * growing dots leaves the avatar's edge and runs to the bubble, so the bubble
 * reads as coming out of the picture. The parent must be `relative`.
 *
 * The bubble has its own opaque surface: it sits over the card's body.
 */
export function ProfileThoughtBubble({ text, avatarLeft, avatarTop, avatarSize, gap = 50, top = 6, rightGap = 16 }: ProfileThoughtBubbleProps) {
  if (!text) return null;
  const radius = avatarSize / 2;
  const angle = (TAIL_START_ANGLE_DEG * Math.PI) / 180;
  const startX = avatarLeft + radius + radius * Math.cos(angle);
  const startY = avatarTop + radius + radius * Math.sin(angle);
  const bubbleLeft = avatarLeft + avatarSize + gap;
  const endY = top + FIRST_LINE_CENTER;
  return (
    // The outer layer is a clipped, static box; only the inner one scales. A
    // scaled box that overshoots its parent would add scrollable area to the
    // profile card for the length of the pop.
    <div data-profile-thought-bubble className="absolute inset-0 z-10 pointer-events-none overflow-hidden">
      <div className="absolute inset-0 motion-pop-in" style={{ transformOrigin: `${startX}px ${startY}px` }}>
        {TAIL_DOTS.map(({ at, size }) => (
          <span
            key={size}
            aria-hidden="true"
            className="absolute rounded-full bg-surface-elevated border border-white/[0.12] shadow-elevation-low"
            style={{ width: size, height: size, left: startX + (bubbleLeft - startX) * at - size / 2, top: startY + (endY - startY) * at - size / 2 }}
          />
        ))}
        <div
          className="absolute rounded-2xl bg-surface-elevated border border-white/[0.08] shadow-elevation-high px-3 py-2 text-ui-label text-txt-primary leading-snug break-words line-clamp-2 pointer-events-auto"
          style={{ left: bubbleLeft, top, maxWidth: `calc(100% - ${bubbleLeft + rightGap}px)` }}
          title={text}
        >
          {replaceEmojiShortcodes(text)}
        </div>
      </div>
    </div>
  );
}
