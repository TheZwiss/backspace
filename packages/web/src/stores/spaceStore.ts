import { create } from 'zustand';
import type { Space, Channel, ChannelCategory, MemberWithUser, SpaceWithChannelsAndMembers, Role, SpaceFolder, SpaceLayoutItem, DmChannel, User, UpdateSpaceRequest, CreateSpaceRequest } from '@backspace/shared';
import { api, BackspaceApiClient } from '../api/client';
import { resolveAssetUrl, normalizeUserAssets } from '../utils/assetUrls';
import { isSelf } from '../utils/identity';
import { sortDmChannels } from '../utils/dmSorting';
import { useAuthStore } from './authStore';
import { useChatStore } from './chatStore';

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
  categories: ChannelCategory[];
  members: MemberWithUser[];
  roles: Role[];
  folders: SpaceFolder[];
  spaceLayout: SpaceLayoutItem[] | null;
  dmChannels: DmChannel[];
  channelToSpaceMap: Map<string, string>;
  channelLastMessageIds: Map<string, string>;
  spacePermissions: Map<string, string>; // spaceId → myPermissions decimal string
  channelPermissions: Map<string, string>; // channelId → myPermissions decimal string
  channelOriginMap: Map<string, string>; // channelId → instance origin ('' = home)
  voiceChannelIds: Set<string>; // channelIds that are voice channels (excluded from unread)
  categoryOriginMap: Map<string, string>; // categoryId → instance origin ('' = home)
  /** federatedId → (origin → localChannelId). Every DM from every origin's ready payload is recorded here regardless of dedup outcome, so failover can re-point to an alternate origin's local channel ID. */
  dmAlternatives: Map<string, Map<string, string>>;
  loadingSpaceId: string | null; // non-null while loadSpaceDetail is fetching
  _layoutUpdatedAt: number;
  setSpaces: (spaces: TaggedSpace[]) => void;
  setCurrentSpace: (spaceId: string | null) => void;
  setChannels: (channels: Channel[]) => void;
  setCategories: (categories: ChannelCategory[]) => void;
  setMembers: (members: MemberWithUser[]) => void;
  setRoles: (roles: Role[]) => void;
  setDmChannels: (channels: DmChannel[]) => void;
  addDmChannel: (channel: DmChannel, origin?: string) => void;
  removeDmChannel: (id: string) => void;
  addDmMember: (dmChannelId: string, user: User) => void;
  removeDmMember: (dmChannelId: string, userId: string) => void;
  updateDmOwner: (dmChannelId: string, newOwnerId: string) => void;
  closeDm: (id: string) => Promise<void>;
  leaveDm: (id: string) => Promise<void>;
  loadSpaces: () => Promise<void>;
  loadSpaceDetail: (spaceId: string) => Promise<void>;
  createSpace: (data: CreateSpaceRequest) => Promise<Space>;
  updateSpace: (spaceId: string, data: UpdateSpaceRequest) => Promise<void>;
  deleteSpace: (spaceId: string) => Promise<void>;
  joinSpace: (spaceId: string, inviteCode: string) => Promise<void>;
  leaveSpace: (spaceId: string) => Promise<void>;
  joinByCode: (inviteCode: string, origin?: string) => Promise<Space>;
  generateInvite: (spaceId: string) => Promise<string>;
  createChannel: (spaceId: string, name: string, type: 'text' | 'voice', topic?: string, categoryId?: string) => Promise<Channel>;
  deleteChannel: (channelId: string) => Promise<void>;
  createCategory: (spaceId: string, name: string) => Promise<ChannelCategory>;
  updateCategory: (categoryId: string, data: { name?: string; position?: number }) => Promise<void>;
  deleteCategory: (categoryId: string) => Promise<void>;
  updateChannelLayout: (spaceId: string, data: { channels: Array<{ id: string; position: number; categoryId: string | null }>; categories: Array<{ id: string; position: number }> }) => Promise<void>;
  addSpace: (space: Space) => void;
  removeSpace: (spaceId: string) => void;
  updateMemberPresence: (userId: string, status: string) => void;
  updateUserEverywhere: (user: User) => void;
  addMember: (member: MemberWithUser) => void;
  removeMember: (userId: string) => void;
  setSpaceLayout: (layout: SpaceLayoutItem[] | null) => void;
  updateSpaceLayout: (items: SpaceLayoutItem[], folders: Record<string, { name: string | null; color: string | null; spaceIds: string[] }>) => Promise<void>;
  populateFromReady: (origin: string, spaces: SpaceWithChannelsAndMembers[], folders?: SpaceFolder[], dmChannels?: DmChannel[], spaceLayout?: SpaceLayoutItem[] | null, layoutUpdatedAt?: number) => void;
  addSpaceFromReady: (origin: string, space: SpaceWithChannelsAndMembers) => void;
  removeInstanceSpaces: (origin: string) => void;
  transferOwnership: (spaceId: string, newOwnerId: string) => Promise<void>;
  findExistingDmForUser: (targetUser: { id: string; homeUserId?: string | null }) => { dm: DmChannel; origin: string } | null;
  reset: () => void;
}

/**
 * Push the current layout to a specific origin whose layout was older.
 * Used when populateFromReady receives a stale layout from an instance.
 */
async function pushLayoutToOrigin(
  origin: string,
  layout: SpaceLayoutItem[] | null,
  folders: SpaceFolder[],
  updatedAt: number,
): Promise<void> {
  try {
    const targetApi = getApiForOrigin(origin);
    // Build folder map from SpaceFolder[]
    const folderMap: Record<string, { name: string | null; color: string | null; spaceIds: string[] }> = {};
    for (const f of folders) {
      folderMap[f.id] = { name: f.name, color: f.color, spaceIds: f.spaceIds };
    }
    await targetApi.spaceLayout.update({
      items: layout ?? [],
      folders: folderMap,
      updatedAt,
    });
  } catch (err) {
    console.warn(`[SpaceStore] Failed to push layout to ${origin || 'home'}:`, err);
  }
}

export const useSpaceStore = create<SpaceState>((set, get) => ({
  spaces: [],
  currentSpaceId: null,
  channels: [],
  categories: [],
  members: [],
  roles: [],
  folders: [],
  spaceLayout: null,
  dmChannels: [],
  channelToSpaceMap: new Map(),
  channelLastMessageIds: new Map(),
  spacePermissions: new Map(),
  channelPermissions: new Map(),
  channelOriginMap: new Map(),
  voiceChannelIds: new Set(),
  categoryOriginMap: new Map(),
  dmAlternatives: new Map(),
  loadingSpaceId: null,
  _layoutUpdatedAt: 0,

  reset: () => {
    _myUserIdByOrigin.clear();
    set({
      spaces: [],
      currentSpaceId: null,
      channels: [],
      categories: [],
      members: [],
      roles: [],
      folders: [],
      spaceLayout: null,
      dmChannels: [],
      channelToSpaceMap: new Map(),
      channelLastMessageIds: new Map(),
      spacePermissions: new Map(),
      channelPermissions: new Map(),
      channelOriginMap: new Map(),
      voiceChannelIds: new Set(),
      categoryOriginMap: new Map(),
      dmAlternatives: new Map(),
      loadingSpaceId: null,
      _layoutUpdatedAt: 0,
    });
  },

  setSpaces: (spaces) => set({ spaces }),
  setCurrentSpace: (spaceId) => set({ currentSpaceId: spaceId }),
  setChannels: (channels) => set({ channels }),
  setCategories: (categories) => set({ categories }),
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

  removeDmChannel: (id) => {
    set((state) => ({
      dmChannels: state.dmChannels.filter(c => c.id !== id)
    }));
    // Clean up unread/read state for the closed DM
    useChatStore.getState().removeChannelStates(new Set([id]));
  },

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

  updateDmOwner: (dmChannelId, newOwnerId) => set((state) => ({
    dmChannels: state.dmChannels.map(dm =>
      dm.id === dmChannelId ? { ...dm, ownerId: newOwnerId } : dm
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

  leaveDm: async (id) => {
    const origin = get().channelOriginMap.get(id) || '';
    const targetApi = getApiForOrigin(origin);
    await targetApi.dm.leave(id);
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
      set({ loadingSpaceId: spaceId });
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

      // Populate permission maps from REST response
      const spacePermissions = new Map(get().spacePermissions);
      const channelPermissions = new Map(get().channelPermissions);
      if (detail.myPermissions) {
        spacePermissions.set(spaceId, detail.myPermissions);
      }
      for (const ch of detail.channels) {
        if (ch.myPermissions) {
          channelPermissions.set(ch.id, ch.myPermissions);
        }
      }

      set({
        loadingSpaceId: null,
        currentSpaceId: spaceId,
        channels: detail.channels.sort((a, b) => a.position - b.position),
        categories: (detail.categories || []).sort((a, b) => a.position - b.position),
        members: detail.members,
        roles: detail.roles.sort((a, b) => b.position - a.position),
        spacePermissions,
        channelPermissions,
      });
    } catch {
      set({ loadingSpaceId: null });
    }
  },

  createSpace: async (data: CreateSpaceRequest) => {
    const space = await api.spaces.create(data);
    const tagged: TaggedSpace = { ...space, _instanceOrigin: '' };
    set((state) => ({ spaces: [...state.spaces, tagged] }));
    return space;
  },

  updateSpace: async (spaceId: string, data: UpdateSpaceRequest) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    const updated = await client.spaces.update(spaceId, data);
    // Normalize remote asset URLs so the icon/banner display correctly in-app
    if (origin && updated.icon) {
      updated.icon = resolveAssetUrl(updated.icon, origin) ?? updated.icon;
    }
    if (origin && updated.banner) {
      updated.banner = resolveAssetUrl(updated.banner, origin) ?? updated.banner;
    }
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

  leaveSpace: async (spaceId: string) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = (space as TaggedSpace)?._instanceOrigin ?? '';
    const targetApi = getApiForOrigin(origin);
    const userId = getMyUserIdForOrigin(origin);
    if (!userId) return;
    await targetApi.spaces.removeMember(spaceId, userId);
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
      if (space.icon) space.icon = resolveAssetUrl(space.icon, origin) ?? space.icon;
      if (space.banner) space.banner = resolveAssetUrl(space.banner, origin) ?? space.banner;
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

  createChannel: async (spaceId: string, name: string, type: 'text' | 'voice', topic?: string, categoryId?: string) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    const channel = await client.channels.create(spaceId, { name, type, topic, categoryId });
    set((state) => {
      if (state.channels.some(c => c.id === channel.id)) return state;
      return { channels: [...state.channels, channel].sort((a, b) => a.position - b.position) };
    });
    return channel;
  },

  deleteChannel: async (channelId: string) => {
    const origin = get().channelOriginMap.get(channelId) ?? '';
    const channelApi = getApiForOrigin(origin);
    await channelApi.channels.delete(channelId);
    set((state) => ({
      channels: state.channels.filter(c => c.id !== channelId),
    }));
  },

  createCategory: async (spaceId: string, name: string) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    const category = await client.categories.create(spaceId, name);
    // Will be added via WS event, but add optimistically
    set((state) => {
      if (state.categories.some(c => c.id === category.id)) return state;
      return { categories: [...state.categories, category].sort((a, b) => a.position - b.position) };
    });
    return category;
  },

  updateCategory: async (categoryId: string, data: { name?: string; position?: number }) => {
    const cat = get().categories.find(c => c.id === categoryId);
    if (!cat) return;
    const space = get().spaces.find(s => s.id === cat.spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    await client.categories.update(categoryId, data);
    // WS event will update the store
  },

  deleteCategory: async (categoryId: string) => {
    const cat = get().categories.find(c => c.id === categoryId);
    if (!cat) return;
    const space = get().spaces.find(s => s.id === cat.spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    await client.categories.delete(categoryId);
    // WS events will update the store
  },

  updateChannelLayout: async (spaceId: string, data: { channels: Array<{ id: string; position: number; categoryId: string | null }>; categories: Array<{ id: string; position: number }> }) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    await client.channels.updateLayout(spaceId, data);
    // WS event will broadcast the updated layout
  },

  addSpace: (space: Space) => {
    set((state) => {
      if (state.spaces.find(s => s.id === space.id)) return state;
      return { spaces: [...state.spaces, { ...space, _instanceOrigin: '' } as TaggedSpace] };
    });
  },

  removeSpace: (spaceId: string) => {
    // Collect channel IDs before set() so we can clean up chatStore after
    const currentState = get();
    const channelIdsToRemove = new Set<string>();
    for (const [channelId, sid] of currentState.channelToSpaceMap) {
      if (sid === spaceId) channelIdsToRemove.add(channelId);
    }

    set((state) => {
      const channelToSpaceMap = new Map(state.channelToSpaceMap);
      const channelPermissions = new Map(state.channelPermissions);
      const channelOriginMap = new Map(state.channelOriginMap);
      const channelLastMessageIds = new Map(state.channelLastMessageIds);
      const spacePermissions = new Map(state.spacePermissions);

      for (const channelId of channelIdsToRemove) {
        channelToSpaceMap.delete(channelId);
        channelPermissions.delete(channelId);
        channelOriginMap.delete(channelId);
        channelLastMessageIds.delete(channelId);
      }
      spacePermissions.delete(spaceId);

      return {
        spaces: state.spaces.filter(s => s.id !== spaceId),
        currentSpaceId: state.currentSpaceId === spaceId ? null : state.currentSpaceId,
        channelToSpaceMap,
        channelPermissions,
        channelOriginMap,
        channelLastMessageIds,
        spacePermissions,
      };
    });

    // Clean up orphaned unread/read states and cached messages in chatStore
    if (channelIdsToRemove.size > 0) {
      useChatStore.getState().removeChannelStates(channelIdsToRemove);
    }
  },

  updateMemberPresence: (userId: string, status: string) => {
    set((state) => ({
      members: state.members.map(m =>
        m.userId === userId ? { ...m, user: { ...m.user, status: status as 'online' | 'idle' | 'dnd' | 'offline' } } : m
      ),
    }));
  },

  updateUserEverywhere: (user: User) => {
    set((state) => ({
      members: state.members.map(m =>
        m.userId === user.id ? { ...m, user: { ...m.user, ...user } } : m
      ),
      dmChannels: state.dmChannels.map(dm => ({
        ...dm,
        members: dm.members.map(m =>
          m.id === user.id ? { ...m, ...user } : m
        ),
      })),
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

  setSpaceLayout: (layout) => set({ spaceLayout: layout }),

  updateSpaceLayout: async (items, folders) => {
    const now = Date.now();
    // Optimistic: apply the layout immediately with new timestamp
    set({ spaceLayout: items, _layoutUpdatedAt: now });

    // Push to ALL connected instances in parallel (browsing + remotes)
    const targets: { origin: string; apiClient: BackspaceApiClient }[] = [
      { origin: '', apiClient: api },
    ];

    // Dynamically import instanceStore to avoid circular dep
    try {
      const { useInstanceStore } = await import('./instanceStore');
      const connected = useInstanceStore.getState().instances.filter(i => i.status === 'connected');
      for (const inst of connected) {
        targets.push({ origin: inst.origin, apiClient: inst.api });
      }
    } catch { /* instanceStore not available yet */ }

    const results = await Promise.allSettled(
      targets.map(t => t.apiClient.spaceLayout.update({ items, folders, updatedAt: now }))
    );

    // Use the first successful response to resolve new:* IDs
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const resolved = result.value;
        set({
          spaceLayout: resolved.items,
          folders: resolved.folders,
          _layoutUpdatedAt: resolved.updatedAt ?? now,
        });
        break;
      }
    }
  },

  populateFromReady: (origin: string, spaces: SpaceWithChannelsAndMembers[], folders?: SpaceFolder[], dmChannels?: DmChannel[], spaceLayout?: SpaceLayoutItem[] | null, layoutUpdatedAt?: number) => {
    const isHome = !origin;

    // Tag all incoming servers with their instance origin
    const taggedSpaces: TaggedSpace[] = spaces.map(s => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      banner: s.banner ?? null,
      avatarColor: s.avatarColor ?? null,
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
    const voiceChannelIds = new Set(get().voiceChannelIds);
    const categoryOriginMap = new Map(get().categoryOriginMap);
    const dmAlternatives = new Map<string, Map<string, string>>();
    for (const [fid, byOrigin] of get().dmAlternatives) {
      dmAlternatives.set(fid, new Map(byOrigin));
    }

    // If home, clear home-origin entries first to avoid stale data
    if (isHome) {
      for (const [key, val] of get().channelOriginMap) {
        if (val === origin) {
          channelToSpaceMap.delete(key);
          channelLastMessageIds.delete(key);
          channelPermissions.delete(key);
          channelOriginMap.delete(key);
          voiceChannelIds.delete(key);
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
          voiceChannelIds.delete(key);
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
        if (ch.type === 'voice') {
          voiceChannelIds.add(ch.id);
        } else if (ch.lastMessageId) {
          channelLastMessageIds.set(ch.id, ch.lastMessageId);
        }
        if (ch.myPermissions) {
          channelPermissions.set(ch.id, ch.myPermissions);
        }
      }
      if (srv.categories) {
        for (const cat of srv.categories) {
          categoryOriginMap.set(cat.id, origin);
        }
      }
    }

    // Accept DMs from all origins. Each instance serves its own DM data.
    const incomingDms = dmChannels ?? [];

    // Normalize asset URLs for remote-origin DMs
    if (origin !== '') {
      for (const dm of incomingDms) {
        for (const member of dm.members) {
          normalizeUserAssets(member, origin);
        }
      }
    }

    // Build a set of existing federatedIds for dedup (only from OTHER origins —
    // DMs from the reconnecting origin will be replaced, not deduplicated)
    const existingFederatedIds = new Map<string, string>(); // federatedId → dmChannelId
    for (const dm of get().dmChannels) {
      if (dm.federatedId) {
        const dmOrigin = get().channelOriginMap.get(dm.id);
        if (dmOrigin !== origin) {
          existingFederatedIds.set(dm.federatedId, dm.id);
        }
      }
    }

    // Filter incoming DMs: skip duplicates (same federatedId already loaded from another origin)
    const filteredDms: typeof incomingDms = [];
    for (const dm of incomingDms) {
      if (dm.federatedId && existingFederatedIds.has(dm.federatedId)) {
        // Duplicate cross-instance DM — keep the existing copy
        continue;
      }
      filteredDms.push(dm);
      if (dm.federatedId) {
        existingFederatedIds.set(dm.federatedId, dm.id);
      }
    }

    for (const dm of filteredDms) {
      channelOriginMap.set(dm.id, origin);
      if (dm.lastMessage?.id) {
        channelLastMessageIds.set(dm.id, dm.lastMessage.id);
      }
    }

    // Record every DM's (origin → localChannelId) for failover lookup,
    // regardless of whether the dedup pass kept this copy in dmChannels.
    for (const dm of incomingDms) {
      if (!dm.federatedId) continue;
      let byOrigin = dmAlternatives.get(dm.federatedId);
      if (!byOrigin) {
        byOrigin = new Map();
        dmAlternatives.set(dm.federatedId, byOrigin);
      }
      byOrigin.set(origin, dm.id);
    }

    // Merge: remove DMs belonging to this origin from existing state, then append incoming
    const existingDmsFromOtherOrigins = get().dmChannels.filter(dm => {
      const dmOrigin = get().channelOriginMap.get(dm.id);
      return dmOrigin !== origin;
    });
    const mergedDms = [...existingDmsFromOtherOrigins, ...filteredDms];

    // Sort DMs using unread-first ordering. On initial load, unreadChannels may
    // still be empty (read states are processed after populateFromReady); the
    // safety-net re-sort in setReadStates handles that case.
    const { unreadChannels, currentChannelId } = useChatStore.getState();
    const sortedDms = sortDmChannels(mergedDms, unreadChannels, currentChannelId);

    const update: Partial<SpaceState> = {
      spaces: mergedSpaces,
      dmChannels: sortedDms,
      channelToSpaceMap,
      channelLastMessageIds,
      spacePermissions,
      channelPermissions,
      channelOriginMap,
      voiceChannelIds,
      categoryOriginMap,
      dmAlternatives,
    };

    // LWW layout merge: accept incoming layout only if its timestamp is >= ours
    const incomingTs = layoutUpdatedAt ?? 0;
    const currentTs = get()._layoutUpdatedAt;
    if (incomingTs >= currentTs) {
      // Incoming is same age or newer — accept
      update.folders = folders || [];
      if (spaceLayout !== undefined) {
        update.spaceLayout = spaceLayout ?? null;
      }
      (update as any)._layoutUpdatedAt = incomingTs;
    } else {
      // Our layout is newer — push back to this instance
      pushLayoutToOrigin(origin, get().spaceLayout, get().folders, currentTs);
    }

    set(update as any);
  },

  addSpaceFromReady: (origin: string, space: SpaceWithChannelsAndMembers) => {
    // Normalize remote asset URLs before creating the tagged object
    if (origin) {
      if (space.icon) space.icon = resolveAssetUrl(space.icon, origin) ?? space.icon;
      if (space.banner) space.banner = resolveAssetUrl(space.banner, origin) ?? space.banner;
    }

    const tagged: TaggedSpace = {
      id: space.id,
      name: space.name,
      icon: space.icon,
      banner: space.banner ?? null,
      avatarColor: space.avatarColor ?? null,
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

  transferOwnership: async (spaceId: string, newOwnerId: string) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = (space as TaggedSpace)?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    const updated = await client.spaces.transferOwnership(spaceId, newOwnerId);
    if (origin && updated.icon) {
      updated.icon = resolveAssetUrl(updated.icon, origin) ?? updated.icon;
    }
    if (origin && updated.banner) {
      updated.banner = resolveAssetUrl(updated.banner, origin) ?? updated.banner;
    }
    set((state) => ({
      spaces: state.spaces.map(s =>
        s.id === spaceId ? { ...s, ...updated, _instanceOrigin: origin } as TaggedSpace : s
      ),
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
    // Collect channel IDs before set() for chatStore cleanup
    const currentState = get();
    const channelIdsToRemove = new Set<string>();
    for (const [channelId, chOrigin] of currentState.channelOriginMap) {
      if (chOrigin === origin) channelIdsToRemove.add(channelId);
    }

    set((state) => {
      const remainingSpaces = state.spaces.filter(s => s._instanceOrigin !== origin);

      // Clean up maps for channels that belonged to this origin
      const channelToSpaceMap = new Map(state.channelToSpaceMap);
      const channelLastMessageIds = new Map(state.channelLastMessageIds);
      const channelPermissions = new Map(state.channelPermissions);
      const channelOriginMap = new Map(state.channelOriginMap);
      const spacePermissions = new Map(state.spacePermissions);

      for (const channelId of channelIdsToRemove) {
        channelToSpaceMap.delete(channelId);
        channelLastMessageIds.delete(channelId);
        channelPermissions.delete(channelId);
        channelOriginMap.delete(channelId);
      }
      for (const s of state.spaces) {
        if (s._instanceOrigin === origin) {
          spacePermissions.delete(s.id);
        }
      }

      // Prune dmAlternatives: drop this origin from every inner map.
      const dmAlternatives = new Map<string, Map<string, string>>();
      for (const [fid, byOrigin] of state.dmAlternatives) {
        const nextInner = new Map(byOrigin);
        nextInner.delete(origin);
        if (nextInner.size > 0) dmAlternatives.set(fid, nextInner);
      }

      return {
        spaces: remainingSpaces,
        channelToSpaceMap,
        channelLastMessageIds,
        channelPermissions,
        channelOriginMap,
        spacePermissions,
        dmAlternatives,
        currentSpaceId: remainingSpaces.find(s => s.id === state.currentSpaceId)
          ? state.currentSpaceId
          : null,
      };
    });

    // Clean up orphaned unread/read states and cached messages in chatStore
    if (channelIdsToRemove.size > 0) {
      useChatStore.getState().removeChannelStates(channelIdsToRemove);
    }
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

/**
 * Resolves a raw DM channel ID to its primary `dmChannels` entry ID.
 *
 * - If `rawId` is already a primary entry: returns `rawId` unchanged.
 * - If `rawId` is recorded in `dmAlternatives` as an alternate-origin local ID
 *   for a DM whose primary is present in `dmChannels`: returns the primary's ID.
 * - Otherwise: returns `null` (unknown ID — caller should no-op).
 *
 * Used by:
 *  - `dm_message_created` WS handler to route messages arriving from alternate
 *    origins to the primary entry (§3.11 of the failover spec).
 *  - Future DM WS handlers that need to dedup alternate-origin deliveries.
 */
export function resolveDmChannelId(rawId: string): string | null {
  const { dmChannels, dmAlternatives } = useSpaceStore.getState();
  if (dmChannels.some(dm => dm.id === rawId)) return rawId;

  for (const [federatedId, byOrigin] of dmAlternatives) {
    for (const localId of byOrigin.values()) {
      if (localId !== rawId) continue;
      const primary = dmChannels.find(dm => dm.federatedId === federatedId);
      return primary ? primary.id : null;
    }
  }
  return null;
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

// ─── Hostname → origin resolution (federation) ────────────────────────────────
// Converts a user's `homeInstance` hostname (e.g. "remote.example.com") to a
// full origin URL (e.g. "https://remote.example.com") by looking up connected
// instances.  Registered by instanceStore on import.

let _resolveOriginFromHostname: ((hostname: string) => string) | null = null;

export function setOriginFromHostnameResolver(resolver: (hostname: string) => string): void {
  _resolveOriginFromHostname = resolver;
}

/**
 * Returns the instance origin for a federated user based on their homeInstance.
 * '' = home/local user, 'https://...' = remote instance.
 */
export function resolveUserOrigin(user: { homeInstance?: string | null }): string {
  const host = user.homeInstance;
  if (!host || host === window.location.host) return '';
  return _resolveOriginFromHostname?.(host) ?? '';
}

/**
 * Returns the origin that is authoritative for this user's space layout.
 * '' = browsing instance (native users, or true home not yet connected).
 * 'https://...' = connected remote that is the user's true home.
 */
export function getLayoutHomeOrigin(): string {
  const user = useAuthStore.getState().user;
  if (!user?.homeInstance) return '';
  return _resolveOriginFromHostname?.(user.homeInstance) ?? '';
}

// ─── User ID resolution (federation) ──────────────────────────────────────────
// Same resolver pattern as getApiForOrigin — registered by instanceStore on
// import to break the circular dependency chain.

let _getUserIdForOrigin: ((origin: string) => string | undefined) | null = null;

export function setUserIdForOriginResolver(resolver: (origin: string) => string | undefined): void {
  _getUserIdForOrigin = resolver;
}

// Direct identity cache populated from WS ready events.
// Bypasses the instanceStore resolver for reliable federation support.
const _myUserIdByOrigin = new Map<string, string>();

export function setMyUserIdForOrigin(origin: string, userId: string): void {
  _myUserIdByOrigin.set(origin, userId);
}

/**
 * Returns the local user's ID on a given instance origin.
 * '' or falsy = home instance (returns authStore user ID).
 * 'https://...' = remote instance (returns the federated user ID on that instance).
 */
export function getMyUserIdForOrigin(origin: string): string | undefined {
  if (!origin) return useAuthStore.getState().user?.id;
  // Direct cache (populated from WS ready) takes priority — always correct
  const cached = _myUserIdByOrigin.get(origin);
  if (cached) return cached;
  // Fallback to instanceStore resolver (may have placeholder user during connection)
  return _getUserIdForOrigin?.(origin);
}
