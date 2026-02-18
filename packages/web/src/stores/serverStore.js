import { create } from 'zustand';
import { api } from '../api/client';
export const useServerStore = create((set, get) => ({
    servers: [],
    currentServerId: null,
    channels: [],
    members: [],
    roles: [],
    folders: [],
    dmChannels: [],
    setServers: (servers) => set({ servers }),
    setCurrentServer: (serverId) => set({ currentServerId: serverId }),
    setChannels: (channels) => set({ channels }),
    setMembers: (members) => set({ members }),
    setRoles: (roles) => set({ roles }),
    setDmChannels: (dmChannels) => set({ dmChannels }),
    addDmChannel: (channel) => set((state) => ({
        dmChannels: [channel, ...state.dmChannels.filter(c => c.id !== channel.id)]
    })),
    loadServers: async () => {
        try {
            const servers = await api.servers.list();
            set({ servers });
        }
        catch {
            // Silently fail - will be populated from WS ready
        }
    },
    loadServerDetail: async (serverId) => {
        try {
            const detail = await api.servers.get(serverId);
            set({
                currentServerId: serverId,
                channels: detail.channels.sort((a, b) => a.position - b.position),
                members: detail.members,
                roles: detail.roles.sort((a, b) => b.position - a.position), // Higher position = higher in list
            });
        }
        catch {
            // Handle error silently
        }
    },
    loadDmChannels: async () => {
        try {
            const dmChannels = await api.dm.list();
            set({ dmChannels });
        }
        catch {
            // Handle error silently
        }
    },
    createServer: async (name, icon) => {
        const server = await api.servers.create({ name, icon });
        set((state) => ({ servers: [...state.servers, server] }));
        return server;
    },
    updateServer: async (serverId, data) => {
        const updated = await api.servers.update(serverId, data);
        set((state) => ({
            servers: state.servers.map(s => s.id === serverId ? { ...s, ...updated } : s),
        }));
    },
    deleteServer: async (serverId) => {
        await api.servers.delete(serverId);
        set((state) => ({
            servers: state.servers.filter(s => s.id !== serverId),
            currentServerId: state.currentServerId === serverId ? null : state.currentServerId,
        }));
    },
    joinServer: async (serverId, inviteCode) => {
        const server = await api.servers.join(serverId, { inviteCode });
        set((state) => {
            if (state.servers.find(s => s.id === server.id))
                return state;
            return { servers: [...state.servers, server] };
        });
    },
    generateInvite: async (serverId) => {
        const result = await api.servers.invite(serverId);
        return result.inviteCode;
    },
    createChannel: async (serverId, name, type, topic) => {
        const channel = await api.channels.create(serverId, { name, type, topic });
        set((state) => ({
            channels: [...state.channels, channel].sort((a, b) => a.position - b.position),
        }));
        return channel;
    },
    deleteChannel: async (channelId) => {
        await api.channels.delete(channelId);
        set((state) => ({
            channels: state.channels.filter(c => c.id !== channelId),
        }));
    },
    addServer: (server) => {
        set((state) => {
            if (state.servers.find(s => s.id === server.id))
                return state;
            return { servers: [...state.servers, server] };
        });
    },
    removeServer: (serverId) => {
        set((state) => ({
            servers: state.servers.filter(s => s.id !== serverId),
            currentServerId: state.currentServerId === serverId ? null : state.currentServerId,
        }));
    },
    updateMemberPresence: (userId, status) => {
        set((state) => ({
            members: state.members.map(m => m.userId === userId ? { ...m, user: { ...m.user, status: status } } : m),
        }));
    },
    addMember: (member) => {
        set((state) => ({
            members: [...state.members.filter(m => m.userId !== member.userId), member],
        }));
    },
    removeMember: (userId) => {
        set((state) => ({
            members: state.members.filter(m => m.userId !== userId),
        }));
    },
    populateFromReady: (servers, folders, dmChannels) => {
        const simpleServers = servers.map(s => ({
            id: s.id,
            name: s.name,
            icon: s.icon,
            ownerId: s.ownerId,
            inviteCode: s.inviteCode,
            createdAt: s.createdAt,
        }));
        set({
            servers: simpleServers,
            folders: folders || [],
            dmChannels: dmChannels || []
        });
    },
}));
