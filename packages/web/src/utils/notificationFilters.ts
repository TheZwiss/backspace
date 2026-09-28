import type { UserStatus } from '@backspace/shared';
import { contentMentionsAny } from './mentionTokens';

/**
 * The rule that decides whether a freshly-arrived chat message alerts the user.
 * Pure; the caller supplies every id the user has (see `messageAlertsUser` in
 * utils/alerts.ts, which both outputs of the `message` alert kind go through).
 *
 * Rule (Discord-default):
 *   - Never for a message authored by self (any id in myIds).
 *   - For a DM, or for content with a `<@${id}>` mention of any id in myIds
 *     outside code (the shared scan in utils/mentionTokens.ts).
 *   - When allChannels=true, for every other message too. Only the in-app
 *     cue passes it: the "Play sound for every message" preference is a sound
 *     setting and does not widen the OS notification.
 */
export interface MessageAlertInput {
  authorUserId: string;
  myIds: ReadonlySet<string>;
  isDmChannel: boolean;
  content: string | null;
  allChannels: boolean;
}

export function isMessageAlert(input: MessageAlertInput): boolean {
  if (input.myIds.has(input.authorUserId)) return false;
  if (input.allChannels) return true;
  if (input.isDmChannel) return true;
  if (!input.content) return false;
  return contentMentionsAny(input.content, input.myIds);
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
