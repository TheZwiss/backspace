import { useExploreStore } from '../stores/exploreStore';
import { isJoinRequestPendingError } from './joinErrors';

/** What became of a join request sent from an invite: a new one, or one already waiting. */
export type InviteRequestOutcome = 'sent' | 'pending';

/**
 * Send the join request an invite to a space joined by request leads to,
 * through the same `POST /api/spaces/:id/request-join` the Explore page uses
 * (its rate limit and a manager's approval apply). A request the user
 * already has waiting answers `join_request_pending`, which is reported as
 * `'pending'` rather than thrown. Every other failure is thrown, including
 * `NotConnectedError` for a remote origin without a session.
 */
export async function sendInviteJoinRequest(
  spaceId: string,
  origin: string,
  message?: string,
): Promise<InviteRequestOutcome> {
  try {
    await useExploreStore.getState().requestJoinSpace(spaceId, origin, message);
    return 'sent';
  } catch (err) {
    if (isJoinRequestPendingError(err)) return 'pending';
    throw err;
  }
}
