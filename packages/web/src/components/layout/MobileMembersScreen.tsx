import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemberWithUser, Activity } from '@backspace/shared';
import { useFormatters } from '../../i18n/formatters';
import { useSpaceStore } from '../../stores/spaceStore';
import { useActivityStore, activitiesFor } from '../../stores/activityStore';
import { useUIStore } from '../../stores/uiStore';
import { Avatar } from '../ui/Avatar';
import { ActivityCard, hasRichActivity, getActivityAccentClass } from '../ui/ActivityCard';
import { getPrimaryActivity } from '@backspace/shared/src/activities.js';
import { parseFederatedUsername, isFederationGlobeApplicable, userDisplayName } from '../../utils/identity';
import { useSpaceOrigin } from '../../hooks/useSpaceOrigin';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { MobileScreenHeader } from './MobileScreenHeader';
import { useDelayedLoading } from '../../hooks/useDelayedLoading';
import { groupMembers, memberNameColor, type MemberGroupKind } from '../../utils/memberGroups';

function MobileMemberRow({
  member,
  isOffline,
  colorStyle,
  activities,
  isRichActivity,
  accentClass,
  onClickMember,
}: {
  member: MemberWithUser;
  isOffline: boolean;
  colorStyle: React.CSSProperties | undefined;
  activities: Activity[];
  isRichActivity: boolean;
  accentClass: string;
  onClickMember: (member: MemberWithUser) => void;
}) {
  const origin = useSpaceOrigin(member.spaceId);
  const canonical = useCanonicalUserView(member.user, origin);
  const displayName = userDisplayName(canonical);

  const rowClass = isRichActivity
    ? `flex items-center gap-2.5 px-4 py-2.5 rounded-[10px] mb-1 cursor-pointer transition-colors glass-pill border-l-2 ${accentClass} active:bg-interactive-hover`
    : 'flex items-center gap-2.5 px-4 py-2.5 rounded-[4px] cursor-pointer transition-colors active:bg-interactive-hover';

  return (
    <div
      onClick={() => onClickMember(member)}
      className={rowClass}
    >
      <Avatar
        src={canonical.avatar}
        name={displayName}
        size={36}
        status={isOffline ? 'offline' : canonical.status}
        className={isOffline ? 'opacity-60' : undefined}
        user={canonical}
      />
      <div className="flex-1 min-w-0">
        <span
          className={`text-[13.5px] leading-[1.2] font-medium truncate ${colorStyle ? (isOffline ? 'opacity-60' : '') : (isOffline ? 'text-txt-tertiary' : 'text-txt-primary')}`}
          style={colorStyle}
        >
          {displayName}
        </span>
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

interface MobileMembersScreenProps {
  params?: Record<string, string>;
}

export function MobileMembersScreen({ params }: MobileMembersScreenProps) {
  const { t } = useTranslation(['spaces', 'common']);
  const { formatNumber } = useFormatters();
  const members = useSpaceStore((s) => s.members);
  const spaces = useSpaceStore((s) => s.spaces);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const loadingSpaceId = useSpaceStore((s) => s.loadingSpaceId);
  const userActivities = useActivityStore((s) => s.userActivities);
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);

  const spaceId = params?.spaceId || currentSpaceId;
  const space = spaces.find(s => s.id === spaceId);
  const spaceOrigin = space?._instanceOrigin ?? '';
  const ownerId = space?.ownerId;

  // Mirror desktop MemberSidebar's `showMemberSkeleton`: gate the skeleton
  // behind useDelayedLoading so cached / fast loads don't flash the placeholder.
  const isLoadingSpace = !!loadingSpaceId && loadingSpaceId === spaceId;
  const showMemberSkeleton = useDelayedLoading(isLoadingSpace);

  const { groups: roleGroups, offline: offlineMembers } = useMemo(() => groupMembers(members, ownerId), [members, ownerId]);

  const totalCount = members.length;

  const getMemberColor = (member: MemberWithUser): React.CSSProperties | undefined => {
    const color = memberNameColor(member, ownerId);
    return color ? { color } : undefined;
  };

  const handleMemberClick = (member: MemberWithUser) => {
    const origin = useSpaceStore.getState().spaces.find(s => s.id === member.spaceId)?._instanceOrigin ?? '';
    pushMobileScreen('user-profile', { userId: member.userId, origin, spaceId: member.spaceId, memberUserId: member.userId });
  };

  const groupHeading = (kind: MemberGroupKind, label: string | null): string => {
    if (kind === 'owner') return t('spaces:members.groups.owner');
    if (kind === 'online') return t('common:states.online');
    return label ?? '';
  };

  const renderMember = (member: MemberWithUser, isOffline = false) => {
    // Roles do not depend on presence: an offline member keeps their colour,
    // dimmed with the rest of the row.
    const colorStyle = getMemberColor(member);
    const activities = activitiesFor(userActivities, member.user, spaceOrigin);
    const isRichActivity = !isOffline && hasRichActivity(activities);
    const primary = getPrimaryActivity(activities);
    const accentClass = primary ? getActivityAccentClass(primary.type) : '';
    return (
      <MobileMemberRow
        key={member.userId}
        member={member}
        isOffline={isOffline}
        colorStyle={colorStyle}
        activities={activities}
        isRichActivity={isRichActivity}
        accentClass={accentClass}
        onClickMember={handleMemberClick}
      />
    );
  };

  const onlineCount = roleGroups.reduce((sum, g) => sum + g.members.length, 0);

  return (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title={totalCount > 0 ? t('spaces:members.titleWithCount', { count: totalCount }) : t('common:labels.members')} />
      <div className="flex-1 overflow-y-auto p-3">
        {showMemberSkeleton ? (
          <div className="px-2 pt-2" role="status" aria-label={t('spaces:members.loading')}>
            {/* Role group 1 — match real row geometry: w-9 h-9 avatar +
                gap-2.5 + py-2.5 → ~52px row height. */}
            <div
              className="skeleton skeleton-bar h-2 w-[35%] mb-2"
              style={{ animationDelay: '0s' }}
            />
            {Array.from({ length: 2 }, (_, i) => (
              <div
                key={`g1-${i}`}
                className="flex items-center gap-2.5 px-2 py-2.5 mb-1"
                style={{ animationDelay: `${i * 0.12}s` }}
              >
                <div
                  className="skeleton skeleton-circle w-9 h-9 flex-shrink-0"
                  style={{ animationDelay: `${i * 0.12}s` }}
                />
                <div className="flex-1 space-y-1.5">
                  <div
                    className="skeleton skeleton-bar"
                    style={{ width: `${50 + (i * 19) % 30}%`, animationDelay: `${i * 0.12}s` }}
                  />
                </div>
              </div>
            ))}
            {/* Role group 2 */}
            <div
              className="skeleton skeleton-bar h-2 w-[45%] mb-2 mt-4"
              style={{ animationDelay: '0.25s' }}
            />
            {Array.from({ length: 5 }, (_, i) => (
              <div
                key={`g2-${i}`}
                className="flex items-center gap-2.5 px-2 py-2.5 mb-1"
                style={{ animationDelay: `${(i + 2) * 0.12}s` }}
              >
                <div
                  className="skeleton skeleton-circle w-9 h-9 flex-shrink-0"
                  style={{ animationDelay: `${(i + 2) * 0.12}s` }}
                />
                <div className="flex-1 space-y-1.5">
                  <div
                    className="skeleton skeleton-bar"
                    style={{ width: `${42 + (i * 15) % 35}%`, animationDelay: `${(i + 2) * 0.12}s` }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : onlineCount === 0 && offlineMembers.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-txt-tertiary text-sm">
            {t('common:labels.noMembersFound')}
          </div>
        ) : (
          <>
            {roleGroups.map((group) => (
              <div key={group.key} className="mb-4">
                <h3 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-1">
                  {groupHeading(group.kind, group.label)} — {formatNumber(group.members.length)}
                </h3>
                {group.members.map((m) => renderMember(m))}
              </div>
            ))}

            {offlineMembers.length > 0 && (
              <div>
                <h3 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-1">
                  {t('common:states.offline')} — {formatNumber(offlineMembers.length)}
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
