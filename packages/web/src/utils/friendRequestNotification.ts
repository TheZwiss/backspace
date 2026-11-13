import { create } from 'zustand';
import type { FriendRequest } from '@backspace/shared';
import { useAuthStore } from '../stores/authStore';
import { useFriendNotificationPreferences } from '../stores/friendNotificationPreferences';
import { alertsAllowed, playAlertSound, showAlertNotification } from './alerts';
import i18n from '../i18n';
export interface FriendRequestNotice { key: string; ownerId: string; request: FriendRequest; origin: string; }
export const useFriendRequestNotices = create<{ notices: FriendRequestNotice[]; remove: (key: string) => void }>(set => ({ notices: [], remove: key => set(s => ({ notices: s.notices.filter(n => n.key !== key) })) }));

export async function notifyFriendRequest(request: FriendRequest, origin: string): Promise<void> {
  const ownerId = useAuthStore.getState().user?.id;
  const preferences = useFriendNotificationPreferences.getState();
  if (!ownerId || !preferences.enabled || !alertsAllowed('friend_request')) return;
  const key = `${ownerId}:${origin}:${request.id}`;
  if (useFriendRequestNotices.getState().notices.some(n => n.key === key)) return;
  useFriendRequestNotices.setState(s => ({ notices: [...s.notices.slice(-2), { key, ownerId, request, origin }] }));
  setTimeout(() => useFriendRequestNotices.getState().remove(key), 12_000);
  if (preferences.sound) void playAlertSound('friend_request').catch(() => {});
  if (document.hasFocus() || !preferences.desktop) return;
  const name = request.user?.displayName || request.user?.username || i18n.t('chat:notification.unknownSender');
  const options = { requestId: request.id, origin, userId: ownerId, kind: 'friend_request' as const, silent: true };
  if (!window.backspace?.showFriendRequest) {
    showAlertNotification('friend_request', name, i18n.t('social:friendNotification.body'), options);
    return;
  }
  let avatar: string | undefined;
  const source = request.user?.avatar;
  if (source) try {
    const url = new URL(source.startsWith('http') || source.startsWith('/') ? source : '/api/uploads/' + source, origin || location.origin);
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    const blob = await response.blob();
    if (response.ok && blob.size <= 1_000_000 && /^image\/(png|jpeg|webp|gif)$/.test(blob.type)) avatar = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
  } catch { /* The sender's initial remains visible when their photo is unavailable. */ }
  if (useAuthStore.getState().user?.id !== ownerId || !useFriendRequestNotices.getState().notices.some(n => n.key === key)) return;
  if (document.hasFocus() || !useFriendNotificationPreferences.getState().enabled || !alertsAllowed('friend_request')) return;
  window.backspace.showFriendRequest({ ...options, sender: name, avatar, labels: { body: i18n.t('social:friendNotification.body'), accept: i18n.t('common:actions.accept'), decline: i18n.t('common:actions.decline'), close: i18n.t('common:actions.close') } });
}
