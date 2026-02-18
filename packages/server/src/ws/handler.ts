import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { verifyJwt } from '../utils/auth.js';
import { getDb, schema } from '../db/index.js';
import { eq, inArray } from 'drizzle-orm';
import { handleClientEvent } from './events.js';
import type {
  User,
  ServerWithChannelsAndMembers,
  MemberWithUser,
  Channel,
  DmChannel,
  ServerEvent,
  ServerFolder,
} from '@opencord/shared';

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

class ConnectionManager {
  // userId → Set of WebSocket connections (multiple tabs)
  private connections: Map<string, Set<WebSocket>> = new Map();
  // userId → Set of server IDs the user belongs to
  private userServers: Map<string, Set<string>> = new Map();
  // channelId → Set of userIds in voice channel
  private voiceStates: Map<string, Set<string>> = new Map();
  // ws → userId (reverse lookup)
  private wsToUser: Map<WebSocket, string> = new Map();

  addConnection(userId: string, ws: WebSocket): void {
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }
    this.connections.get(userId)!.add(ws);
    this.wsToUser.set(ws, userId);
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
      }
    }
    return userId;
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

  // Voice state management
  joinVoice(channelId: string, userId: string): void {
    // Leave any existing voice channel first
    this.leaveAllVoice(userId);
    if (!this.voiceStates.has(channelId)) {
      this.voiceStates.set(channelId, new Set());
    }
    this.voiceStates.get(channelId)!.add(userId);
  }

  leaveVoice(channelId: string, userId: string): void {
    const users = this.voiceStates.get(channelId);
    if (users) {
      users.delete(userId);
      if (users.size === 0) {
        this.voiceStates.delete(channelId);
      }
    }
  }

  leaveAllVoice(userId: string): string | null {
    for (const [channelId, users] of this.voiceStates) {
      if (users.has(userId)) {
        users.delete(userId);
        if (users.size === 0) {
          this.voiceStates.delete(channelId);
        }
        return channelId;
      }
    }
    return null;
  }

  getVoiceUsers(channelId: string): Set<string> {
    return this.voiceStates.get(channelId) ?? new Set();
  }

  getUserVoiceChannel(userId: string): string | null {
    for (const [channelId, users] of this.voiceStates) {
      if (users.has(userId)) {
        return channelId;
      }
    }
    return null;
  }

  // Send to a specific user (all their connections)
  sendToUser(userId: string, event: ServerEvent): void {
    const connections = this.getUserConnections(userId);
    const message = JSON.stringify(event);
    for (const ws of connections) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(message);
      }
    }
  }

  // Send to all members of a server
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

  // Send to all connections of all online users (for global events)
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
}

export const connectionManager = new ConnectionManager();

function buildReadyPayload(userId: string): {
  user: User;
  servers: ServerWithChannelsAndMembers[];
  dmChannels: DmChannel[];
  folders: ServerFolder[];
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

    for (const serverRow of serverRows) {
      const channels = db.select()
        .from(schema.channels)
        .where(eq(schema.channels.serverId, serverRow.id))
        .all();

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
        ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
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
            role: (m.role ?? 'member') as MemberWithUser['role'],
            nickname: m.nickname,
            joinedAt: m.joinedAt,
            user: sanitizeUser(u),
            roles: memberRoles,
          };
        })
        .filter((m): m is MemberWithUser => m !== null);

      servers.push({
        id: serverRow.id,
        name: serverRow.name,
        icon: serverRow.icon,
        ownerId: serverRow.ownerId,
        inviteCode: serverRow.inviteCode,
        createdAt: serverRow.createdAt,
        channels: channels.map(ch => ({
          id: ch.id,
          serverId: ch.serverId,
          name: ch.name,
          type: ch.type as Channel['type'],
          topic: ch.topic,
          position: ch.position ?? 0,
          createdAt: ch.createdAt,
        })),
        members,
        roles: roles.map(r => ({
          id: r.id,
          serverId: r.serverId,
          name: r.name,
          color: r.color ?? '#b9bbbe',
          position: r.position ?? 0,
          createdAt: r.createdAt,
        })),
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

  const dmChannels: DmChannel[] = [];

  for (const dm of dmMemberships) {
    const dmChannel = db.select()
      .from(schema.dmChannels)
      .where(eq(schema.dmChannels.id, dm.dmChannelId))
      .get();

    if (!dmChannel) continue;

    const dmMemberRows = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, dm.dmChannelId))
      .all();

    const dmMemberUserIds = dmMemberRows.map(m => m.userId);
    const dmUsers = dmMemberUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, dmMemberUserIds)).all()
      : [];

    // Get last message
    const lastMessage = db.select()
      .from(schema.dmMessages)
      .where(eq(schema.dmMessages.dmChannelId, dm.dmChannelId))
      .orderBy(schema.dmMessages.createdAt)
      .all();

    const last = lastMessage.length > 0 ? lastMessage[lastMessage.length - 1] : null;

    dmChannels.push({
      id: dmChannel.id,
      createdAt: dmChannel.createdAt,
      members: dmUsers.map(sanitizeUser),
      lastMessage: last ? {
        id: last.id,
        dmChannelId: last.dmChannelId,
        userId: last.userId,
        content: last.content,
        createdAt: last.createdAt,
      } : null,
    });
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
        const users = connectionManager.getVoiceUsers(ch.id);
        if (users.size > 0) {
          voiceStates[ch.id] = Array.from(users);
        }
      }
    }
  }

  return { user, servers, dmChannels, folders, voiceStates };
}

export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const ws = socket as unknown as WebSocket;
    let authenticated = false;
    let userId: string | undefined;
    let username: string | undefined;

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

      // Handle authenticated events
      if (userId && username) {
        handleClientEvent(parsed, userId, username);
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (userId) {
        const removedUserId = connectionManager.removeConnection(ws);

        // If user has no more connections, set offline
        if (removedUserId && !connectionManager.isUserOnline(removedUserId)) {
          const db = getDb();
          db.update(schema.users).set({ status: 'offline' }).where(eq(schema.users.id, removedUserId)).run();

          // Leave voice if in one
          const leftChannel = connectionManager.leaveAllVoice(removedUserId);
          if (leftChannel) {
            // Get channel's server to broadcast
            const channel = db.select().from(schema.channels).where(eq(schema.channels.id, leftChannel)).get();
            if (channel) {
              connectionManager.sendToServer(channel.serverId, {
                type: 'voice_state_update',
                channelId: leftChannel,
                userId: removedUserId,
                action: 'leave',
              });
            }
          }

          // Broadcast offline to all servers
          const userServers = connectionManager.getUserServers(removedUserId);
          for (const serverId of userServers) {
            connectionManager.sendToServer(serverId, {
              type: 'presence_update',
              userId: removedUserId,
              status: 'offline',
            });
          }
        }
      }
    });

    ws.on('error', () => {
      clearTimeout(authTimeout);
    });
  });
}
