import { useEffect, useState } from 'react';
import { MUTED_FOREVER } from '@backspace/shared';
import { notificationKey, useNotificationStore, type NotificationTarget } from '../../stores/notificationStore';
import { useSpaceStore } from '../../stores/spaceStore';

/** Expiry updates the visual state without waiting for a new message or a reload. */
export function useNotificationMuted(target: NotificationTarget): boolean {
  const parentId = useSpaceStore(s => target.targetType === 'channel' ? s.channelToSpaceMap.get(target.targetId) : undefined);
  const ownUntil = useNotificationStore(s => s.settings[notificationKey(target)]?.mutedUntil ?? 0);
  const parentUntil = useNotificationStore(s => parentId ? s.settings[notificationKey({ origin: target.origin, targetType: 'space', targetId: parentId })]?.mutedUntil ?? 0 : 0);
  const until = Math.max(ownUntil, parentUntil);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (until <= Date.now() || until === MUTED_FOREVER) return;
    // Browsers clamp delays to signed 32-bit milliseconds; long mutes re-arm.
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(until - Date.now(), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [until, now]);
  return until > Math.max(now, Date.now());
}
