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
 * A reason this build does not know (a newer receiver's) is `retry`: waiting
 * is safe, dropping or rolling back on a guess is not.
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
 * Event types whose `unknown_message` answer means the effect is already in
 * place: a delete of a message the receiver does not hold, or a reaction
 * removed from one. Receivers of this build accept those outright; an older
 * receiver still answers `unknown_message`, and the outbox only sends them
 * after the entity's earlier events are settled, so there is nothing to wait
 * for.
 */
const UNKNOWN_MESSAGE_TAKEN = new Set<string>(['delete', 'reaction_remove']);

export function classifyRejection(eventType: string | null, reason: string): RejectionOutcome {
  if (reason === 'duplicate') return 'taken';
  if (reason === 'unknown_message' && eventType !== null && UNKNOWN_MESSAGE_TAKEN.has(eventType)) return 'taken';
  if (REFUSED_REASONS.has(reason)) return 'refused';
  return 'retry';
}

/** Whether the sender stops delivering the event (`taken` or `refused`). */
export function isTerminalRejection(eventType: string | null, reason: string): boolean {
  return classifyRejection(eventType, reason) !== 'retry';
}
