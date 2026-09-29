import type { UserStatus, NotificationSetting } from '@backspace/shared';
import { parseMentions } from '@backspace/shared/src/mentions';
import { contentMentionsAny } from './mentionTokens';

/**
 * The rule that decides whether a freshly-arrived chat message alerts the user.
 * Pure; the caller supplies every id the user has (see `messageAlertsUser` in
 * utils/alerts.ts, which both outputs of the `message` alert kind go through).
 *
 * Space/channel mute gates both outputs without touching unread state.
 * Channel level overrides space level. Without an explicit level, DMs and
 * mentions alert; allChannels widens only the legacy sound preference.
 * Space mention filters apply in mentions mode, never hide an explicit user ping.
 */
export interface MessageAlertInput {
  authorUserId: string;
  myIds: ReadonlySet<string>;
  isDmChannel: boolean;
  content: string | null;
  allChannels: boolean;
  spaceSetting?: NotificationSetting;
  channelSetting?: NotificationSetting;
  roleIds?: ReadonlySet<string>;
  now?: number;
}

export function isMessageAlert(input: MessageAlertInput): boolean {
  if (input.myIds.has(input.authorUserId)) return false;
  if (input.isDmChannel) return true;
  const { spaceSetting: space, channelSetting: channel } = input;
  const now = input.now ?? Date.now();
  // Space mute is an absolute gate, even for a channel with an explicit level.
  if ((space?.mutedUntil ?? 0) > now || (channel?.mutedUntil ?? 0) > now) return false;
  const level = channel?.level ?? space?.level ?? (input.allChannels ? 'all' : 'mentions');
  if (level === 'nothing') return false;
  if (level === 'all') return true;
  if (!input.content) return false;
  if (contentMentionsAny(input.content, input.myIds)) return true;
  const mentions = parseMentions(input.content);
  if (mentions.everyone && !space?.suppressEveryone) return true;
  return !space?.suppressRoles && [...mentions.roleIds].some(id => input.roleIds?.has(id));
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
