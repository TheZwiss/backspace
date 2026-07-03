import { isElectron } from './platform';
import { useUIStore } from '../stores/uiStore';

interface NotificationOptions {
  channelId?: string;
  spaceId?: string;
}

export function sendNotification(title: string, body: string, options?: NotificationOptions): void {
  if (isElectron()) {
    window.backspace!.showNotification(title, body);
  } else if ('Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(title, { body, icon: '/icons/icon-192.png' });
    notification.onclick = () => {
      window.focus();
      const { channelId, spaceId } = options ?? {};
      if (channelId) {
        const isMobile = useUIStore.getState().isMobile;
        if (isMobile) {
          useUIStore.getState().pushMobileScreen('channel-chat', {
            channelId,
            spaceId: spaceId || '@me',
          });
        }
      }
    };
  }
}

export function requestNotificationPermission(): Promise<boolean> {
  if (isElectron()) return Promise.resolve(true);
  if (!('Notification' in window)) return Promise.resolve(false);
  return Notification.requestPermission().then((p) => p === 'granted');
}

export function updateBadgeCount(count: number): void {
  if (isElectron()) {
    window.backspace!.setBadgeCount(count);
  }
}
