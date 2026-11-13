import type { ChannelNotificationPolicy, UserStatus } from '@backspace/shared';
import { contentMentionsAny } from './mentionTokens';

/** What a message mentions, as the reader needs it to decide whether it mentions them. */
export interface MessageMentionInput {
  /** The reader's id on the instance that issued the channel. */
  myId: string | undefined;
  /** The reader's role ids in the channel's space on that instance; absent for a DM or an unread roster. */
  myRoleIds?: readonly string[];
  content: string | null;
  /**
   * The mass mention fields the instance hosting the space stamped on the
   * message (`Message.mentionEveryone`, `Message.mentionRoleIds`). Mass
   * mentions are read from these alone, never from the text: that instance
   * stamps only what it let an author with MENTION_EVERYONE send, and an
   * instance from before the permission stamps nothing.
   */
  mentionEveryone?: boolean;
  mentionRoleIds?: readonly string[];
}

/** How a message mentions its reader. Each is false when it does not. */
export interface MessageMentions {
  /** A `<@id>` token for the reader's id, outside code. */
  direct: boolean;
  /** A stamped `@everyone` or `@here`. */
  everyone: boolean;
  /** A stamped role the reader holds. */
  role: boolean;
}

/**
 * How a message mentions the reader: the rule the alert below and the
 * message highlight (`Message.tsx`) share. Documented in
 * docs/systems/sounds.md ("Which messages alert").
 */
export function messageMentions(input: MessageMentionInput): MessageMentions {
  const direct = !!input.content && !!input.myId && contentMentionsAny(input.content, new Set([input.myId]));
  const everyone = input.mentionEveryone === true;
  const stamped = input.mentionRoleIds ?? [];
  const role = stamped.length > 0 && (input.myRoleIds ?? []).some((id) => stamped.includes(id));
  return { direct, everyone, role };
}

/** Whether a message mentions the reader in any way: what the highlight shows. */
export function mentionsReader(input: MessageMentionInput): boolean {
  const m = messageMentions(input);
  return m.direct || m.everyone || m.role;
}

/**
 * The rule that decides whether a freshly-arrived chat message alerts the user.
 * Pure; the caller answers who wrote it, which id is the user's in that
 * channel and what the channel's notification settings are (see
 * `messageAlertsUser` in utils/alerts.ts, which both outputs of the `message`
 * alert kind go through). Documented in docs/systems/sounds.md ("Which
 * messages alert").
 *
 * Rule:
 *   - Never for a message the user wrote (`authoredBySelf`).
 *   - Always for a DM. Notification settings belong to spaces and channels
 *     and do not reach DMs.
 *   - For a space channel, by its notification policy:
 *     - muted (its own mute or its space's): never, mentions included;
 *     - `nothing`: never, mentions included;
 *     - `all`: every message;
 *     - `mentions`: a message that mentions the user (`messageMentions`):
 *       directly, by a stamped `@everyone` / `@here` unless the space's
 *       `suppressEveryone` is on, or by a stamped role they hold unless
 *       `suppressRoles` is on. The switches never hold back a direct mention.
 *       With `allChannels`, every message: only the in-app cue passes it,
 *       since the "Play sound for every message" preference is a sound
 *       setting and does not widen the OS notification. It widens `mentions`
 *       only, so it never overrides a channel the user set to `nothing` or
 *       muted.
 */
export interface MessageAlertInput extends MessageMentionInput {
  authoredBySelf: boolean;
  isDmChannel: boolean;
  allChannels: boolean;
  /** The channel's resolved settings (`resolveChannelNotificationPolicy`); not read for a DM. */
  notification: Pick<ChannelNotificationPolicy, 'level' | 'muted'> & Partial<Pick<ChannelNotificationPolicy, 'suppressEveryone' | 'suppressRoles'>>;
}

export function isMessageAlert(input: MessageAlertInput): boolean {
  if (input.authoredBySelf) return false;
  if (input.isDmChannel) return true;
  if (input.notification.muted) return false;
  switch (input.notification.level) {
    case 'nothing':
      return false;
    case 'all':
      return true;
    case 'mentions': {
      if (input.allChannels) return true;
      const m = messageMentions(input);
      return m.direct
        || (m.everyone && input.notification.suppressEveryone !== true)
        || (m.role && input.notification.suppressRoles !== true);
    }
  }
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
export type AlertKind = 'message' | 'incoming_call' | 'friend_request';

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
    case 'friend_request':
      return selfStatus !== 'dnd';
  }
}
