/**
 * What a relay rejection means, the one classification both directions use:
 * the outbox worker reading a peer's answer to a batch it sent, and the pull
 * (`utils/federationSync.ts`) reading this instance's own answer to an event
 * it pulled. See docs/systems/federation.md, "Rejection reasons".
 *
 * - `taken`: the receiver already has what the event would give it. The
 *   sender drops the event without rolling anything back; the pull counts it
 *   as applied.
 * - `refused`: the receiver will never apply this event. The sender drops it
 *   and runs the event type's rollback, if any (`utils/federationRollback.ts`);
 *   the pull drops it with a warning.
 * - `retry`: the receiver may apply it later, once something it waits for
 *   arrives (the conversation, the author, the proof of a homeward actor). The
 *   sender retries on its backoff until the row expires; the pull keeps it in
 *   `federation_sync_retry`.
 *
 * Every reason this build's processors give is listed below as refused or
 * retry. What an unlisted reason means depends on who gave it:
 * - the outbox reads a peer's answer, and an unlisted reason is a newer
 *   receiver's: `retry` (`classifyRejection`), since waiting until the row
 *   expires is safe and dropping or rolling back on a guess is not;
 * - the pull reads this instance's own answer, so an unlisted reason is one
 *   this build forgot to classify: `refused` with a warning
 *   (`classifyPulledRejection`), so it cannot park events for days.
 */
export type RejectionOutcome = 'taken' | 'refused' | 'retry';

/**
 * Reasons that end an event's delivery for good whatever its type.
 * `attribution_unproven` is deliberately absent: the proof it waits for comes
 * from the user's client.
 */
const REFUSED_REASONS = new Set<string>([
  'recipient_not_found',  // receiver doesn't know the target user
  'attribution_mismatch', // the source can never speak for this actor (third-instance, malformed, or no such user)
  'unknown_event_type',   // peer doesn't understand this eventType, and never will
  'self_target_invalid',  // payload's from-identity equals to-identity
  'not_message_author',   // relayed edit/delete names a message the actor did not write
  'system_message_immutable', // relayed edit names a system message, which cannot be edited
  'invalid_system_message',   // relayed system message that is not a well-formed relayable event
  'invalid_target',       // edit/delete/reaction target malformed or from a non-peer; 1-on-1 create or reaction by a non-member; group op on a 1-on-1; unacceptable bootstrap; friend_add answering no pending request
  'source_peer_mismatch', // the batch's claimed source is not the peer that signed it
  // The payload itself is malformed; sending it again sends the same payload.
  'invalid_payload',
  'invalid_status',
  'missing_participants',
  'missing_federated_id',
  'missing_message_payload',
  'missing_reaction_payload',
  'missing_membership_payload',
  'missing_ownership_payload',
  'missing_metadata_payload',
  'missing_friendship_payload',
  'missing_file_rejected_payload',
  'missing_profile_update_payload',
  'missing_presence_update_payload',
  'missing_read_state_payload',
  'missing_dm_close_payload',
  'missing_dm_reopen_payload',
  'missing_call_payload',
  'missing_typing_payload',
  // file_rejected names a message of the receiver's own that is gone, or an
  // attachment it does not have: nothing will bring either back.
  'message_not_found',
  'attachment_not_found',
]);

/**
 * Reasons that wait for something that can still arrive. A pulled event kept
 * for one of them is dropped after `SYNC_RETRY_MAX_AGE_MS`
 * (utils/federationSync.ts); the outbox retries it until the row expires.
 */
const RETRY_REASONS = new Set<string>([
  'channel_not_found',     // this instance's copy of the group is not bootstrapped yet (member_add)
  'participant_not_found', // a participant or member is not known here yet
  'author_not_found',      // the message author is not known here yet
  'user_not_found',        // the reacting or reading user is not known here yet
  'sender_not_found',      // the friend request's sender is not known here yet
  'actor_not_found',       // the metadata actor is not known here yet
  'attribution_unproven',  // the proof comes from the user's client
  'unknown_message',       // the message is not here yet; see UNKNOWN_MESSAGE_TAKEN, and the pull's own rule in federationSync.ts
  'unauthorized_source',   // the sender is not the conversation's owner instance here yet; a transfer may arrive
  'max_members_exceeded',  // a removal may free a place
  'processing_error',      // the processor threw; a transient failure passes
]);

/** Every reason this build classifies, for the test that keeps the lists complete. */
export const CLASSIFIED_REASONS: ReadonlySet<string> = new Set(['duplicate', ...REFUSED_REASONS, ...RETRY_REASONS]);

/**
 * Event types whose `unknown_message` answer means the effect is already in
 * place: a delete of a message the receiver does not hold, or a reaction
 * removed from one. Receivers of this build accept those outright; an older
 * receiver still answers `unknown_message`, and the outbox only sends them
 * after the entity's earlier events are settled, so there is nothing to wait
 * for.
 */
const UNKNOWN_MESSAGE_TAKEN = new Set<string>(['delete', 'reaction_remove']);

function classifyListed(eventType: string | null, reason: string): RejectionOutcome | null {
  if (reason === 'duplicate') return 'taken';
  if (reason === 'unknown_message' && eventType !== null && UNKNOWN_MESSAGE_TAKEN.has(eventType)) return 'taken';
  if (REFUSED_REASONS.has(reason)) return 'refused';
  if (RETRY_REASONS.has(reason)) return 'retry';
  return null;
}

/** A peer's answer to an event this instance sent (the outbox); an unlisted reason is `retry`. */
export function classifyRejection(eventType: string | null, reason: string): RejectionOutcome {
  return classifyListed(eventType, reason) ?? 'retry';
}

/** This instance's own answer to an event it pulled; an unlisted reason is `refused`. */
export function classifyPulledRejection(eventType: string | null, reason: string): RejectionOutcome {
  const outcome = classifyListed(eventType, reason);
  if (outcome !== null) return outcome;
  console.warn('[federation-sync] Unclassified rejection reason %s for %s; dropping the pulled event', reason, eventType ?? 'unknown');
  return 'refused';
}

/** Whether the sender stops delivering the event (`taken` or `refused`). */
export function isTerminalRejection(eventType: string | null, reason: string): boolean {
  return classifyRejection(eventType, reason) !== 'retry';
}
