import React, { useMemo } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { Avatar } from '../ui/Avatar';
import { Mascot } from '../ui/Mascot';
import { resolveAssetUrl } from '../../utils/assetUrls';
import { useNavigate } from 'react-router-dom';
import { parseFederatedUsername } from '../../utils/identity';

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
            {onlineFriends.map(friend => {
              const avatarUrl = friend.avatar
                ? resolveAssetUrl(friend.avatar, friend._instanceOrigin) ?? `/api/uploads/${friend.avatar}`
                : null;
              return (
                <button
                  key={friend.id}
                  onClick={() => {
                    // Find or create DM with this friend
                    const existingDm = dmChannels.find(dm =>
                      !dm.ownerId && dm.members.some(m => m.id === friend.id)
                    );
                    if (existingDm) {
                      handleDmTap(existingDm.id);
                    }
                  }}
                  className="flex flex-col items-center gap-1 shrink-0 w-14"
                >
                  <div className="relative">
                    <Avatar
                      src={avatarUrl}
                      name={friend.displayName ?? parseFederatedUsername(friend.username).baseName}
                      avatarColor={friend.avatarColor}
                      size={40}
                    />
                    <span className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-surface-base ${
                      friend.status === 'online' ? 'bg-status-online' :
                      friend.status === 'idle' ? 'bg-status-idle' :
                      'bg-status-dnd'
                    }`} />
                  </div>
                  <span className="text-[10px] text-txt-secondary truncate w-full text-center">
                    {friend.displayName ?? parseFederatedUsername(friend.username).baseName}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* DM list */}
      <div className="flex-1 overflow-y-auto">
        {sortedDms.map(dm => {
          const otherMembers = dm.members.filter(m => m.id !== authUser?.id);
          const isGroup = !!dm.ownerId;
          const name = isGroup
            ? otherMembers.map(m => m.displayName ?? parseFederatedUsername(m.username).baseName).join(', ')
            : otherMembers[0]?.displayName ?? (parseFederatedUsername(otherMembers[0]?.username ?? '').baseName || 'Unknown');

          const lastMsgId = dm.lastMessage?.id;
          const readState = readStates.get(dm.id);
          const isUnread = lastMsgId && (!readState || readState < lastMsgId);

          const preview = dm.lastMessage?.content;
          const previewTime = dm.lastMessage?.createdAt;
          const previewSender = dm.lastMessage
            ? dm.members.find(m => m.id === dm.lastMessage!.userId)
            : null;

          const mainUser = otherMembers[0];
          const avatarUrl = mainUser?.avatar
            ? `/api/uploads/${mainUser.avatar}`
            : null;

          return (
            <button
              key={dm.id}
              data-context-menu
              onClick={() => handleDmTap(dm.id)}
              onContextMenu={(e) => handleDmContextMenu(e, dm.id, isGroup)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-interactive-hover text-left transition-colors"
            >
              <div className="relative shrink-0">
                {isGroup ? (
                  <div className="w-10 h-10 rounded-full bg-surface-elevated flex items-center justify-center">
                    <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
                    </svg>
                  </div>
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
                  <span className={`text-sm truncate ${isUnread ? 'font-semibold text-txt-primary' : 'text-txt-primary'}`}>
                    {name}
                  </span>
                  {previewTime && (
                    <span className="text-[11px] text-txt-tertiary shrink-0">
                      {formatTimestamp(previewTime)}
                    </span>
                  )}
                </div>
                {(() => {
                  const mainUser = otherMembers[0];
                  if (!mainUser) return null;
                  const { domain } = parseFederatedUsername(mainUser.username);
                  if (!domain) return null;
                  return <div className="text-[10px] leading-[1.3] text-txt-tertiary truncate opacity-60">@{domain}</div>;
                })()}
                {preview && (
                  <p className={`text-xs truncate mt-0.5 ${isUnread ? 'text-txt-secondary font-medium' : 'text-txt-tertiary'}`}>
                    {previewSender && previewSender.id !== authUser?.id
                      ? `${previewSender.displayName ?? parseFederatedUsername(previewSender.username).baseName}: ${preview}`
                      : preview}
                  </p>
                )}
              </div>
              {isUnread && <span className="w-2.5 h-2.5 rounded-full bg-accent-primary shrink-0" />}
            </button>
          );
        })}

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
