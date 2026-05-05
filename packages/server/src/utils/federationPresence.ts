import { eq } from 'drizzle-orm';
import type { Activity, FederationRelayEvent, FederationPresenceUpdatePayload } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { getOurOrigin } from './federationAuth.js';
import { isFederationRelayEnabled, queueOutboxEvent } from './federationOutbox.js';

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

/**
 * Queue a presence_update event for the given native user. Broadcast to all
 * active peers (mirrors profile_update). Outbox-only — presence is ephemeral;
 * stale replays from a mutation log are wrong, so we never call
 * appendMutationLog. The peer-activation hook re-emits a fresh snapshot for
 * peer-related online natives, so a peer recovering from unreachable converges
 * without history replay.
 *
 * No-op for replicated users (their home instance owns presence projection).
 */
export function queuePresenceRelay(
  userId: string,
  status: PresenceStatus,
  activities: Activity[],
): void {
  if (!isFederationRelayEnabled()) return;

  const db = getDb();
  const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) return;
  if (user.homeInstance) return; // replicated — not our authority

  const ts = Date.now();
  const payload: FederationPresenceUpdatePayload = {
    homeUserId: user.id,
    homeInstance: getOurOrigin(),
    status,
    ts,
    ...(activities.length > 0 ? { activities } : {}),
  };

  const event: FederationRelayEvent = {
    eventType: 'presence_update',
    contextType: 'profile',
    messageId: `presence:${user.id}:${ts}`,
    encryptionVersion: 0,
    timestamp: ts,
    presenceUpdate: payload,
  };

  // entityId = userId so the outbox coalesces rapid status flaps into the latest.
  // contextId = userId, contextType = 'profile' (reuses existing routing).
  // targetPeerOrigins = undefined → broadcast to all active peers.
  // NO appendMutationLog — presence must not be replayed from history.
  queueOutboxEvent(
    user.id,
    user.id,
    'presence_update',
    JSON.stringify(event),
    undefined,
    'profile',
  );
}
