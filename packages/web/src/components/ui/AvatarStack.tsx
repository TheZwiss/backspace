import React from 'react';
import type { User } from '@backspace/shared';
import { Avatar } from './Avatar';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { parseFederatedUsername } from '../../utils/identity';

/**
 * Reusable avatar-stack widget for group-DM identity slots.
 *
 * Renders one of five layouts depending on `members.length`, plus an
 * optional `iconUrl` override that bypasses the stack entirely:
 *
 *   - iconUrl set    → single `<img>` filling the box
 *   - 0 members      → empty placeholder + group badge
 *   - 1 member       → centered avatar + group badge (12×12, bottom-right)
 *   - 2 members      → equal-size offset overlap
 *   - 3 members      → 2×2 grid, three tiles
 *   - 4+ members     → 2×2 grid, three tiles + `+N` overflow tile
 *
 * Status dots are never rendered — group identity wins regardless of
 * member count.
 *
 * Hooks-in-loop safety: each rendered slot is its own `<AvatarTile>`
 * component so `useCanonicalUserView` is called once per slot, not inside
 * a variable-length `.map()`.
 */
export interface AvatarStackProps {
  /** "Other" members already filtered to exclude self when applicable. */
  members: User[];
  /** Outer box edge length in px. Common: 24, 32, 40, 56, 80. */
  size: number;
  /** Which surface tier this stack sits on; controls border color. */
  border: 'channel' | 'chat' | 'modal';
  /** When set, renders the icon and ignores the stack. Bare filename or absolute URL. */
  iconUrl?: string | null;
}

const BORDER_CLASS: Record<AvatarStackProps['border'], string> = {
  channel: 'border-surface-channel',
  chat: 'border-surface-chat',
  // No `surface-modal` token in tailwind.config.js — fall back to elevated per plan note.
  modal: 'border-surface-elevated',
};

/** Resolves a bare filename to /api/uploads/, leaves absolute URLs alone. */
function resolveIconSrc(iconUrl: string): string {
  if (iconUrl.startsWith('http') || iconUrl.startsWith('blob:') || iconUrl.startsWith('data:') || iconUrl.startsWith('/')) {
    return iconUrl;
  }
  return `/api/uploads/${iconUrl}`;
}

/** Two-figure people SVG used as the group badge for 0/1-member groups. */
function GroupBadgeIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 12.75c1.63 0 3.07.39 4.24.9 1.08.48 1.76 1.56 1.76 2.73V18H6v-1.61c0-1.18.68-2.26 1.76-2.73 1.17-.52 2.61-.91 4.24-.91zM4 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm1.13 1.1c-.37-.06-.74-.1-1.13-.1-.99 0-1.93.21-2.78.58A2.01 2.01 0 0 0 0 16.43V18h4.5v-1.61c0-.83.23-1.61.63-2.29zM20 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm4 3.43c0-.81-.48-1.53-1.22-1.85A6.95 6.95 0 0 0 20 14c-.39 0-.76.04-1.13.1.4.68.63 1.46.63 2.29V18H24v-1.57zM12 6c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z" />
    </svg>
  );
}

/**
 * Single avatar slot. Extracted as a component so `useCanonicalUserView`
 * is called exactly once per slot (hooks rules: no hooks inside .map()).
 */
function AvatarTile({
  member,
  size,
  borderClass,
  className = '',
  style,
}: {
  member: User;
  size: number;
  borderClass: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const canonical = useCanonicalUserView(member);
  const displayName = canonical.displayName ?? parseFederatedUsername(canonical.username).baseName;
  return (
    <div
      data-avatar-stack-tile="true"
      className={`absolute rounded-full overflow-hidden border-2 ${borderClass} ${className}`}
      style={{ width: size, height: size, ...style }}
    >
      <Avatar
        src={canonical.avatar}
        name={displayName}
        size={size}
        userId={canonical.homeUserId ?? canonical.id}
        user={canonical}
      />
    </div>
  );
}

export function AvatarStack({ members, size, border, iconUrl }: AvatarStackProps) {
  const borderClass = BORDER_CLASS[border];

  // Icon override — bypass the stack entirely.
  if (iconUrl) {
    return (
      <div
        className="relative flex-shrink-0 rounded-full overflow-hidden"
        style={{ width: size, height: size }}
      >
        <img
          src={resolveIconSrc(iconUrl)}
          alt=""
          loading="lazy"
          className="w-full h-full rounded-full object-cover"
        />
      </div>
    );
  }

  // Group-badge sizing: fixed 12×12 per spec.
  const badgeBoxSize = 12;
  const badgeIconSize = 8;
  const badgeOffset = -2;

  // ─── Empty group ────────────────────────────────────────────────────────
  if (members.length === 0) {
    return (
      <div
        className="relative flex-shrink-0"
        style={{ width: size, height: size }}
      >
        <div
          data-avatar-stack-placeholder="true"
          className={`absolute inset-0 rounded-full bg-surface-input border-2 ${borderClass}`}
        />
        <div
          data-group-badge="true"
          className={`absolute rounded-full bg-surface-elevated border-2 ${borderClass} flex items-center justify-center text-txt-tertiary`}
          style={{
            width: badgeBoxSize,
            height: badgeBoxSize,
            right: badgeOffset,
            bottom: badgeOffset,
          }}
        >
          <GroupBadgeIcon size={badgeIconSize} />
        </div>
      </div>
    );
  }

  // ─── Single member: centered avatar + group badge ───────────────────────
  if (members.length === 1) {
    return (
      <div
        className="relative flex-shrink-0"
        style={{ width: size, height: size }}
      >
        <AvatarTile
          member={members[0]!}
          size={size}
          borderClass="border-transparent"
          style={{ left: 0, top: 0 }}
        />
        <div
          data-group-badge="true"
          className={`absolute rounded-full bg-surface-elevated border-2 ${borderClass} flex items-center justify-center text-txt-secondary z-10`}
          style={{
            width: badgeBoxSize,
            height: badgeBoxSize,
            right: badgeOffset,
            bottom: badgeOffset,
          }}
        >
          <GroupBadgeIcon size={badgeIconSize} />
        </div>
      </div>
    );
  }

  // ─── Two members: equal-size offset overlap ─────────────────────────────
  if (members.length === 2) {
    const tileSize = Math.round(size * 0.7);
    const offset = Math.round(size * 0.3);
    return (
      <div
        data-avatar-stack-layout="overlap"
        className="relative flex-shrink-0"
        style={{ width: size, height: size }}
      >
        {members.map((m, i) => (
          <AvatarTile
            key={m.id}
            member={m}
            size={tileSize}
            borderClass={borderClass}
            style={{
              left: i === 0 ? 0 : offset,
              top: i === 0 ? 0 : offset,
              zIndex: i === 0 ? 2 : 1,
            }}
          />
        ))}
      </div>
    );
  }

  // ─── 3+ members: 2×2 grid (three avatar tiles, fourth slot empty or +N) ─
  const tileSize = Math.round((size - 2) / 2); // half the box, with a 2px gutter
  const tileGap = size - tileSize * 2;
  // Four grid positions: top-left, top-right, bottom-left, bottom-right.
  const positions = [
    { left: 0, top: 0 },
    { left: tileSize + tileGap, top: 0 },
    { left: 0, top: tileSize + tileGap },
    { left: tileSize + tileGap, top: tileSize + tileGap },
  ];

  const visibleMembers = members.slice(0, 3);
  const overflow = members.length > 3 ? members.length - 3 : 0;
  const overflowFontSize = Math.max(9, Math.round(tileSize * 0.45));

  return (
    <div
      data-avatar-stack-layout="grid"
      className="relative flex-shrink-0"
      style={{ width: size, height: size }}
    >
      {visibleMembers.map((m, i) => (
        <AvatarTile
          key={m.id}
          member={m}
          size={tileSize}
          borderClass={borderClass}
          style={positions[i]}
        />
      ))}
      {overflow > 0 && (
        <div
          data-avatar-stack-overflow="true"
          className={`absolute rounded-full bg-surface-input border-2 ${borderClass} flex items-center justify-center text-txt-secondary font-semibold leading-none`}
          style={{
            width: tileSize,
            height: tileSize,
            left: positions[3]!.left,
            top: positions[3]!.top,
            fontSize: overflowFontSize,
          }}
        >
          {`+${members.length - 3}`}
        </div>
      )}
    </div>
  );
}
