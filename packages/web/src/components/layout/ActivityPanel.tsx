import React, { useEffect, useMemo } from 'react';
import { useSocialStore } from '../../stores/socialStore';
import { useUIStore } from '../../stores/uiStore';
import { Avatar } from '../ui/Avatar';
import type { Friend } from '@opencord/shared';

export function ActivityPanel() {
  const friends = useSocialStore((s) => s.friends);
  const loadFriends = useSocialStore((s) => s.loadFriends);
  const memberListOpen = useUIStore((s) => s.memberListOpen);
  const openUserProfile = useUIStore((s) => s.openUserProfile);

  useEffect(() => {
    loadFriends();
  }, [loadFriends]);

  const { onlineFriends, offlineFriends } = useMemo(() => {
    const online = friends.filter(f => f.status !== 'offline');
    const offline = friends.filter(f => f.status === 'offline');
    return { onlineFriends: online, offlineFriends: offline };
  }, [friends]);

  if (!memberListOpen) return null;

  const handleFriendClick = (e: React.MouseEvent, friend: Friend) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openUserProfile(
      {
        id: friend.id,
        username: friend.username,
        displayName: friend.displayName,
        avatar: friend.avatar,
        status: friend.status,
        customStatus: friend.customStatus,
        createdAt: friend.createdAt,
      } as any,
      {
        top: Math.min(rect.top, window.innerHeight - 450),
        left: rect.left - 316,
      }
    );
  };

  const renderFriend = (friend: Friend, isOffline = false) => (
    <div
      key={friend.id}
      onClick={(e) => handleFriendClick(e, friend)}
      className="flex items-center gap-3 px-2 py-1.5 rounded-[4px] hover:bg-discord-modifier-hover cursor-pointer group transition-colors"
    >
      <Avatar
        src={friend.avatar}
        name={friend.displayName ?? friend.username}
        size={32}
        status={isOffline ? 'offline' : friend.status}
        className={isOffline ? 'opacity-60' : undefined}
      />
      <div className="flex-1 min-w-0">
        <div className={`text-[15px] font-medium truncate ${isOffline ? 'text-discord-text-muted' : 'text-discord-text-primary'}`}>
          {friend.displayName ?? friend.username}
        </div>
        {!isOffline && friend.customStatus && (
          <div className="text-[12px] text-discord-text-muted truncate">{friend.customStatus}</div>
        )}
      </div>
    </div>
  );

  return (
    <div className="w-60 bg-discord-bg-secondary flex-shrink-0 overflow-y-auto select-none no-scrollbar">
      <div className="p-3">
        <h3 className="text-[20px] font-bold text-discord-text-header mb-4 px-2">Active Now</h3>

        {onlineFriends.length === 0 && offlineFriends.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-[16px] font-bold text-discord-text-header mb-1">It's quiet for now...</div>
            <div className="text-[14px] text-discord-text-muted max-w-[200px] mx-auto">
              When a friend starts an activity&#8212;like playing a game or hanging out on voice&#8212;we'll show it here!
            </div>
          </div>
        ) : (
          <>
            {onlineFriends.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[12px] font-bold text-discord-text-muted uppercase tracking-wider px-2 mb-1">
                  ONLINE — {onlineFriends.length}
                </h3>
                {onlineFriends.map(f => renderFriend(f))}
              </div>
            )}
            {offlineFriends.length > 0 && (
              <div>
                <h3 className="text-[12px] font-bold text-discord-text-muted uppercase tracking-wider px-2 mb-1">
                  OFFLINE — {offlineFriends.length}
                </h3>
                {offlineFriends.map(f => renderFriend(f, true))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
