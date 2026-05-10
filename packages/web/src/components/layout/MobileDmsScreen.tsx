import React, { useMemo } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { Avatar } from '../ui/Avatar';
import { AvatarStack } from '../ui/AvatarStack';
import { Mascot } from '../ui/Mascot';
import { resolveAssetUrl } from '../../utils/assetUrls';
import { useNavigate } from 'react-router-dom';
import { parseFederatedUsername, isFederationGlobeApplicable, isSelf } from '../../utils/identity';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { formatDmSidebarPreview } from '../../utils/dmFormatters';
import type { DmChannel, User } from '@backspace/shared';
import type { TaggedFriend } from '../../stores/socialStore';

const FALLBACK_USER = { id: '', username: '', createdAt: 0, isAdmin: false, replicatedInstances: [] } as unknown as User;

function MobileFriendBubble({
  friend,
  dmChannels,
  onTap,
}: {
  friend: TaggedFriend;
  dmChannels: DmChannel[];
  onTap: (dmId: string) => void;
}) {
  const canonical = useCanonicalUserView(friend as unknown as User);
  // _instanceOrigin lives on TaggedFriend, not on the canonical User. Use the
  // canonical avatar value but source the origin from the original friend.
  const avatarUrl = canonical.avatar
    ? resolveAssetUrl(canonical.avatar, friend._instanceOrigin) ?? `/api/uploads/${canonical.avatar}`
    : null;
  const displayName = canonical.displayName ?? parseFederatedUsername(canonical.username).baseName;

  return (
    <button
      onClick={() => {
        const existingDm = dmChannels.find(dm =>
          !dm.ownerId && dm.members.some(m => m.id === friend.id)
        );
        if (existingDm) {
          onTap(existingDm.id);
        }
      }}
      className="flex flex-col items-center gap-1 shrink-0 w-14"
    >
      <div className="relative">
        <Avatar
          src={avatarUrl}
          name={displayName}
          avatarColor={canonical.avatarColor}
          size={40}
        />
        <span className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-surface-base ${
          friend.status === 'online' ? 'bg-status-online' :
          friend.status === 'idle' ? 'bg-status-idle' :
          'bg-status-dnd'
        }`} />
      </div>
      <span className="text-[10px] text-txt-secondary truncate w-full text-center">
        {displayName}
      </span>
    </button>
  );
}

function MobileDmRow({
  dm,
  authUser,
  readStates,
  onTap,
  onContextMenu,
  formatTimestamp,
}: {
  dm: DmChannel;
  authUser: User | null;
  readStates: Map<string, string>;
  onTap: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string, isGroup: boolean) => void;
  formatTimestamp: (ts: number) => string;
}) {
  const otherMembers = dm.members.filter(m => authUser ? !isSelf(m, authUser) : m.id !== authUser);
  const isGroup = !!dm.ownerId;
  const rawMainUser = otherMembers[0] ?? null;
  const canonicalMainUser = useCanonicalUserView(rawMainUser ?? FALLBACK_USER);
  const mainUser = rawMainUser ? canonicalMainUser : null;

  // Group DMs use `dm.name` when set, else fall back to a comma-joined member
  // list (matches `MobileChatScreen` + `DmListItem`). 1:1 DMs use the
  // canonical view of the single other member.
  const name = isGroup
    ? (dm.name && dm.name.length > 0
        ? dm.name
        : otherMembers.map(m => m.displayName ?? parseFederatedUsername(m.username).baseName).join(', '))
    : mainUser?.displayName ?? (parseFederatedUsername(mainUser?.username ?? '').baseName || 'Unknown');

  // Show a single federation globe next to the group name when any non-self
  // member is federated. No tooltip on mobile — the new `group-dm-info` screen
  // surfaces federation identity per-member.
  const groupHasFederatedMember = isGroup && otherMembers.some((m) => isFederationGlobeApplicable(m));

  const lastMsgId = dm.lastMessage?.id;
  const readState = readStates.get(dm.id);
  const isUnread = lastMsgId && (!readState || readState < lastMsgId);

  const preview = formatDmSidebarPreview(dm, authUser ?? null);
  const previewTime = dm.lastMessage?.createdAt;

  const avatarUrl = mainUser?.avatar ? `/api/uploads/${mainUser.avatar}` : null;

  return (
    <button
      key={dm.id}
      data-context-menu
      onClick={() => onTap(dm.id)}
      onContextMenu={(e) => onContextMenu(e, dm.id, isGroup)}
      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-interactive-hover text-left transition-colors"
    >
      <div className="relative shrink-0">
        {isGroup ? (
          // Reuse the shared AvatarStack so group rows match the rest of the
          // group-DM surface (chat header, DmListItem, GroupDmSettings hero).
          // size 40 matches the 1:1 Avatar above it; border="chat" picks the
          // surface-chat border color used elsewhere on the messages list.
          <AvatarStack
            members={otherMembers}
            size={40}
            border="chat"
            iconUrl={dm.icon}
          />
        ) : (
          <Avatar
            src={avatarUrl}
            name={name}
            avatarColor={mainUser?.avatarColor}
            size={40}
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 min-w-0">
            <span className={`text-sm truncate ${isUnread ? 'font-semibold text-txt-primary' : 'text-txt-primary'}`}>
              {name}
            </span>
            {groupHasFederatedMember && (
              <svg
                data-dm-row-globe
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="text-txt-tertiary/80 flex-shrink-0"
                aria-hidden="true"
              >
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
              </svg>
            )}
          </span>
          {previewTime && (
            <span className="text-[11px] text-txt-tertiary shrink-0">
              {formatTimestamp(previewTime)}
            </span>
          )}
        </div>
        {!isGroup && mainUser && isFederationGlobeApplicable(mainUser) && (
          <div className="text-[10px] leading-[1.3] text-txt-tertiary truncate opacity-60">
            @{parseFederatedUsername(mainUser.username).domain}
          </div>
        )}
        {preview && (
          <p className={`text-xs truncate mt-0.5 ${isUnread ? 'text-txt-secondary font-medium' : 'text-txt-tertiary'}`}>
            {preview}
          </p>
        )}
      </div>
      {isUnread && <span className="w-2.5 h-2.5 rounded-full bg-accent-primary shrink-0" />}
    </button>
  );
}

export function MobileDmsScreen() {
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);
  const openModal = useUIStore((s) => s.openModal);

  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const readStates = useChatStore((s) => s.readStates);
  const authUser = useAuthStore((s) => s.user);
  const friends = useSocialStore((s) => s.friends);
  const navigate = useNavigate();
  const openContextMenu = useContextMenuStore((s) => s.open);
  const setCurrentChannel = useChatStore((s) => s.setCurrentChannel);

  // Online friends for the activity row
  const onlineFriends = useMemo(() =>
    friends.filter(f => f.status === 'online' || f.status === 'idle' || f.status === 'dnd'),
    [friends]
  );

  // Sort DMs by last message time (newest first)
  const sortedDms = useMemo(() =>
    [...dmChannels].sort((a, b) => {
      const aTime = a.lastMessage?.createdAt ?? a.createdAt;
      const bTime = b.lastMessage?.createdAt ?? b.createdAt;
      return bTime - aTime;
    }),
    [dmChannels]
  );

  const handleDmTap = (dmId: string) => {
    navigate(`/channels/@me/${dmId}`);
    pushMobileScreen('channel-chat', { channelId: dmId, spaceId: '@me' });
  };

  const handleDmContextMenu = (e: React.MouseEvent, dmId: string, isGroup: boolean) => {
    if (!isGroup) return;
    e.preventDefault();
    e.stopPropagation();

    openContextMenu({ x: e.clientX, y: e.clientY }, [
      {
        key: 'leave-group',
        type: 'action',
        label: 'Leave Group',
        danger: true,
        icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" /></svg>,
        onClick: () => {
          const currentChId = useChatStore.getState().currentChannelId;
          if (currentChId === dmId) {
            navigate('/channels/@me');
            setCurrentChannel(null);
          }
          useSpaceStore.getState().leaveDm(dmId);
        },
      },
    ]);
  };

  const formatTimestamp = (ts: number): string => {
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60_000) return 'now';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
    if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}d`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <div className="flex flex-col h-full bg-surface-base">
      {/* Header */}
      <header className="h-12 flex items-center justify-between px-4 border-b border-border-soft shrink-0">
        <h1 className="text-base font-semibold text-txt-primary">Messages</h1>
        <div className="flex items-center gap-1">
          <button
            onClick={() => pushMobileScreen('friends')}
            className="h-8 px-3 rounded-lg text-xs font-medium text-accent-primary hover:bg-interactive-hover transition-colors"
          >
            Friends
          </button>
        </div>
      </header>

      {/* Activity row — online friends */}
      {onlineFriends.length > 0 && (
        <div className="px-4 py-3 border-b border-border-soft">
          <div className="flex gap-3 overflow-x-auto no-scrollbar">
            {onlineFriends.map(friend => (
              <MobileFriendBubble
                key={friend.id}
                friend={friend}
                dmChannels={dmChannels}
                onTap={handleDmTap}
              />
            ))}
          </div>
        </div>
      )}

      {/* DM list */}
      <div className="flex-1 overflow-y-auto">
        {sortedDms.map(dm => (
          <MobileDmRow
            key={dm.id}
            dm={dm}
            authUser={authUser ?? null}
            readStates={readStates}
            onTap={handleDmTap}
            onContextMenu={handleDmContextMenu}
            formatTimestamp={formatTimestamp}
          />
        ))}

        {sortedDms.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 opacity-80">
            <Mascot state="sleeping" className="w-20 h-20 mb-2" />
            <p className="text-txt-tertiary text-sm">No conversations yet.</p>
          </div>
        )}
      </div>

      {/* FAB — New DM */}
      <button
        onClick={() => openModal('newDm')}
        className="fixed bottom-20 right-4 w-14 h-14 rounded-full bg-accent-primary text-white shadow-elevation-high flex items-center justify-center z-20 hover:bg-accent-primary-hover active:bg-accent-primary-active transition-colors"
      >
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
        </svg>
      </button>
    </div>
  );
}
