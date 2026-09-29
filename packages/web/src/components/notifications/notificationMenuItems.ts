import { MUTED_FOREVER } from '@backspace/shared';
import i18n from '../../i18n';
import { describeError } from '../../i18n/errors';
import type { ContextMenuItem } from '../../stores/contextMenuStore';
import { useUIStore } from '../../stores/uiStore';
import { emptyNotificationSetting, notificationKey, useNotificationStore, type NotificationTarget } from '../../stores/notificationStore';

export function notificationMenuItems(target: NotificationTarget): ContextMenuItem[] {
  const setting = useNotificationStore.getState().settings[notificationKey(target)] ?? emptyNotificationSetting;
  const saveMute = async (mutedUntil: number | null) => {
    const current = useNotificationStore.getState().settings[notificationKey(target)] ?? emptyNotificationSetting;
    try {
      await useNotificationStore.getState().save(target, { ...current, mutedUntil });
    } catch (error) {
      useUIStore.getState().addToast(describeError(error), 'warning');
    }
  };
  const durations = [
    { label: i18n.t('spaces:notifications.minutes15'), duration: 15 * 60_000 },
    { label: i18n.t('spaces:notifications.hour1'), duration: 60 * 60_000 },
    { label: i18n.t('spaces:notifications.hours8'), duration: 8 * 60 * 60_000 },
    { label: i18n.t('spaces:notifications.forever'), duration: null },
  ];
  const mute: ContextMenuItem = (setting.mutedUntil ?? 0) > Date.now()
    ? { key: 'unmute', type: 'action', label: i18n.t('spaces:notifications.unmute'), onClick: () => { void saveMute(null); } }
    : { key: 'mute', type: 'submenu', label: i18n.t('spaces:notifications.mute'), children: durations.map(({ label, duration }) => ({
      key: 'mute-' + duration, type: 'action', label,
      onClick: () => { void saveMute(duration === null ? MUTED_FOREVER : Date.now() + duration); },
    })) };
  return [mute, { key: 'notification-settings', type: 'action', label: i18n.t('spaces:notifications.title'),
    onClick: () => useNotificationStore.getState().open(target) }];
}
