import { create } from 'zustand';
import type { Server, Channel, MemberWithUser, ServerWithChannelsAndMembers, Role, ServerFolder, DmChannel, User } from '@backspace/shared';
import { api } from '../api/client';

interface ServerState {
  servers: Server[];
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
  setServers: (servers: Server[]) => void;
  setCurrentServer: (serverId: string | null) => void;
  setChannels: (channels: Channel[]) => void;
  setMembers: (members: MemberWithUser[]) => void;
  setRoles: (roles: Role[]) => void;
  setDmChannels: (channels: DmChannel[]) => void;
  addDmChannel: (channel: DmChannel) => void;
  removeDmChannel: (id: string) => void;
  addDmMember: (dmChannelId: string, user: User) => void;
  removeDmMember: (dmChannelId: string, userId: string) => void;
  closeDm: (id: string) => Promise<void>;
  loadServers: () => Promise<void>;
  loadServerDetail: (serverId: string) => Promise<void>;
  loadDmChannels: () => Promise<void>;
  createServer: (name: string, icon?: string) => Promise<Server>;
  updateServer: (serverId: string, data: { name?: string; icon?: string }) => Promise<void>;
  deleteServer: (serverId: string) => Promise<void>;
  joinServer: (serverId: string, inviteCode: string) => Promise<void>;
  joinByCode: (inviteCode: string) => Promise<Server>;
  generateInvite: (serverId: string) => Promise<string>;
  createChannel: (serverId: string, name: string, type: 'text' | 'voice' | 'video', topic?: string) => Promise<Channel>;
  deleteChannel: (channelId: string) => Promise<void>;
  addServer: (server: Server) => void;
  removeServer: (serverId: string) => void;
  updateMemberPresence: (userId: string, status: string) => void;
  addMember: (member: MemberWithUser) => void;
  removeMember: (userId: string) => void;
  populateFromReady: (servers: ServerWithChannelsAndMembers[], folders?: ServerFolder[], dmChannels?: DmChannel[]) => void;
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

  setServers: (servers) => set({ servers }),
  setCurrentServer: (serverId) => set({ currentServerId: serverId }),
  setChannels: (channels) => set({ channels }),
  setMembers: (members) => set({ members }),
  setRoles: (roles) => set({ roles }),
  setDmChannels: (dmChannels) => set({ dmChannels }),
  
  addDmChannel: (channel) => set((state) => ({
    dmChannels: [channel, ...state.dmChannels.filter(c => c.id !== channel.id)]
  })),

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
    await api.dm.close(id);
    set((state) => ({
      dmChannels: state.dmChannels.filter(c => c.id !== id)
    }));
  },

  loadServers: async () => {
    try {
      const servers = await api.servers.list();
      set({ servers });
    } catch {
      // Silently fail - will be populated from WS ready
    }
  },

  loadServerDetail: async (serverId: string) => {
    try {
      const detail = await api.servers.get(serverId);
      set({
        currentServerId: serverId,
        channels: detail.channels.sort((a, b) => a.position - b.position),
        members: detail.members,
        roles: detail.roles.sort((a, b) => b.position - a.position), // Higher position = higher in list
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
    set((state) => ({ servers: [...state.servers, server] }));
    return server;
  },

  updateServer: async (serverId: string, data: { name?: string; icon?: string }) => {
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
      return { servers: [...state.servers, server] };
    });
  },

  joinByCode: async (inviteCode: string) => {
    const server = await api.servers.joinByCode(inviteCode);
    set((state) => {
      if (state.servers.find(s => s.id === server.id)) return state;
      return { servers: [...state.servers, server] };
    });
    return server;
  },

  generateInvite: async (serverId: string) => {
    const result = await api.servers.invite(serverId);
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
      return { servers: [...state.servers, server] };
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

  populateFromReady: (servers: ServerWithChannelsAndMembers[], folders?: ServerFolder[], dmChannels?: DmChannel[]) => {
    const simpleServers: Server[] = servers.map(s => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      ownerId: s.ownerId,
      inviteCode: s.inviteCode,
      createdAt: s.createdAt,
    }));

    // Build channel→server map, channel→lastMessageId map, and permission maps
    const channelToServerMap = new Map<string, string>();
    const channelLastMessageIds = new Map<string, string>();
    const serverPermissions = new Map<string, string>();
    const channelPermissions = new Map<string, string>();

    for (const srv of servers) {
      if (srv.myPermissions) {
        serverPermissions.set(srv.id, srv.myPermissions);
      }
      for (const ch of srv.channels) {
        channelToServerMap.set(ch.id, srv.id);
        if (ch.lastMessageId) {
          channelLastMessageIds.set(ch.id, ch.lastMessageId);
        }
        if (ch.myPermissions) {
          channelPermissions.set(ch.id, ch.myPermissions);
        }
      }
    }
    // Also map DM channels
    const dms = dmChannels || [];
    for (const dm of dms) {
      if (dm.lastMessage?.id) {
        channelLastMessageIds.set(dm.id, dm.lastMessage.id);
      }
    }

    set({
      servers: simpleServers,
      folders: folders || [],
      dmChannels: dms,
      channelToServerMap,
      channelLastMessageIds,
      serverPermissions,
      channelPermissions,
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
