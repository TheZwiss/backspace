import type { DmSystemEvent } from '@backspace/shared';

/**
 * DM system messages on the server: the one place their content is written,
 * and the rule that they cannot be edited. The event shapes and the parser are
 * `@backspace/shared/src/dmSystemEvents`; the rules are in
 * docs/systems/dm-system.md, "System messages".
 */

/** The stored content of a system message. */
export function dmSystemContent(event: DmSystemEvent): string {
  return JSON.stringify(event);
}

/**
 * The name a system message records for a user at the time of the event: the
 * display name, else the handle without the `@<domain>` a replicated row
 * carries, else "Unknown" for a row that no longer exists.
 */
export function dmSystemName(user: { displayName: string | null; username: string } | null | undefined): string {
  if (!user) return 'Unknown';
  if (user.displayName) return user.displayName;
  const at = user.username.indexOf('@');
  const handle = at === -1 ? user.username : user.username.slice(0, at);
  return handle || 'Unknown';
}

/**
 * Why `editorId` may not edit the DM message `message`, or null when they may.
 * System messages cannot be edited, by anyone; any other message only by its
 * author. The REST and WebSocket edit paths both ask this.
 */
export function dmMessageEditRefusal(
  message: { userId: string; type: string | null },
  editorId: string,
): 'system_message_immutable' | 'not_message_author' | null {
  if (message.type === 'system') return 'system_message_immutable';
  if (message.userId !== editorId) return 'not_message_author';
  return null;
}
