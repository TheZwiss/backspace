import { create } from 'zustand';
import type { Space, Channel, MemberWithUser, SpaceWithChannelsAndMembers, Role, SpaceFolder, DmChannel, User, UpdateSpaceRequest } from '@backspace/shared';
import { api, BackspaceApiClient } from '../api/client';
import { resolveAssetUrl, normalizeUserAssets } from '../utils/assetUrls';
import { isSelf } from '../utils/identity';
import { useAuthStore } from './authStore';

// ─── Instance-aware types ─────────────────────────────────────────────────────

/** Server augmented with instance origin tracking (client-only, not in shared types). */
export type TaggedSpace = Space & { _instanceOrigin: string };

// ─── Error types ─────────────────────────────────────────────────────────────

/** Thrown when joinByCode targets a remote origin the user is not connected to. */
export class NotConnectedError extends Error {
  constructor(public origin: string) {
    super(`Not connected to ${origin}`);
    this.name = 'NotConnectedError';
  }
}

// ─── Store interface ──────────────────────────────────────────────────────────

interface SpaceState {
  spaces: TaggedSpace[];
  currentSpaceId: string | null;
  channels: Channel[];
  members: MemberWithUser[];
  roles: Role[];
  folders: SpaceFolder[];
  dmChannels: DmChannel[];
  channelToSpaceMap: Map<string, string>;
  channelLastMessageIds: Map<string, string>;
  spacePermissions: Map<string, string>; // spaceId → myPermissions decimal string
  channelPermissions: Map<string, string>; // channelId → myPermissions decimal string
  channelOriginMap: Map<string, string>; // channelId → instance origin ('' = home)
  setSpaces: (spaces: TaggedSpace[]) => void;
  setCurrentSpace: (spaceId: string | null) => void;
  setChannels: (channels: Channel[]) => void;
  setMembers: (members: MemberWithUser[]) => void;
  setRoles: (roles: Role[]) => void;
  setDmChannels: (channels: DmChannel[]) => void;
  addDmChannel: (channel: DmChannel, origin?: string) => void;
  removeDmChannel: (id: string) => void;
  addDmMember: (dmChannelId: string, user: User) => void;
  removeDmMember: (dmChannelId: string, userId: string) => void;
  closeDm: (id: string) => Promise<void>;
  loadSpaces: () => Promise<void>;
  loadSpaceDetail: (spaceId: string) => Promise<void>;
  loadDmChannels: () => Promise<void>;
  createSpace: (name: string, icon?: string) => Promise<Space>;
  updateSpace: (spaceId: string, data: UpdateSpaceRequest) => Promise<void>;
  deleteSpace: (spaceId: string) => Promise<void>;
  joinSpace: (spaceId: string, inviteCode: string) => Promise<void>;
  joinByCode: (inviteCode: string, origin?: string) => Promise<Space>;
  generateInvite: (spaceId: string) => Promise<string>;
  createChannel: (spaceId: string, name: string, type: 'text' | 'voice' | 'video', topic?: string) => Promise<Channel>;
  deleteChannel: (channelId: string) => Promise<void>;
  addSpace: (space: Space) => void;
  removeSpace: (spaceId: string) => void;
  updateMemberPresence: (userId: string, status: string) => void;
  addMember: (member: MemberWithUser) => void;
  removeMember: (userId: string) => void;
  populateFromReady: (origin: string, spaces: SpaceWithChannelsAndMembers[], folders?: SpaceFolder[], dmChannels?: DmChannel[]) => void;
  addSpaceFromReady: (origin: string, space: SpaceWithChannelsAndMembers) => void;
  removeInstanceSpaces: (origin: string) => void;
  findExistingDmForUser: (targetUser: { id: string; homeUserId?: string | null }) => { dm: DmChannel; origin: string } | null;
}

export const useSpaceStore = create<SpaceState>((set, get) => ({
  spaces: [],
  currentSpaceId: null,
  channels: [],
  members: [],
  roles: [],
  folders: [],
  dmChannels: [],
  channelToSpaceMap: new Map(),
  channelLastMessageIds: new Map(),
  spacePermissions: new Map(),
  channelPermissions: new Map(),
  channelOriginMap: new Map(),

  setSpaces: (spaces) => set({ spaces }),
  setCurrentSpace: (spaceId) => set({ currentSpaceId: spaceId }),
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

  loadSpaces: async () => {
    try {
      const spaces =await api.spaces.list();
      set((state) => ({
        spaces: spaces.map(s => ({ ...s, _instanceOrigin: '' })) as TaggedSpace[],
      }));
    } catch {
      // Silently fail - will be populated from WS ready
    }
  },

  loadSpaceDetail: async (spaceId: string) => {
    try {
      // Resolve the correct API client based on the server's instance origin
      const space =get().spaces.find(s => s.id === spaceId);
      if (!space) return; // Not populated yet — remote WS ready will trigger reload
      const origin = space._instanceOrigin ?? '';
      const client = getApiForOrigin(origin);

      const detail = await client.spaces.get(spaceId);
      // Normalize remote asset URLs (avatars, server icon)
      if (origin) {
        if (detail.icon) detail.icon = resolveAssetUrl(detail.icon, origin) ?? detail.icon;
        for (const member of detail.members) {
          normalizeUserAssets(member.user, origin);
        }
      }
      set({
        currentSpaceId: spaceId,
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

  createSpace: async (name: string, icon?: string) => {
    const space =await api.spaces.create({ name, icon });
    const tagged: TaggedSpace = { ...space, _instanceOrigin: '' };
    set((state) => ({ spaces: [...state.spaces, tagged] }));
    return space;
  },

  updateSpace: async (spaceId: string, data: UpdateSpaceRequest) => {
    const updated = await api.spaces.update(spaceId, data);
    set((state) => ({
      spaces: state.spaces.map(s => s.id === spaceId ? { ...s, ...updated } : s),
    }));
  },

  deleteSpace: async (spaceId: string) => {
    await api.spaces.delete(spaceId);
    set((state) => ({
      spaces: state.spaces.filter(s => s.id !== spaceId),
      currentSpaceId: state.currentSpaceId === spaceId ? null : state.currentSpaceId,
    }));
  },

  joinSpace: async (spaceId: string, inviteCode: string) => {
    const space =await api.spaces.join(spaceId, { inviteCode });
    set((state) => {
      if (state.spaces.find(s => s.id === space.id)) return state;
      return { spaces: [...state.spaces, { ...space, _instanceOrigin: '' } as TaggedSpace] };
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
      const space =await remoteApi.spaces.joinByCode(inviteCode);
      set((state) => {
        if (state.spaces.find(s => s.id === space.id)) return state;
        return { spaces: [...state.spaces, { ...space, _instanceOrigin: origin } as TaggedSpace] };
      });
      return space;
    }

    // Home instance
    const space =await api.spaces.joinByCode(inviteCode);
    set((state) => {
      if (state.spaces.find(s => s.id === space.id)) return state;
      return { spaces: [...state.spaces, { ...space, _instanceOrigin: '' } as TaggedSpace] };
    });
    return space;
  },

  generateInvite: async (spaceId: string) => {
    const space =get().spaces.find(s => s.id === spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    const result = await client.spaces.invite(spaceId);
    return result.inviteCode;
  },

  createChannel: async (spaceId: string, name: string, type: 'text' | 'voice' | 'video', topic?: string) => {
    const channel = await api.channels.create(spaceId, { name, type, topic });
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

  addSpace: (space: Space) => {
    set((state) => {
      if (state.spaces.find(s => s.id === space.id)) return state;
      return { spaces: [...state.spaces, { ...space, _instanceOrigin: '' } as TaggedSpace] };
    });
  },

  removeSpace: (spaceId: string) => {
    set((state) => ({
      spaces: state.spaces.filter(s => s.id !== spaceId),
      currentSpaceId: state.currentSpaceId === spaceId ? null : state.currentSpaceId,
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

  populateFromReady: (origin: string, spaces: SpaceWithChannelsAndMembers[], folders?: SpaceFolder[], dmChannels?: DmChannel[]) => {
    const isHome = !origin;

    // Tag all incoming servers with their instance origin
    const taggedSpaces: TaggedSpace[] = spaces.map(s => ({
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
    const existingFromOtherOrigins = get().spaces.filter(s => s._instanceOrigin !== origin);
    const mergedSpaces = [...existingFromOtherOrigins, ...taggedSpaces];

    // Build/merge maps for incoming channels
    const channelToSpaceMap = new Map(get().channelToSpaceMap);
    const channelLastMessageIds = new Map(get().channelLastMessageIds);
    const spacePermissions = new Map(get().spacePermissions);
    const channelPermissions = new Map(get().channelPermissions);
    const channelOriginMap = new Map(get().channelOriginMap);

    // If home, clear home-origin entries first to avoid stale data
    if (isHome) {
      for (const [key, val] of get().channelOriginMap) {
        if (val === origin) {
          channelToSpaceMap.delete(key);
          channelLastMessageIds.delete(key);
          channelPermissions.delete(key);
          channelOriginMap.delete(key);
        }
      }
      // Also clear server permissions for this origin
      for (const s of get().spaces) {
        if (s._instanceOrigin === origin) {
          spacePermissions.delete(s.id);
        }
      }
    } else {
      // Remote: clear entries that belonged to this origin
      for (const [key, val] of get().channelOriginMap) {
        if (val === origin) {
          channelToSpaceMap.delete(key);
          channelLastMessageIds.delete(key);
          channelPermissions.delete(key);
          channelOriginMap.delete(key);
        }
      }
      for (const s of get().spaces) {
        if (s._instanceOrigin === origin) {
          spacePermissions.delete(s.id);
        }
      }
    }

    // Populate maps from incoming servers
    for (const srv of spaces) {
      if (srv.myPermissions) {
        spacePermissions.set(srv.id, srv.myPermissions);
      }
      for (const ch of srv.channels) {
        channelToSpaceMap.set(ch.id, srv.id);
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

    const update: Partial<SpaceState> = {
      spaces: mergedSpaces,
      dmChannels: mergedDms,
      channelToSpaceMap,
      channelLastMessageIds,
      spacePermissions,
      channelPermissions,
      channelOriginMap,
    };

    // Only set folders from home origin
    if (isHome) {
      update.folders = folders || [];
    }

    set(update as any);
  },

  addSpaceFromReady: (origin: string, space: SpaceWithChannelsAndMembers) => {
    const tagged: TaggedSpace = {
      id: space.id,
      name: space.name,
      icon: space.icon,
      ownerId: space.ownerId,
      inviteCode: space.inviteCode,
      visibility: space.visibility,
      description: space.description,
      createdAt: space.createdAt,
      _instanceOrigin: origin,
    };

    const channelToSpaceMap = new Map(get().channelToSpaceMap);
    const channelLastMessageIds = new Map(get().channelLastMessageIds);
    const spacePermissions = new Map(get().spacePermissions);
    const channelPermissions = new Map(get().channelPermissions);
    const channelOriginMap = new Map(get().channelOriginMap);

    if (space.myPermissions) {
      spacePermissions.set(space.id, space.myPermissions);
    }
    for (const ch of space.channels) {
      channelToSpaceMap.set(ch.id, space.id);
      channelOriginMap.set(ch.id, origin);
      if (ch.lastMessageId) {
        channelLastMessageIds.set(ch.id, ch.lastMessageId);
      }
      if (ch.myPermissions) {
        channelPermissions.set(ch.id, ch.myPermissions);
      }
    }

    set((state) => ({
      spaces: [...state.spaces.filter(s => s.id !== space.id), tagged],
      channelToSpaceMap,
      channelLastMessageIds,
      spacePermissions,
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

  removeInstanceSpaces: (origin: string) => {
    set((state) => {
      const remainingSpaces = state.spaces.filter(s => s._instanceOrigin !== origin);

      // Clean up maps for channels that belonged to this origin
      const channelToSpaceMap = new Map(state.channelToSpaceMap);
      const channelLastMessageIds = new Map(state.channelLastMessageIds);
      const channelPermissions = new Map(state.channelPermissions);
      const channelOriginMap = new Map(state.channelOriginMap);
      const spacePermissions = new Map(state.spacePermissions);

      for (const [channelId, chOrigin] of state.channelOriginMap) {
        if (chOrigin === origin) {
          channelToSpaceMap.delete(channelId);
          channelLastMessageIds.delete(channelId);
          channelPermissions.delete(channelId);
          channelOriginMap.delete(channelId);
        }
      }
      for (const s of state.spaces) {
        if (s._instanceOrigin === origin) {
          spacePermissions.delete(s.id);
        }
      }

      return {
        spaces: remainingSpaces,
        channelToSpaceMap,
        channelLastMessageIds,
        channelPermissions,
        channelOriginMap,
        spacePermissions,
        currentSpaceId: remainingSpaces.find(s => s.id === state.currentSpaceId)
          ? state.currentSpaceId
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
  const dmChannels = useSpaceStore.getState().dmChannels;
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
  return useSpaceStore.getState().channelOriginMap.get(channelId) ?? '';
}

// ─── API client resolution ────────────────────────────────────────────────────
// The actual resolver is registered by instanceStore on import, avoiding a
// circular dependency (instanceStore → useWebSocket → chatStore → spaceStore).

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
