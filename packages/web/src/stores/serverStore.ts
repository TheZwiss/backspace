import { create } from 'zustand';
import type { Server, Channel, MemberWithUser, ServerWithChannelsAndMembers, Role, ServerFolder, DmChannel, User, UpdateServerRequest } from '@backspace/shared';
import { api, BackspaceApiClient } from '../api/client';
import { resolveAssetUrl, normalizeUserAssets } from '../utils/assetUrls';
import { isSelf } from '../utils/identity';
import { useAuthStore } from './authStore';

// ─── Instance-aware types ─────────────────────────────────────────────────────

/** Server augmented with instance origin tracking (client-only, not in shared types). */
export type TaggedServer = Server & { _instanceOrigin: string };

// ─── Error types ─────────────────────────────────────────────────────────────

/** Thrown when joinByCode targets a remote origin the user is not connected to. */
export class NotConnectedError extends Error {
  constructor(public origin: string) {
    super(`Not connected to ${origin}`);
    this.name = 'NotConnectedError';
  }
}

// ─── Store interface ──────────────────────────────────────────────────────────

interface ServerState {
  servers: TaggedServer[];
  currentServerId: string | null;
  channels: Channel[];
  members: MemberWithUser[];
  roles: Role[];
  folders: ServerFolder[];
  dmChannels: DmChannel[];
  channelToServerMap: Map<string, string>;
  channelLastMessageIds: Map<string, string>;
  serverPermissions: Map<string, string>; // serverId → myPermissions decimal string
  channelPermissions: Map<string, string>; // channelId → myPermissions decimal string
  channelOriginMap: Map<string, string>; // channelId → instance origin ('' = home)
  setServers: (servers: TaggedServer[]) => void;
  setCurrentServer: (serverId: string | null) => void;
  setChannels: (channels: Channel[]) => void;
  setMembers: (members: MemberWithUser[]) => void;
  setRoles: (roles: Role[]) => void;
  setDmChannels: (channels: DmChannel[]) => void;
  addDmChannel: (channel: DmChannel, origin?: string) => void;
  removeDmChannel: (id: string) => void;
  addDmMember: (dmChannelId: string, user: User) => void;
  removeDmMember: (dmChannelId: string, userId: string) => void;
  closeDm: (id: string) => Promise<void>;
  loadServers: () => Promise<void>;
  loadServerDetail: (serverId: string) => Promise<void>;
  loadDmChannels: () => Promise<void>;
  createServer: (name: string, icon?: string) => Promise<Server>;
  updateServer: (serverId: string, data: UpdateServerRequest) => Promise<void>;
  deleteServer: (serverId: string) => Promise<void>;
  joinServer: (serverId: string, inviteCode: string) => Promise<void>;
  joinByCode: (inviteCode: string, origin?: string) => Promise<Server>;
  generateInvite: (serverId: string) => Promise<string>;
  createChannel: (serverId: string, name: string, type: 'text' | 'voice' | 'video', topic?: string) => Promise<Channel>;
  deleteChannel: (channelId: string) => Promise<void>;
  addServer: (server: Server) => void;
  removeServer: (serverId: string) => void;
  updateMemberPresence: (userId: string, status: string) => void;
  addMember: (member: MemberWithUser) => void;
  removeMember: (userId: string) => void;
  populateFromReady: (origin: string, servers: ServerWithChannelsAndMembers[], folders?: ServerFolder[], dmChannels?: DmChannel[]) => void;
  addServerFromReady: (origin: string, server: ServerWithChannelsAndMembers) => void;
  removeInstanceServers: (origin: string) => void;
  findExistingDmForUser: (targetUser: { id: string; homeUserId?: string | null }) => { dm: DmChannel; origin: string } | null;
}

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  currentServerId: null,
  channels: [],
  members: [],
  roles: [],
  folders: [],
  dmChannels: [],
  channelToServerMap: new Map(),
  channelLastMessageIds: new Map(),
  serverPermissions: new Map(),
  channelPermissions: new Map(),
  channelOriginMap: new Map(),

  setServers: (servers) => set({ servers }),
  setCurrentServer: (serverId) => set({ currentServerId: serverId }),
  setChannels: (channels) => set({ channels }),
  setMembers: (members) => set({ members }),
  setRoles: (roles) => set({ roles }),
  setDmChannels: (dmChannels) => set({ dmChannels }),

  addDmChannel: (channel, origin?: string) => set((state) => {
    const channelOriginMap = new Map(state.channelOriginMap);
    if (origin !== undefined) {
      channelOriginMap.set(channel.id, origin);
    }
    return {
      dmChannels: [channel, ...state.dmChannels.filter(c => c.id !== channel.id)],
      channelOriginMap,
    };
  }),

  removeDmChannel: (id) => set((state) => ({
    dmChannels: state.dmChannels.filter(c => c.id !== id)
  })),

  addDmMember: (dmChannelId, user) => set((state) => ({
    dmChannels: state.dmChannels.map(dm =>
      dm.id === dmChannelId
        ? { ...dm, members: dm.members.some(m => m.id === user.id) ? dm.members : [...dm.members, user] }
        : dm
    ),
  })),

  removeDmMember: (dmChannelId, userId) => set((state) => ({
    dmChannels: state.dmChannels.map(dm =>
      dm.id === dmChannelId
        ? { ...dm, members: dm.members.filter(m => m.id !== userId) }
        : dm
    ),
  })),

  closeDm: async (id) => {
    const origin = get().channelOriginMap.get(id) || '';
    const targetApi = getApiForOrigin(origin);
    await targetApi.dm.close(id);
    set((state) => ({
      dmChannels: state.dmChannels.filter(c => c.id !== id)
    }));
  },

  loadServers: async () => {
    try {
      const servers = await api.servers.list();
      set((state) => ({
        servers: servers.map(s => ({ ...s, _instanceOrigin: '' })) as TaggedServer[],
      }));
    } catch {
      // Silently fail - will be populated from WS ready
    }
  },

  loadServerDetail: async (serverId: string) => {
    try {
      // Resolve the correct API client based on the server's instance origin
      const server = get().servers.find(s => s.id === serverId);
      if (!server) return; // Not populated yet — remote WS ready will trigger reload
      const origin = server._instanceOrigin ?? '';
      const client = getApiForOrigin(origin);

      const detail = await client.servers.get(serverId);
      // Normalize remote asset URLs (avatars, server icon)
      if (origin) {
        if (detail.icon) detail.icon = resolveAssetUrl(detail.icon, origin) ?? detail.icon;
        for (const member of detail.members) {
          normalizeUserAssets(member.user, origin);
        }
      }
      set({
        currentServerId: serverId,
        channels: detail.channels.sort((a, b) => a.position - b.position),
        members: detail.members,
        roles: detail.roles.sort((a, b) => b.position - a.position),
      });
    } catch {
      // Handle error silently
    }
  },

  loadDmChannels: async () => {
    try {
      const dmChannels = await api.dm.list();
      set({ dmChannels });
    } catch {
      // Handle error silently
    }
  },

  createServer: async (name: string, icon?: string) => {
    const server = await api.servers.create({ name, icon });
    const tagged: TaggedServer = { ...server, _instanceOrigin: '' };
    set((state) => ({ servers: [...state.servers, tagged] }));
    return server;
  },

  updateServer: async (serverId: string, data: UpdateServerRequest) => {
    const updated = await api.servers.update(serverId, data);
    set((state) => ({
      servers: state.servers.map(s => s.id === serverId ? { ...s, ...updated } : s),
    }));
  },

  deleteServer: async (serverId: string) => {
    await api.servers.delete(serverId);
    set((state) => ({
      servers: state.servers.filter(s => s.id !== serverId),
      currentServerId: state.currentServerId === serverId ? null : state.currentServerId,
    }));
  },

  joinServer: async (serverId: string, inviteCode: string) => {
    const server = await api.servers.join(serverId, { inviteCode });
    set((state) => {
      if (state.servers.find(s => s.id === server.id)) return state;
      return { servers: [...state.servers, { ...server, _instanceOrigin: '' } as TaggedServer] };
    });
  },

  joinByCode: async (inviteCode: string, origin?: string) => {
    if (origin) {
      // Remote instance — verify connectivity via dynamic import (avoids circular dep)
      const { useInstanceStore } = await import('./instanceStore');
      const connected = useInstanceStore.getState().instances.some(
        (i) => i.origin === origin && i.status === 'connected',
      );
      if (!connected) throw new NotConnectedError(origin);

      const remoteApi = getApiForOrigin(origin);
      const server = await remoteApi.servers.joinByCode(inviteCode);
      set((state) => {
        if (state.servers.find(s => s.id === server.id)) return state;
        return { servers: [...state.servers, { ...server, _instanceOrigin: origin } as TaggedServer] };
      });
      return server;
    }

    // Home instance
    const server = await api.servers.joinByCode(inviteCode);
    set((state) => {
      if (state.servers.find(s => s.id === server.id)) return state;
      return { servers: [...state.servers, { ...server, _instanceOrigin: '' } as TaggedServer] };
    });
    return server;
  },

  generateInvite: async (serverId: string) => {
    const server = get().servers.find(s => s.id === serverId);
    const origin = server?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    const result = await client.servers.invite(serverId);
    return result.inviteCode;
  },

  createChannel: async (serverId: string, name: string, type: 'text' | 'voice' | 'video', topic?: string) => {
    const channel = await api.channels.create(serverId, { name, type, topic });
    set((state) => {
      if (state.channels.some(c => c.id === channel.id)) return state;
      return { channels: [...state.channels, channel].sort((a, b) => a.position - b.position) };
    });
    return channel;
  },

  deleteChannel: async (channelId: string) => {
    await api.channels.delete(channelId);
    set((state) => ({
      channels: state.channels.filter(c => c.id !== channelId),
    }));
  },

  addServer: (server: Server) => {
    set((state) => {
      if (state.servers.find(s => s.id === server.id)) return state;
      return { servers: [...state.servers, { ...server, _instanceOrigin: '' } as TaggedServer] };
    });
  },

  removeServer: (serverId: string) => {
    set((state) => ({
      servers: state.servers.filter(s => s.id !== serverId),
      currentServerId: state.currentServerId === serverId ? null : state.currentServerId,
    }));
  },

  updateMemberPresence: (userId: string, status: string) => {
    set((state) => ({
      members: state.members.map(m =>
        m.userId === userId ? { ...m, user: { ...m.user, status: status as 'online' | 'idle' | 'dnd' | 'offline' } } : m
      ),
    }));
  },

  addMember: (member: MemberWithUser) => {
    set((state) => ({
      members: [...state.members.filter(m => m.userId !== member.userId), member],
    }));
  },

  removeMember: (userId: string) => {
    set((state) => ({
      members: state.members.filter(m => m.userId !== userId),
    }));
  },

  populateFromReady: (origin: string, servers: ServerWithChannelsAndMembers[], folders?: ServerFolder[], dmChannels?: DmChannel[]) => {
    const isHome = !origin;

    // Tag all incoming servers with their instance origin
    const taggedServers: TaggedServer[] = servers.map(s => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      ownerId: s.ownerId,
      inviteCode: s.inviteCode,
      visibility: s.visibility ?? 'private' as const,
      description: s.description ?? null,
      createdAt: s.createdAt,
      _instanceOrigin: origin,
    }));

    // Merge by origin: keep servers from other origins, replace all from this origin
    const existingFromOtherOrigins = get().servers.filter(s => s._instanceOrigin !== origin);
    const mergedServers = [...existingFromOtherOrigins, ...taggedServers];

    // Build/merge maps for incoming channels
    const channelToServerMap = new Map(get().channelToServerMap);
    const channelLastMessageIds = new Map(get().channelLastMessageIds);
    const serverPermissions = new Map(get().serverPermissions);
    const channelPermissions = new Map(get().channelPermissions);
    const channelOriginMap = new Map(get().channelOriginMap);

    // If home, clear home-origin entries first to avoid stale data
    if (isHome) {
      for (const [key, val] of get().channelOriginMap) {
        if (val === origin) {
          channelToServerMap.delete(key);
          channelLastMessageIds.delete(key);
          channelPermissions.delete(key);
          channelOriginMap.delete(key);
        }
      }
      // Also clear server permissions for this origin
      for (const s of get().servers) {
        if (s._instanceOrigin === origin) {
          serverPermissions.delete(s.id);
        }
      }
    } else {
      // Remote: clear entries that belonged to this origin
      for (const [key, val] of get().channelOriginMap) {
        if (val === origin) {
          channelToServerMap.delete(key);
          channelLastMessageIds.delete(key);
          channelPermissions.delete(key);
          channelOriginMap.delete(key);
        }
      }
      for (const s of get().servers) {
        if (s._instanceOrigin === origin) {
          serverPermissions.delete(s.id);
        }
      }
    }

    // Populate maps from incoming servers
    for (const srv of servers) {
      if (srv.myPermissions) {
        serverPermissions.set(srv.id, srv.myPermissions);
      }
      for (const ch of srv.channels) {
        channelToServerMap.set(ch.id, srv.id);
        channelOriginMap.set(ch.id, origin);
        if (ch.lastMessageId) {
          channelLastMessageIds.set(ch.id, ch.lastMessageId);
        }
        if (ch.myPermissions) {
          channelPermissions.set(ch.id, ch.myPermissions);
        }
      }
    }

    // DM channels: process from any origin, normalize remote assets
    const incomingDms = dmChannels || [];
    if (!isHome) {
      for (const dm of incomingDms) {
        for (const member of dm.members) {
          normalizeUserAssets(member, origin);
        }
      }
    }
    for (const dm of incomingDms) {
      channelOriginMap.set(dm.id, origin);
      if (dm.lastMessage?.id) {
        channelLastMessageIds.set(dm.id, dm.lastMessage.id);
      }
    }
    // Merge: remove DMs belonging to this origin from existing state, then append incoming
    const existingDmsFromOtherOrigins = get().dmChannels.filter(dm => {
      const dmOrigin = get().channelOriginMap.get(dm.id);
      return dmOrigin !== origin;
    });
    const mergedDms = [...existingDmsFromOtherOrigins, ...incomingDms];

    const update: Partial<ServerState> = {
      servers: mergedServers,
      dmChannels: mergedDms,
      channelToServerMap,
      channelLastMessageIds,
      serverPermissions,
      channelPermissions,
      channelOriginMap,
    };

    // Only set folders from home origin
    if (isHome) {
      update.folders = folders || [];
    }

    set(update as any);
  },

  addServerFromReady: (origin: string, server: ServerWithChannelsAndMembers) => {
    const tagged: TaggedServer = {
      id: server.id,
      name: server.name,
      icon: server.icon,
      ownerId: server.ownerId,
      inviteCode: server.inviteCode,
      visibility: server.visibility,
      description: server.description,
      createdAt: server.createdAt,
      _instanceOrigin: origin,
    };

    const channelToServerMap = new Map(get().channelToServerMap);
    const channelLastMessageIds = new Map(get().channelLastMessageIds);
    const serverPermissions = new Map(get().serverPermissions);
    const channelPermissions = new Map(get().channelPermissions);
    const channelOriginMap = new Map(get().channelOriginMap);

    if (server.myPermissions) {
      serverPermissions.set(server.id, server.myPermissions);
    }
    for (const ch of server.channels) {
      channelToServerMap.set(ch.id, server.id);
      channelOriginMap.set(ch.id, origin);
      if (ch.lastMessageId) {
        channelLastMessageIds.set(ch.id, ch.lastMessageId);
      }
      if (ch.myPermissions) {
        channelPermissions.set(ch.id, ch.myPermissions);
      }
    }

    set((state) => ({
      servers: [...state.servers.filter(s => s.id !== server.id), tagged],
      channelToServerMap,
      channelLastMessageIds,
      serverPermissions,
      channelPermissions,
      channelOriginMap,
    }));
  },

  findExistingDmForUser: (targetUser) => {
    const { dmChannels, channelOriginMap } = get();
    const me = useAuthStore.getState().user;
    if (!me) return null;

    const targetHomeId = targetUser.homeUserId || targetUser.id;

    for (const dm of dmChannels) {
      if (dm.members.length !== 2) continue;
      const other = dm.members.find(m => !isSelf(m, me));
      if (!other) continue;
      const otherHomeId = other.homeUserId || other.id;
      if (otherHomeId === targetHomeId) {
        return { dm, origin: channelOriginMap.get(dm.id) || '' };
      }
    }
    return null;
  },

  removeInstanceServers: (origin: string) => {
    set((state) => {
      const remainingServers = state.servers.filter(s => s._instanceOrigin !== origin);

      // Clean up maps for channels that belonged to this origin
      const channelToServerMap = new Map(state.channelToServerMap);
      const channelLastMessageIds = new Map(state.channelLastMessageIds);
      const channelPermissions = new Map(state.channelPermissions);
      const channelOriginMap = new Map(state.channelOriginMap);
      const serverPermissions = new Map(state.serverPermissions);

      for (const [channelId, chOrigin] of state.channelOriginMap) {
        if (chOrigin === origin) {
          channelToServerMap.delete(channelId);
          channelLastMessageIds.delete(channelId);
          channelPermissions.delete(channelId);
          channelOriginMap.delete(channelId);
        }
      }
      for (const s of state.servers) {
        if (s._instanceOrigin === origin) {
          serverPermissions.delete(s.id);
        }
      }

      return {
        servers: remainingServers,
        channelToServerMap,
        channelLastMessageIds,
        channelPermissions,
        channelOriginMap,
        serverPermissions,
        currentServerId: remainingServers.find(s => s.id === state.currentServerId)
          ? state.currentServerId
          : null,
      };
    });
  },
}));

/**
 * Data-driven DM channel detection. Returns true if the given channelId
 * belongs to a DM channel. Authoritative because dmChannels is populated
 * from the WS ready event and DM/server channel IDs never overlap.
 */
export function isDmChannel(channelId: string): boolean {
  const dmChannels = useServerStore.getState().dmChannels;
  if (dmChannels.length > 0) {
    return dmChannels.some(dm => dm.id === channelId);
  }
  // Before WS ready populates dmChannels, fall back to URL path
  if (typeof window !== 'undefined') {
    return window.location.pathname.startsWith('/channels/@me/');
  }
  return false;
}

/**
 * Returns the instance origin for a given channel ID.
 * '' = home instance, 'https://...' = remote instance.
 */
export function getChannelOrigin(channelId: string): string {
  return useServerStore.getState().channelOriginMap.get(channelId) ?? '';
}

// ─── API client resolution ────────────────────────────────────────────────────
// The actual resolver is registered by instanceStore on import, avoiding a
// circular dependency (instanceStore → useWebSocket → chatStore → serverStore).

let _getApiForOrigin: ((origin: string) => BackspaceApiClient) | null = null;

export function setApiForOriginResolver(resolver: (origin: string) => BackspaceApiClient): void {
  _getApiForOrigin = resolver;
}

/**
 * Returns the correct API client for a given instance origin.
 * '' or falsy = home instance, 'https://...' = remote instance.
 * The resolver is registered by instanceStore on import.
 */
export function getApiForOrigin(origin: string): BackspaceApiClient {
  if (!origin || !_getApiForOrigin) return api;
  return _getApiForOrigin(origin);
}

// ─── User ID resolution (federation) ──────────────────────────────────────────
// Same resolver pattern as getApiForOrigin — registered by instanceStore on
// import to break the circular dependency chain.

let _getUserIdForOrigin: ((origin: string) => string | undefined) | null = null;

export function setUserIdForOriginResolver(resolver: (origin: string) => string | undefined): void {
  _getUserIdForOrigin = resolver;
}

/**
 * Returns the local user's ID on a given instance origin.
 * '' or falsy = home instance (returns authStore user ID).
 * 'https://...' = remote instance (returns the federated user ID on that instance).
 */
export function getMyUserIdForOrigin(origin: string): string | undefined {
  if (!origin) return useAuthStore.getState().user?.id;
  return _getUserIdForOrigin?.(origin);
}
