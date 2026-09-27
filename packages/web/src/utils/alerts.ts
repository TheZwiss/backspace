import type { ChosenUserStatus } from '@backspace/shared';
import { selectMyChosenStatus, useAuthStore } from '../stores/authStore';
import { AudioManager } from '../audio/AudioManager';
import { sendNotification, type NotificationOptions } from '../platform/notifications';
import { isAlertAllowed, type AlertKind } from './notificationFilters';
import { getSfxVolume } from './sfx';

/**
 * The only way the client raises an alert (see `AlertKind`). Both outputs, the
 * in-app cue and the OS notification, go through `alertsAllowed`, so a new
 * alert site cannot forget the Do Not Disturb rule and the rule cannot drift
 * between the sound and the notification. Documented in
 * docs/systems/sounds.md ("Do Not Disturb").
 */

const ALERT_SOUNDS: Record<AlertKind, string> = {
  message: 'message',
  incoming_call: 'call_ringing',
};

/**
 * The user's chosen status, from the account that owns it. Which account that
 * is, and why no other instance's view of the user counts, is stated in
 * activity-presence.md ("The client's copy of the user's own status").
 */
export function getSelfStatus(): ChosenUserStatus | null {
  return selectMyChosenStatus(useAuthStore.getState());
}

/** Read at alert time, so a status change applies to the next alert without re-subscribing. */
export function alertsAllowed(kind: AlertKind): boolean {
  return isAlertAllowed(kind, getSelfStatus());
}

/**
 * Plays the cue for an alert kind at the SFX volume. Resolves to null when the
 * gate withholds it, the same value `AudioManager.playSound` resolves to when a
 * cue cannot play, so looping callers need no extra branch.
 */
export function playAlertSound(
  kind: AlertKind,
  options: { loop?: boolean } = {},
): Promise<AudioBufferSourceNode | null> {
  if (!alertsAllowed(kind)) return Promise.resolve(null);
  return AudioManager.getInstance().playSound(ALERT_SOUNDS[kind], {
    loop: options.loop === true,
    volume: getSfxVolume(),
  });
}

/** Raises the OS notification for an alert kind, unless the gate withholds it. */
export function showAlertNotification(
  kind: AlertKind,
  title: string,
  body: string,
  options?: NotificationOptions,
): void {
  if (!alertsAllowed(kind)) return;
  sendNotification(title, body, options);
}
