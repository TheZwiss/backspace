import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { verifyJwt } from '../utils/auth.js';
import { getDb, schema } from '../db/index.js';
import { eq, and, or, inArray, isNull, desc, sql } from 'drizzle-orm';
import { handleClientEvent } from './events.js';
import { computePermissions, PermissionBits, permissionsToString } from '../utils/permissions.js';
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
} from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';

// ─── Heartbeat State ──────────────────────────────────────────────────────────
const wsIsAlive: WeakMap<WebSocket, boolean> = new WeakMap();
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// SQLite's SQLITE_MAX_VARIABLE_NUMBER default is 999.
// Chunk inArray() calls to stay safely under this limit.
const BATCH_CHUNK_SIZE = 500;

function batchInArray<TId, TResult>(ids: TId[], queryFn: (chunk: TId[]) => TResult[]): TResult[] {
  if (ids.length <= BATCH_CHUNK_SIZE) return queryFn(ids);
  const results: TResult[] = [];
  for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
    results.push(...queryFn(ids.slice(i, i + BATCH_CHUNK_SIZE)));
  }
  return results;
}

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
}

/** In-memory registry for federated calls on REMOTE instances. */
export interface FederatedCallEntry {
  dmChannelId: string;
  federatedId: string;
  callerId: string;             // local stub userId of the caller
  callerHomeUserId: string;
  federatedCallHost: string;    // peer origin of the host instance
  livekitUrl: string;
  tokens: Map<string, string>;  // homeUserId → LiveKit token
  state: 'ringing' | 'active';
  startedAt: number;
}

export interface VoiceRoom {
  roomId: string;
  roomType: 'space' | 'dm';
  participants: Set<string>;
  metadata: SpaceRoomMeta | DmRoomMeta;
  startedAt: number;
}

// ─── ConnectionManager ─────────────────────────────────────────────────────

class ConnectionManager {
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
  // roomId → Timeout for ringing DM rooms (60s auto-cleanup)
  private ringingTimeouts: Map<string, NodeJS.Timeout> = new Map();
  /** Federated calls where this instance is NOT the host. Keyed by local dmChannelId. */
  private federatedCalls: Map<string, FederatedCallEntry> = new Map();
  private federatedCallTimeouts: Map<string, NodeJS.Timeout> = new Map();
  // Space-muted/deafened users (moderator action)
  private spaceMutedUsers: Set<string> = new Set(); // Stores spaceId:userId
  private spaceDeafenedUsers: Set<string> = new Set(); // Stores spaceId:userId
  // Permission-muted users (SPEAK permission revoked while in voice)
  private permissionMutedUsers: Set<string> = new Set(); // Stores spaceId:userId
  // The specific WebSocket that initiated voice_join / DM call for this user.
  // When THIS socket closes, voice state is cleaned up immediately.
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

      // ── Immediate voice cleanup if this was the voice-active socket ──
      if (this.voiceWs.get(userId) === ws) {
        this.voiceWs.delete(userId);

        // Leave voice room (space or DM)
        const left = this.leaveCurrentRoom(userId);
        this.clearVoiceUserStatus(userId);
        if (left) {
          if (left.room.roomType === 'space') {
            const meta = left.room.metadata as SpaceRoomMeta;
            this.sendToSpace(meta.spaceId, {
              type: 'voice_state_update',
              channelId: left.roomId,
              userId,
              action: 'leave',
            });
          } else {
            this.sendToDmMembers(left.roomId, {
              type: 'voice_state_update',
              channelId: left.roomId,
              userId,
              action: 'leave',
            });
            // Auto-end empty active DM calls
            const updatedRoom = this.voiceRooms.get(left.roomId);
            if (updatedRoom && updatedRoom.participants.size === 0
                && (updatedRoom.metadata as DmRoomMeta).state === 'active') {
              this.destroyRoom(left.roomId);
              this.sendToDmMembers(left.roomId, {
                type: 'dm_call_ended',
                dmChannelId: left.roomId,
              });
            }
          }
        }

        // Clean up ringing DM rooms where this user is the caller
        for (const [roomId, room] of this.voiceRooms) {
          if (room.roomType === 'dm') {
            const meta = room.metadata as DmRoomMeta;
            if (meta.state === 'ringing' && meta.callerId === userId) {
              this.destroyRoom(roomId);
              this.sendToDmMembers(roomId, {
                type: 'dm_call_ended',
                dmChannelId: roomId,
              });
            }
          }
        }

        // Notify the user's remaining tabs so their UI updates
        if (userConnections.size > 0 && left) {
          this.sendToUser(userId, {
            type: 'voice_disconnected',
            userId,
            channelId: left.roomId,
            reason: 'session_closed',
          });
        }
      }

      if (userConnections.size === 0) {
        this.connections.delete(userId);
        // Schedule disconnect cleanup (presence/offline, NOT voice — already handled above)
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

  private finalizeDisconnect(userId: string) {
    // Double check they are still offline
    if (this.isUserOnline(userId)) return;

    console.log(`[ConnectionManager] Finalizing disconnect for user ${userId}`);
    const db = getDb();
    db.update(schema.users).set({ status: 'offline' }).where(eq(schema.users.id, userId)).run();

    // Leave voice room if in one (handles both space and DM rooms)
    const left = this.leaveCurrentRoom(userId);
    this.clearVoiceUserStatus(userId);
    this.voiceWs.delete(userId);
    if (left) {
      if (left.room.roomType === 'space') {
        const meta = left.room.metadata as SpaceRoomMeta;
        this.sendToSpace(meta.spaceId, {
          type: 'voice_state_update',
          channelId: left.roomId,
          userId: userId,
          action: 'leave',
        });
      } else {
        // DM room — broadcast leave and auto-end if empty
        this.sendToDmMembers(left.roomId, {
          type: 'voice_state_update',
          channelId: left.roomId,
          userId: userId,
          action: 'leave',
        });
        const updatedRoom = this.voiceRooms.get(left.roomId);
        if (updatedRoom && updatedRoom.participants.size === 0 && (updatedRoom.metadata as DmRoomMeta).state === 'active') {
          this.destroyRoom(left.roomId);
          this.sendToDmMembers(left.roomId, {
            type: 'dm_call_ended',
            dmChannelId: left.roomId,
          });
        }
      }
    }

    // Destroy any ringing DM rooms where this user is the caller
    for (const [roomId, room] of this.voiceRooms) {
      if (room.roomType === 'dm') {
        const meta = room.metadata as DmRoomMeta;
        if (meta.state === 'ringing' && meta.callerId === userId) {
          this.destroyRoom(roomId);
          this.sendToDmMembers(roomId, {
            type: 'dm_call_ended',
            dmChannelId: roomId,
          });
        }
      }
    }

    // Clear activity state
    this.clearUserActivities(userId);
    this.userShowActivity.delete(userId);
    this.userStatuses.delete(userId);
    this.lastActivityUpdate.delete(userId);

    // Broadcast offline to all spaces
    const userSpaces = this.getUserSpaces(userId);
    for (const spaceId of userSpaces) {
      this.sendToSpace(spaceId, {
        type: 'presence_update',
        userId: userId,
        status: 'offline',
        activities: [] as Activity[],
      });
    }

    // Clean up userSpaces (re-populated on next connect via setUserSpaces)
    this.userSpaces.delete(userId);

    // Clean up per-user rate limiter
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
  }

  getUserSpaces(userId: string): Set<string> {
    return this.userSpaces.get(userId) ?? new Set();
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

  /** Create a DM room in ringing state with 60s auto-cleanup. */
  createDmRoom(dmChannelId: string, callerId: string): boolean {
    const created = this.createRoom(dmChannelId, 'dm', {
      type: 'dm',
      callerId,
      state: 'ringing',
    });
    if (!created) return false;

    // 60s ringing timeout — auto-destroy if still ringing
    const timeout = setTimeout(() => {
      this.ringingTimeouts.delete(dmChannelId);
      const room = this.voiceRooms.get(dmChannelId);
      if (room && room.roomType === 'dm' && (room.metadata as DmRoomMeta).state === 'ringing') {
        this.destroyRoom(dmChannelId);
        this.sendToDmMembers(dmChannelId, {
          type: 'dm_call_ended',
          dmChannelId,
        });
      }
    }, 60_000);
    this.ringingTimeouts.set(dmChannelId, timeout);

    return true;
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

  /** Register a federated call received via S2S. Adds 60s ringing timeout. */
  createFederatedCall(entry: FederatedCallEntry): void {
    // Clear any existing entry + timeout to avoid leaked timers
    this.clearFederatedCall(entry.dmChannelId);
    this.federatedCalls.set(entry.dmChannelId, entry);

    // 60s ringing timeout — mirrors host behavior
    const timeout = setTimeout(() => {
      this.federatedCallTimeouts.delete(entry.dmChannelId);
      const call = this.federatedCalls.get(entry.dmChannelId);
      if (call && call.state === 'ringing') {
        this.federatedCalls.delete(entry.dmChannelId);
        this.sendToDmMembers(entry.dmChannelId, {
          type: 'dm_call_ended',
          dmChannelId: entry.dmChannelId,
        });
      }
    }, 60_000);
    this.federatedCallTimeouts.set(entry.dmChannelId, timeout);
  }

  /** Get a federated call entry by local dmChannelId. */
  getFederatedCall(dmChannelId: string): FederatedCallEntry | undefined {
    return this.federatedCalls.get(dmChannelId);
  }

  /** Transition a federated call from ringing → active. */
  activateFederatedCall(dmChannelId: string): boolean {
    const call = this.federatedCalls.get(dmChannelId);
    if (!call || call.state !== 'ringing') return false;
    call.state = 'active';
    const timeout = this.federatedCallTimeouts.get(dmChannelId);
    if (timeout) {
      clearTimeout(timeout);
      this.federatedCallTimeouts.delete(dmChannelId);
    }
    return true;
  }

  /** Remove a federated call entry and clear its timeout. */
  clearFederatedCall(dmChannelId: string): void {
    this.federatedCalls.delete(dmChannelId);
    const timeout = this.federatedCallTimeouts.get(dmChannelId);
    if (timeout) {
      clearTimeout(timeout);
      this.federatedCallTimeouts.delete(dmChannelId);
    }
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
      displaced.push(userId);
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
    this.voiceWs.set(userId, ws);
  }

  /** Get the voice-owning ws for this user. */
  getVoiceWs(userId: string): WebSocket | undefined {
    return this.voiceWs.get(userId);
  }

  /** Clear the voice ws binding for this user. */
  clearVoiceWs(userId: string): void {
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

    // Leave voice room if in one
    const left = this.leaveCurrentRoom(userId);
    this.clearVoiceUserStatus(userId);
    this.voiceWs.delete(userId);
    if (left) {
      if (left.room.roomType === 'space') {
        const meta = left.room.metadata as SpaceRoomMeta;
        this.sendToSpace(meta.spaceId, {
          type: 'voice_state_update',
          channelId: left.roomId,
          userId,
          action: 'leave',
        });
      } else {
        this.sendToDmMembers(left.roomId, {
          type: 'voice_state_update',
          channelId: left.roomId,
          userId,
          action: 'leave',
        });
      }
    }

    // Destroy any ringing DM rooms where this user is the caller
    for (const [roomId, room] of this.voiceRooms) {
      if (room.roomType === 'dm') {
        const meta = room.metadata as DmRoomMeta;
        if (meta.state === 'ringing' && meta.callerId === userId) {
          this.destroyRoom(roomId);
          this.sendToDmMembers(roomId, {
            type: 'dm_call_ended',
            dmChannelId: roomId,
          });
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

  /** Push a fresh ready payload to a specific user, forcing full store re-sync. */
  pushReadyPayload(userId: string): void {
    const connections = this.getUserConnections(userId);
    if (connections.size === 0) return;

    const readyData = buildReadyPayload(userId);
    const message = JSON.stringify({ type: 'ready', ...readyData });
    for (const ws of connections) {
      if (ws.readyState === 1) {
        ws.send(message);
      }
    }
  }
}

export const connectionManager = new ConnectionManager();

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

function buildReadyPayload(userId: string): {
  user: User;
  spaces: SpaceWithChannelsAndMembers[];
  dmChannels: DmChannel[];
  folders: SpaceFolder[];
  spaceLayout: SpaceLayoutItem[] | null;
  layoutUpdatedAt: number | null;
  voiceStates: Record<string, string[]>;
  voiceUserStates: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>;
  spaceVoiceStates: Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted: boolean }>;
  readStates: ReadState[];
  activeCalls: ActiveCallInfo[];
  userActivities: Record<string, Activity[]>;
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

    // Batch: determine which channels are private (VIEW_CHANNEL denied on @everyone)
    // @everyone role ID equals the space ID, so we query for overrides targeting role = spaceId
    const allEveroneOverrides = batchInArray(
      spaceIds,
      ids => db.select().from(schema.channelOverrides).where(
        and(
          eq(schema.channelOverrides.targetType, 'role'),
          inArray(schema.channelOverrides.targetId, ids),
        )
      ).all(),
    );
    const privateChannelIds = new Set<string>();
    for (const o of allEveroneOverrides) {
      const denyBits = BigInt(o.deny || '0');
      if ((denyBits & PermissionBits.VIEW_CHANNEL) !== 0n) {
        privateChannelIds.add(o.channelId);
      }
    }

    // Batch: all categories for all spaces (1 query instead of N)
    const allCategories = batchInArray(
      spaceIds,
      ids => db.select().from(schema.channelCategories).where(inArray(schema.channelCategories.spaceId, ids)).all(),
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
        }).from(schema.messages).where(inArray(schema.messages.channelId, ids)).groupBy(schema.messages.channelId).all(),
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

          const assignedRoleIds = memberRoleRows
            .filter(mr => mr.userId === m.userId)
            .map(mr => mr.roleId);

          const memberRoles = roles
            .filter(r => assignedRoleIds.includes(r.id))
            .map(r => ({
              id: r.id,
              spaceId: r.spaceId,
              name: r.name,
              color: r.color ?? '#b9bbbe',
              position: r.position ?? 0,
              createdAt: r.createdAt,
            }));

          return {
            spaceId: m.spaceId,
            userId: m.userId,
            nickname: m.nickname,
            joinedAt: m.joinedAt,
            user: sanitizeUser(u),
            roles: memberRoles,
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
        description: spaceRow.description ?? null,
        createdAt: spaceRow.createdAt,
        channels: visibleChannels,
        categories: categoriesBySpace.get(spaceRow.id) ?? [],
        members,
        roles: roles.map(r => ({
          id: r.id,
          spaceId: r.spaceId,
          name: r.name,
          color: r.color ?? '#b9bbbe',
          position: r.position ?? 0,
          permissions: r.permissions ?? undefined,
          isEveryone: r.id === spaceRow.id,
          createdAt: r.createdAt,
        })),
        myPermissions: permissionsToString(spacePerms),
      });
    }
  }

  // Store user's space IDs for broadcasting
  connectionManager.setUserSpaces(userId, spaceIds);

  // Get DM channels — skip entirely for federated users (they get DMs from their home instance)
  const dmMemberships = isFederated ? [] : db.select()
    .from(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.userId, userId),
      eq(schema.dmMembers.closed, 0),
    ))
    .all();

  const dmChannelIds = dmMemberships.map(dm => dm.dmChannelId);
  const dmChannels: DmChannel[] = [];

  if (dmChannelIds.length > 0) {
    // Batch: all DM channels (1 query, exclude soft-deleted)
    const allDmChannelRows = batchInArray(
      dmChannelIds,
      ids => db.select().from(schema.dmChannels).where(and(inArray(schema.dmChannels.id, ids), isNull(schema.dmChannels.deletedAt))).all(),
    );
    const dmChannelMap = new Map(allDmChannelRows.map(c => [c.id, c]));

    // Batch: all DM members across all channels (1 query)
    const allDmMemberRows = batchInArray(
      dmChannelIds,
      ids => db.select().from(schema.dmMembers).where(inArray(schema.dmMembers.dmChannelId, ids)).all(),
    );

    // Batch: all unique users from DM members (1 query)
    const allDmUserIds = [...new Set(allDmMemberRows.map(m => m.userId))];
    const allDmUsers = allDmUserIds.length > 0
      ? batchInArray(allDmUserIds, ids => db.select().from(schema.users).where(inArray(schema.users.id, ids)).all())
      : [];
    const dmUserMap = new Map(allDmUsers.map(u => [u.id, u]));

    // Batch: last message per DM channel.
    // Two-step approach (same as GET /api/dm): get MAX(created_at) per channel,
    // then fetch the actual message rows matching those timestamps.
    const dmMaxTimestamps = batchInArray(
      dmChannelIds,
      ids => db.select({
        dmChannelId: schema.dmMessages.dmChannelId,
        maxCreatedAt: sql<number>`MAX(${schema.dmMessages.createdAt})`.as('max_created_at'),
      }).from(schema.dmMessages).where(inArray(schema.dmMessages.dmChannelId, ids)).groupBy(schema.dmMessages.dmChannelId).all(),
    );
    const dmLastMsgMap = new Map<string, typeof schema.dmMessages.$inferSelect>();
    if (dmMaxTimestamps.length > 0) {
      const conditions = dmMaxTimestamps.map(t =>
        and(eq(schema.dmMessages.dmChannelId, t.dmChannelId), eq(schema.dmMessages.createdAt, t.maxCreatedAt!))
      );
      const dmLastMessages = db.select().from(schema.dmMessages).where(or(...conditions)).all();
      for (const m of dmLastMessages) {
        if (!dmLastMsgMap.has(m.dmChannelId)) {
          dmLastMsgMap.set(m.dmChannelId, m);
        }
      }
    }
    const dmLastMsgIds = [...dmLastMsgMap.values()].map(m => m.id);

    // Batch: attachments for last messages (1 query)
    const dmLastMsgAttachments = dmLastMsgIds.length > 0
      ? batchInArray(dmLastMsgIds, ids =>
          db.select({
            dmMessageId: schema.attachments.dmMessageId,
            type: schema.attachments.mimetype,
            filename: schema.attachments.originalName,
          }).from(schema.attachments).where(inArray(schema.attachments.dmMessageId, ids)).all()
        )
      : [];
    const dmLastMsgAttachmentMap = new Map<string, Array<{ type: string; filename: string }>>();
    for (const a of dmLastMsgAttachments) {
      if (!a.dmMessageId) continue;
      const arr = dmLastMsgAttachmentMap.get(a.dmMessageId) ?? [];
      arr.push({ type: a.type, filename: a.filename });
      dmLastMsgAttachmentMap.set(a.dmMessageId, arr);
    }

    // Assemble DM channels with zero additional queries
    for (const dm of dmMemberships) {
      const dmChannel = dmChannelMap.get(dm.dmChannelId);
      if (!dmChannel) continue;

      const memberRows = allDmMemberRows.filter(m => m.dmChannelId === dm.dmChannelId);
      const members = memberRows
        .map(m => dmUserMap.get(m.userId))
        .filter((u): u is NonNullable<typeof u> => u != null)
        .map(u => sanitizeUser(u));

      const last = dmLastMsgMap.get(dm.dmChannelId) ?? null;

      dmChannels.push({
        id: dmChannel.id,
        ownerId: dmChannel.ownerId ?? null,
        createdAt: dmChannel.createdAt,
        members,
        lastMessage: last ? {
          id: last.id,
          dmChannelId: last.dmChannelId,
          userId: last.userId,
          content: last.content,
          createdAt: last.createdAt,
          attachments: dmLastMsgAttachmentMap.get(last.id) ?? [],
        } : null,
      });
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

  // Build voice states — tell the client who is currently in voice channels
  // across all their spaces
  const voiceStates: Record<string, string[]> = {};
  for (const space of spaces) {
    for (const ch of space.channels) {
      if (ch.type === 'voice') {
        const participants = connectionManager.getRoomParticipants(ch.id);
        if (participants.size > 0) {
          voiceStates[ch.id] = Array.from(participants);
        }
      }
    }
  }

  // Build active calls from user's DM memberships
  const activeCalls: ActiveCallInfo[] = [];
  for (const dm of dmMemberships) {
    const room = connectionManager.getRoom(dm.dmChannelId);
    if (room && room.roomType === 'dm') {
      const dmMeta = room.metadata as DmRoomMeta;
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

  // Resolve this user's homeUserId for token lookup
  const readyUser = db.select({ homeUserId: schema.users.homeUserId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  const myHomeUserId = readyUser?.homeUserId || userId;

  // Also include federated calls (this instance is NOT the host)
  for (const dm of dmMemberships) {
    const fedCall = connectionManager.getFederatedCall(dm.dmChannelId);
    if (fedCall) {
      activeCalls.push({
        dmChannelId: dm.dmChannelId,
        callerId: fedCall.callerId,
        participants: [],
        startedAt: fedCall.startedAt,
        state: fedCall.state,
        federatedCallHost: fedCall.federatedCallHost,
        livekitUrl: fedCall.livekitUrl,
        livekitToken: fedCall.tokens.get(myHomeUserId),  // only this user's token
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

  // Build space mute/deafen states from DB (authoritative source for all spaces the user belongs to)
  // Also includes ephemeral permission-mute state from in-memory Set
  const spaceVoiceStates: Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted: boolean }> = {};
  if (spaceIds.length > 0) {
    const allRestrictions = db.select()
      .from(schema.voiceRestrictions)
      .where(inArray(schema.voiceRestrictions.spaceId, spaceIds))
      .all();
    for (const r of allRestrictions) {
      const key = `${r.spaceId}:${r.userId}`;
      const existing = spaceVoiceStates[key] ?? { spaceMuted: false, spaceDeafened: false, permissionMuted: false };
      if (r.restrictionType === 'mute') existing.spaceMuted = true;
      if (r.restrictionType === 'deafen') existing.spaceDeafened = true;
      spaceVoiceStates[key] = existing;
    }
    // Include ephemeral permission-mute state for all voice participants in user's spaces
    for (const [roomId, room] of connectionManager.getAllRooms()) {
      if (room.roomType !== 'space') continue;
      const meta = room.metadata as SpaceRoomMeta;
      if (!spaceIds.includes(meta.spaceId)) continue;
      for (const participantId of room.participants) {
        if (connectionManager.isPermissionMuted(meta.spaceId, participantId)) {
          const key = `${meta.spaceId}:${participantId}`;
          const existing = spaceVoiceStates[key] ?? { spaceMuted: false, spaceDeafened: false, permissionMuted: false };
          existing.permissionMuted = true;
          spaceVoiceStates[key] = existing;
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

  // Build user activities snapshot for all visible users
  // Auto-inject customStatus as a 'custom' activity for users with no ephemeral activities
  const userActivities: Record<string, Activity[]> = {};
  const seenUserIds = new Set<string>();

  function collectUserActivities(uid: string, customStatus: string | null) {
    if (seenUserIds.has(uid)) return;
    seenUserIds.add(uid);
    let acts = connectionManager.getUserActivities(uid);
    if (acts.length === 0 && customStatus) {
      acts = [{ type: 'custom', name: customStatus }];
    }
    if (acts.length > 0) {
      userActivities[uid] = acts;
    }
  }

  for (const space of spaces) {
    for (const member of space.members) {
      collectUserActivities(member.userId, member.user?.customStatus ?? null);
    }
  }
  for (const dm of dmChannels) {
    for (const member of dm.members) {
      collectUserActivities(member.id, member.customStatus ?? null);
    }
  }

  return { user, spaces, dmChannels, folders, spaceLayout, layoutUpdatedAt, voiceStates, voiceUserStates, spaceVoiceStates, readStates, activeCalls, userActivities };
}

export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const ws = socket as unknown as WebSocket;
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

          // Update user status to online
          db.update(schema.users).set({ status: 'online' }).where(eq(schema.users.id, userId)).run();

          // Add connection
          connectionManager.addConnection(userId, ws);

          // Mark alive for heartbeat detection; browsers auto-respond to ping frames (RFC 6455)
          wsIsAlive.set(ws, true);
          ws.on('pong', () => { wsIsAlive.set(ws, true); });

          // Build and send ready payload
          const readyData = buildReadyPayload(userId);
          ws.send(JSON.stringify({
            type: 'ready',
            ...readyData,
          }));

          // Broadcast presence update to all spaces
          const userSpaces = connectionManager.getUserSpaces(userId);
          for (const spaceId of userSpaces) {
            connectionManager.sendToSpace(spaceId, {
              type: 'presence_update',
              userId,
              status: 'online',
            }, userId);
          }
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
