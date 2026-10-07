import type { ChosenUserStatus } from '@backspace/shared';
import { getMyUserIdForOrigin, isMe, selectMyChosenStatus, useAuthStore } from '../stores/authStore';
import type { RealtimeMessageEvent } from '../stores/chatStore';
import { getChannelOrigin, isDmChannel } from '../stores/spaceStore';
import { AudioManager } from '../audio/AudioManager';
import { sendNotification, type NotificationOptions } from '../platform/notifications';
import { isAlertAllowed, isMessageAlert, type AlertKind } from './notificationFilters';
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
 * Whether a message that just arrived is a `message` alert: the one predicate
 * behind both of that kind's outputs, `message.ogg` (SoundController) and the
 * OS notification (NotificationController). Do Not Disturb is applied after
 * it, by `playAlertSound` and `showAlertNotification`.
 *
 * Who wrote it is `isMe` of its author as the channel's instance issued the
 * row. A mention of the user is `<@id>` with the id that instance gave them
 * (`getMyUserIdForOrigin`): on a remote instance's channel that is not the
 * home account's id.
 *
 * The channel is the event's `channelId`, the id `addRealtimeMessage` filed the
 * message under, which is authoritative for space and DM messages alike.
 *
 * `everyMessage` is the "Play sound for every message" preference. Only the
 * sound passes it; the notification stays on DMs and mentions.
 */
export function messageAlertsUser(
  event: RealtimeMessageEvent,
  options: { everyMessage?: boolean } = {},
): boolean {
  if (!event.channelId) return false;
  const origin = getChannelOrigin(event.channelId);
  return isMessageAlert({
    authoredBySelf: isMe(event.message.user ?? { id: event.message.userId }, origin),
    myId: getMyUserIdForOrigin(origin),
    isDmChannel: isDmChannel(event.channelId),
    content: event.message.content,
    allChannels: options.everyMessage === true,
  });
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
