import { getDb } from '../../../db/index.js';
import { and } from 'drizzle-orm';
import type { FederationRelayEvent } from '@backspace/shared';
import { processDmCallAcceptEvent, processDmCallEndEvent, processDmCallRejectEvent, processDmCallStartEvent, processDmTypingStartEvent, processDmTypingStopEvent } from './calls.js';
import { processCreateEvent, processDeleteEvent, processReactionAddEvent, processReactionRemoveEvent, processUpdateEvent } from './dmMessages.js';
import { processDmCloseEvent, processDmReopenEvent, processFileRejectedEvent, processPresenceUpdateEvent, processReadStateUpdateEvent } from './dmState.js';
import { processFriendAddEvent, processFriendRemoveEvent, processFriendRequestCancelEvent, processFriendRequestCreateEvent, processFriendRequestUpdateEvent } from './friends.js';
import { processGroupMetadataUpdateEvent, processMemberAddEvent, processMemberRemoveEvent, processOwnershipTransferEvent } from './membership.js';
import { processProfileUpdateEvent } from '../profile.js';

/**
 * Process an array of federation relay events. Used by the HTTP relay endpoint
 * and directly by the initial-sync worker (which skips the HTTP round-trip).
 */
export async function processRelayEvents(
  events: FederationRelayEvent[],
  sourceInstance: string,
  peerOrigin: string,
  db: ReturnType<typeof getDb>,
): Promise<{
  accepted: string[];
  rejected: Array<{ messageId: string; reason: string }>;
  undeliverable: Array<{ messageId: string; reason: string }>;
}> {
  const accepted: string[] = [];
  const rejected: Array<{ messageId: string; reason: string }> = [];
  const undeliverable: Array<{ messageId: string; reason: string }> = [];

  for (const event of events) {
    try {
      switch (event.eventType) {
        case 'create':
          await processCreateEvent(event, sourceInstance, peerOrigin, db, accepted, rejected);
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
      console.error(`[federation-relay] Error processing event ${event.messageId}:`, errMsg);
      rejected.push({ messageId: event.messageId, reason: 'processing_error' });
    }
  }

  return { accepted, rejected, undeliverable };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
