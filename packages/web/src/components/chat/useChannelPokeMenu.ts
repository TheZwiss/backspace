import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useChannelPokeStore } from './channelPokeStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { useUIStore } from '../../stores/uiStore';
import { wsSend } from '../../hooks/useWebSocket';

interface Options { channelId: string; targetUserId: string; origin: string; enabled: boolean; pending: boolean }

/** Keep the author action separate from message actions; this PR adds only poke. */
export function useChannelPokeMenu({ channelId, targetUserId, origin, enabled, pending }: Options) {
  const { t } = useTranslation('chat');
  const supported = useChannelPokeStore(s => s.hosts[origin] === true);
  return (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (pending) return;
    useContextMenuStore.getState().open({ x: event.clientX, y: event.clientY }, [{
      type: 'action', key: 'poke-author', label: t('poke.action'), disabled: !enabled || !supported,
      onClick: () => {
        if (!wsSend({ type: 'channel_poke', channelId, targetUserId }, origin)) {
          useUIStore.getState().addToast(t('poke.disconnected'), 'warning');
        }
      },
    }]);
  };
}
