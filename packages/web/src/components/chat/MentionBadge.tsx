import React from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../stores/uiStore';
import { useChannelUser } from '../../utils/channelUser';
import { userDisplayName } from '../../utils/identity';

/** Resolved mention without a role colour (a DM, or a member with no role). */
const ACCENT_COLOR = '#7c6cf6';
/** A mention this client cannot place in the channel. */
const UNRESOLVED_COLOR = '#a0a0aa';

interface MentionBadgeProps {
  userId: string;
  /**
   * The channel the mention was written in. A `<@id>` token carries an id on
   * that channel's origin and names one of that channel's people, so it is
   * resolved there (`utils/channelUser`). Null outside a channel: the badge
   * cannot resolve and shows the unknown-user label.
   */
  channelId: string | null;
  /**
   * False inside another control (a reply preview is a jump button): the badge
   * keeps its look but is plain text, so it neither opens a profile nor nests
   * interactive content in that control.
   */
  interactive?: boolean;
}

export const MentionBadge = React.memo(function MentionBadge({ userId, channelId, interactive = true }: MentionBadgeProps) {
  const { t } = useTranslation('chat');
  const openUserProfile = useUIStore((s) => s.openUserProfile);
  const resolved = useChannelUser(channelId, userId);

  const displayName = resolved ? userDisplayName(resolved.user) : t('message.mention.unknownUser');
  // Role colour and owner rose exist only in space channels (nameColor is null in a DM).
  const color = resolved ? resolved.nameColor ?? ACCENT_COLOR : UNRESOLVED_COLOR;

  const handleClick = (e: React.MouseEvent) => {
    if (!resolved) return;
    e.stopPropagation();
    const memberContext = resolved.member
      ? { spaceId: resolved.member.spaceId, userId: resolved.member.userId }
      : undefined;
    openUserProfile(resolved.user, e.currentTarget.getBoundingClientRect(), undefined, memberContext);
  };

  // Build inline styles: role-colored text with tinted background
  const bgColor = color + '1a'; // ~10% opacity hex
  const baseClass = 'inline-flex items-center rounded-[3px] px-[2px] font-medium';

  if (!interactive) {
    return (
      <span className={baseClass} style={{ color, backgroundColor: bgColor }}>
        @{displayName}
      </span>
    );
  }

  return (
    <span
      onClick={handleClick}
      className={`${baseClass} cursor-pointer transition-colors hover:brightness-125`}
      style={{ color, backgroundColor: bgColor }}
    >
      @{displayName}
    </span>
  );
});
