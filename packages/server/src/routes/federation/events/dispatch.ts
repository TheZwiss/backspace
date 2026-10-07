import { getDb } from '../../../db/index.js';
import { normalizeOriginForCompare } from '../../../utils/federationAuth.js';
import { hasAppliedEvent, recordAppliedEvent, relayEventKey } from '../../../utils/federationAppliedEvents.js';
import { and } from 'drizzle-orm';
import type { FederationRelayEvent } from '@backspace/shared';
import { processDmCallAcceptEvent, processDmCallEndEvent, processDmCallRejectEvent, processDmCallStartEvent, processDmTypingStartEvent, processDmTypingStopEvent } from './calls.js';
import { processCreateEvent, processDeleteEvent, processReactionAddEvent, processReactionRemoveEvent, processUpdateEvent } from './dmMessages.js';
import { processDmCloseEvent, processDmReopenEvent, processFileRejectedEvent, processPresenceUpdateEvent, processReadStateUpdateEvent } from './dmState.js';
import { processFriendAddEvent, processFriendRemoveEvent, processFriendRequestCancelEvent, processFriendRequestCreateEvent, processFriendRequestUpdateEvent } from './friends.js';
import { processGroupMetadataUpdateEvent, processMemberAddEvent, processMemberRemoveEvent, processOwnershipTransferEvent } from './membership.js';
import { processProfileUpdateEvent } from '../profile.js';

/**
 * How an event reached this instance.
 * - `live`: the peer's outbox sent it (`POST /api/federation/relay`).
 * - `catch_up`: this instance pulled it from the peer's mutation log
 *   (`utils/federationSync.ts`), or replays a pulled event it deferred. A
 *   pulled event is catch-up, not news: it raises no sound or notification on
 *   a client, so a message created this way is stored without a
 *   `dm_message_created` broadcast; clients see it when they next load the
 *   conversation.
 */
export type RelayDelivery = 'live' | 'catch_up';

export interface ProcessRelayOptions {
  delivery?: RelayDelivery;
}

/**
 * Event types applied through the ledger (`federation_applied_events`): a
 * friend event acts on whatever request or friendship the pair has NOW, so
 * applied a second time, after the users moved on (a request declined, a
 * friendship removed and formed again), it would act on a newer state. Each
 * event's `messageId` is unique per event and the same on the live relay and
 * the pull, so the ledger tells a second delivery apart and answers it
 * `duplicate`. See docs/systems/social.md, "Applied-event ledger".
 */
const LEDGERED_EVENT_TYPES = new Set<FederationRelayEvent['eventType']>([
  'friend_request_create',
  'friend_request_update',
  'friend_request_cancel',
  'friend_add',
  'friend_remove',
]);

/**
 * Process an array of federation relay events. Used by the HTTP relay endpoint
 * (`live`) and by the pull (`catch_up`), which skips the HTTP round-trip.
 */
export async function processRelayEvents(
  events: FederationRelayEvent[],
  sourceInstance: string,
  peerOrigin: string,
  db: ReturnType<typeof getDb>,
  options: ProcessRelayOptions = {},
): Promise<{
  accepted: string[];
  rejected: Array<{ messageId: string; reason: string }>;
  undeliverable: Array<{ messageId: string; reason: string }>;
}> {
  const accepted: string[] = [];
  const rejected: Array<{ messageId: string; reason: string }> = [];
  const undeliverable: Array<{ messageId: string; reason: string }> = [];

  // Structural invariant. Every per-event attribution check downstream reads
  // `sourceInstance` as if it were the signing peer, so the two MUST already be
  // the same instance. The HTTP boundary rejects a mismatched batch with 403
  // before it gets here; this re-assertion means no caller — present or future,
  // HTTP or in-process — can feed the pipeline a source the peer did not prove.
  if (normalizeOriginForCompare(sourceInstance) !== normalizeOriginForCompare(peerOrigin)) {
    console.error(`[federation-relay] Refusing batch: sourceInstance=${sourceInstance} is not the authenticated peer ${peerOrigin}`);
    for (const event of events) {
      rejected.push({ messageId: event.messageId, reason: 'source_peer_mismatch' });
    }
    return { accepted, rejected, undeliverable };
  }

  for (const event of events) {
    const ledgerKey = LEDGERED_EVENT_TYPES.has(event.eventType) ? relayEventKey(event.eventType, event.messageId) : null;
    if (ledgerKey && hasAppliedEvent(sourceInstance, ledgerKey, db)) {
      rejected.push({ messageId: event.messageId, reason: 'duplicate' });
      continue;
    }
    try {
      switch (event.eventType) {
        case 'create':
          await processCreateEvent(event, sourceInstance, peerOrigin, db, accepted, rejected, options.delivery ?? 'live');
          break;
        case 'update':
          processUpdateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'delete':
          processDeleteEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'reaction_add':
          processReactionAddEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'reaction_remove':
          processReactionRemoveEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'member_add':
          await processMemberAddEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'member_remove':
          processMemberRemoveEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'ownership_transfer':
          processOwnershipTransferEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_request_create':
          await processFriendRequestCreateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_request_update':
          processFriendRequestUpdateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_request_cancel':
          processFriendRequestCancelEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_add':
          await processFriendAddEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_remove':
          processFriendRemoveEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'file_rejected':
          processFileRejectedEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_call_start':
          processDmCallStartEvent(event, sourceInstance, db, accepted, rejected, undeliverable);
          break;
        case 'dm_call_accept':
          processDmCallAcceptEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_call_reject':
          processDmCallRejectEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_call_end':
          processDmCallEndEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_typing_start':
          processDmTypingStartEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_typing_stop':
          processDmTypingStopEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'profile_update':
          await processProfileUpdateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'group_metadata_update':
          await processGroupMetadataUpdateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'presence_update':
          processPresenceUpdateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'read_state_update':
          processReadStateUpdateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_close':
          processDmCloseEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_reopen':
          processDmReopenEvent(event, sourceInstance, db, accepted, rejected);
          break;
        default:
          rejected.push({ messageId: event.messageId, reason: 'unknown_event_type' });
          break;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'unknown_error';
      console.error('[federation-relay] Error processing event %s:', event.messageId, errMsg);
      rejected.push({ messageId: event.messageId, reason: 'processing_error' });
    }
    if (ledgerKey && accepted.includes(event.messageId)) {
      recordAppliedEvent(sourceInstance, ledgerKey, db);
    }
  }

  return { accepted, rejected, undeliverable };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
