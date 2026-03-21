import React, { useEffect, useMemo } from 'react';
import { useSocialStore } from '../../stores/socialStore';
import { useUIStore } from '../../stores/uiStore';
import { useActivityStore } from '../../stores/activityStore';
import { Avatar } from '../ui/Avatar';
import { Username } from '../ui/Username';
import { ActivityCard } from '../ui/ActivityCard';
import type { Friend } from '@backspace/shared';
import { getPrimaryActivity } from '@backspace/shared/src/activities.js';
import { parseFederatedUsername } from '../../utils/identity';

export function ActivityPanel() {
  const friends = useSocialStore((s) => s.friends);
  const loadFriends = useSocialStore((s) => s.loadFriends);
  const memberListOpen = useUIStore((s) => s.memberListOpen);
  const openUserProfile = useUIStore((s) => s.openUserProfile);
  const userActivities = useActivityStore((s) => s.userActivities);

  useEffect(() => {
    loadFriends();
  }, [loadFriends]);

  const { activeFriends, onlineFriends, offlineFriends } = useMemo(() => {
    const active: Friend[] = [];
    const online: Friend[] = [];
    const offline: Friend[] = [];

    for (const f of friends) {
      if (f.status === 'offline') {
        offline.push(f);
        continue;
      }
      const activities = userActivities.get(f.homeUserId ?? f.id) ?? [];
      const primary = getPrimaryActivity(activities);
      // Active = has a non-custom activity (playing, listening, watching, streaming)
      if (primary && primary.type !== 'custom') {
        active.push(f);
      } else {
        online.push(f);
      }
    }

    return { activeFriends: active, onlineFriends: online, offlineFriends: offline };
  }, [friends, userActivities]);

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
        banner: friend.banner,
        accentColor: friend.accentColor,
        avatarColor: friend.avatarColor,
        bio: friend.bio,
        status: friend.status,
        customStatus: friend.customStatus,
        createdAt: friend.createdAt,
        homeUserId: friend.homeUserId,
        homeInstance: friend.homeInstance,
        isAdmin: false,
        replicatedInstances: [],
      },
      {
        top: Math.min(rect.top, window.innerHeight - 450),
        left: rect.left - 316,
      }
    );
  };

  const renderFriend = (friend: Friend, isOffline = false, isCompact = true) => {
    const { baseName, domain } = parseFederatedUsername(friend.username);
    const friendDisplayName = friend.displayName ?? baseName;
    const activities = userActivities.get(friend.homeUserId ?? friend.id) ?? [];
    return (
      <div
        key={friend.id}
        onClick={(e) => handleFriendClick(e, friend)}
        className="flex items-center gap-2.5 px-2 py-1.5 rounded-[4px] hover:bg-interactive-hover cursor-pointer group transition-colors"
      >
        <Avatar
          src={friend.avatar}
          name={friendDisplayName}
          size={32}
          status={isOffline ? 'offline' : friend.status}
          className={isOffline ? 'opacity-60' : undefined}
          userId={friend.homeUserId ?? friend.id}
          avatarColor={friend.avatarColor}
        />
        <div className="flex-1 min-w-0">
          <Username
            username={friendDisplayName}
            className={`text-[13.5px] leading-[1.2] font-medium truncate ${isOffline ? 'text-txt-tertiary' : 'text-txt-primary'}`}
          />
          {domain && !isOffline && (
            <div className="text-[10px] leading-[1.3] text-txt-tertiary truncate opacity-60">@{domain}</div>
          )}
          {!isOffline && (
            <ActivityCard
              activities={activities}
              compact={isCompact}
              fallbackCustomStatus={friend.customStatus}
            />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="w-60 bg-surface-channel flex-shrink-0 overflow-y-auto select-none no-scrollbar hidden md:block border-l border-border-hard">
      <div className="p-3">
        <h3 className="text-[20px] font-bold text-txt-primary mb-4 px-2">Active Now</h3>

        {activeFriends.length === 0 && onlineFriends.length === 0 && offlineFriends.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-[16px] font-bold text-txt-primary mb-1">It's quiet for now...</div>
            <div className="text-[14px] text-txt-tertiary max-w-[200px] mx-auto">
              When a friend starts an activity&#8212;like playing a game or hanging out on voice&#8212;we'll show it here!
            </div>
          </div>
        ) : (
          <>
            {activeFriends.length > 0 && (
              <div className="mb-4">
                {activeFriends.map(f => renderFriend(f, false, false))}
              </div>
            )}
            {onlineFriends.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-1">
                  ONLINE — {onlineFriends.length}
                </h3>
                {onlineFriends.map(f => renderFriend(f))}
              </div>
            )}
            {offlineFriends.length > 0 && (
              <div>
                <h3 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-1">
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
