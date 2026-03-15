import { isElectron } from './platform';

export function sendNotification(title: string, body: string): void {
  if (isElectron()) {
    window.backspace!.showNotification(title, body);
  } else if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/icons/icon-192.png' });
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
