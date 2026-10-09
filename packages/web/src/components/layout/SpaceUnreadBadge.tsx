import { useTranslation } from 'react-i18next';
import { useChannelActivityStore } from '../../stores/channelActivityStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { isMuteActive } from '@backspace/shared';
import { useStoredNotificationSetting } from '../../hooks/useNotificationSettings';
import { useNotificationSettingsStore } from '../../stores/notificationSettingsStore';

export function SpaceUnreadBadge({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation('spaces');
  const origin = useSpaceStore(s => s.spaces.find(space => space.id === spaceId)?._instanceOrigin ?? '');
  const channelSpaces = useSpaceStore(s => s.channelToSpaceMap);
  const unread = useChatStore(s => s.unreadChannels);
  const counts = useChannelActivityStore(s => s.counts[origin]);
  const setting = useStoredNotificationSetting(origin, spaceId, null);
  // The upstream clock updates when a timed mute expires.
  useNotificationSettingsStore(s => s.clock);
  const muted = isMuteActive(setting, Date.now());
  // Only render known counts for currently visible channels; old hosts keep their unread dot.
  const unreadTotal = Object.entries(counts ?? {}).reduce((total, [id, value]) =>
    total + (channelSpaces.get(id) === spaceId && unread.has(id) ? value : 0), 0);
  if (unreadTotal === 0) return null;
  // Muting changes the visual emphasis, not the visibility or unread count.
  return <span aria-label={t('sidebar.space.unreadMessages', { quantity: unreadTotal })}
    className={`absolute -right-1.5 -top-1.5 z-10 min-w-[18px] h-[18px] px-1 rounded-full ${muted ? 'bg-gray-500' : 'bg-red-500'} text-white text-[10px] leading-[18px] font-bold text-center ring-2 ring-surface-base pointer-events-none`}>
    {unreadTotal > 99 ? '99+' : unreadTotal}
  </span>;
}
