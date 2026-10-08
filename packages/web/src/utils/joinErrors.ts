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

/**
 * Whether a failed join request means the user already has one waiting for
 * a manager. The invite surfaces show that as the request's state, not as a
 * failure.
 */
export function isJoinRequestPendingError(err: unknown): boolean {
  return err instanceof HttpError && err.code === 'join_request_pending';
}

/**
 * Whether a join request was refused because the space no longer takes
 * requests (`space_not_requestable`): its visibility changed after the
 * invite was read. The invite surfaces then join by the code, which follows
 * the space's current visibility.
 */
export function isNotRequestableError(err: unknown): boolean {
  return err instanceof HttpError && err.code === 'space_not_requestable';
}

/**
 * Thrown by `spaceStore.joinByCode` when the code belongs to a space joined
 * by request. The code admits no one there; the caller offers a join request
 * instead, sent to `spaceId` on `origin` (`''` for the page's instance). It
 * is the server's `join_request_required` refusal, so `describeError` still
 * has words for it on a surface that does not offer the request.
 */
export class JoinRequestRequiredError extends HttpError {
  constructor(source: HttpError, public readonly spaceId: string, public readonly origin: string) {
    super(source.status, source.message, source.body, 'join_request_required', source.details);
    this.name = 'JoinRequestRequiredError';
  }
}
