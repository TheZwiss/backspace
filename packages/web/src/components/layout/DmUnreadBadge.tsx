import { useTranslation } from 'react-i18next';
import { useChannelActivityStore } from '../../stores/channelActivityStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';

export function DmUnreadBadge() {
  const { t } = useTranslation('spaces');
  const dms = useSpaceStore(s => s.dmChannels);
  const origins = useSpaceStore(s => s.channelOriginMap);
  const unread = useChatStore(s => s.unreadChannels);
  const counts = useChannelActivityStore(s => s.counts);
  // dmChannels contains canonical conversations: do not sum their federated mirrors.
  const total = dms.reduce((sum, dm) => sum + (unread.has(dm.id)
    ? counts[origins.get(dm.id) ?? '']?.[dm.id] ?? 0 : 0), 0);
  if (total === 0) return null;
  return <span aria-label={t('sidebar.dmUnreadMessages', { quantity: total })}
    className="absolute -right-1.5 -top-1.5 z-10 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] leading-[18px] font-bold text-center ring-2 ring-surface-base pointer-events-none">
    {total > 99 ? '99+' : total}
  </span>;
}
