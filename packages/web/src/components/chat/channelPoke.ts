import type { ServerEvent } from '@backspace/shared';
import { useAuthStore, selectMyChosenStatus } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore, getChannelOrigin } from '../../stores/spaceStore';
import { useNotificationStore, notificationKey } from '../../stores/notificationStore';
import { isRegisteredSelfId } from '../../utils/identity';

type Poke = Extract<ServerEvent, { type: 'channel_poke' }>;
export function receiveChannelPoke(origin: string, event: Poke): void {
  const channelId = useChatStore.getState().currentChannelId;
  const inChannel = channelId === event.channelId && getChannelOrigin(channelId) === origin;
  if (!inChannel) return;
  const settings = useNotificationStore.getState().settings;
  const spaceId = useSpaceStore.getState().channelToSpaceMap.get(event.channelId);
  const space = settings[notificationKey({ origin, targetType: 'space', targetId: spaceId ?? '' })];
  const channel = settings[notificationKey({ origin, targetType: 'channel', targetId: event.channelId })];
  if (!isRegisteredSelfId(event.userId)) {
    if (selectMyChosenStatus(useAuthStore.getState()) === 'dnd') return;
    if (Math.max(space?.mutedUntil ?? 0, channel?.mutedUntil ?? 0) > Date.now()) return;
    if ((channel?.level ?? space?.level) === 'nothing') return;
  }
  // The timeline already confirms the poke; only animate here, without a duplicate toast.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const avatars = document.querySelectorAll<HTMLElement>('[data-poke-user]');
  const avatar = Array.from(avatars).reverse().find(el => el.dataset.pokeUser === event.targetUserId);
  if (!avatar) return;
  avatar.animate([
    { transform: 'rotate(0deg)' }, { transform: 'rotate(-12deg) scale(0.94)' },
    { transform: 'rotate(10deg)' }, { transform: 'rotate(-6deg)' }, { transform: 'rotate(0deg)' },
  ], { duration: 550 });
  const finger = document.createElement('span');
  finger.textContent = '👈';
  finger.setAttribute('aria-hidden', 'true');
  finger.className = 'absolute -right-5 top-1 text-2xl pointer-events-none z-10';
  avatar.append(finger);
  const animation = finger.animate([{ transform: 'translateX(14px)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1, offset: 0.4 }, { transform: 'translateX(14px)', opacity: 0 }], { duration: 650 });
  animation.onfinish = () => finger.remove();
}
