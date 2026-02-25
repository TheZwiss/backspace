import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { verifyJwt } from '../utils/auth.js';
import { getDb, schema } from '../db/index.js';
import { eq, inArray, desc, sql } from 'drizzle-orm';
import { handleClientEvent } from './events.js';
import { computePermissions, PermissionBits, permissionsToString } from '../utils/permissions.js';
import type {
  User,
  ServerWithChannelsAndMembers,
  MemberWithUser,
  Channel,
  DmChannel,
  ServerEvent,
  ServerFolder,
  ReadState,
  ActiveCallInfo,
} from '@opencord/shared';

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

function sanitizeUser(row: typeof schema.users.$inferSelect): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatar: row.avatar,
    status: (row.status ?? 'offline') as User['status'],
    customStatus: row.customStatus,
    createdAt: row.createdAt,
  };
}

export interface AuthenticatedSocket {
  ws: WebSocket;
  userId: string;
  username: string;
}

// ─── VoiceRoom Abstraction ─────────────────────────────────────────────────

export interface ServerRoomMeta {
  type: 'server';
  serverId: string;
}

export interface DmRoomMeta {
  type: 'dm';
  callerId: string;
  state: 'ringing' | 'active';
}

export interface VoiceRoom {
  roomId: string;
  roomType: 'server' | 'dm';
  participants: Set<string>;
  metadata: ServerRoomMeta | DmRoomMeta;
  startedAt: number;
}

// ─── ConnectionManager ─────────────────────────────────────────────────────

class ConnectionManager {
  // userId → Set of WebSocket connections (multiple tabs)
  private connections: Map<string, Set<WebSocket>> = new Map();
  // userId → Set of server IDs the user belongs to
  private userServers: Map<string, Set<string>> = new Map();
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
      if (userConnections.size === 0) {
        this.connections.delete(userId);
        // Schedule disconnect cleanup
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

    // Leave voice room if in one (handles both server and DM rooms)
    const left = this.leaveCurrentRoom(userId);
    this.clearVoiceUserStatus(userId);
    if (left) {
      if (left.room.roomType === 'server') {
        const meta = left.room.metadata as ServerRoomMeta;
        this.sendToServer(meta.serverId, {
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

    // Broadcast offline to all servers
    const userServers = this.getUserServers(userId);
    for (const serverId of userServers) {
      this.sendToServer(serverId, {
        type: 'presence_update',
        userId: userId,
        status: 'offline',
      });
    }
  }

  getUserConnections(userId: string): Set<WebSocket> {
    return this.connections.get(userId) ?? new Set();
  }

  isUserOnline(userId: string): boolean {
    const conns = this.connections.get(userId);
    return conns !== undefined && conns.size > 0;
  }

  setUserServers(userId: string, serverIds: string[]): void {
    this.userServers.set(userId, new Set(serverIds));
  }

  addUserServer(userId: string, serverId: string): void {
    if (!this.userServers.has(userId)) {
      this.userServers.set(userId, new Set());
    }
    this.userServers.get(userId)!.add(serverId);
  }

  getUserServers(userId: string): Set<string> {
    return this.userServers.get(userId) ?? new Set();
  }

  // ─── Unified VoiceRoom API ─────────────────────────────────────────────────

  /** Create a room. Returns false if room already exists. */
  createRoom(roomId: string, roomType: 'server' | 'dm', metadata: ServerRoomMeta | DmRoomMeta): boolean {
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
        if (oldRoom.participants.size === 0 && oldRoom.roomType === 'server') {
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

    // Auto-cleanup empty server rooms (they're lazy-created)
    if (room.participants.size === 0 && room.roomType === 'server') {
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

  /** Send to all members of a server. */
  sendToServer(serverId: string, event: ServerEvent, excludeUserId?: string): void {
    const message = JSON.stringify(event);
    for (const [userId, serverIds] of this.userServers) {
      if (serverIds.has(serverId) && userId !== excludeUserId) {
        const connections = this.getUserConnections(userId);
        for (const ws of connections) {
          if (ws.readyState === 1) {
            ws.send(message);
          }
        }
      }
    }
  }

  /** Send to server members who have VIEW_CHANNEL on the given channel. */
  sendToChannel(serverId: string, channelId: string, event: ServerEvent, excludeUserId?: string): void {
    const message = JSON.stringify(event);
    for (const [userId, serverIds] of this.userServers) {
      if (serverIds.has(serverId) && userId !== excludeUserId) {
        const perms = computePermissions(userId, serverId, channelId);
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

  /** Expose userServers iterator for pre-delete viewer collection. */
  getUserServerEntries(): IterableIterator<[string, Set<string>]> {
    return this.userServers.entries();
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

  /** Send to a room — routes to sendToServer (server rooms) or sendToDmMembers (DM rooms). */
  sendToRoom(roomId: string, event: ServerEvent, excludeUserId?: string): void {
    const room = this.voiceRooms.get(roomId);
    if (!room) return;

    if (room.roomType === 'server') {
      const meta = room.metadata as ServerRoomMeta;
      this.sendToServer(meta.serverId, event, excludeUserId);
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

  getAllOnlineUserIds(): string[] {
    return Array.from(this.connections.keys());
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
  servers: ServerWithChannelsAndMembers[];
  dmChannels: DmChannel[];
  folders: ServerFolder[];
  voiceStates: Record<string, string[]>;
  voiceUserStates: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>;
  readStates: ReadState[];
  activeCalls: ActiveCallInfo[];
} {
  const db = getDb();

  // Get user
  const userRow = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!userRow) {
    throw new Error('User not found');
  }
  const user = sanitizeUser(userRow);

  // Get user's server memberships
  const memberships = db.select()
    .from(schema.serverMembers)
    .where(eq(schema.serverMembers.userId, userId))
    .all();

  const serverIds = memberships.map(m => m.serverId);

  const servers: ServerWithChannelsAndMembers[] = [];

  if (serverIds.length > 0) {
    const serverRows = db.select()
      .from(schema.servers)
      .where(inArray(schema.servers.id, serverIds))
      .all();

    // Batch: all channels for all servers (1 query instead of N)
    const allChannels = batchInArray(
      serverIds,
      ids => db.select().from(schema.channels).where(inArray(schema.channels.serverId, ids)).all(),
    );
    const channelsByServer = new Map<string, (typeof allChannels)>();
    for (const ch of allChannels) {
      let arr = channelsByServer.get(ch.serverId);
      if (!arr) { arr = []; channelsByServer.set(ch.serverId, arr); }
      arr.push(ch);
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

    for (const serverRow of serverRows) {
      const channels = channelsByServer.get(serverRow.id) ?? [];

      const roles = db.select()
        .from(schema.roles)
        .where(eq(schema.roles.serverId, serverRow.id))
        .orderBy(schema.roles.position)
        .all();

      const memberRows = db.select()
        .from(schema.serverMembers)
        .where(eq(schema.serverMembers.serverId, serverRow.id))
        .all();

      const memberUserIds = memberRows.map(m => m.userId);
      const users = memberUserIds.length > 0
        ? batchInArray(memberUserIds, ids => db.select().from(schema.users).where(inArray(schema.users.id, ids)).all())
        : [];
      const userMap = new Map(users.map(u => [u.id, u]));

      const memberRoleRows = db.select()
        .from(schema.memberRoles)
        .where(eq(schema.memberRoles.serverId, serverRow.id))
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
              serverId: r.serverId,
              name: r.name,
              color: r.color ?? '#b9bbbe',
              position: r.position ?? 0,
              createdAt: r.createdAt,
            }));

          return {
            serverId: m.serverId,
            userId: m.userId,
            nickname: m.nickname,
            joinedAt: m.joinedAt,
            user: sanitizeUser(u),
            roles: memberRoles,
          };
        })
        .filter((m): m is MemberWithUser => m !== null);

      // Compute server-level permissions for this user
      const serverPerms = computePermissions(userId, serverRow.id);

      // Filter channels by VIEW_CHANNEL and attach per-channel permissions
      const visibleChannels: Channel[] = [];
      for (const ch of channels) {
        const chPerms = computePermissions(userId, serverRow.id, ch.id);
        const hasView = (chPerms & PermissionBits.VIEW_CHANNEL) !== 0n || (chPerms & PermissionBits.ADMINISTRATOR) !== 0n;
        if (hasView) {
          visibleChannels.push({
            id: ch.id,
            serverId: ch.serverId,
            name: ch.name,
            type: ch.type as Channel['type'],
            topic: ch.topic,
            position: ch.position ?? 0,
            createdAt: ch.createdAt,
            lastMessageId: lastMsgMap.get(ch.id) ?? null,
            myPermissions: permissionsToString(chPerms),
          });
        }
      }

      servers.push({
        id: serverRow.id,
        name: serverRow.name,
        icon: serverRow.icon,
        ownerId: serverRow.ownerId,
        inviteCode: serverRow.inviteCode,
        createdAt: serverRow.createdAt,
        channels: visibleChannels,
        members,
        roles: roles.map(r => ({
          id: r.id,
          serverId: r.serverId,
          name: r.name,
          color: r.color ?? '#b9bbbe',
          position: r.position ?? 0,
          permissions: r.permissions ?? undefined,
          isEveryone: r.id === serverRow.id,
          createdAt: r.createdAt,
        })),
        myPermissions: permissionsToString(serverPerms),
      });
    }
  }

  // Store user's server IDs for broadcasting
  connectionManager.setUserServers(userId, serverIds);

  // Get DM channels
  const dmMemberships = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.userId, userId))
    .all();

  const dmChannelIds = dmMemberships.map(dm => dm.dmChannelId);
  const dmChannels: DmChannel[] = [];

  if (dmChannelIds.length > 0) {
    // Batch: all DM channels (1 query)
    const allDmChannelRows = batchInArray(
      dmChannelIds,
      ids => db.select().from(schema.dmChannels).where(inArray(schema.dmChannels.id, ids)).all(),
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

    // Batch: last message per DM channel (1 query — fixes the full-table-scan bug)
    const dmLastMsgIdRows = batchInArray(
      dmChannelIds,
      ids => db.select({
        dmChannelId: schema.dmMessages.dmChannelId,
        lastId: sql<string>`max(${schema.dmMessages.id})`,
      }).from(schema.dmMessages).where(inArray(schema.dmMessages.dmChannelId, ids)).groupBy(schema.dmMessages.dmChannelId).all(),
    );
    const dmLastMsgIds = dmLastMsgIdRows.map(r => r.lastId).filter((id): id is string => id != null);
    const dmLastMessages = dmLastMsgIds.length > 0
      ? batchInArray(dmLastMsgIds, ids => db.select().from(schema.dmMessages).where(inArray(schema.dmMessages.id, ids)).all())
      : [];
    const dmLastMsgMap = new Map(dmLastMessages.map(m => [m.dmChannelId, m]));

    // Assemble DM channels with zero additional queries
    for (const dm of dmMemberships) {
      const dmChannel = dmChannelMap.get(dm.dmChannelId);
      if (!dmChannel) continue;

      const memberRows = allDmMemberRows.filter(m => m.dmChannelId === dm.dmChannelId);
      const members = memberRows
        .map(m => dmUserMap.get(m.userId))
        .filter((u): u is NonNullable<typeof u> => u != null)
        .map(sanitizeUser);

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
        } : null,
      });
    }
  }

  // Get Server Folders
  const folderRows = db.select()
    .from(schema.serverFolders)
    .where(eq(schema.serverFolders.userId, userId))
    .orderBy(schema.serverFolders.position)
    .all();

  const folders: any[] = [];
  for (const folder of folderRows) {
    const serverIds = db.select()
      .from(schema.serverFolderMembers)
      .where(eq(schema.serverFolderMembers.folderId, folder.id))
      .all()
      .map(m => m.serverId);

    folders.push({
      id: folder.id,
      userId: folder.userId,
      name: folder.name,
      color: folder.color,
      position: folder.position,
      serverIds,
    });
  }

  // Build voice states — tell the client who is currently in voice channels
  // across all their servers
  const voiceStates: Record<string, string[]> = {};
  for (const srv of servers) {
    for (const ch of srv.channels) {
      if (ch.type === 'voice' || ch.type === 'video') {
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

  // Build voice user states — includes both server and DM participants now
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

  const readStates: ReadState[] = readStateRows.map(rs => ({
    channelId: rs.channelId,
    lastReadMessageId: rs.lastReadMessageId,
  }));

  return { user, servers, dmChannels, folders, voiceStates, voiceUserStates, readStates, activeCalls };
}

export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const ws = socket as unknown as WebSocket;
    let authenticated = false;
    let userId: string | undefined;
    let username: string | undefined;
    const rateLimiter = new WsRateLimiter();

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
          authenticated = true;
          clearTimeout(authTimeout);

          // Update user status to online
          const db = getDb();
          db.update(schema.users).set({ status: 'online' }).where(eq(schema.users.id, userId)).run();

          // Add connection
          connectionManager.addConnection(userId, ws);

          // Build and send ready payload
          const readyData = buildReadyPayload(userId);
          ws.send(JSON.stringify({
            type: 'ready',
            ...readyData,
          }));

          // Broadcast presence update to all servers
          const userServers = connectionManager.getUserServers(userId);
          for (const serverId of userServers) {
            connectionManager.sendToServer(serverId, {
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

      // Rate limit all post-auth, non-ping messages
      if (!rateLimiter.consume()) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limited' }));
        return;
      }

      // Handle authenticated events
      if (userId && username) {
        handleClientEvent(parsed, userId, username);
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
}
