import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Activity, FederationRelayEvent, FederationPresenceUpdatePayload, ReplicatedInstance } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { getOurOrigin } from './federationAuth.js';
import { isFederationRelayEnabled, queueOutboxEvent } from './federationOutbox.js';
import { collectProfileBroadcastTargetIds } from './userDeletion.js';
import { extractDomain } from '../routes/federation.js';

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

/**
 * On peer activation, send a fresh presence snapshot to the newly-active peer
 * for every online local native user that has an S2S relationship with that
 * peer (so the peer's stubs reflect current reality — presence is outbox-only,
 * no mutation-log replay can do this).
 *
 * Scope is bounded by relationship count, not native count. A native qualifies
 * if ANY of:
 *   - friend with at least one stub whose home_instance = peer domain
 *   - DM-member (closed=0) with at least one stub whose home_instance = peer domain
 *   - replicatedInstances JSON includes peerOrigin (explicit client-federation opt-in)
 *
 * Re-runs on every activation (including health-check unreachable→active flaps),
 * because markPeerStubsOffline ran on deactivation — peers and our stubs both
 * need a fresh handshake on recovery, not a stale-window-skip.
 */
export function snapshotPresenceForPeer(peerOrigin: string): void {
  if (!isFederationRelayEnabled()) return;

  const db = getDb();
  const peerDomain = extractDomain(peerOrigin);

  // 1. All stubs from this peer that exist locally.
  const peerStubIdList = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(
      eq(schema.users.homeInstance, peerDomain),
      eq(schema.users.isDeleted, 0),
    ))
    .all()
    .map((s) => s.id);
  const peerStubIds = new Set(peerStubIdList); // O(1) membership tests in the friend loop

  // 2. Build the set of native IDs related to those stubs (friends + DM co-members).
  const relatedNativeIds = new Set<string>();
  if (peerStubIdList.length > 0) {
    const friendRows = db.select().from(schema.friends)
      .where(or(
        inArray(schema.friends.userId, peerStubIdList),
        inArray(schema.friends.friendId, peerStubIdList),
      ))
      .all();
    for (const f of friendRows) {
      const stubSide = peerStubIds.has(f.userId) ? f.userId : f.friendId;
      const otherSide = stubSide === f.userId ? f.friendId : f.userId;
      relatedNativeIds.add(otherSide);
    }

    // Stub's DM memberships — filter closed=0 so DMs the stub left don't pull
    // their old co-members into snapshot scope.
    const stubDmIds = db.select({ dmChannelId: schema.dmMembers.dmChannelId })
      .from(schema.dmMembers)
      .where(and(
        inArray(schema.dmMembers.userId, peerStubIdList),
        eq(schema.dmMembers.closed, 0),
      ))
      .all()
      .map((d) => d.dmChannelId);
    if (stubDmIds.length > 0) {
      // Co-members — filter closed=0 so a native who closed the DM locally
      // doesn't receive snapshots for its lingering stub.
      const dmCoMembers = db.select({ userId: schema.dmMembers.userId })
        .from(schema.dmMembers)
        .where(and(
          inArray(schema.dmMembers.dmChannelId, stubDmIds),
          eq(schema.dmMembers.closed, 0),
        ))
        .all();
      for (const m of dmCoMembers) relatedNativeIds.add(m.userId);
    }
  }

  // 3. Add explicit client-federation opt-ins via replicatedInstances JSON.
  // (We can't index a JSON string in SQLite, so scan natives once and parse.)
  // SCALING NOTE: this full-natives scan is fine pre-launch and remains cheap
  // for instances under ~10k users. If population grows past that, replace with
  // a `user_replicated_instance_index` table populated when replicatedInstances
  // is written, indexed on (origin) for direct EXISTS lookup.
  const allNatives = db.select().from(schema.users)
    .where(and(
      isNull(schema.users.homeInstance),
      eq(schema.users.isDeleted, 0),
    ))
    .all();
  for (const u of allNatives) {
    if (!u.replicatedInstances) continue;
    try {
      const list = JSON.parse(u.replicatedInstances) as ReplicatedInstance[];
      if (list.some((ri) => ri.origin === peerOrigin)) relatedNativeIds.add(u.id);
    } catch { /* malformed JSON — skip */ }
  }

  // 4. Filter to online natives in the related set; emit one outbox event each.
  for (const u of allNatives) {
    if (!relatedNativeIds.has(u.id)) continue;
    if (!u.status || u.status === 'offline') continue;
    if (u.homeInstance) continue; // belt-and-braces: must be native

    const ts = Date.now();
    const event: FederationRelayEvent = {
      eventType: 'presence_update',
      contextType: 'profile',
      messageId: `presence:${u.id}:${ts}:snap`,
      encryptionVersion: 0,
      timestamp: ts,
      presenceUpdate: {
        homeUserId: u.id,
        homeInstance: getOurOrigin(),
        status: u.status as 'online' | 'idle' | 'dnd',
        ts,
      },
    };
    queueOutboxEvent(u.id, u.id, 'presence_update', JSON.stringify(event), [peerOrigin], 'profile');
  }
}

/**
 * On peer deactivation (status flipping out of 'active'), flip all replicated
 * stubs whose home is that peer to status='offline' and broadcast a local
 * presence_update so connected friends/DM-mates/space-co-members see them go
 * offline immediately.
 *
 * Imported lazily by onPeerDeactivated to avoid an import cycle through
 * ws/handler.js (connectionManager).
 *
 * Accepts an origin string; derives the bare domain via extractDomain so the
 * caller doesn't need to handle that detail.
 */
export async function markPeerStubsOffline(peerOrigin: string): Promise<void> {
  const peerDomain = extractDomain(peerOrigin);
  const db = getDb();
  const stubs = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(
      eq(schema.users.homeInstance, peerDomain),
      eq(schema.users.isDeleted, 0),
    ))
    .all();

  if (stubs.length === 0) return;

  // Lazy import keeps this module pure for tests that don't need ws/handler.
  const { connectionManager } = await import('../ws/handler.js');

  for (const stub of stubs) {
    db.update(schema.users)
      .set({ status: 'offline' })
      .where(eq(schema.users.id, stub.id))
      .run();

    const targets = collectProfileBroadcastTargetIds(stub.id);
    const payload = {
      type: 'presence_update' as const,
      userId: stub.id,
      status: 'offline' as const,
      activities: [] as Activity[],
    };
    for (const uid of targets) connectionManager.sendToUser(uid, payload);
  }
}
