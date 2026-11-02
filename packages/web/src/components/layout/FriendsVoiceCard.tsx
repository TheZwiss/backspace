import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Avatar } from '../ui/Avatar';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { joinVoiceChannel } from '../../utils/voice';
import { resolveAssetUrl } from '../../utils/assetUrls';
import type { groupFriendsInVoice } from '../../utils/friendsInVoice';

type VoiceGroup = ReturnType<typeof groupFriendsInVoice>[number];
export function FriendsVoiceCard({ group, children }: { group: VoiceGroup; children: ReactNode }) {
  const { t } = useTranslation('social');
  const navigate = useNavigate();
  const openSpace = (channelId?: string) => {
    useSpaceStore.getState().setCurrentSpace(group.space.id);
    useUIStore.getState().setShowDms(false);
    navigate(channelId ? `/channels/${group.space.id}/${channelId}` : `/channels/${group.space.id}`);
  };
  const enterChannel = () => {
    openSpace(group.channelId);
    joinVoiceChannel(group.channelId, useVoiceStore.getState().connectFn ?? undefined);
  };
  return <div className="rounded-[10px] bg-white/[0.03] border border-border-soft p-2 mb-2">
    <button type="button" onClick={() => openSpace()} className="flex w-full items-center gap-2 rounded-lg p-1 text-left hover:bg-interactive-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary" title={t('activity.openSpace')}>
      <Avatar src={resolveAssetUrl(group.space.icon, group.space._instanceOrigin)} name={group.space.name} size={28} palette="space" userId={group.space.id} avatarColor={group.space.avatarColor} />
      <span className="text-xs font-semibold text-txt-primary truncate">{group.space.name}</span>
    </button>
    <button type="button" aria-haspopup="menu" aria-label={t('activity.channelOptions', { channel: group.channelName })} className="block w-full rounded-lg px-1.5 py-2 mt-1 text-txt-secondary hover:text-txt-primary hover:bg-interactive-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary" onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      useContextMenuStore.getState().open({ x: rect.left, y: rect.bottom }, [
        { type: 'action', key: 'open-space', label: t('activity.openSpace'), onClick: () => openSpace() },
        { type: 'action', key: 'join-channel', label: t('activity.joinChannel'), onClick: enterChannel },
      ]);
    }}>
      <span className="flex items-center gap-1.5">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m11 5-6 4H2v6h3l6 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></svg>
      <span className="min-w-0 flex-1 text-left text-[11px] truncate">{group.channelName}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </span>
      <span className="flex flex-wrap items-center gap-1 pt-2">{children}</span>
    </button>
  </div>;
}
