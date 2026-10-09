import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { verifyJwt } from '../utils/auth.js';
import { getDb, schema } from '../db/index.js';
import { eq, and, or, inArray, desc, sql } from 'drizzle-orm';
import { handleClientEvent } from './events.js';
import { recordSocketAddress } from './socketAddress.js';
import { computePermissions, PermissionBits, permissionsToString } from '../utils/permissions.js';
import { idsHiddenFromEveryone } from '@backspace/shared/src/permissions.js';
import type {
  User,
  Space,
  SpaceWithChannelsAndMembers,
  MemberWithUser,
  Channel,
  ChannelCategory,
  DmChannel,
  ServerEvent,
  SpaceFolder,
  SpaceLayoutItem,
  ReadState,
  ActiveCallInfo,
  Activity,
  PresenceIdentity,
} from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';
import { batchInArray } from '../utils/sqlBatch.js';
import { loadOpenDmChannels } from '../utils/dmChannelWire.js';
import { collectProfileBroadcastTargetIds } from '../utils/userDeletion.js';
import { statusOnConnect, type StatusSourceRow } from '../utils/presenceStatus.js';
import { ownsChosenStatus, type ChosenUserStatus } from '@backspace/shared';
import { attachReplicaSessionHost, showReplicaStatusOnConnect, showReplicaStatusOnDisconnect, type ReplicaSessionHost } from './replicaPresence.js';
import { presenceIdentityOf, presenceUpdateFor, snapshotActivities } from './presenceEvent.js';
import { touchUserActivity, parseClientKind } from '../telemetry/activity.js';
import { isGroupConversation } from '../utils/dmConversation.js';
import { normalizeOriginForCompare } from '../utils/federationAuth.js';
import { utcDay } from '../telemetry/day.js';
import { memberRolesView, rolesForViewer } from '../utils/permissionDataView.js';

// ─── Heartbeat State ──────────────────────────────────────────────────────────
const wsIsAlive: WeakMap<WebSocket, boolean> = new WeakMap();
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

export const VOICE_RECONNECT_GRACE_MS = 60_000;
const MAX_PENDING_VOICE_RECONNECTS = 10_000;

export interface AuthenticatedSocket {
  ws: WebSocket;
  userId: string;
  username: string;
}

// ─── VoiceRoom Abstraction ─────────────────────────────────────────────────

export interface SpaceRoomMeta {
  type: 'space';
  spaceId: string;
}

export interface DmRoomMeta {
  type: 'dm';
  callerId: string;
  state: 'ringing' | 'active';
  /**
   * The call is in a group conversation (`isGroupConversation`). A group
   * member's end or decline removes only that member; in a 1-on-1 either
   * side ends the call (voice.md, "DM Call State Machine").
   */
  group: boolean;
  /** Members who declined while the call rang. Read only for group calls. */
  declinedUserIds: Set<string>;
  /**
   * Participants homed on a peer, added by a relayed accept: local row id to
   * the origin of the peer that relayed it. They are in `participants` like
   * any other member; this map lets a peer that goes away take them along.
   */
  remoteParticipants: Map<string, string>;
}

/** In-memory registry for federated calls on REMOTE instances. */
export interface FederatedCallEntry {
  dmChannelId: string | null;     // null for Path B (no local DM), late-bound when DM created mid-call
  federatedId: string;            // primary key — cross-instance stable
  callerId: string;               // local stub userId of the caller
  callerHomeUserId: string;
  federatedCallHost: string;      // peer origin of the host instance
  livekitUrl: string;
  tokens: Map<string, string>;    // local userId → LiveKit token minted for them (`callTokensByLocalUser`)
  ringedUserIds: string[];        // local userIds that received dm_call_incoming
  /**
   * Local users in the call through this instance (relayed accept to the
   * host). Each one's voice session is bound here, and a session lost past
   * its reconnect grace takes them out (`setFederatedCallLeaveHook`).
   */
  joinedUserIds: string[];
  /** A group conversation: a member's end or decline removes only that member. */
  group: boolean;
  state: 'ringing' | 'active';
  startedAt: number;
}

interface PendingVoiceReconnect {
  timeout: NodeJS.Timeout;
  roomId: string | null;
  federatedId: string | null;
}

export interface VoiceRoom {
  roomId: string;
  roomType: 'space' | 'dm';
  participants: Set<string>;
  metadata: SpaceRoomMeta | DmRoomMeta;
  startedAt: number;
}

/** Whole occupied seconds for the wire protocol; never exposes a server clock timestamp. */
export function getVoiceRoomElapsedSeconds(room: VoiceRoom, now = Date.now()): number {
  return Math.max(0, Math.floor((now - room.startedAt) / 1_000));
}

// ─── ConnectionManager ─────────────────────────────────────────────────────

class ConnectionManager implements ReplicaSessionHost {
  // userId → Set of WebSocket connections (multiple tabs)
  private connections: Map<string, Set<WebSocket>> = new Map();
  // userId → Set of space IDs the user belongs to
  private userSpaces: Map<string, Set<string>> = new Map();
  // ws → userId (reverse lookup)
  private wsToUser: Map<WebSocket, string> = new Map();
  // Unified voice room tracking (replaces voiceStates + activeCalls)
  private voiceRooms: Map<string, VoiceRoom> = new Map();
  // O(1) reverse index: userId → roomId
  private userToRoom: Map<string, string> = new Map();
  // userId → { isMuted, isDeafened, isCameraOn, isScreenSharing } — voice user status
  private voiceUserStates: Map<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }> = new Map();
  // userId → Timeout
  private pendingOfflineTimeouts: Map<string, NodeJS.Timeout> = new Map();
  // Voice has a longer grace than presence so a VPN/network handover can be
  // recovered by LiveKit without creating a visible leave/join cycle.
  // `roomId` is the room hosted here the session held; `federatedId` the call
  // hosted on a peer it held instead (`FederatedCallEntry.joinedUserIds`).
  private pendingVoiceReconnects: Map<string, PendingVoiceReconnect> = new Map();
  // roomId → Timeout for ringing DM rooms (60s auto-cleanup)
  private ringingTimeouts: Map<string, NodeJS.Timeout> = new Map();
  // Callback registered by events.ts to fan dm_call_end out to peers on ring timeout.
  // Null during startup — ring timeouts that fire before registration simply no-op (there are no peers to notify before boot completes).
  private ringTimeoutFanoutHook: ((dmChannelId: string, callerId: string) => Promise<void>) | null = null;
  // Callback registered by events.ts: a local user left a call hosted on a
  // peer without hanging up (voice session lost, account deleted). It takes
  // them out of the entry and tells the host. Null before registration.
  private federatedCallLeaveHook: ((userId: string) => void) | null = null;
  /** Federated calls where this instance is NOT the host. Keyed by federatedId. */
  private federatedCalls: Map<string, FederatedCallEntry> = new Map();
  private federatedCallTimeouts: Map<string, NodeJS.Timeout> = new Map();
  // Space-muted/deafened users (moderator action)
  private spaceMutedUsers: Set<string> = new Set(); // Stores spaceId:userId
  private spaceDeafenedUsers: Set<string> = new Set(); // Stores spaceId:userId
  // Permission-muted users (SPEAK permission revoked while in voice)
  private permissionMutedUsers: Set<string> = new Set(); // Stores spaceId:userId
  // The specific WebSocket that initiated voice_join / DM call for this user.
  // When THIS socket closes, voice cleanup enters the reconnect grace period.
  private voiceWs: Map<string, WebSocket> = new Map();
  // Per-user WebSocket rate limiters (shared across all tabs/connections)
  private userRateLimiters: Map<string, WsRateLimiter> = new Map();

  // ─── Rich Presence ──────────────────────────────────────────────────────
  // userId → Activity[] (ephemeral, same lifecycle as voiceUserStates)
  private userActivities: Map<string, Activity[]> = new Map();
  // userId → boolean (cached from DB at auth time, updated via REST)
  private userShowActivity: Map<string, boolean> = new Map();
  // userId → status string (cached at auth, updated on presence_update)
  private userStatuses: Map<string, string> = new Map();
  // userId → timestamp of last activity_update (rate limiting)
  private lastActivityUpdate: Map<string, number> = new Map();

  addConnection(userId: string, ws: WebSocket): void {
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }
    this.connections.get(userId)!.add(ws);
    this.wsToUser.set(ws, userId);

    // If they were pending offline, cancel it!
    this.cancelDisconnect(userId);
  }

  removeConnection(ws: WebSocket): string | undefined {
    const userId = this.wsToUser.get(ws);
    if (!userId) return undefined;

    this.wsToUser.delete(ws);
    const userConnections = this.connections.get(userId);
    if (userConnections) {
      userConnections.delete(ws);

      // Only the socket that owns voice starts the voice grace period. Closing
      // another tab must not disturb the active voice session.
      if (this.voiceWs.get(userId) === ws) {
        this.voiceWs.delete(userId);
        this.scheduleVoiceDisconnect(userId);
      }

      if (userConnections.size === 0) {
        this.connections.delete(userId);
        // Presence and voice have independent grace periods.
        this.scheduleDisconnect(userId);
      }
    }
    return userId;
  }

  private scheduleDisconnect(userId: string) {
    if (this.pendingOfflineTimeouts.has(userId)) return;

    const timeout = setTimeout(() => {
      this.finalizeDisconnect(userId);
      this.pendingOfflineTimeouts.delete(userId);
    }, 5000); // 5 second grace period

    this.pendingOfflineTimeouts.set(userId, timeout);
  }

  private cancelDisconnect(userId: string) {
    const timeout = this.pendingOfflineTimeouts.get(userId);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingOfflineTimeouts.delete(userId);
      console.log(`[ConnectionManager] Rescued session for user ${userId}`);
    }
  }

  private scheduleVoiceDisconnect(userId: string): void {
    this.cancelVoiceDisconnect(userId);
    const roomId = this.userToRoom.get(userId)
      ?? Array.from(this.voiceRooms).find(([, room]) =>
        room.roomType === 'dm'
        && (room.metadata as DmRoomMeta).state === 'ringing'
        && (room.metadata as DmRoomMeta).callerId === userId,
      )?.[0]
      ?? null;
    // A session with no room here may hold a call hosted on a peer, joined
    // through this instance. Its loss is that member's only leave signal.
    const federatedId = roomId === null ? this.getJoinedFederatedCall(userId)?.federatedId ?? null : null;
    if (!roomId && !federatedId) return;

    if (this.pendingVoiceReconnects.size >= MAX_PENDING_VOICE_RECONNECTS) {
      const oldest = this.pendingVoiceReconnects.entries().next().value as
        | [string, PendingVoiceReconnect]
        | undefined;
      if (oldest) {
        clearTimeout(oldest[1].timeout);
        this.pendingVoiceReconnects.delete(oldest[0]);
        this.finalizeVoiceDisconnect(oldest[0], oldest[1].roomId, oldest[1].federatedId);
      }
    }

    const timeout = setTimeout(() => {
      const pending = this.pendingVoiceReconnects.get(userId);
      if (!pending || pending.timeout !== timeout) return;
      this.pendingVoiceReconnects.delete(userId);
      if (!this.voiceWs.has(userId)) this.finalizeVoiceDisconnect(userId, pending.roomId, pending.federatedId);
    }, VOICE_RECONNECT_GRACE_MS);
    this.pendingVoiceReconnects.set(userId, { timeout, roomId, federatedId });
  }

  private cancelVoiceDisconnect(userId: string): void {
    const pending = this.pendingVoiceReconnects.get(userId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingVoiceReconnects.delete(userId);
  }

  private finalizeVoiceDisconnect(
    userId: string,
    expectedRoomId: string | null = null,
    expectedFederatedId: string | null = null,
  ): void {
    if (this.voiceWs.has(userId)) return;
    this.clearVoiceUserStatus(userId);

    // The session held a call hosted on a peer: the member leaves it as if
    // they had hung up, unless they already left it.
    if (expectedFederatedId !== null) {
      if (this.federatedCalls.get(expectedFederatedId)?.joinedUserIds.includes(userId)) {
        this.leaveFederatedCall(userId);
      }
      return;
    }

    const current = this.getUserRoom(userId);
    if (!expectedRoomId || current?.roomId === expectedRoomId) this.leaveCurrentRoomAnnounced(userId);

    for (const [roomId, room] of this.voiceRooms) {
      if (room.roomType !== 'dm') continue;
      const meta = room.metadata as DmRoomMeta;
      if (meta.state === 'ringing' && meta.callerId === userId
          && (!expectedRoomId || expectedRoomId === roomId)) {
        this.endDmRoom(roomId, 'dm_call_ended');
        this.fanOutCallEnd(roomId, userId);
      }
    }
  }

  /**
   * Publish the status of a connection for `row` that just authenticated and
   * return it. A row that owns its status shows its chosen one
   * (`statusOnConnect`); a replicated row's status is written by
   * `showReplicaStatusOnConnect` (ws/replicaPresence.ts).
   */
  publishConnectStatus(row: StatusSourceRow & { id: string }): ChosenUserStatus {
    if (!ownsChosenStatus(row)) return showReplicaStatusOnConnect(row);
    const status = statusOnConnect(row);
    getDb().update(schema.users).set({ status }).where(eq(schema.users.id, row.id)).run();
    return status;
  }

  /** A session of the user is open here, or its disconnect grace period runs. */
  hasSessionHere(userId: string): boolean {
    return this.isUserOnline(userId) || this.pendingOfflineTimeouts.has(userId);
  }

  private finalizeDisconnect(userId: string) {
    // Double check they are still offline
    if (this.isUserOnline(userId)) return;

    console.log(`[ConnectionManager] Finalizing disconnect for user ${userId}`);

    // A replicated row returns to its home's projection, or to 'offline' when
    // none is known (ws/replicaPresence.ts). The home owns its status, so
    // nothing is relayed, and relayed activities stay unless it is offline.
    const replica = showReplicaStatusOnDisconnect(userId);
    if (replica) {
      if (replica.status === 'offline') this.clearUserActivities(userId);
      if (replica.changed) {
        const payload = presenceUpdateFor(userId, replica.status, replica.status === 'offline' ? [] : undefined);
        for (const uid of collectProfileBroadcastTargetIds(userId)) this.sendToUser(uid, payload);
      }
      this.forgetSessionState(userId);
      return;
    }

    getDb().update(schema.users).set({ status: 'offline' }).where(eq(schema.users.id, userId)).run();

    // Clear activity state
    this.clearUserActivities(userId);

    // Broadcast offline to friends + DM co-members + space co-members.
    // Mirrors collectProfileBroadcastTargetIds (the recipient set used by
    // user_updated). Two locally-friended users with no shared space now see
    // each other's offline transitions live, instead of being space-only.
    const offlinePayload = presenceUpdateFor(userId, 'offline', []);
    const offlineTargets = collectProfileBroadcastTargetIds(userId);
    for (const uid of offlineTargets) this.sendToUser(uid, offlinePayload);

    // S2S: project offline to peers, as the profile_update broadcast (see queueOutboxEvent).
    // Imported lazily to avoid circular import (federationPresence → db → ws/handler).
    void import('../utils/federationPresence.js').then(({ queuePresenceRelay }) => {
      try { queuePresenceRelay(userId, 'offline', []); } catch (e) { console.warn('[ws] queuePresenceRelay(offline) failed', e); }
    });

    this.forgetSessionState(userId);
  }

  /** The per-session state a user's last disconnect drops. */
  private forgetSessionState(userId: string): void {
    this.userShowActivity.delete(userId);
    this.userStatuses.delete(userId);
    this.lastActivityUpdate.delete(userId);
    // userSpaces is re-populated on the next connect via setUserSpaces.
    this.userSpaces.delete(userId);
    this.userRateLimiters.delete(userId);
  }

  getUserConnections(userId: string): Set<WebSocket> {
    return this.connections.get(userId) ?? new Set();
  }

  isUserOnline(userId: string): boolean {
    const conns = this.connections.get(userId);
    return conns !== undefined && conns.size > 0;
  }

  getUserRateLimiter(userId: string): WsRateLimiter {
    let limiter = this.userRateLimiters.get(userId);
    if (!limiter) {
      limiter = new WsRateLimiter();
      this.userRateLimiters.set(userId, limiter);
    }
    return limiter;
  }

  // ─── Activity accessors ─────────────────────────────────────────────────

  setUserActivities(userId: string, activities: Activity[]): void {
    if (activities.length === 0) {
      this.userActivities.delete(userId);
    } else {
      this.userActivities.set(userId, activities);
    }
  }

  getUserActivities(userId: string): Activity[] {
    return this.userActivities.get(userId) ?? [];
  }

  clearUserActivities(userId: string): void {
    this.userActivities.delete(userId);
  }

  setUserShowActivity(userId: string, show: boolean): void {
    this.userShowActivity.set(userId, show);
  }

  getUserShowActivity(userId: string): boolean {
    return this.userShowActivity.get(userId) ?? true;
  }

  setUserStatus(userId: string, status: string): void {
    this.userStatuses.set(userId, status);
  }

  getUserStatus(userId: string): string {
    return this.userStatuses.get(userId) ?? 'offline';
  }

  checkActivityRateLimit(userId: string): boolean {
    const now = Date.now();
    const last = this.lastActivityUpdate.get(userId) ?? 0;
    if (now - last < 3000) return false;
    this.lastActivityUpdate.set(userId, now);
    return true;
  }

  setUserSpaces(userId: string, spaceIds: string[]): void {
    this.userSpaces.set(userId, new Set(spaceIds));
  }

  addUserSpace(userId: string, spaceId: string): void {
    if (!this.userSpaces.has(userId)) {
      this.userSpaces.set(userId, new Set());
    }
    this.userSpaces.get(userId)!.add(spaceId);

    // A user joining a space mid-session must be bootstrapped with that space's
    // current voice presence. The `ready` payload only carries voice state at
    // connect time (see buildReadyPayload), so without this push, members already
    // sitting in a voice channel stay invisible in the new member's channel
    // sidebar until a full page reload. `addUserSpace` is the single chokepoint
    // every join path funnels through (invite, public join, join-request
    // approval) and is NOT used on reconnect (that path uses setUserSpaces), so
    // this fires exactly once per genuine join. Space creation hits this too but
    // produces an empty snapshot, which is not sent.
    this.pushSpaceVoiceState(userId, spaceId);
  }

  /**
   * Send `userId` the voice presence of `spaceId` they can see now, as one
   * `space_voice_state` (`buildSpaceVoiceState`, VIEW_CHANNEL-filtered). It
   * rides the same ordered socket as the `voice_state_update` deltas, so a
   * join or leave after it arrives after it. Nothing is sent when the user has
   * no connection or the snapshot is empty (no one in voice, no restriction).
   */
  pushSpaceVoiceState(userId: string, spaceId: string): void {
    if (this.getUserConnections(userId).size === 0) return;
    const snapshot = this.buildSpaceVoiceState(spaceId, userId);
    if (Object.keys(snapshot.voiceStates).length === 0
        && Object.keys(snapshot.spaceVoiceStates).length === 0) {
      return;
    }
    this.sendToUser(userId, {
      type: 'space_voice_state',
      spaceId,
      voiceStates: snapshot.voiceStates,
      voiceChannelElapsedSeconds: snapshot.voiceChannelElapsedSeconds,
      voiceUserStates: snapshot.voiceUserStates,
      spaceVoiceStates: snapshot.spaceVoiceStates,
    });
  }

  /**
   * After a change to the space's roles or to a member's roles
   * (websocket.md, `space_access_changed`): every connected member of the
   * space is told, and refetches the space's detail. The detail has no voice
   * presence, so each member in `affectedUserIds` (whose own permissions may
   * have changed) is then sent the voice state they can see now
   * (`pushSpaceVoiceState`); a voice channel they just gained shows who is in
   * it at once.
   */
  announceSpaceAccessChange(spaceId: string, affectedUserIds: Iterable<string>): void {
    this.sendToSpace(spaceId, { type: 'space_access_changed', spaceId });
    for (const userId of new Set(affectedUserIds)) {
      if (this.getUserSpaces(userId).has(spaceId)) this.pushSpaceVoiceState(userId, spaceId);
    }
  }

  /**
   * After a change to one user's own permissions in each of `spaceIds` that
   * no other member's view depends on (an instance admin promoted or demoted:
   * websocket.md, `space_access_changed`). Only that user is told, with one
   * `space_access_changed` per space on each of their connections, and is
   * then sent the voice state they can see there now (`pushSpaceVoiceState`).
   */
  announceUserAccessChange(userId: string, spaceIds: Iterable<string>): void {
    if (this.getUserConnections(userId).size === 0) return;
    for (const spaceId of new Set(spaceIds)) {
      this.sendToUser(userId, { type: 'space_access_changed', spaceId });
      this.pushSpaceVoiceState(userId, spaceId);
    }
  }

  getUserSpaces(userId: string): Set<string> {
    return this.userSpaces.get(userId) ?? new Set();
  }

  /**
   * Build the current voice-presence snapshot for a single space, from the
   * perspective of `userId`:
   * - which voice channels the user can VIEW have participants, and who they are,
   * - each participant's per-user status (mute/deafen/camera/screenshare),
   * - space-level mute/deafen (persisted) + permission-mute (ephemeral)
   *   restrictions, keyed `spaceId:userId`.
   *
   * Voice presence is VIEW_CHANNEL-filtered per `computePermissions` exactly as
   * `buildReadyPayload` does — a user must never learn who is sitting in a voice
   * channel they cannot see.
   *
   * Single source of truth shared by `buildReadyPayload` (connect-time bootstrap,
   * looped across all of a user's spaces) and `addUserSpace` (mid-session join
   * push). Keep these two consumers in sync by changing only this method.
   */
  buildSpaceVoiceState(spaceId: string, userId: string): {
    voiceStates: Record<string, string[]>;
    voiceChannelElapsedSeconds: Record<string, number>;
    voiceUserStates: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>;
    spaceVoiceStates: Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted: boolean }>;
  } {
    const db = getDb();
    const voiceStates: Record<string, string[]> = {};
    const voiceChannelElapsedSeconds: Record<string, number> = {};
    const voiceUserStates: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }> = {};
    const spaceVoiceStates: Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted: boolean }> = {};

    // Who is currently in each of this space's voice channels the user can VIEW.
    const voiceChannels = db.select({ id: schema.channels.id })
      .from(schema.channels)
      .where(and(eq(schema.channels.spaceId, spaceId), eq(schema.channels.type, 'voice')))
      .all();
    for (const ch of voiceChannels) {
      const chPerms = computePermissions(userId, spaceId, ch.id);
      const hasView = (chPerms & PermissionBits.VIEW_CHANNEL) !== 0n || (chPerms & PermissionBits.ADMINISTRATOR) !== 0n;
      if (!hasView) continue;
      const room = this.getRoom(ch.id);
      if (room && room.participants.size > 0) {
        const ids = Array.from(room.participants);
        voiceStates[ch.id] = ids;
        voiceChannelElapsedSeconds[ch.id] = getVoiceRoomElapsedSeconds(room);
        for (const uid of ids) {
          const status = this.getVoiceUserStatus(uid);
          if (status) voiceUserStates[uid] = status;
        }
      }
    }

    // Space mute/deafen — persisted, authoritative (survives reconnect). These are
    // space-level flags (they do not reveal which channel a user is in), so they
    // are not channel-filtered, mirroring buildReadyPayload.
    const restrictions = db.select()
      .from(schema.voiceRestrictions)
      .where(eq(schema.voiceRestrictions.spaceId, spaceId))
      .all();
    for (const r of restrictions) {
      const key = `${r.spaceId}:${r.userId}`;
      const existing = spaceVoiceStates[key] ?? { spaceMuted: false, spaceDeafened: false, permissionMuted: false };
      if (r.restrictionType === 'mute') existing.spaceMuted = true;
      if (r.restrictionType === 'deafen') existing.spaceDeafened = true;
      spaceVoiceStates[key] = existing;
    }
    // Permission-mute — ephemeral, derived from in-memory state for every
    // participant currently in this space's voice rooms (mirrors buildReadyPayload).
    for (const [, room] of this.voiceRooms) {
      if (room.roomType !== 'space') continue;
      const meta = room.metadata as SpaceRoomMeta;
      if (meta.spaceId !== spaceId) continue;
      for (const participantId of room.participants) {
        if (this.isPermissionMuted(spaceId, participantId)) {
          const key = `${spaceId}:${participantId}`;
          const existing = spaceVoiceStates[key] ?? { spaceMuted: false, spaceDeafened: false, permissionMuted: false };
          existing.permissionMuted = true;
          spaceVoiceStates[key] = existing;
        }
      }
    }

    return { voiceStates, voiceChannelElapsedSeconds, voiceUserStates, spaceVoiceStates };
  }

  // ─── Unified VoiceRoom API ─────────────────────────────────────────────────

  /** Create a room. Returns false if room already exists. */
  createRoom(roomId: string, roomType: 'space' | 'dm', metadata: SpaceRoomMeta | DmRoomMeta): boolean {
    if (this.voiceRooms.has(roomId)) return false;
    this.voiceRooms.set(roomId, {
      roomId,
      roomType,
      participants: new Set(),
      metadata,
      startedAt: Date.now(),
    });
    return true;
  }

  /**
   * Register the fan-out callback for a DM call this instance ends on its own:
   * the 60s ring timeout, the last participant's voice grace running out, or
   * the participants of a peer that went away. It relays `dm_call_end` to the
   * peers so their ringing and joined members leave the call too.
   */
  setRingTimeoutFanoutHook(fn: (dmChannelId: string, callerId: string) => Promise<void>): void {
    this.ringTimeoutFanoutHook = fn;
  }

  /**
   * Relay `dm_call_end` for a call this instance ended to every peer with a
   * member in it. `endedByUserId` must be a local user this instance speaks
   * for (the caller, or the local member whose action ended the call): a peer
   * refuses an end attributed to a user homed on another instance.
   */
  fanOutCallEnd(dmChannelId: string, endedByUserId: string): void {
    if (!this.ringTimeoutFanoutHook) return;
    this.ringTimeoutFanoutHook(dmChannelId, endedByUserId).catch(err =>
      console.error('[ws] call-end fan-out error:', err),
    );
  }

  /**
   * Register the callback that takes a local user out of the call hosted on
   * a peer they joined through this instance, and tells the host, when they
   * leave it without hanging up.
   */
  setFederatedCallLeaveHook(fn: (userId: string) => void): void {
    this.federatedCallLeaveHook = fn;
  }

  /** `userId` left the call hosted on a peer they joined through here. */
  leaveFederatedCall(userId: string): void {
    this.federatedCallLeaveHook?.(userId);
  }

  /** The call hosted on a peer that `userId` joined through this instance. */
  getJoinedFederatedCall(userId: string): FederatedCallEntry | undefined {
    for (const entry of this.federatedCalls.values()) {
      if (entry.joinedUserIds.includes(userId)) return entry;
    }
    return undefined;
  }

  /**
   * Take `userId` out of the room they are in, unless it is `keepRoomId`,
   * and tell whoever sees that room. A DM call they leave empty ends, and the
   * end is relayed to the peers in the name of its caller, who is homed here.
   * Returns the room left, if any.
   */
  leaveCurrentRoomAnnounced(userId: string, keepRoomId?: string): { roomId: string; room: VoiceRoom } | null {
    if (keepRoomId !== undefined && this.userToRoom.get(userId) === keepRoomId) return null;
    const left = this.leaveCurrentRoom(userId);
    if (!left) return null;
    if (left.room.roomType === 'space') {
      const meta = left.room.metadata as SpaceRoomMeta;
      this.sendToSpace(meta.spaceId, {
        type: 'voice_state_update', channelId: left.roomId, userId, action: 'leave',
      });
    } else if (this.afterDmCallLeave(left.roomId, userId) === 'ended') {
      this.fanOutCallEnd(left.roomId, (left.room.metadata as DmRoomMeta).callerId);
    }
    return left;
  }

  /**
   * End every DM call hosted here that `userId` placed and that still rings,
   * except `exceptRoomId`: the user started another call or joined voice, and
   * holds one call at a time. Each end goes to the DM members and is relayed
   * to the peers in the caller's name, so members ringing on other instances
   * stop ringing too.
   */
  endRingingCallsPlacedBy(userId: string, exceptRoomId?: string): void {
    for (const [roomId, room] of Array.from(this.voiceRooms)) {
      if (room.roomType !== 'dm' || roomId === exceptRoomId) continue;
      const meta = room.metadata as DmRoomMeta;
      if (meta.state !== 'ringing' || meta.callerId !== userId) continue;
      this.endDmRoom(roomId, 'dm_call_ended');
      this.fanOutCallEnd(roomId, userId);
    }
  }

  /** Create a DM room in ringing state with 60s auto-cleanup. */
  createDmRoom(dmChannelId: string, callerId: string): boolean {
    const row = getDb().select({ ownerId: schema.dmChannels.ownerId, federatedId: schema.dmChannels.federatedId })
      .from(schema.dmChannels)
      .where(eq(schema.dmChannels.id, dmChannelId))
      .get();
    const created = this.createRoom(dmChannelId, 'dm', {
      type: 'dm',
      callerId,
      state: 'ringing',
      group: row ? isGroupConversation({ owner_id: row.ownerId, federated_id: row.federatedId }) : false,
      declinedUserIds: new Set(),
      remoteParticipants: new Map(),
    });
    if (!created) return false;

    // 60s ringing timeout: nobody but the caller joined, so the call ends.
    const timeout = setTimeout(() => {
      this.ringingTimeouts.delete(dmChannelId);
      const room = this.voiceRooms.get(dmChannelId);
      if (room && room.roomType === 'dm' && (room.metadata as DmRoomMeta).state === 'ringing') {
        const ringedCallerId = (room.metadata as DmRoomMeta).callerId;
        this.endDmRoom(dmChannelId, 'dm_call_ended');
        // Fan dm_call_end out to remote peers so stranded Path-A/B ringees exit the ring.
        // Without this, an accept-relay failure → Alice's 60s auto-clean leaves Bob's FederatedCallEntry lingering with no terminal event.
        this.fanOutCallEnd(dmChannelId, ringedCallerId);
      }
    }, 60_000);
    this.ringingTimeouts.set(dmChannelId, timeout);

    return true;
  }

  /**
   * End a DM call hosted here: unbind the voice sessions it holds, destroy the
   * room, tell the DM members that each participant left, then send `kind`
   * (`dm_call_ended`, or `dm_call_rejected` for a call every ringee declined).
   * Local only: the caller relays `dm_call_end` to the peers. Returns false
   * when there is no such room.
   */
  endDmRoom(dmChannelId: string, kind: 'dm_call_ended' | 'dm_call_rejected'): boolean {
    const room = this.voiceRooms.get(dmChannelId);
    if (!room || room.roomType !== 'dm') return false;
    const meta = room.metadata as DmRoomMeta;
    const participants = Array.from(room.participants);
    // The caller of a ringing call holds no seat but owns the voice binding,
    // unless they have since joined some other room.
    const callerRoom = this.userToRoom.get(meta.callerId);
    if (callerRoom === undefined || callerRoom === dmChannelId) this.clearVoiceWs(meta.callerId);
    for (const participantId of participants) {
      this.clearVoiceUserStatus(participantId);
      this.clearVoiceWs(participantId);
    }
    this.destroyRoom(dmChannelId);
    for (const participantId of participants) {
      this.sendToDmMembers(dmChannelId, {
        type: 'voice_state_update', channelId: dmChannelId, userId: participantId, action: 'leave',
      });
    }
    this.sendToDmMembers(dmChannelId, { type: kind, dmChannelId });
    return true;
  }

  /**
   * After `userId` left the DM call `dmChannelId` (already out of its
   * participants): tell the DM members, and end the call when it is active
   * and nobody is left in it. Returns 'ended' when the call ended, so the
   * caller relays the end to the peers.
   */
  afterDmCallLeave(dmChannelId: string, userId: string): 'left' | 'ended' {
    const room = this.voiceRooms.get(dmChannelId);
    if (room && room.roomType === 'dm') (room.metadata as DmRoomMeta).remoteParticipants.delete(userId);
    this.sendToDmMembers(dmChannelId, {
      type: 'voice_state_update', channelId: dmChannelId, userId, action: 'leave',
    });
    if (room && room.roomType === 'dm' && room.participants.size === 0
        && (room.metadata as DmRoomMeta).state === 'active') {
      this.endDmRoom(dmChannelId, 'dm_call_ended');
      return 'ended';
    }
    return 'left';
  }

  /**
   * A member hangs up or cancels a group call hosted here (`dm_call_end`,
   * local or relayed). The caller of a call nobody has joined yet ends it;
   * a participant leaves it, and the call ends with the last one out; anyone
   * else is not in the call and changes nothing.
   */
  leaveGroupDmCall(dmChannelId: string, userId: string): 'ignored' | 'left' | 'ended' {
    const room = this.voiceRooms.get(dmChannelId);
    if (!room || room.roomType !== 'dm') return 'ignored';
    const meta = room.metadata as DmRoomMeta;
    if (meta.state === 'ringing' && meta.callerId === userId) {
      this.endDmRoom(dmChannelId, 'dm_call_ended');
      return 'ended';
    }
    if (!room.participants.has(userId)) return 'ignored';
    this.leaveRoom(dmChannelId, userId);
    this.clearVoiceUserStatus(userId);
    this.clearVoiceWs(userId);
    return this.afterDmCallLeave(dmChannelId, userId);
  }

  /**
   * A member declines a group call hosted here (`dm_call_reject`, local or
   * relayed). The decliner stops ringing; the call goes on for everyone else.
   * When the call is still ringing and every member but the caller has
   * declined, nobody is left to answer and it ends as rejected. The caller
   * and participants cannot decline. Membership is the caller's to check.
   */
  declineGroupDmCall(dmChannelId: string, userId: string): 'ignored' | 'declined' | 'ended' {
    const room = this.voiceRooms.get(dmChannelId);
    if (!room || room.roomType !== 'dm') return 'ignored';
    const meta = room.metadata as DmRoomMeta;
    if (meta.callerId === userId || room.participants.has(userId)) return 'ignored';
    meta.declinedUserIds.add(userId);
    if (meta.state !== 'ringing') return 'declined';
    const ringees = getDb().select({ userId: schema.dmMembers.userId })
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
      .all()
      .filter(m => m.userId !== meta.callerId);
    if (ringees.some(m => !meta.declinedUserIds.has(m.userId))) return 'declined';
    this.endDmRoom(dmChannelId, 'dm_call_rejected');
    return 'ended';
  }

  /**
   * Take every participant that `peerOrigin` relayed into the DM call
   * `dmChannelId` (`remoteParticipants`) out of it, as when that peer can no
   * longer tell us they left. Returns how many left and whether the call
   * ended because nobody is left. Local only: the caller relays the end.
   */
  leavePeerParticipants(dmChannelId: string, peerOrigin: string): { removed: number; ended: boolean } {
    const peerKey = normalizeOriginForCompare(peerOrigin);
    const room = this.voiceRooms.get(dmChannelId);
    if (peerKey === null || !room || room.roomType !== 'dm') return { removed: 0, ended: false };
    const meta = room.metadata as DmRoomMeta;
    let removed = 0;
    for (const [userId, origin] of Array.from(meta.remoteParticipants)) {
      if (normalizeOriginForCompare(origin) !== peerKey) continue;
      this.leaveRoom(dmChannelId, userId);
      removed += 1;
      if (this.afterDmCallLeave(dmChannelId, userId) === 'ended') return { removed, ended: true };
    }
    return { removed, ended: false };
  }

  /**
   * A peer stopped being active: the participants it relayed into calls
   * hosted here can no longer tell us they left, so they leave now. A call
   * left empty ends, and the end is relayed to the remaining peers in the
   * caller's name. Returns how many participants were removed.
   */
  dropRemoteCallParticipants(peerOrigin: string): number {
    let removed = 0;
    for (const [roomId, room] of Array.from(this.voiceRooms)) {
      if (room.roomType !== 'dm') continue;
      const callerId = (room.metadata as DmRoomMeta).callerId;
      const result = this.leavePeerParticipants(roomId, peerOrigin);
      removed += result.removed;
      if (result.ended) this.fanOutCallEnd(roomId, callerId);
    }
    return removed;
  }

  /** Transition a DM room from ringing → active. Returns false if not found or not ringing. */
  activateDmRoom(dmChannelId: string): boolean {
    const room = this.voiceRooms.get(dmChannelId);
    if (!room || room.roomType !== 'dm') return false;
    const meta = room.metadata as DmRoomMeta;
    if (meta.state !== 'ringing') return false;
    meta.state = 'active';

    // Clear ringing timeout
    const timeout = this.ringingTimeouts.get(dmChannelId);
    if (timeout) {
      clearTimeout(timeout);
      this.ringingTimeouts.delete(dmChannelId);
    }
    return true;
  }

  /**
   * Register a federated call received via S2S, with its 60 s ring window.
   * A call still ringing when the window closes ends here. One answered by
   * then is dropped silently if nobody here is in it any more
   * (`dropFederatedCallIfIdle`).
   */
  createFederatedCall(entry: FederatedCallEntry): void {
    this.clearFederatedCall(entry.federatedId);
    this.federatedCalls.set(entry.federatedId, entry);

    const timeout = setTimeout(() => {
      this.federatedCallTimeouts.delete(entry.federatedId);
      const call = this.federatedCalls.get(entry.federatedId);
      if (call && call.state === 'active') {
        this.dropFederatedCallIfIdle(entry.federatedId);
        return;
      }
      if (call && call.state === 'ringing') {
        this.federatedCalls.delete(entry.federatedId);
        const endEvent = {
          type: 'dm_call_ended',
          dmChannelId: call.dmChannelId,
          federatedCallId: call.federatedId,
        };
        for (const uid of call.ringedUserIds) {
          this.sendToUser(uid, endEvent as ServerEvent);
        }
      }
    }, 60_000);
    this.federatedCallTimeouts.set(entry.federatedId, timeout);
  }

  /** Get a federated call entry by federatedId (primary lookup). */
  getFederatedCall(federatedId: string): FederatedCallEntry | undefined {
    return this.federatedCalls.get(federatedId);
  }

  /** Get a federated call entry by local dmChannelId (convenience reverse lookup). */
  getFederatedCallByDmChannel(dmChannelId: string): FederatedCallEntry | undefined {
    for (const entry of this.federatedCalls.values()) {
      if (entry.dmChannelId === dmChannelId) return entry;
    }
    return undefined;
  }

  /**
   * Transition a federated call from ringing → active. The ring window keeps
   * running: members here who were rung may still answer until it closes.
   */
  activateFederatedCall(federatedId: string): boolean {
    const call = this.federatedCalls.get(federatedId);
    if (!call || call.state !== 'ringing') return false;
    call.state = 'active';
    return true;
  }

  /**
   * `userId` is no longer in the call hosted on a peer (`joinedUserIds`): they
   * hung up, or left it without hanging up. The record goes once it can no
   * longer matter (`dropFederatedCallIfIdle`).
   */
  leaveFederatedCallEntry(federatedId: string, userId: string): void {
    const entry = this.federatedCalls.get(federatedId);
    if (!entry) return;
    entry.joinedUserIds = entry.joinedUserIds.filter(id => id !== userId);
    this.dropFederatedCallIfIdle(federatedId);
  }

  /**
   * Drop the record of a call hosted on a peer that can no longer matter: it
   * was answered, nobody here is in it, and its ring window has closed, so no
   * member here can still answer it. Without this, a record whose final end
   * from the host never came (a lost relay, or a host up to 1.8.0 that ends
   * some calls without telling its peers) stayed until a restart. Silent:
   * nobody here holds the call, and a member in it through another instance
   * must not be told it ended.
   */
  dropFederatedCallIfIdle(federatedId: string): void {
    const entry = this.federatedCalls.get(federatedId);
    if (!entry || entry.state !== 'active' || entry.joinedUserIds.length > 0) return;
    if (this.federatedCallTimeouts.has(federatedId)) return;
    this.clearFederatedCall(federatedId);
  }

  /** Remove a federated call entry and clear its timeout. */
  clearFederatedCall(federatedId: string): void {
    // The members still in the call are out of it now; the voice sessions
    // it held are no longer anyone's call.
    for (const userId of this.federatedCalls.get(federatedId)?.joinedUserIds ?? []) {
      if (!this.userToRoom.has(userId)) this.clearVoiceWs(userId);
    }
    this.federatedCalls.delete(federatedId);
    const timeout = this.federatedCallTimeouts.get(federatedId);
    if (timeout) {
      clearTimeout(timeout);
      this.federatedCallTimeouts.delete(federatedId);
    }
  }

  /**
   * Evict all FederatedCallEntry objects whose federatedCallHost matches the given peer origin.
   * Emits dm_call_undeliverable { phase: 'host_unreachable', terminal: true } to each entry's
   * ringedUserIds, then clears the entry (and its 60s ring timer if still armed).
   *
   * Idempotent: re-invocation with an already-evicted host returns 0.
   * Called from onPeerDeactivated (signal 1) and the 30s sentinel (signal 2 / backstop).
   */
  evictFederatedCallsForHost(
    peerOrigin: string,
    ctx: {
      reason: 'peer_transient_failure' | 'peer_rejected';
      peerLabel?: string;
    },
  ): number {
    const matches: FederatedCallEntry[] = [];
    for (const entry of this.federatedCalls.values()) {
      if (entry.federatedCallHost === peerOrigin) matches.push(entry);
    }
    if (matches.length === 0) return 0;

    let evicted = 0;
    for (const entry of matches) {
      // Re-check — concurrent teardown may have removed it between collect and broadcast.
      if (!this.federatedCalls.has(entry.federatedId)) continue;

      const event: ServerEvent = {
        type: 'dm_call_undeliverable',
        dmChannelId: entry.dmChannelId,
        federatedCallId: entry.federatedId,
        terminal: true,
        phase: 'host_unreachable',
        failures: [{
          reason: ctx.reason,
          peerOrigin,
          peerLabel: ctx.peerLabel,
        }],
      };

      for (const uid of entry.ringedUserIds) {
        this.sendToUser(uid, event);
      }

      this.clearFederatedCall(entry.federatedId);
      evicted += 1;
    }

    return evicted;
  }

  /** Late-bind a dmChannelId onto a Path B FederatedCallEntry. */
  lateBindFederatedCall(federatedId: string, dmChannelId: string): void {
    const call = this.federatedCalls.get(federatedId);
    if (call && call.dmChannelId === null) {
      call.dmChannelId = dmChannelId;
    }
  }

  /** Expose federated calls for ready payload assembly. */
  getAllFederatedCalls(): Map<string, FederatedCallEntry> {
    return this.federatedCalls;
  }

  /** Add a user to a room. Enforces one-room-per-user invariant. Returns the room or null if room doesn't exist. */
  joinRoom(roomId: string, userId: string): VoiceRoom | null {
    const room = this.voiceRooms.get(roomId);
    if (!room) return null;

    // Enforce one-room-per-user invariant: silently remove from old room
    const currentRoomId = this.userToRoom.get(userId);
    if (currentRoomId && currentRoomId !== roomId) {
      const oldRoom = this.voiceRooms.get(currentRoomId);
      if (oldRoom) {
        oldRoom.participants.delete(userId);
        if (oldRoom.participants.size === 0 && oldRoom.roomType === 'space') {
          this.voiceRooms.delete(currentRoomId);
        }
      }
    }

    room.participants.add(userId);
    this.userToRoom.set(userId, roomId);
    return room;
  }

  /** Remove a user from a specific room. Returns the room or null if not found. */
  leaveRoom(roomId: string, userId: string): VoiceRoom | null {
    const room = this.voiceRooms.get(roomId);
    if (!room || !room.participants.has(userId)) return null;

    room.participants.delete(userId);
    this.userToRoom.delete(userId);
    
    if (room.roomType === 'space') {
      const meta = room.metadata as SpaceRoomMeta;
      this.clearSpaceVoiceState(meta.spaceId, userId);
    }

    // Auto-cleanup empty space rooms (they're lazy-created)
    if (room.participants.size === 0 && room.roomType === 'space') {
      this.voiceRooms.delete(roomId);
    }

    return room;
  }

  /** Leave whatever room the user is in. Returns { roomId, room } or null. */
  leaveCurrentRoom(userId: string): { roomId: string; room: VoiceRoom } | null {
    const roomId = this.userToRoom.get(userId);
    if (!roomId) return null;

    const room = this.leaveRoom(roomId, userId);
    if (!room) return null;

    return { roomId, room };
  }

  /** Destroy a room entirely. Returns displaced userIds. */
  destroyRoom(roomId: string): string[] {
    const room = this.voiceRooms.get(roomId);
    if (!room) return [];

    const displaced: string[] = [];
    for (const userId of room.participants) {
      this.userToRoom.delete(userId);
      this.cancelVoiceDisconnect(userId);
      displaced.push(userId);
    }

    if (room.roomType === 'dm') {
      this.cancelVoiceDisconnect((room.metadata as DmRoomMeta).callerId);
    }

    this.voiceRooms.delete(roomId);

    // Clear ringing timeout if any
    const timeout = this.ringingTimeouts.get(roomId);
    if (timeout) {
      clearTimeout(timeout);
      this.ringingTimeouts.delete(roomId);
    }

    return displaced;
  }

  /** Get a room by ID. */
  getRoom(roomId: string): VoiceRoom | undefined {
    return this.voiceRooms.get(roomId);
  }

  /** Get participants in a room. */
  getRoomParticipants(roomId: string): Set<string> {
    return this.voiceRooms.get(roomId)?.participants ?? new Set();
  }

  /** Get the room a user is currently in. Returns { roomId, room } or null. */
  getUserRoom(userId: string): { roomId: string; room: VoiceRoom } | null {
    const roomId = this.userToRoom.get(userId);
    if (!roomId) return null;
    const room = this.voiceRooms.get(roomId);
    if (!room) return null;
    return { roomId, room };
  }

  /** Read-only access to all rooms. */
  getAllRooms(): Map<string, VoiceRoom> {
    return this.voiceRooms;
  }

  // ─── Voice User Status (unchanged) ────────────────────────────────────────

  setVoiceUserStatus(userId: string, isMuted: boolean, isDeafened: boolean, isCameraOn: boolean, isScreenSharing: boolean): void {
    this.voiceUserStates.set(userId, { isMuted, isDeafened, isCameraOn, isScreenSharing });
  }

  getVoiceUserStatus(userId: string): { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean } | undefined {
    return this.voiceUserStates.get(userId);
  }

  clearVoiceUserStatus(userId: string): void {
    this.voiceUserStates.delete(userId);
  }

  // ─── Voice WebSocket Binding ───────────────────────────────────────────────

  /** Store which ws owns the voice session for this user. */
  setVoiceWs(userId: string, ws: WebSocket): void {
    this.cancelVoiceDisconnect(userId);
    this.voiceWs.set(userId, ws);
  }

  /** Get the voice-owning ws for this user. */
  getVoiceWs(userId: string): WebSocket | undefined {
    return this.voiceWs.get(userId);
  }

  /** Clear the voice ws binding for this user. */
  clearVoiceWs(userId: string): void {
    this.cancelVoiceDisconnect(userId);
    this.voiceWs.delete(userId);
  }

  setSpaceMuted(spaceId: string, userId: string, muted: boolean): void {
    const key = `${spaceId}:${userId}`;
    if (muted) this.spaceMutedUsers.add(key);
    else this.spaceMutedUsers.delete(key);
  }

  isSpaceMuted(spaceId: string, userId: string): boolean {
    return this.spaceMutedUsers.has(`${spaceId}:${userId}`);
  }

  setSpaceDeafened(spaceId: string, userId: string, deafened: boolean): void {
    const key = `${spaceId}:${userId}`;
    if (deafened) this.spaceDeafenedUsers.add(key);
    else this.spaceDeafenedUsers.delete(key);
  }

  isSpaceDeafened(spaceId: string, userId: string): boolean {
    return this.spaceDeafenedUsers.has(`${spaceId}:${userId}`);
  }

  clearSpaceVoiceState(spaceId: string, userId: string): void {
    this.spaceMutedUsers.delete(`${spaceId}:${userId}`);
    this.spaceDeafenedUsers.delete(`${spaceId}:${userId}`);
    this.permissionMutedUsers.delete(`${spaceId}:${userId}`);
  }

  setPermissionMuted(spaceId: string, userId: string, muted: boolean): void {
    const key = `${spaceId}:${userId}`;
    if (muted) this.permissionMutedUsers.add(key);
    else this.permissionMutedUsers.delete(key);
  }

  isPermissionMuted(spaceId: string, userId: string): boolean {
    return this.permissionMutedUsers.has(`${spaceId}:${userId}`);
  }

  getAllVoiceUserStates(): Map<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }> {
    return this.voiceUserStates;
  }

  // ─── Broadcasting ─────────────────────────────────────────────────────────

  /** Send to a specific user (all their connections). */
  sendToUser(userId: string, event: ServerEvent): void {
    const connections = this.getUserConnections(userId);
    const message = JSON.stringify(event);
    for (const ws of connections) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(message);
      }
    }
  }

  /** Send to all members of a space. */
  sendToSpace(spaceId: string, event: ServerEvent, excludeUserId?: string): void {
    const message = JSON.stringify(event);
    for (const [userId, spaceIds] of this.userSpaces) {
      if (spaceIds.has(spaceId) && userId !== excludeUserId) {
        const connections = this.getUserConnections(userId);
        for (const ws of connections) {
          if (ws.readyState === 1) {
            ws.send(message);
          }
        }
      }
    }
  }

  /** Send to space members who have VIEW_CHANNEL on the given channel. */
  sendToChannel(spaceId: string, channelId: string, event: ServerEvent, excludeUserId?: string): void {
    const message = JSON.stringify(event);
    for (const [userId, spaceIds] of this.userSpaces) {
      if (spaceIds.has(spaceId) && userId !== excludeUserId) {
        const perms = computePermissions(userId, spaceId, channelId);
        if ((perms & PermissionBits.VIEW_CHANNEL) !== 0n) {
          const connections = this.getUserConnections(userId);
          for (const ws of connections) {
            if (ws.readyState === 1) {
              ws.send(message);
            }
          }
        }
      }
    }
  }

  /** Expose userSpaces iterator for pre-delete viewer collection. */
  getUserSpaceEntries(): IterableIterator<[string, Set<string>]> {
    return this.userSpaces.entries();
  }

  /** Send to all DM channel members (queries dm_members table). */
  sendToDmMembers(dmChannelId: string, event: ServerEvent, excludeUserId?: string): void {
    const db = getDb();
    const dmMembers = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
      .all();

    for (const member of dmMembers) {
      if (member.userId !== excludeUserId) {
        this.sendToUser(member.userId, event);
      }
    }
  }

  /** Send event to users who were ringed for a federated call.
   *  ALWAYS uses ringedUserIds, never sendToDmMembers — sendToDmMembers would
   *  also reach the caller's replicated stub, causing cross-instance event contamination
   *  (the caller's multi-instance WS gets dm_call_accepted with the wrong dmChannelId). */
  sendToFederatedCallUsers(federatedId: string, event: ServerEvent, excludeUserId?: string): void {
    const call = this.federatedCalls.get(federatedId);
    if (!call) return;
    for (const uid of call.ringedUserIds) {
      if (uid !== excludeUserId) {
        this.sendToUser(uid, event);
      }
    }
  }

  /** Send to a room — routes to sendToSpace (space rooms) or sendToDmMembers (DM rooms). */
  sendToRoom(roomId: string, event: ServerEvent, excludeUserId?: string): void {
    const room = this.voiceRooms.get(roomId);
    if (!room) return;

    if (room.roomType === 'space') {
      const meta = room.metadata as SpaceRoomMeta;
      this.sendToSpace(meta.spaceId, event, excludeUserId);
    } else {
      this.sendToDmMembers(roomId, event, excludeUserId);
    }
  }

  /** Send to all connections of all online users. */
  sendToAll(event: ServerEvent, excludeUserId?: string): void {
    const message = JSON.stringify(event);
    for (const [userId, connections] of this.connections) {
      if (userId !== excludeUserId) {
        for (const ws of connections) {
          if (ws.readyState === 1) {
            ws.send(message);
          }
        }
      }
    }
  }

  /** Send to a specific WebSocket instance (not all of a user's connections). */
  sendToWs(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(JSON.stringify(event));
    }
  }

  /** Force-disconnect all WebSocket connections for a user (e.g. account deletion). */
  forceDisconnectUser(userId: string): void {
    // Cancel any pending offline timeout
    const timeout = this.pendingOfflineTimeouts.get(userId);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingOfflineTimeouts.delete(userId);
    }

    // Leave the voice room they are in. This is a leave like any other: a
    // DM call it empties ends, and the end reaches the peers. A call hosted
    // on a peer that they joined through here is left as if they hung up.
    this.clearVoiceUserStatus(userId);
    this.clearVoiceWs(userId);
    this.leaveCurrentRoomAnnounced(userId);
    if (this.getJoinedFederatedCall(userId)) this.leaveFederatedCall(userId);

    // End any ringing DM rooms where this user is the caller
    for (const [roomId, room] of this.voiceRooms) {
      if (room.roomType === 'dm') {
        const meta = room.metadata as DmRoomMeta;
        if (meta.state === 'ringing' && meta.callerId === userId) {
          this.endDmRoom(roomId, 'dm_call_ended');
          this.fanOutCallEnd(roomId, userId);
        }
      }
    }

    // Clear activity state
    this.clearUserActivities(userId);
    this.userShowActivity.delete(userId);
    this.userStatuses.delete(userId);
    this.lastActivityUpdate.delete(userId);

    // Close all WebSocket connections
    const connections = this.connections.get(userId);
    if (connections) {
      for (const ws of connections) {
        this.wsToUser.delete(ws);
        try { ws.close(4001, 'Account deleted'); } catch { /* ignore */ }
      }
      this.connections.delete(userId);
    }

    // Clean up user spaces
    this.userSpaces.delete(userId);
  }

  getAllOnlineUserIds(): string[] {
    return Array.from(this.connections.keys());
  }

  getAllConnections(): Map<string, Set<WebSocket>> {
    return this.connections;
  }

  /** Send an event to all connected admin users. */
  sendToAdmins(event: ServerEvent): void {
    const db = getDb();
    for (const userId of this.connections.keys()) {
      const user = db.select({ isAdmin: schema.users.isAdmin })
        .from(schema.users).where(eq(schema.users.id, userId)).get();
      if (user?.isAdmin === 1) {
        this.sendToUser(userId, event);
      }
    }
  }
}

export const connectionManager = new ConnectionManager();
attachReplicaSessionHost(connectionManager);

// The pong path runs every 30 seconds per socket, so a database that keeps
// refusing this write would flood the log at one line per socket per pong. One
// line per hour is the compromise: quiet enough that a persistent fault does
// not bury everything else, loud enough that an outage lasting a week stays
// visible for the whole week. A one-shot flag was the earlier form and it went
// permanently silent after the first failure, so an outage that began before
// anyone looked left no trace at all.
const ACTIVITY_WARN_INTERVAL_MS = 60 * 60 * 1000;
let activityWarnedAt = 0;

/**
 * The last UTC day each live connection recorded activity for.
 *
 * Keyed on the socket, so it dies with the socket and holds nothing across
 * reconnects. `touchUserActivity` already refuses to rewrite a row that holds
 * today, so this memo changes no stored value; what it avoids is the round
 * trip. Without it an `UPDATE` runs for every socket on every pong, which on an
 * instance holding a few hundred desktop clients open is constant write-lock
 * churn on `users` for a column that moves once a day.
 *
 * A miss is always safe: a connection with no memo simply writes, and the
 * statement's own predicate makes that a no-op when the day is already there.
 */
const activityDayByConnection: WeakMap<object, string> = new WeakMap();

/**
 * Day-coarse activity for the opt-in telemetry counts. `authMessage` is the
 * parsed auth message on the auth path (its optional `client` field names the
 * client kind) and null on a heartbeat pong, which touches the day only.
 *
 * A failed write is swallowed: this bookkeeping is optional, and it runs on the
 * auth path (where a throw would look like a rejected token) and inside the
 * 'pong' listener (where an uncaught throw would take the process down).
 *
 * `connection` is the socket, used as the key of a per-connection memo of the
 * day already recorded. Given, a pong that has already recorded today returns
 * without touching the database. Omitted, every call writes.
 */
export function recordConnectionActivity(
  userId: string,
  authMessage: Record<string, unknown> | null,
  now: Date,
  connection?: object,
): void {
  const today = utcDay(now);
  // The auth path is never skipped: it carries the client kind, which can
  // differ from what the row holds even on a day already recorded. Only the
  // pong path, which touches the day and nothing else, has anything to skip.
  if (authMessage === null && connection !== undefined
    && activityDayByConnection.get(connection) === today) {
    return;
  }
  try {
    const db = getDb();
    if (authMessage) {
      touchUserActivity(db, userId, today, parseClientKind(authMessage.client));
    } else {
      touchUserActivity(db, userId, today);
    }
    // Recorded only after the write did not throw, so a failing database is
    // retried on the next pong rather than memoised as done.
    if (connection !== undefined) activityDayByConnection.set(connection, today);
  } catch (err) {
    const at = now.getTime();
    if (activityWarnedAt === 0 || at - activityWarnedAt >= ACTIVITY_WARN_INTERVAL_MS) {
      activityWarnedAt = at;
      console.warn(`[ws] could not record activity: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─── WebSocket Rate Limiter (Token Bucket) ─────────────────────────────────

class WsRateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second
  private lastRefill: number;

  constructor(maxTokens = 30, refillRate = 2) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  consume(): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/** The `ready` payload for `userId`: everything a client needs to start, sent once per connection. */
export function buildReadyPayload(userId: string): {
  user: User;
  spaces: SpaceWithChannelsAndMembers[];
  dmChannels: DmChannel[];
  folders: SpaceFolder[];
  spaceLayout: SpaceLayoutItem[] | null;
  layoutUpdatedAt: number | null;
  voiceStates: Record<string, string[]>;
  voiceChannelElapsedSeconds: Record<string, number>;
  voiceUserStates: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>;
  spaceVoiceStates: Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted: boolean }>;
  supportsPoke: boolean;
  readStates: ReadState[];
  activeCalls: ActiveCallInfo[];
  userActivities: Record<string, Activity[]>;
  userActivityIdentities: Record<string, PresenceIdentity>;
  rejectedPeerOrigins: string[];
  awaitingApprovalPeerOrigins: string[];
  activePeerOrigins: string[];
  pendingApprovalCount: number;
} {
  const db = getDb();

  // Get user
  const userRow = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!userRow) {
    throw new Error('User not found');
  }
  const user = sanitizeUser(userRow, true);
  const isFederated = !!userRow.homeInstance;

  // Cache showActivity and status for Rich Presence
  connectionManager.setUserShowActivity(userId, userRow.showActivity !== 0);
  connectionManager.setUserStatus(userId, (userRow.status ?? 'offline') as string);

  // Get user's space memberships
  const memberships = db.select()
    .from(schema.spaceMembers)
    .where(eq(schema.spaceMembers.userId, userId))
    .all();

  const spaceIds = memberships.map(m => m.spaceId);

  const visibleChannelIdSet = new Set<string>();
  const spaces: SpaceWithChannelsAndMembers[] = [];

  if (spaceIds.length > 0) {
    const spaceRows = db.select()
      .from(schema.spaces)
      .where(inArray(schema.spaces.id, spaceIds))
      .all();

    // Batch: all channels for all spaces (1 query instead of N)
    const allChannels = batchInArray(
      spaceIds,
      ids => db.select().from(schema.channels).where(inArray(schema.channels.spaceId, ids)).all(),
    );
    const channelsBySpace = new Map<string, (typeof allChannels)>();
    for (const ch of allChannels) {
      let arr = channelsBySpace.get(ch.spaceId);
      if (!arr) { arr = []; channelsBySpace.set(ch.spaceId, arr); }
      arr.push(ch);
    }

    // Batch: which channels are private (`isHiddenFromEveryone`). The @everyone
    // role id equals the space id, so only overrides on a role whose id is one
    // of these spaces are read, each against the space of its own channel.
    const channelSpaceIds = new Map(allChannels.map((ch) => [ch.id, ch.spaceId]));
    const privateChannelIds = idsHiddenFromEveryone(
      batchInArray(
        spaceIds,
        ids => db.select().from(schema.channelOverrides).where(
          and(
            eq(schema.channelOverrides.targetType, 'role'),
            inArray(schema.channelOverrides.targetId, ids),
          )
        ).all(),
      ),
      (o) => o.channelId,
      (channelId) => channelSpaceIds.get(channelId),
    );

    // Batch: all categories for all spaces (1 query instead of N)
    const allCategories = batchInArray(
      spaceIds,
      ids => db.select().from(schema.channelCategories).where(inArray(schema.channelCategories.spaceId, ids)).all(),
    );
    // Batch: which categories are private, read the same way as channels.
    const categorySpaceIds = new Map(allCategories.map((cat) => [cat.id, cat.spaceId]));
    const privateCategoryIds = idsHiddenFromEveryone(
      batchInArray(
        spaceIds,
        ids => db.select().from(schema.categoryOverrides).where(
          and(
            eq(schema.categoryOverrides.targetType, 'role'),
            inArray(schema.categoryOverrides.targetId, ids),
          )
        ).all(),
      ),
      (o) => o.categoryId,
      (categoryId) => categorySpaceIds.get(categoryId),
    );
    const categoriesBySpace = new Map<string, ChannelCategory[]>();
    for (const cat of allCategories) {
      let arr = categoriesBySpace.get(cat.spaceId);
      if (!arr) { arr = []; categoriesBySpace.set(cat.spaceId, arr); }
      arr.push({
        id: cat.id,
        spaceId: cat.spaceId,
        name: cat.name,
        position: cat.position ?? 0,
        isPrivate: privateCategoryIds.has(cat.id),
        createdAt: cat.createdAt,
      });
    }

    // Batch: last message ID per channel (1 query instead of N×C)
    const allChannelIds = allChannels.map(ch => ch.id);
    const lastMsgMap = new Map<string, string>();
    if (allChannelIds.length > 0) {
      const lastMsgRows = batchInArray(
        allChannelIds,
        ids => db.select({
          channelId: schema.messages.channelId,
          lastId: sql<string>`max(${schema.messages.id})`,
        }).from(schema.messages).where(and(inArray(schema.messages.channelId, ids), eq(schema.messages.type, 'user'))).groupBy(schema.messages.channelId).all(),
      );
      for (const row of lastMsgRows) {
        if (row.lastId) lastMsgMap.set(row.channelId, row.lastId);
      }
    }

    for (const spaceRow of spaceRows) {
      const channels = channelsBySpace.get(spaceRow.id) ?? [];

      const roles = db.select()
        .from(schema.roles)
        .where(eq(schema.roles.spaceId, spaceRow.id))
        .orderBy(schema.roles.position)
        .all();

      const memberRows = db.select()
        .from(schema.spaceMembers)
        .where(eq(schema.spaceMembers.spaceId, spaceRow.id))
        .all();

      const memberUserIds = memberRows.map(m => m.userId);
      const users = memberUserIds.length > 0
        ? batchInArray(memberUserIds, ids => db.select().from(schema.users).where(inArray(schema.users.id, ids)).all())
        : [];
      const userMap = new Map(users.map(u => [u.id, u]));

      const memberRoleRows = db.select()
        .from(schema.memberRoles)
        .where(eq(schema.memberRoles.spaceId, spaceRow.id))
        .all();

      const members: MemberWithUser[] = memberRows
        .map(m => {
          const u = userMap.get(m.userId);
          if (!u) return null;

          const assignedRoleIds = new Set(memberRoleRows
            .filter(mr => mr.userId === m.userId)
            .map(mr => mr.roleId));

          return {
            spaceId: m.spaceId,
            userId: m.userId,
            nickname: m.nickname,
            joinedAt: m.joinedAt,
            user: sanitizeUser(u),
            roles: memberRolesView(roles, assignedRoleIds),
          };
        })
        .filter((m): m is MemberWithUser => m !== null);

      // Compute space-level permissions for this user
      const spacePerms = computePermissions(userId, spaceRow.id);

      // Filter channels by VIEW_CHANNEL and attach per-channel permissions
      const visibleChannels: Channel[] = [];
      for (const ch of channels) {
        const chPerms = computePermissions(userId, spaceRow.id, ch.id);
        const hasView = (chPerms & PermissionBits.VIEW_CHANNEL) !== 0n || (chPerms & PermissionBits.ADMINISTRATOR) !== 0n;
        if (hasView) {
          visibleChannelIdSet.add(ch.id);
          visibleChannels.push({
            id: ch.id,
            spaceId: ch.spaceId,
            name: ch.name,
            type: ch.type as Channel['type'],
            topic: ch.topic,
            position: ch.position ?? 0,
            categoryId: ch.categoryId ?? null,
            isPrivate: privateChannelIds.has(ch.id),
            createdAt: ch.createdAt,
            lastMessageId: lastMsgMap.get(ch.id) ?? null,
            myPermissions: permissionsToString(chPerms),
          });
        }
      }

      spaces.push({
        id: spaceRow.id,
        name: spaceRow.name,
        icon: spaceRow.icon,
        banner: spaceRow.banner ?? null,
        avatarColor: (spaceRow.avatarColor as Space['avatarColor']) ?? null,
        ownerId: spaceRow.ownerId,
        inviteCode: spaceRow.inviteCode,
        visibility: (spaceRow.visibility ?? 'private') as SpaceWithChannelsAndMembers['visibility'],
        directoryListed: spaceRow.directoryListed === 1,
        description: spaceRow.description ?? null,
        createdAt: spaceRow.createdAt,
        channels: visibleChannels,
        categories: categoriesBySpace.get(spaceRow.id) ?? [],
        members,
        roles: rolesForViewer(roles, spacePerms),
        myPermissions: permissionsToString(spacePerms),
      });
    }
  }

  // Store user's space IDs for broadcasting
  connectionManager.setUserSpaces(userId, spaceIds);

  // Open DM memberships (active-call lookup below) and the DM channels
  // themselves (the same list GET /api/dm serves).
  const dmMemberships = db.select()
    .from(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.userId, userId),
      eq(schema.dmMembers.closed, 0),
    ))
    .all();
  const dmChannels = loadOpenDmChannels(db, userId, dmMemberships);

  // Include DM channel IDs in the visible set for read state filtering
  for (const dm of dmChannels) {
    visibleChannelIdSet.add(dm.id);
  }

  // Seed read states for federated users' DM channels that have no existing read state.
  // This handles the bootstrap: DMs existed before cross-instance access was enabled,
  // so the remote instance has no read state history. Mark as read (latest message).
  // Going forward, the S2S read_state_update relay keeps things in sync.
  if (isFederated && dmChannels.length > 0) {
    const dmIds = dmChannels.map(dm => dm.id);
    const existingDmReadStates = batchInArray(
      dmIds,
      ids => db.select({ channelId: schema.readStates.channelId })
        .from(schema.readStates)
        .where(and(eq(schema.readStates.userId, userId), inArray(schema.readStates.channelId, ids)))
        .all(),
    );
    const hasReadState = new Set(existingDmReadStates.map(rs => rs.channelId));
    const now = Date.now();
    for (const dm of dmChannels) {
      if (!hasReadState.has(dm.id) && dm.lastMessage) {
        db.insert(schema.readStates).values({
          userId,
          channelId: dm.id,
          lastReadMessageId: dm.lastMessage.id,
          updatedAt: now,
        }).run();
      }
    }
  }

  // Get Space Folders
  const folderRows = db.select()
    .from(schema.spaceFolders)
    .where(eq(schema.spaceFolders.userId, userId))
    .orderBy(schema.spaceFolders.position)
    .all();

  const folders: SpaceFolder[] = [];
  for (const folder of folderRows) {
    const folderSpaceIds = db.select()
      .from(schema.spaceFolderMembers)
      .where(eq(schema.spaceFolderMembers.folderId, folder.id))
      .orderBy(schema.spaceFolderMembers.position)
      .all()
      .map(m => m.spaceId);

    folders.push({
      id: folder.id,
      userId: folder.userId,
      name: folder.name,
      color: folder.color,
      position: folder.position ?? 0,
      spaceIds: folderSpaceIds,
    });
  }

  // Get user space layout
  const layoutRow = db.select().from(schema.userSpaceLayout)
    .where(eq(schema.userSpaceLayout.userId, userId)).get();
  const spaceLayout: SpaceLayoutItem[] | null = layoutRow ? JSON.parse(layoutRow.layout) : null;
  const layoutUpdatedAt: number | null = layoutRow?.updatedAt ?? null;

  // Build voice states — who is currently in voice channels, plus space mute/
  // deafen and permission-mute, across all the user's spaces. Delegates to the
  // shared per-space helper (also used for the mid-session join push in
  // ConnectionManager.addUserSpace) so the two code paths can never diverge.
  // The helper applies the same VIEW_CHANNEL filtering used when building the
  // `spaces` array above.
  const voiceStates: Record<string, string[]> = {};
  const voiceChannelElapsedSeconds: Record<string, number> = {};
  const spaceVoiceStates: Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted: boolean }> = {};
  for (const space of spaces) {
    const snap = connectionManager.buildSpaceVoiceState(space.id, userId);
    Object.assign(voiceStates, snap.voiceStates);
    Object.assign(voiceChannelElapsedSeconds, snap.voiceChannelElapsedSeconds);
    Object.assign(spaceVoiceStates, snap.spaceVoiceStates);
  }

  // Build active calls from user's DM memberships
  const activeCalls: ActiveCallInfo[] = [];
  for (const dm of dmMemberships) {
    const room = connectionManager.getRoom(dm.dmChannelId);
    if (room && room.roomType === 'dm') {
      const dmMeta = room.metadata as DmRoomMeta;
      // A member who declined a group call that still rings is not rung
      // again on reconnect.
      if (dmMeta.state === 'ringing' && dmMeta.declinedUserIds.has(userId)) continue;
      activeCalls.push({
        dmChannelId: dm.dmChannelId,
        callerId: dmMeta.callerId,
        participants: Array.from(room.participants),
        startedAt: room.startedAt,
        state: dmMeta.state,
      });
      // Inject DM call participants into voiceStates so frontend's generic handler works
      if (room.participants.size > 0) {
        voiceStates[dm.dmChannelId] = Array.from(room.participants);
      }
    }
  }

  // Also include federated calls (this instance is NOT the host)
  for (const [_fedId, fedCall] of connectionManager.getAllFederatedCalls()) {
    const isParticipant = fedCall.ringedUserIds.includes(userId);
    const isDmMember = fedCall.dmChannelId && dmMemberships.some(dm => dm.dmChannelId === fedCall.dmChannelId);
    // A group decline takes the member out of `ringedUserIds`; while the
    // call still rings, that member is not rung again on reconnect.
    const declined = fedCall.group && fedCall.state === 'ringing' && !isParticipant;
    if ((isParticipant || isDmMember) && !declined) {
      activeCalls.push({
        dmChannelId: fedCall.dmChannelId,
        federatedCallId: fedCall.federatedId,
        callerId: fedCall.callerId,
        participants: [],
        startedAt: fedCall.startedAt,
        state: fedCall.state,
        federatedCallHost: fedCall.federatedCallHost,
        livekitUrl: fedCall.livekitUrl,
        livekitToken: fedCall.tokens.get(userId),
      });
    }
  }

  // Build voice user states — includes both space and DM participants now
  const voiceUserStates: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }> = {};
  for (const chId of Object.keys(voiceStates)) {
    const usersInChannel = voiceStates[chId];
    if (usersInChannel) {
      for (const uid of usersInChannel) {
        const status = connectionManager.getVoiceUserStatus(uid);
        if (status) {
          voiceUserStates[uid] = status;
        }
      }
    }
  }

  // Fetch read states for unread tracking
  const readStateRows = db.select()
    .from(schema.readStates)
    .where(eq(schema.readStates.userId, userId))
    .all();

  const readStates: ReadState[] = readStateRows
    .filter(rs => !isFederated || visibleChannelIdSet.has(rs.channelId))
    .map(rs => ({
      channelId: rs.channelId,
      lastReadMessageId: rs.lastReadMessageId,
    }));

  // Build user activities snapshot for all visible users: space members, DM
  // members and friends (a friend may share neither with the user). Keys are
  // this instance's row ids; userActivityIdentities names each key's federated
  // identity so the client can key it like every other view of that person.
  // Auto-inject customStatus as a 'custom' activity for users with no ephemeral activities
  const userActivities: Record<string, Activity[]> = {};
  const userActivityIdentities: Record<string, PresenceIdentity> = {};
  const seenUserIds = new Set<string>();

  function collectUserActivities(
    subject: { id: string; homeUserId: string | null; homeInstance: string | null; customStatus: string | null },
  ) {
    if (seenUserIds.has(subject.id)) return;
    seenUserIds.add(subject.id);
    const acts = snapshotActivities(connectionManager.getUserActivities(subject.id), subject.customStatus);
    if (acts.length > 0) {
      userActivities[subject.id] = acts;
      userActivityIdentities[subject.id] = presenceIdentityOf(subject);
    }
  }

  for (const space of spaces) {
    for (const member of space.members) {
      collectUserActivities({
        id: member.userId,
        homeUserId: member.user?.homeUserId ?? null,
        homeInstance: member.user?.homeInstance ?? null,
        customStatus: member.user?.customStatus ?? null,
      });
    }
  }
  for (const dm of dmChannels) {
    for (const member of dm.members) {
      collectUserActivities({
        id: member.id,
        homeUserId: member.homeUserId ?? null,
        homeInstance: member.homeInstance ?? null,
        customStatus: member.customStatus ?? null,
      });
    }
  }
  const friendIds = db.select({ userId: schema.friends.userId, friendId: schema.friends.friendId })
    .from(schema.friends)
    .where(or(eq(schema.friends.userId, userId), eq(schema.friends.friendId, userId)))
    .all()
    .map(f => (f.userId === userId ? f.friendId : f.userId));
  if (friendIds.length > 0) {
    const friendRows = db.select({
      id: schema.users.id,
      homeUserId: schema.users.homeUserId,
      homeInstance: schema.users.homeInstance,
      customStatus: schema.users.customStatus,
    })
      .from(schema.users)
      .where(inArray(schema.users.id, friendIds))
      .all();
    for (const friend of friendRows) collectUserActivities(friend);
  }

  // Rejected peer origins for unreachable member indicators
  const rejectedPeers = db
    .select({ origin: schema.federationPeers.origin })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.status, 'rejected'))
    .all();
  const rejectedPeerOrigins = rejectedPeers.map(p => p.origin);

  // Awaiting-approval peer origins for softer unreachable indicators
  const awaitingApprovalPeers = db
    .select({ origin: schema.federationPeers.origin })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.status, 'awaiting_approval'))
    .all();
  const awaitingApprovalPeerOrigins = awaitingApprovalPeers.map(p => p.origin);

  // Active peer origins — client uses this allowlist to gate DM events from remote instances
  const activePeers = db
    .select({ origin: schema.federationPeers.origin })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.status, 'active'))
    .all();
  const activePeerOrigins = activePeers.map(p => p.origin);

  // Pending approval count for admin notification
  let pendingApprovalCount = 0;
  if (userRow?.isAdmin === 1) {
    const countResult = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.peerApprovalRequests)
      .get();
    pendingApprovalCount = countResult?.count ?? 0;
  }

  return { supportsPoke: true, user, spaces, dmChannels, folders, spaceLayout, layoutUpdatedAt, voiceStates, voiceChannelElapsedSeconds, voiceUserStates, spaceVoiceStates, readStates, activeCalls, userActivities, userActivityIdentities, rejectedPeerOrigins, awaitingApprovalPeerOrigins, activePeerOrigins, pendingApprovalCount };
}

export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const ws = socket as unknown as WebSocket;
    // Per-address limits on events key on this, as the HTTP limiter does.
    recordSocketAddress(ws, request.ip);
    let authenticated = false;
    let userId: string | undefined;
    let username: string | undefined;
    let isFederated = false;

    // Set auth timeout - must authenticate within 10 seconds
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Authentication timeout' }));
        ws.close();
      }
    }, 10000);

    ws.on('message', (data: Buffer | string) => {
      let parsed: Record<string, unknown>;
      try {
        const raw = typeof data === 'string' ? data : data.toString('utf-8');
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      // Any received message proves liveness
      wsIsAlive.set(ws, true);

      if (!authenticated) {
        // First message must be auth
        if (parsed.type !== 'auth' || typeof parsed.token !== 'string') {
          ws.send(JSON.stringify({ type: 'error', message: 'First message must be auth' }));
          ws.close();
          return;
        }

        try {
          const payload = verifyJwt(parsed.token);
          userId = payload.userId;
          username = payload.username;

          // Reject deleted users and revoked tokens
          const db = getDb();
          const userRow = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
          if (!userRow || userRow.isDeleted) {
            ws.send(JSON.stringify({ type: 'error', message: 'This account has been deleted' }));
            ws.close();
            return;
          }
          // Token revocation: reject tokens issued before last password change
          if (userRow.passwordChangedAt && payload.iat) {
            if (payload.iat < Math.floor(userRow.passwordChangedAt / 1000)) {
              ws.send(JSON.stringify({ type: 'error', message: 'Token has been revoked' }));
              ws.close();
              return;
            }
          }

          authenticated = true;
          isFederated = !!userRow.homeInstance;
          clearTimeout(authTimeout);

          // Publish the user's live presence: for a native row its
          // chosen_status (idle and dnd survive reconnects and restarts), for a
          // replicated row what ws/replicaPresence.ts shows.
          const connectStatus = connectionManager.publishConnectStatus(userRow);

          // Add connection
          connectionManager.addConnection(userId, ws);

          // Captured for the pong closure: `userId` is a mutable outer binding, so
          // its narrowing to a string does not survive into the callback.
          const activeUserId = userId;
          recordConnectionActivity(activeUserId, parsed, new Date());

          // Mark alive for heartbeat detection; browsers auto-respond to ping frames (RFC 6455)
          wsIsAlive.set(ws, true);
          ws.on('pong', () => {
            wsIsAlive.set(ws, true);
            // `ws` is the memo key: this socket writes the day once and then
            // stops asking until the day rolls over.
            recordConnectionActivity(activeUserId, null, new Date(), ws);
          });

          // Build and send ready payload
          const readyData = buildReadyPayload(userId);
          ws.send(JSON.stringify({
            type: 'ready',
            ...readyData,
          }));

          // Broadcast the connect status to friends + DM co-members + space co-members.
          const connectPayload = presenceUpdateFor(userId, connectStatus);
          const connectTargets = collectProfileBroadcastTargetIds(userId);
          for (const uid of connectTargets) connectionManager.sendToUser(uid, connectPayload);

          // S2S: project it to peers, as the profile_update broadcast (see queueOutboxEvent).
          // No-op for a replicated row: its home instance owns the projection.
          // The relay is a full snapshot, so it carries the activities another
          // session of this user already reported (none on a first connection).
          const _uid = userId;
          const connectActivities = connectionManager.getUserActivities(_uid);
          void import('../utils/federationPresence.js').then(({ queuePresenceRelay }) => {
            try { queuePresenceRelay(_uid, connectStatus, connectActivities); } catch (e) { console.warn('[ws] queuePresenceRelay(connect) failed', e); }
          });
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
          ws.close();
        }
        return;
      }

      // Fast-path heartbeat — never reaches business logic
      if (parsed.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // Rate limit all post-auth, non-ping messages (per-user, shared across tabs)
      if (!connectionManager.getUserRateLimiter(userId!).consume()) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limited' }));
        return;
      }

      // Handle authenticated events
      if (userId && username) {
        try {
          handleClientEvent(parsed, userId, username, ws, isFederated);
        } catch (err) {
          app.log.error({ err, eventType: parsed.type, userId }, 'Unhandled error in WS event handler');
          try {
            ws.send(JSON.stringify({ type: 'error', message: 'Internal server error' }));
          } catch { /* ws may already be closed */ }
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (userId) {
        connectionManager.removeConnection(ws);
      }
    });

    ws.on('error', () => {
      clearTimeout(authTimeout);
    });
  });

  // ─── Heartbeat Sweep ──────────────────────────────────────────────────────
  // Detect dead connections (e.g. PC shut off without TCP FIN).
  // Sends protocol-level ping frames; browsers auto-respond with pong (RFC 6455).
  // Worst-case detection: 30s + 30s + 5s grace = ~65s.
  const HEARTBEAT_INTERVAL_MS = 30_000;

  heartbeatInterval = setInterval(() => {
    for (const [, userConnections] of connectionManager.getAllConnections()) {
      for (const ws of userConnections) {
        if (wsIsAlive.get(ws) === false) {
          ws.terminate(); // Emits 'close' → removeConnection → scheduleDisconnect → finalizeDisconnect
          continue;
        }
        wsIsAlive.set(ws, false);
        if (ws.readyState === 1) ws.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  app.addHook('onClose', async () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  });
}
