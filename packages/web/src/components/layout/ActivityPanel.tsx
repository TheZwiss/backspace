import { FriendsVoiceCard } from './FriendsVoiceCard';
import { friendshipMenuItems, runMemberAction, sendMemberMessage } from './memberMenu/memberSocialActions';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { useNavigate } from 'react-router-dom';
import React, { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSocialStore, type TaggedFriend } from '../../stores/socialStore';
import { useUIStore } from '../../stores/uiStore';
import { useActivityStore, activitiesFor } from '../../stores/activityStore';
import { Avatar } from '../ui/Avatar';
import { ActivityCard, hasRichActivity, getActivityAccentClass } from '../ui/ActivityCard';
import type { Activity, User } from '@backspace/shared';
import { getPrimaryActivity } from '@backspace/shared/src/activities.js';
import { parseFederatedUsername, isFederationGlobeApplicable } from '../../utils/identity';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { groupFriendsInVoice } from '../../utils/friendsInVoice';

function ActivityFriendRow({
  friend,
  isOffline,
  activities,
  isRichActivity,
  accentClass,
  onClickFriend,
}: {
  friend: TaggedFriend;
  isOffline: boolean;
  activities: Activity[];
  isRichActivity: boolean;
  accentClass: string;
  onClickFriend: (e: React.MouseEvent, friend: TaggedFriend) => void;
}) {
  const canonical = useCanonicalUserView(friend as unknown as User, friend._instanceOrigin);
  const { baseName } = parseFederatedUsername(canonical.username);
  const friendDisplayName = canonical.displayName ?? baseName;

  const rowClass = isRichActivity
    ? `flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] mb-1 cursor-pointer transition-all duration-200 ease-out glass-pill border-l-2 ${accentClass}`
    : 'flex items-center gap-2.5 px-2 py-1.5 rounded-[4px] border-l-2 border-transparent hover:bg-interactive-hover cursor-pointer group transition-all duration-200 ease-out';

  return (
    <div
      onClick={(e) => onClickFriend(e, friend)}
      className={rowClass}
    >
      <Avatar
        src={canonical.avatar}
        name={friendDisplayName}
        size={32}
        status={isOffline ? 'offline' : canonical.status}
        className={isOffline ? 'opacity-60' : undefined}
        userId={canonical.homeUserId ?? canonical.id}
        avatarColor={canonical.avatarColor}
      />
      <div className="flex-1 min-w-0">
        <span className={`text-[13.5px] leading-[1.2] font-medium truncate ${isOffline ? 'text-txt-tertiary' : 'text-txt-primary'}`}>{friendDisplayName}</span>
        {!isOffline && isFederationGlobeApplicable(canonical) && (
          <div className="text-[10px] leading-[1.3] text-txt-tertiary truncate opacity-60">@{parseFederatedUsername(canonical.username).domain}</div>
        )}
        {!isOffline && (
          <ActivityCard
            activities={activities}
            fallbackCustomStatus={canonical.customStatus}
          />
        )}
      </div>
    </div>
  );
}

export function ActivityPanel() {
  const navigate = useNavigate();
  const { t } = useTranslation(['social', 'common', 'spaces']);
  const friends = useSocialStore((s) => s.friends);
  const loadFriends = useSocialStore((s) => s.loadFriends);
  const memberListOpen = useUIStore((s) => s.memberListOpen);
  const openUserProfile = useUIStore((s) => s.openUserProfile);
  const userActivities = useActivityStore((s) => s.userActivities);
  const voiceUsers = useVoiceStore((s) => s.voiceUsers);
  const channelIndex = useSpaceStore((s) => s.spaceChannelIndex);
  const spaces = useSpaceStore((s) => s.spaces);
  const voiceGroups = useMemo(() => groupFriendsInVoice(friends, voiceUsers, channelIndex, spaces), [friends, voiceUsers, channelIndex, spaces]);

  useEffect(() => {
    loadFriends();
  }, [loadFriends]);

  const { activeFriends, onlineFriends, offlineFriends } = useMemo(() => {
    const active: TaggedFriend[] = [];
    const online: TaggedFriend[] = [];
    const offline: TaggedFriend[] = [];

    for (const f of friends) {
      if (f.status === 'offline') {
        offline.push(f);
        continue;
      }
      const activities = activitiesFor(userActivities, f, f._instanceOrigin);
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

  const handleFriendClick = (e: React.MouseEvent, friend: TaggedFriend) => {
    e.stopPropagation();
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
      friend._instanceOrigin,
      e.currentTarget.getBoundingClientRect(),
      'left',
    );
  };

  const renderFriend = (friend: TaggedFriend, isOffline = false) => {
    const activities = activitiesFor(userActivities, friend, friend._instanceOrigin);
    const isRichActivity = !isOffline && hasRichActivity(activities);
    const primary = getPrimaryActivity(activities);
    const accentClass = primary ? getActivityAccentClass(primary.type) : '';
    return (
      <ActivityFriendRow
        key={friend.id}
        friend={friend}
        isOffline={isOffline}
        activities={activities}
        isRichActivity={isRichActivity}
        accentClass={accentClass}
        onClickFriend={handleFriendClick}
      />
    );
  };

  return (
    <div className="w-60 bg-surface-channel flex-shrink-0 overflow-y-auto select-none no-scrollbar hidden desktop:block border-l border-border-hard">
      <div className="p-3">
        <h3 className="text-[20px] font-bold text-txt-primary mb-4 px-2">{t('social:activity.title')}</h3>
        {voiceGroups.length > 0 && <section className="mb-4" aria-label={t('social:activity.friendsInVoice')}>
          <h3 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-2">{t('social:activity.friendsInVoice')}</h3>
          {voiceGroups.map(group => <FriendsVoiceCard key={group.channelId} group={group}>
              {group.friends.slice(0, 5).map(friend => <span key={friend.id} title={friend.displayName ?? friend.username} aria-label={friend.displayName ?? friend.username} onContextMenu={e => {
                e.preventDefault(); e.stopPropagation();
                const anchor = e.currentTarget.getBoundingClientRect();
                const user = { ...friend, isAdmin: false, replicatedInstances: [] };
                useContextMenuStore.getState().open({ x: e.clientX, y: e.clientY }, [
                  { type: 'action', key: 'profile', label: t('spaces:members.menu.profile'), onClick: () => openUserProfile(user, friend._instanceOrigin, anchor, 'left') },
                  { type: 'action', key: 'message', label: t('social:profile.sendMessage'), onClick: () => { void runMemberAction(() => sendMemberMessage(user, friend._instanceOrigin, navigate)); } },
                  ...friendshipMenuItems(user, friend._instanceOrigin),
                ]);
              }} className="shrink-0 rounded-full hover:opacity-80">
                <Avatar src={friend.avatar} name={friend.displayName ?? friend.username} size={28} userId={friend.homeUserId ?? friend.id} avatarColor={friend.avatarColor} />
              </span>)}
              {group.friends.length > 5 && <span className="shrink-0 text-[10px] font-semibold text-txt-tertiary" title={t('social:activity.moreFriends', { n: group.friends.length - 5 })} aria-label={t('social:activity.moreFriends', { n: group.friends.length - 5 })}>+{group.friends.length - 5}</span>}
          </FriendsVoiceCard>)}
        </section>}

        {activeFriends.length === 0 && onlineFriends.length === 0 && offlineFriends.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-[16px] font-bold text-txt-primary mb-1">{t('social:activity.quietTitle')}</div>
            <div className="text-[14px] text-txt-tertiary max-w-[200px] mx-auto">
              {t('social:activity.quietDescription')}
            </div>
          </div>
        ) : (
          <>
            {activeFriends.length > 0 && (
              <div className="mb-4">
                {activeFriends.map(f => renderFriend(f))}
              </div>
            )}
            {onlineFriends.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-1">
                  {t('social:activity.online', { n: onlineFriends.length })}
                </h3>
                {onlineFriends.map(f => renderFriend(f))}
              </div>
            )}
            {offlineFriends.length > 0 && (
              <div>
                <h3 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-1">
                  {t('social:activity.offline', { n: offlineFriends.length })}
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
