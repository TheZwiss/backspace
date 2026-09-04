import type { MessageWithUser, User } from '@backspace/shared';
import { isSelf } from '../../utils/identity';

/**
 * Finds the newest text message the current user can open in the inline editor.
 * System messages and attachment-only messages are skipped. If the newest own
 * message is still optimistic, wait for the server copy instead of unexpectedly
 * opening an older message.
 */
export function findLastOwnEditableMessage(
  messages: readonly MessageWithUser[],
  currentUser: User | null,
): MessageWithUser | null {
  if (!currentUser) return null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.type === 'system' || !isSelf(message.user, currentUser)) continue;
    if (message.id.startsWith('temp_')) return null;
    if (message.content?.trim()) return message;
  }

  return null;
}
