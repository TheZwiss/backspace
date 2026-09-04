import { HttpError } from '../api/client';

/**
 * Whether a failed join means the user is already in the space, which every
 * caller treats as success. The current server sends the `already_member`
 * code; a federated peer on an older version still sends only English text,
 * so the text match stays as the fallback for remote joins.
 */
export function isAlreadyMemberError(err: unknown): boolean {
  if (err instanceof HttpError && err.code) {
    return err.code === 'already_member';
  }
  return err instanceof Error && err.message.toLowerCase().includes('already a member');
}
