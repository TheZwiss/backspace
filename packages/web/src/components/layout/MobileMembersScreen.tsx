import React, { useMemo } from 'react';
import type { MemberWithUser } from '@backspace/shared';
import { useSpaceStore } from '../../stores/spaceStore';
import { useActivityStore } from '../../stores/activityStore';
import { useUIStore } from '../../stores/uiStore';
import { Avatar } from '../ui/Avatar';
import { Username } from '../ui/Username';
import { ActivityCard, hasRichActivity, getActivityAccentClass } from '../ui/ActivityCard';
import { getPrimaryActivity } from '@backspace/shared/src/activities.js';
import { parseFederatedUsername } from '../../utils/identity';
import { MobileScreenHeader } from './MobileScreenHeader';

/**
 * Derives the display group for a member based on their highest-positioned role
 * or owner status. Returns { key, label, color, position }.
 */
function getMemberGroup(member: MemberWithUser, ownerId: string | undefined) {
  if (ownerId && member.userId === ownerId) {
    const ownerRole = member.roles?.find(r => r.position > 0);
    return {
      key: '__owner__',
      label: 'OWNER',
      color: ownerRole?.color ?? 'rgb(var(--accent-rose))',
      position: Infinity,
    };
  }
  if (member.roles && member.roles.length > 0) {
    const sorted = [...member.roles].sort((a, b) => b.position - a.position);
    const top = sorted[0]!;
    return {
      key: top.id,
      label: top.name.toUpperCase(),
      color: top.color,
      position: top.position,
    };
  }
  return {
    key: '__online__',
    label: 'ONLINE',
    color: undefined,
    position: -1,
  };
}

interface MobileMembersScreenProps {
  params?: Record<string, string>;
}

export function MobileMembersScreen({ params }: MobileMembersScreenProps) {
  const members = useSpaceStore((s) => s.members);
  const spaces = useSpaceStore((s) => s.spaces);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const userActivities = useActivityStore((s) => s.userActivities);
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);

  const spaceId = params?.spaceId || currentSpaceId;
  const space = spaces.find(s => s.id === spaceId);
  const ownerId = space?.ownerId;

  const { roleGroups, offlineMembers } = useMemo(() => {
    const online = members.filter(m => m.user.status !== 'offline');
    const offline = members.filter(m => m.user.status === 'offline');

    const groups = new Map<string, { label: string; color: string | undefined; position: number; members: MemberWithUser[] }>();
    for (const m of online) {
      const group = getMemberGroup(m, ownerId);
      if (!groups.has(group.key)) {
        groups.set(group.key, { label: group.label, color: group.color, position: group.position, members: [] });
      }
      groups.get(group.key)!.members.push(m);
    }

    const sorted = [...groups.entries()].sort(
      (a, b) => b[1].position - a[1].position
    );

    return { roleGroups: sorted, offlineMembers: offline };
  }, [members, ownerId]);

  const totalCount = members.length;

  const getMemberColor = (member: MemberWithUser): React.CSSProperties | undefined => {
    if (member.roles && member.roles.length > 0) {
      const sorted = [...member.roles].sort((a, b) => b.position - a.position);
      return { color: sorted[0]!.color };
    }
    if (ownerId && member.userId === ownerId) {
      return { color: 'rgb(var(--accent-rose))' };
    }
    return undefined;
  };

  const handleMemberClick = (userId: string) => {
    pushMobileScreen('user-profile', { userId });
  };

  const renderMember = (member: MemberWithUser, isOffline = false) => {
    const { baseName, domain } = parseFederatedUsername(member.user.username);
    const displayName = member.user.displayName ?? baseName;
    const colorStyle = isOffline ? undefined : getMemberColor(member);
    const activities = userActivities.get(member.userId) ?? [];
    const isRichActivity = !isOffline && hasRichActivity(activities);
    const primary = getPrimaryActivity(activities);
    const accentClass = primary ? getActivityAccentClass(primary.type) : '';

    const rowClass = isRichActivity
      ? `flex items-center gap-2.5 px-4 py-2.5 rounded-[10px] mb-1 cursor-pointer transition-colors glass-pill border-l-2 ${accentClass} active:bg-interactive-hover`
      : 'flex items-center gap-2.5 px-4 py-2.5 rounded-[4px] cursor-pointer transition-colors active:bg-interactive-hover';

    return (
      <div
        key={member.userId}
        onClick={() => handleMemberClick(member.userId)}
        className={rowClass}
      >
        <Avatar
          src={member.user.avatar}
          name={displayName}
          size={36}
          status={isOffline ? 'offline' : member.user.status}
          className={isOffline ? 'opacity-60' : undefined}
          user={member.user}
        />
        <div className="flex-1 min-w-0">
          <Username
            username={displayName}
            className={`text-[13.5px] leading-[1.2] font-medium truncate ${isOffline ? 'text-txt-tertiary' : (!colorStyle ? 'text-txt-primary' : '')}`}
            style={colorStyle}
          />
          {domain && !isOffline && (
            <div className="text-[10px] leading-[1.3] text-txt-tertiary truncate opacity-60">@{domain}</div>
          )}
          {!isOffline && (
            <ActivityCard
              activities={activities}
              fallbackCustomStatus={member.user.customStatus}
            />
          )}
        </div>
      </div>
    );
  };

  const onlineCount = roleGroups.reduce((sum, [, g]) => sum + g.members.length, 0);

  return (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title={totalCount > 0 ? `Members — ${totalCount}` : 'Members'} />
      <div className="flex-1 overflow-y-auto p-3">
        {onlineCount === 0 && offlineMembers.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-txt-tertiary text-sm">
            No members found
          </div>
        ) : (
          <>
            {roleGroups.map(([key, group]) => (
              <div key={key} className="mb-4">
                <h3 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-1">
                  {group.label} — {group.members.length}
                </h3>
                {group.members.map((m) => renderMember(m))}
              </div>
            ))}

            {offlineMembers.length > 0 && (
              <div>
                <h3 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-1">
                  OFFLINE — {offlineMembers.length}
                </h3>
                {offlineMembers.map((m) => renderMember(m, true))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
