import { create } from 'zustand';
import type { Server, Channel, MemberWithUser, ServerWithChannelsAndMembers } from '@opencord/shared';
import { api } from '../api/client';

interface ServerState {
  servers: Server[];
  currentServerId: string | null;
  channels: Channel[];
  members: MemberWithUser[];
  setServers: (servers: Server[]) => void;
  setCurrentServer: (serverId: string | null) => void;
  setChannels: (channels: Channel[]) => void;
  setMembers: (members: MemberWithUser[]) => void;
  loadServers: () => Promise<void>;
  loadServerDetail: (serverId: string) => Promise<void>;
  createServer: (name: string, icon?: string) => Promise<Server>;
  updateServer: (serverId: string, data: { name?: string; icon?: string }) => Promise<void>;
  deleteServer: (serverId: string) => Promise<void>;
  joinServer: (serverId: string, inviteCode: string) => Promise<void>;
  generateInvite: (serverId: string) => Promise<string>;
  createChannel: (serverId: string, name: string, type: 'text' | 'voice' | 'video', topic?: string) => Promise<Channel>;
  deleteChannel: (channelId: string) => Promise<void>;
  addServer: (server: Server) => void;
  removeServer: (serverId: string) => void;
  updateMemberPresence: (userId: string, status: string) => void;
  addMember: (member: MemberWithUser) => void;
  removeMember: (userId: string) => void;
  populateFromReady: (servers: ServerWithChannelsAndMembers[]) => void;
}

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  currentServerId: null,
  channels: [],
  members: [],

  setServers: (servers) => set({ servers }),
  setCurrentServer: (serverId) => set({ currentServerId: serverId }),
  setChannels: (channels) => set({ channels }),
  setMembers: (members) => set({ members }),

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
      });
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

  generateInvite: async (serverId: string) => {
    const result = await api.servers.invite(serverId);
    return result.inviteCode;
  },

  createChannel: async (serverId: string, name: string, type: 'text' | 'voice' | 'video', topic?: string) => {
    const channel = await api.channels.create(serverId, { name, type, topic });
    set((state) => ({
      channels: [...state.channels, channel].sort((a, b) => a.position - b.position),
    }));
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

  populateFromReady: (servers: ServerWithChannelsAndMembers[]) => {
    const simpleServers: Server[] = servers.map(s => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      ownerId: s.ownerId,
      inviteCode: s.inviteCode,
      createdAt: s.createdAt,
    }));
    set({ servers: simpleServers });
  },
}));
