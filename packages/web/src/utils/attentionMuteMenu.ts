import { createElement } from 'react';
import type { ContextMenuItem } from '../stores/contextMenuStore';
import { useAttentionMutes, attentionMuted, ATTENTION_MUTE_DURATIONS, type AttentionMuteTarget } from '../stores/attentionMutes';
import { useAuthStore } from '../stores/authStore';
import { userKey, isMine, selfIdentityOf } from './identity';
import i18n from '../i18n';
export const attentionMuteDurationLabels = ['minutes15', 'hour1', 'hours8', 'hours24', 'forever'] as const;
export function attentionMuteMenuItems(user: AttentionMuteTarget, origin: string): ContextMenuItem[] {
  const auth = useAuthStore.getState();
  if (!auth.user || isMine(user, origin, selfIdentityOf(auth.user, auth.myRowIds))) return [];
  const owner = userKey(auth.user, '');
  const icon = createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true }, createElement('path', { d: 'm3 3 18 18M8 5a6 6 0 0 1 10 4v5m-1 3H3c0-2 3-2 3-8M10 21h4' }));
  if (attentionMuted(owner, user, origin)) return [{ type: 'action', key: 'unmute-attention', label: i18n.t('settings:attentionMutes.unmute'), icon, onClick: () => {
    const current = useAttentionMutes.getState();
    for (const entry of current.entries) if (entry.owner === owner && (entry.aliases.includes(userKey(user, origin)) || entry.aliases.includes(userKey({ id: user.id }, origin)))) current.unmute(owner, entry.key);
  } }];
  return [{ type: 'submenu', key: 'mute-attention', label: i18n.t('settings:attentionMutes.mute'), icon,
    children: [...ATTENTION_MUTE_DURATIONS, null].map((duration, index) => ({ type: 'action' as const, key: `mute-attention-${index}`, label: i18n.t(`settings:attentionMutes.${attentionMuteDurationLabels[index]!}`), onClick: () => useAttentionMutes.getState().mute(owner, user, origin, duration) })) }];
}
