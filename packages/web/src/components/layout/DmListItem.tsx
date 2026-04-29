import type { DmChannel, User } from '@backspace/shared';
import { Avatar } from '../ui/Avatar';
import { Tooltip } from '../ui/Tooltip';
import { parseFederatedUsername, isSelf } from '../../utils/identity';
import { formatDmTimestamp, formatDmSidebarPreview } from '../../utils/dmFormatters';
import { getRejectedPeerOrigins, getAwaitingApprovalPeerOrigins } from '../../hooks/useWebSocket';

function isMemberUnreachable(homeInstance: string | null | undefined): boolean {
  if (!homeInstance) return false;
  const normalized = homeInstance.startsWith('http') ? homeInstance : `https://${homeInstance}`;
  return getRejectedPeerOrigins().has(normalized);
}

function isMemberAwaitingApproval(homeInstance: string | null | undefined): boolean {
  if (!homeInstance) return false;
  const normalized = homeInstance.startsWith('http') ? homeInstance : `https://${homeInstance}`;
  return getAwaitingApprovalPeerOrigins().has(normalized);
}

interface DmListItemProps {
  dm: DmChannel;
  isActive: boolean;
  isUnread: boolean;
  user: User;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onLeave: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent, id: string) => void;
}

export function DmListItem({ dm, isActive, isUnread, user, onSelect, onClose, onLeave, onContextMenu }: DmListItemProps) {
  const otherMembers = dm.members.filter(m => !isSelf(m, user));
  const isGroup = !!dm.ownerId;
  if (otherMembers.length === 0 && !isGroup) return null;

  const firstOther = isGroup ? null : otherMembers[0];
  const { baseName, domain } = parseFederatedUsername(firstOther?.username ?? '');
  const displayName = isGroup
    ? (otherMembers.length > 0
      ? otherMembers.map(m => m.displayName ?? parseFederatedUsername(m.username).baseName).join(', ')
      : 'Empty Group')
    : firstOther?.displayName ?? baseName;

  const handleClick = () => onSelect(dm.id);
  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isGroup) {
      onLeave(dm.id);
    } else {
      onClose(dm.id);
    }
  };
  const handleContextMenu = onContextMenu
    ? (e: React.MouseEvent) => onContextMenu(e, dm.id)
    : undefined;

  // ── State-driven classes ──────────────────────────────────────────────
  // Container: 6px radius (up from 4px), 44px height (up from 42px)
  const containerClass = `relative flex items-center gap-3 px-2 h-[44px] rounded-[6px] cursor-pointer transition-colors group ${
    isActive
      ? 'bg-interactive-selected text-white'
      : isUnread
        ? 'text-white hover:bg-interactive-hover'
        : 'text-txt-tertiary hover:bg-interactive-hover hover:text-txt-secondary'
  }`;

  // Name: font-semibold for unread (deliberately NOT font-bold — design decision)
  const nameClass = `text-[15px] truncate leading-tight ${
    isActive ? 'text-white font-medium'
      : isUnread ? 'text-white font-semibold'
      : 'text-txt-tertiary group-hover:text-txt-secondary font-medium'
  }`;

  // Timestamp: brightens on hover and lifts for unread/selected
  const timestampClass = `text-[11px] ml-auto flex-shrink-0 ${
    isActive || isUnread
      ? 'text-txt-secondary'
      : 'text-txt-tertiary group-hover:text-txt-secondary'
  }`;

  // Preview: brightens on hover and lifts for unread/selected
  const previewClass = `text-[12px] truncate leading-tight mt-0.5 ${
    isActive || isUnread
      ? 'text-txt-secondary'
      : 'text-txt-tertiary group-hover:text-txt-secondary'
  }`;

  // Federation badge: brightens with parent
  const fedBadgeClass = `flex-shrink-0 ${
    isActive || isUnread
      ? 'text-txt-secondary/60'
      : 'text-txt-tertiary/60 group-hover:text-txt-secondary/60'
  }`;

  // Close button: always visible when selected, hover-reveal otherwise
  const closeClass = `${
    isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
  } text-txt-tertiary hover:text-txt-primary transition-opacity flex-shrink-0 ml-1`;

  // ── Preview text ──────────────────────────────────────────────────────
  // formatDmSidebarPreview handles user/system messages and applies the
  // sender prefix for group user-messages. We only need to provide the
  // empty-group fallback ourselves.
  const preview = formatDmSidebarPreview(dm, user);
  const previewText = preview ?? (isGroup ? `${dm.members.length} Members` : null);

  const itemJsx = (
    <div
      onClick={handleClick}
      className={containerClass}
    >
      {/* Selected accent bar */}
      {isActive && (
        <div
          className="absolute -left-[2px] top-1/2 -translate-y-1/2 w-[3px] bg-white rounded-r-full"
          style={{ height: '55%', opacity: 0.7 }}
        />
      )}

      {/* Unread indicator */}
      {isUnread && (
        <div className="absolute -left-1 w-1 h-2 bg-white rounded-r-full" />
      )}

      {/* Avatar */}
      {isGroup ? (
        <div className="relative w-8 h-8 flex-shrink-0">
          {otherMembers.slice(0, 2).map((m, i) => (
            <div
              key={m.id}
              className="absolute rounded-full overflow-hidden border-2 border-surface-channel"
              style={{
                width: 22, height: 22,
                left: i * 10,
                top: i * 6,
                zIndex: 2 - i,
              }}
            >
              <Avatar src={m.avatar} name={m.displayName ?? parseFederatedUsername(m.username).baseName} size={22} userId={m.homeUserId ?? m.id} user={m} />
            </div>
          ))}
        </div>
      ) : (
        <Avatar src={otherMembers[0]?.avatar} name={otherMembers[0]?.displayName ?? parseFederatedUsername(otherMembers[0]?.username ?? '').baseName} size={32} status={otherMembers[0]?.status as any} userId={otherMembers[0]?.homeUserId ?? otherMembers[0]?.id} user={otherMembers[0]} />
      )}

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1 min-w-0">
          <span className={nameClass}>
            {displayName}
          </span>
          {!isGroup && domain && (
            <Tooltip content={firstOther?.username ?? ''} position="top">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className={fedBadgeClass}>
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
              </svg>
            </Tooltip>
          )}
          {firstOther && isMemberUnreachable(firstOther.homeInstance) && (
            <Tooltip content="Cannot relay messages — their server denied peering. Contact their admin." position="top">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="text-accent-rose opacity-70 flex-shrink-0">
                <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
              </svg>
            </Tooltip>
          )}
          {firstOther && !isMemberUnreachable(firstOther.homeInstance) && isMemberAwaitingApproval(firstOther.homeInstance) && (
            <Tooltip content="Messages will be delivered once their admin approves the peering request." position="top">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="text-accent-amber opacity-70 flex-shrink-0">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
              </svg>
            </Tooltip>
          )}
          {dm.lastMessage && (
            <span className={timestampClass}>
              {formatDmTimestamp(dm.lastMessage.createdAt)}
            </span>
          )}
        </div>
        {previewText && (
          <div className={previewClass}>
            {previewText}
          </div>
        )}
      </div>

      {/* Close / Leave button */}
      <button
        onClick={handleClose}
        className={closeClass}
        title={isGroup ? 'Leave Group DM' : 'Close DM'}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
        </svg>
      </button>
    </div>
  );

  // Group DMs get a context menu wrapper
  if (isGroup && handleContextMenu) {
    return <div onContextMenu={handleContextMenu}>{itemJsx}</div>;
  }

  return itemJsx;
}
