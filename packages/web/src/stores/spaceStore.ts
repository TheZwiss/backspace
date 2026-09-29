import type {
  Channel,
  ChannelCategory,
  CreateSpaceRequest,
  DmChannel,
  DmMessageWithUser,
  MemberWithUser,
  Role,
  Space,
  SpaceFolder,
  SpaceLayoutItem,
  SpaceWithChannelsAndMembers,
  UpdateChannelRequest,
  UpdateSpaceRequest,
  User,
} from '@backspace/shared';
import { create } from 'zustand';
import { api, BackspaceApiClient } from '../api/client';
import { normalizeUserAssets, resolveAssetUrl } from '../utils/assetUrls';
import {
  clearMyUserIdCache,
  getApiForOrigin,
  getCachedUserIdForOrigin,
  resolveOriginFromHostname,
  resolveUserIdFromInstances,
  setOwnerInstanceForDmResolver,
} from '../utils/crossStoreResolvers';
import { locateDmChannel } from '../utils/dmChannelLookup';
import { deriveMissingOneOnOneKeys, type PeerDmChannel } from '../utils/dmConversationKey';
import { applyDmPinMoves } from '../utils/dmOriginFailover';
import { sortDmChannels } from '../utils/dmSorting';
import {
  activityKey,
  canonicalUserKey,
  isDeliveryFromHome,
  isSelf,
  type PresenceSubject,
} from '../utils/identity';
import { useAuthStore } from './authStore';
import { useChatStore } from './chatStore';
import {
  conversationCopyIndex,
  copyIdOnOrigin,
  copyOnOrigin,
  dropOrigin,
  EMPTY_DM_CONVERSATIONS,
  mergeOriginListing,
  patchCopy,
  patchEveryCopy,
  pinnedDmChannels,
  pinnedOriginByChannelId,
  removeCopy,
  setOriginAvailable,
  upsertCopy,
  upsertUnplacedCopy,
  type DmConversations,
  type DmOperation,
  type DmPinContext,
} from './dmConversations';
import { createAddSpaceFromReadySlice } from './spaceAddSpaceFromReadySlice';
import { createSpaceLayoutSlice, pushLayoutToOrigin } from './spaceLayoutSlice';
import { createPopulateFromReadySlice } from './spacePopulateFromReadySlice';
import { createRemoveInstanceSpacesSlice } from './spaceRemoveInstanceSpacesSlice';
import type { SpaceState } from './spaceStoreTypes';

// ─── Instance-aware types ─────────────────────────────────────────────────────

/** Server augmented with instance origin tracking (client-only, not in shared types). */
export type TaggedSpace = Space & { _instanceOrigin: string; ownerTitle?: string | null };

// ─── Error types ─────────────────────────────────────────────────────────────

/** Thrown when joinByCode targets a remote origin the user is not connected to. */
export class NotConnectedError extends Error {
  constructor(public origin: string) {
    super(`Not connected to ${origin}`);
    this.name = 'NotConnectedError';
  }
}

// ─── User-view cache types ────────────────────────────────────────────────────

/**
 * A single cached view of a user, populated from one delivering origin.
 *
 * The userViews cache stores the best-known view of each canonical identity
 * across every connected instance, regardless of whether the carrying channel
 * survived dedup. Mirrors `dmAlternatives` philosophy: information from
 * skipped ready payloads is still load-bearing for rendering.
 */
export interface UserViewEntry {
  user: User;
  deliveredBy: string;
  isHome: boolean;
  updatedAt: number;
}

// ─── Roster changes during a detail fetch ────────────────────────────────────

type RosterChange =
  | { kind: 'join'; member: MemberWithUser }
  | { kind: 'leave'; userId: string };

/** spaceId → the change logs of the loads in flight for it (one per load). */
const inFlightRosterLogs = new Map<string, Set<RosterChange[]>>();

function recordRosterChange(spaceId: string, change: RosterChange): void {
  const logs = inFlightRosterLogs.get(spaceId);
  if (!logs) return;
  for (const log of logs) log.push(change);
}

/** A change replayed onto a fetched roster: a join never replaces a fetched row. */
function replayRosterChange(members: MemberWithUser[], change: RosterChange): MemberWithUser[] {
  if (change.kind === 'join' && members.some(m => m.userId === change.member.userId)) return members;
  return applyRosterChange(members, change);
}

function applyRosterChange(members: MemberWithUser[], change: RosterChange): MemberWithUser[] {
  if (change.kind === 'join') {
    return [...members.filter(m => m.userId !== change.member.userId), change.member];
  }
  return members.filter(m => m.userId !== change.userId);
}

// ─── DM conversations: the derived view ──────────────────────────────────────

export type DmView = Pick<SpaceState, 'dmConversations' | 'dmChannels' | 'dmAlternatives' | 'channelOriginMap' | 'channelLastMessageIds'>;

/**
 * The store fields derived from `conversations`. `previousRows` are the DM
 * rows the maps held entries for until now; those entries are replaced, the
 * space-channel entries are kept.
 */
export function deriveDmView(
  conversations: DmConversations,
  previousRows: readonly DmChannel[],
  channelOriginMap: ReadonlyMap<string, string>,
  channelLastMessageIds: ReadonlyMap<string, string>,
): DmView {
  const origins = new Map(channelOriginMap);
  const lastMessageIds = new Map(channelLastMessageIds);
  for (const dm of previousRows) {
    origins.delete(dm.id);
    lastMessageIds.delete(dm.id);
  }
  const rows = pinnedDmChannels(conversations);
  for (const [channelId, origin] of pinnedOriginByChannelId(conversations)) origins.set(channelId, origin);
  for (const dm of rows) {
    if (dm.lastMessage?.id) lastMessageIds.set(dm.id, dm.lastMessage.id);
  }
  const { unreadChannels, currentChannelId } = useChatStore.getState();
  return {
    dmConversations: conversations,
    dmChannels: sortDmChannels(rows, unreadChannels, currentChannelId),
    dmAlternatives: conversationCopyIndex(conversations),
    channelOriginMap: origins,
    channelLastMessageIds: lastMessageIds,
  };
}

/** The pin rule's view of the session: the user's home is `getLayoutHomeOrigin()`. */
export function dmPinContext(): DmPinContext {
  return { home: getLayoutHomeOrigin() };
}

/**
 * Store the result of a DM operation, derive the view from it, and apply its
 * pin moves: the chat state and URL of a row follow it to its new channel id
 * (`applyDmPinMoves`), after which the list is re-sorted, since the moves
 * carried unread state to the new ids.
 */
export function commitDmOperation(op: DmOperation): void {
  if (op.next !== useSpaceStore.getState().dmConversations) {
    useSpaceStore.setState((state) =>
      deriveDmView(op.next, state.dmChannels, state.channelOriginMap, state.channelLastMessageIds),
    );
  }
  if (op.pinMoves.length === 0) return;
  applyDmPinMoves(op.pinMoves);
  useSpaceStore.getState().resortDmChannels();
}

// ─── Store implementation ───────────────────────────────────────────────────

export const useSpaceStore = create<SpaceState>((set, get, apiStore) => ({
  spaces: [],
  currentSpaceId: null,
  lastSelectedSpaceId: null,
  channels: [],
  categories: [],
  members: [],
  roles: [],
  folders: [],
  spaceLayout: null,
  dmConversations: EMPTY_DM_CONVERSATIONS,
  dmChannels: [],
  channelToSpaceMap: new Map(),
  channelLastMessageIds: new Map(),
  spacePermissions: new Map(),
  channelPermissions: new Map(),
  channelOriginMap: new Map(),
  voiceChannelIds: new Set(),
  categoryOriginMap: new Map(),
  dmAlternatives: new Map(),
  userViews: new Map(),
  loadingSpaceId: null,
  loadedSpaceIds: new Set(),
  _layoutUpdatedAt: 0,

  setSpaces: (spaces) => set({ spaces }),
  setCurrentSpace: (spaceId) =>
    set((state) => ({
      currentSpaceId: spaceId,
      lastSelectedSpaceId: spaceId !== null ? spaceId : state.lastSelectedSpaceId,
    })),
  setChannels: (channels) => set({ channels }),
  setCategories: (categories) => set({ categories }),
  setMembers: (members) => set({ members }),
  setRoles: (roles) => set({ roles }),

  // DM Actions
  upsertDmCopy: (origin, channel, keySource) => {
    const op = upsertCopy(get().dmConversations, origin, channel, keySource, dmPinContext());
    commitDmOperation(op);
    return op.pinnedChannelId;
  },

  placeUnplacedDmMessage: (origin, message) => {
    commitDmOperation(upsertUnplacedCopy(get().dmConversations, origin, message, dmPinContext()));
  },

  patchDmCopy: (channelId, patch) => {
    commitDmOperation(patchCopy(get().dmConversations, channelId, patch));
  },

  resortDmChannels: (currentChannelId) => set((state) => {
    if (state.dmChannels.length === 0) return state;
    const chat = useChatStore.getState();
    const current = currentChannelId !== undefined ? currentChannelId : chat.currentChannelId;
    return { dmChannels: sortDmChannels(state.dmChannels, chat.unreadChannels, current) };
  }),

  setDmOriginAvailable: (origin, available) => {
    commitDmOperation(setOriginAvailable(get().dmConversations, origin, available, dmPinContext()));
  },

  reloadDmsForOrigin: async (origin: string) => {
    const client = getApiForOrigin(origin);
    const listed: PeerDmChannel[] = await client.dm.list();
    const derivedKeys = await deriveMissingOneOnOneKeys(listed);

    if (origin !== '') {
      for (const dm of listed) {
        for (const member of dm.members) {
          normalizeUserAssets(member, origin);
        }
      }
    }

    const { upsertUserView } = get();
    for (const dm of listed) {
      for (const member of dm.members) {
        upsertUserView(member, origin);
      }
    }

    commitDmOperation(mergeOriginListing(get().dmConversations, origin, listed, derivedKeys, dmPinContext()));
  },

  upsertUserView: (user, deliveringOrigin) => set((state) => {
    const key = canonicalUserKey(user);
    const incomingIsHome = isDeliveryFromHome(user, deliveringOrigin);
    const existing = state.userViews.get(key);

    if (existing && existing.isHome && !incomingIsHome) return state;

    const next = new Map(state.userViews);
    next.set(key, {
      user,
      deliveredBy: deliveringOrigin,
      isHome: incomingIsHome,
      updatedAt: Date.now(),
    });
    return { userViews: next };
  }),

  removeDmChannel: (id) => {
    commitDmOperation(removeCopy(get().dmConversations, id, dmPinContext()));
    useChatStore.getState().removeChannelStates(new Set([id]));
  },

  addDmMember: (dmChannelId, user) => {
    commitDmOperation(patchCopy(get().dmConversations, dmChannelId, (dm) =>
      dm.members.some(m => m.id === user.id) ? dm : { ...dm, members: [...dm.members, user] },
    ));
  },

  removeDmMember: (dmChannelId, userId) => {
    commitDmOperation(patchCopy(get().dmConversations, dmChannelId, (dm) =>
      ({ ...dm, members: dm.members.filter(m => m.id !== userId) }),
    ));
  },

  updateDmOwner: (dmChannelId, newOwnerId, newOwnerHomeUserId, newOwnerHomeInstance) => {
    commitDmOperation(patchCopy(get().dmConversations, dmChannelId, (dm) => {
      const next = { ...dm, ownerId: newOwnerId };
      if (newOwnerHomeUserId !== undefined) next.ownerHomeUserId = newOwnerHomeUserId;
      if (newOwnerHomeInstance !== undefined) next.ownerHomeInstance = newOwnerHomeInstance;
      return next;
    }));
  },

  updateDmMetadata: (dmChannelId, patch) => {
    commitDmOperation(patchCopy(get().dmConversations, dmChannelId, (dm) => {
      const next = { ...dm };
      if ('name' in patch) next.name = patch.name ?? null;
      if ('icon' in patch) next.icon = patch.icon ?? null;
      return next;
    }));
  },

  closeDm: async (id) => {
    const origin = get().channelOriginMap.get(id) || '';
    const targetApi = getApiForOrigin(origin);
    await targetApi.dm.close(id);
    commitDmOperation(removeCopy(get().dmConversations, id, dmPinContext()));
  },

  leaveDm: async (id) => {
    const origin = get().channelOriginMap.get(id) || '';
    const targetApi = getApiForOrigin(origin);
    await targetApi.dm.leave(id);
    commitDmOperation(removeCopy(get().dmConversations, id, dmPinContext()));
  },

  setDmChannels: (channels) => set({ dmChannels: channels }),
  addDmChannel: (channel, origin = '') => {
    get().upsertDmCopy(origin, channel, 'stated');
  },

  // Space Actions
  loadSpaces: async () => {
    try {
      const spaces = await api.spaces.list();
      set((state) => ({
        spaces: spaces.map(s => ({ ...s, _instanceOrigin: '' })) as TaggedSpace[],
      }));
    } catch {
      // Silently fail - will be populated from WS ready
    }
  },

  loadSpaceDetail: async (spaceId: string) => {
    const rosterChanges: RosterChange[] = [];
    try {
      const space = get().spaces.find(s => s.id === spaceId);
      if (!space) return;
      set({ loadingSpaceId: spaceId });
      const origin = space._instanceOrigin ?? '';
      const client = getApiForOrigin(origin);

      const logs = inFlightRosterLogs.get(spaceId) ?? new Set<RosterChange[]>();
      logs.add(rosterChanges);
      inFlightRosterLogs.set(spaceId, logs);

      const detail = await client.spaces.get(spaceId);
      if (origin) {
        if (detail.icon) detail.icon = resolveAssetUrl(detail.icon, origin) ?? detail.icon;
        for (const member of detail.members) {
          normalizeUserAssets(member.user, origin);
        }
      }
      for (const member of detail.members) {
        get().upsertUserView(member.user, origin);
      }

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

      set((state) => {
        const loadedSpaceIds = new Set(state.loadedSpaceIds);
        loadedSpaceIds.add(spaceId);
        return {
          loadingSpaceId: null,
          currentSpaceId: spaceId,
          lastSelectedSpaceId: spaceId,
          channels: detail.channels.sort((a, b) => a.position - b.position),
          categories: (detail.categories || []).sort((a, b) => a.position - b.position),
          members: rosterChanges.reduce(replayRosterChange, detail.members),
          roles: detail.roles.sort((a, b) => b.position - a.position),
          spacePermissions,
          channelPermissions,
          loadedSpaceIds,
        };
      });
    } catch {
      set({ loadingSpaceId: null });
    } finally {
      const logs = inFlightRosterLogs.get(spaceId);
      logs?.delete(rosterChanges);
      if (logs?.size === 0) inFlightRosterLogs.delete(spaceId);
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
    set((state) => {
      const loadedSpaceIds = new Set(state.loadedSpaceIds);
      loadedSpaceIds.delete(spaceId);
      return {
        spaces: state.spaces.filter(s => s.id !== spaceId),
        currentSpaceId: state.currentSpaceId === spaceId ? null : state.currentSpaceId,
        lastSelectedSpaceId:
          state.lastSelectedSpaceId === spaceId ? null : state.lastSelectedSpaceId,
        loadedSpaceIds,
      };
    });
  },

  leaveSpace: async (spaceId: string) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = (space as TaggedSpace)?._instanceOrigin ?? '';
    const targetApi = getApiForOrigin(origin);
    const userId = getMyUserIdForOrigin(origin);
    if (!userId) return;
    await targetApi.spaces.removeMember(spaceId, userId);
    set((state) => {
      const loadedSpaceIds = new Set(state.loadedSpaceIds);
      loadedSpaceIds.delete(spaceId);
      return {
        spaces: state.spaces.filter(s => s.id !== spaceId),
        currentSpaceId: state.currentSpaceId === spaceId ? null : state.currentSpaceId,
        lastSelectedSpaceId:
          state.lastSelectedSpaceId === spaceId ? null : state.lastSelectedSpaceId,
        loadedSpaceIds,
      };
    });
  },

  joinSpace: async (spaceId: string, inviteCode: string) => {
    const space = await api.spaces.join(spaceId, { inviteCode });
    set((state) => {
      if (state.spaces.find(s => s.id === space.id)) return state;
      return { spaces: [...state.spaces, { ...space, _instanceOrigin: '' } as TaggedSpace] };
    });
  },

  joinByCode: async (inviteCode: string, origin?: string) => {
    if (origin && typeof window !== 'undefined' && origin === window.location.origin) {
      origin = undefined;
    }
    if (origin) {
      const { useInstanceStore } = await import('./instanceStore');
      const connected = useInstanceStore.getState().instances.some(
        (i) => i.origin === origin && i.status === 'connected',
      );
      if (!connected) throw new NotConnectedError(origin);

      const remoteApi = getApiForOrigin(origin);
      const space = await remoteApi.spaces.joinByCode(inviteCode);
      if (space.icon) space.icon = resolveAssetUrl(space.icon, origin) ?? space.icon;
      if (space.banner) space.banner = resolveAssetUrl(space.banner, origin) ?? space.banner;
      set((state) => {
        if (state.spaces.find(s => s.id === space.id)) return state;
        return { spaces: [...state.spaces, { ...space, _instanceOrigin: origin } as TaggedSpace] };
      });
      return space;
    }

    const space = await api.spaces.joinByCode(inviteCode);
    set((state) => {
      if (state.spaces.find(s => s.id === space.id)) return state;
      return { spaces: [...state.spaces, { ...space, _instanceOrigin: '' } as TaggedSpace] };
    });
    return space;
  },

  generateInvite: async (spaceId: string) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    const result = await client.spaces.invite(spaceId);
    return result.inviteCode;
  },

  // Channel & Category Actions
  createChannel: async (spaceId: string, name: string, type: 'text' | 'voice', topic?: string, categoryId?: string) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    const channel = await client.channels.create(spaceId, { name, type, topic, categoryId });
    get().upsertChannel(channel, spaceId, origin);
    return channel;
  },

  upsertChannel: (channel: Channel, spaceId: string, origin: string) => {
    set((state) => {
      state.channelToSpaceMap.set(channel.id, spaceId);
      state.channelOriginMap.set(channel.id, origin);
      if (channel.type === 'voice') state.voiceChannelIds.add(channel.id);

      const channelPermissions = new Map(state.channelPermissions);
      if (channel.myPermissions) {
        channelPermissions.set(channel.id, channel.myPermissions);
      }

      if (state.currentSpaceId !== spaceId) {
        return { channelPermissions };
      }
      const exists = state.channels.some(c => c.id === channel.id);
      const channels = (exists
        ? state.channels.map(c => (c.id === channel.id ? channel : c))
        : [...state.channels, channel]
      ).sort((a, b) => a.position - b.position);
      return { channels, channelPermissions };
    });
  },

  updateChannel: async (channelId: string, data: UpdateChannelRequest) => {
    const origin = get().channelOriginMap.get(channelId) ?? '';
    const channel = await getApiForOrigin(origin).channels.update(channelId, data);
    get().upsertChannel(channel, channel.spaceId, origin);
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
    set((state) => {
      if (state.categories.some(c => c.id === category.id)) return state;
      return { categories: [...state.categories, category].sort((a, b) => a.position - b.position) };
    });
    return category;
  },

  updateCategory: async (categoryId: string, data: { name?: string; position?: number }) => {
    const known = get().categories.find(c => c.id === categoryId);
    const space = known ? get().spaces.find(s => s.id === known.spaceId) : undefined;
    const origin = space?._instanceOrigin ?? get().categoryOriginMap.get(categoryId) ?? '';
    const category = await getApiForOrigin(origin).categories.update(categoryId, data);
    set((state) => ({
      categories: state.categories
        .map(c => (c.id === category.id ? category : c))
        .sort((a, b) => a.position - b.position),
    }));
    return category;
  },

  deleteCategory: async (categoryId: string) => {
    const cat = get().categories.find(c => c.id === categoryId);
    if (!cat) return;
    const space = get().spaces.find(s => s.id === cat.spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    await client.categories.delete(categoryId);
  },

  updateChannelLayout: async (spaceId: string, data: { channels: Array<{ id: string; position: number; categoryId: string | null }>; categories: Array<{ id: string; position: number }> }) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    await client.channels.updateLayout(spaceId, data);
  },

  addSpace: (space: Space) => {
    set((state) => {
      if (state.spaces.find(s => s.id === space.id)) return state;
      return { spaces: [...state.spaces, { ...space, _instanceOrigin: '' } as TaggedSpace] };
    });
  },

  removeSpace: (spaceId: string) => {
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

      const loadedSpaceIds = new Set(state.loadedSpaceIds);
      loadedSpaceIds.delete(spaceId);

      return {
        spaces: state.spaces.filter(s => s.id !== spaceId),
        currentSpaceId: state.currentSpaceId === spaceId ? null : state.currentSpaceId,
        lastSelectedSpaceId:
          state.lastSelectedSpaceId === spaceId ? null : state.lastSelectedSpaceId,
        channelToSpaceMap,
        channelPermissions,
        channelOriginMap,
        channelLastMessageIds,
        spacePermissions,
        loadedSpaceIds,
      };
    });

    if (channelIdsToRemove.size > 0) {
      useChatStore.getState().removeChannelStates(channelIdsToRemove);
    }
  },

  updateMemberPresence: (subject: PresenceSubject, origin: string, status: string) => {
    const key = activityKey(subject, origin);
    set((state) => {
      const typedStatus = status as 'online' | 'idle' | 'dnd' | 'offline';
      let nextUserViews = state.userViews;
      for (const [viewKey, entry] of state.userViews) {
        if (activityKey(entry.user, entry.deliveredBy) !== key) continue;
        if (nextUserViews === state.userViews) nextUserViews = new Map(state.userViews);
        nextUserViews.set(viewKey, { ...entry, user: { ...entry.user, status: typedStatus } });
      }

      const spaceOrigins = new Map<string, string>();
      const spaceOriginOf = (spaceId: string): string => {
        let spaceOrigin = spaceOrigins.get(spaceId);
        if (spaceOrigin === undefined) {
          spaceOrigin = state.spaces.find(s => s.id === spaceId)?._instanceOrigin ?? '';
          spaceOrigins.set(spaceId, spaceOrigin);
        }
        return spaceOrigin;
      };

      return {
        members: state.members.map(m =>
          activityKey(m.user, spaceOriginOf(m.spaceId)) === key ? { ...m, user: { ...m.user, status: typedStatus } } : m
        ),
        userViews: nextUserViews,
      };
    });
  },

  updateUserEverywhere: (user: User) => {
    set((state) => ({
      members: state.members.map(m =>
        m.userId === user.id ? { ...m, user: { ...m.user, ...user } } : m
      ),
    }));
    commitDmOperation(patchEveryCopy(get().dmConversations, (dm) =>
      dm.members.some(m => m.id === user.id)
        ? { ...dm, members: dm.members.map(m => (m.id === user.id ? { ...m, ...user } : m)) }
        : dm,
    ));
  },

  addMember: (spaceId: string, member: MemberWithUser) => {
    const change: RosterChange = { kind: 'join', member };
    recordRosterChange(spaceId, change);
    set((state) => ({ members: applyRosterChange(state.members, change) }));
  },

  removeMember: (spaceId: string, userId: string) => {
    const change: RosterChange = { kind: 'leave', userId };
    recordRosterChange(spaceId, change);
    set((state) => ({ members: applyRosterChange(state.members, change) }));
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

  reset: () => {
    clearMyUserIdCache();
    set({
      spaces: [],
      currentSpaceId: null,
      lastSelectedSpaceId: null,
      channels: [],
      categories: [],
      members: [],
      roles: [],
      folders: [],
      spaceLayout: null,
      dmConversations: EMPTY_DM_CONVERSATIONS,
      dmChannels: [],
      channelToSpaceMap: new Map(),
      channelLastMessageIds: new Map(),
      spacePermissions: new Map(),
      channelPermissions: new Map(),
      channelOriginMap: new Map(),
      voiceChannelIds: new Set(),
      categoryOriginMap: new Map(),
      dmAlternatives: new Map(),
      userViews: new Map(),
      loadingSpaceId: null,
      loadedSpaceIds: new Set(),
      _layoutUpdatedAt: 0,
    });
  },

  // Slices
  ...createPopulateFromReadySlice(set, get, apiStore),
  ...createAddSpaceFromReadySlice(set, get, apiStore),
  ...createRemoveInstanceSpacesSlice(set, get, apiStore),
  ...createSpaceLayoutSlice(set, get, apiStore),
}));

export { pushLayoutToOrigin };

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
 * Returns the owner's home-instance origin for a group DM, or '' for the
 * local home instance.
 */
export function getOwnerInstanceForDm(channelId: string): string {
  const dm = useSpaceStore.getState().dmChannels.find(d => d.id === channelId);
  return dm?.ownerHomeInstance ?? '';
}

setOwnerInstanceForDmResolver(getOwnerInstanceForDm);

/**
 * Resolves a raw DM channel ID to its primary `dmChannels` entry ID.
 */
export function resolveDmChannelId(rawId: string): string | null {
  const { dmChannels, dmAlternatives } = useSpaceStore.getState();
  return locateDmChannel(dmChannels, dmAlternatives, rawId)?.dm.id ?? null;
}

/**
 * The channel id `origin` holds for the DM conversation of `channelId`, or
 * null when that instance holds no copy of it.
 */
export function dmCopyIdOnOrigin(channelId: string, origin: string): string | null {
  return copyIdOnOrigin(useSpaceStore.getState().dmConversations, channelId, origin);
}

/**
 * The copy `origin` holds of the DM conversation of `channelId` (its id and
 * its members as that instance knows them), or null when it holds none.
 */
export function dmCopyOnOrigin(channelId: string, origin: string): DmChannel | null {
  return copyOnOrigin(useSpaceStore.getState().dmConversations, channelId, origin);
}

// ─── Cross-store resolvers (federation) ───────────────────────────────────────
export {
  setApiForOriginResolver,
  getApiForOrigin,
  setOriginFromHostnameResolver,
  setUserIdForOriginResolver,
  setMyUserIdForOrigin,
  setTokenForOriginResolver,
  getTokenForOrigin,
} from '../utils/crossStoreResolvers';

/**
 * Returns the instance origin for a federated user based on their homeInstance.
 * '' = home/local user, 'https://...' = remote instance.
 */
export function resolveUserOrigin(user: { homeInstance?: string | null }): string {
  const host = user.homeInstance;
  if (!host || host === window.location.host) return '';
  return resolveOriginFromHostname(host);
}

/**
 * Returns the origin that is authoritative for this user's space layout.
 * '' = browsing instance (native users, or true home not yet connected).
 * 'https://...' = connected remote that is the user's true home.
 */
export function getLayoutHomeOrigin(): string {
  const user = useAuthStore.getState().user;
  if (!user?.homeInstance) return '';
  return resolveOriginFromHostname(user.homeInstance);
}

/**
 * Returns the local user's ID on a given instance origin.
 * '' or falsy = home instance (returns authStore user ID).
 * 'https://...' = remote instance (returns the federated user ID on that instance).
 */
export function getMyUserIdForOrigin(origin: string): string | undefined {
  if (!origin) return useAuthStore.getState().user?.id;
  const cached = getCachedUserIdForOrigin(origin);
  if (cached) return cached;
  return resolveUserIdFromInstances(origin);
}
