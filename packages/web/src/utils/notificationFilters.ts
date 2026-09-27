import type { UserStatus } from '@backspace/shared';

/**
 * Decides whether a freshly-arrived chat message should fire the in-app
 * `message.ogg` cue. Pure, federation-aware (matches against any of the
 * caller's known self-ids).
 *
 * Rule (Discord-default):
 *   - Suppress messages authored by self (any id in myIds).
 *   - When allChannels=true, fire for every non-self message.
 *   - Otherwise, fire only if the channel is a DM, or if the content contains
 *     a `<@${id}>` mention for any id in myIds.
 */
export interface ShouldPlayMessageSoundInput {
  authorUserId: string;
  myIds: Set<string>;
  isDmChannel: boolean;
  content: string | null;
  allChannels: boolean;
}

export function shouldPlayMessageSound(input: ShouldPlayMessageSoundInput): boolean {
  if (input.myIds.has(input.authorUserId)) return false;
  if (input.allChannels) return true;
  if (input.isDmChannel) return true;
  if (!input.content) return false;
  for (const id of input.myIds) {
    if (input.content.includes(`<@${id}>`)) return true;
  }
  return false;
}

/**
 * Attention-seeking alerts the client can raise on its own. Each kind covers
 * both of its outputs: the in-app cue and the OS notification.
 *
 * - `message`: `message.ogg` and the new-message OS notification.
 * - `incoming_call`: the `call_ringing.ogg` loop and the "is calling you" OS
 *   notification.
 *
 * Cues that answer the user's own action (mute, deafen, camera, join/leave,
 * watch/stop watching, the outgoing `call_calling` loop) and the unread badge
 * are not alerts and never pass through this gate.
 */
export type AlertKind = 'message' | 'incoming_call';

/**
 * The Do Not Disturb rule, in one place. `selfStatus` is the user's chosen
 * status as `selectMyChosenStatus` reads it (activity-presence.md, "The
 * client's copy of the user's own status"), never another user's presence.
 *
 * Do Not Disturb suppresses every alert kind. An unknown status (no user
 * loaded yet) does not suppress: the gate only withholds what the user asked
 * to withhold.
 */
export function isAlertAllowed(kind: AlertKind, selfStatus: UserStatus | null | undefined): boolean {
  switch (kind) {
    case 'message':
    case 'incoming_call':
      return selfStatus !== 'dnd';
  }
}
