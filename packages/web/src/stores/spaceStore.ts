import { create } from 'zustand';
import type { Space, Channel, ChannelCategory, MemberWithUser, SpaceWithChannelsAndMembers, Role, SpaceFolder, SpaceLayoutItem, DmChannel, DmMessageWithUser, User, UpdateSpaceRequest, CreateSpaceRequest, UpdateChannelRequest } from '@backspace/shared';
import { api, BackspaceApiClient } from '../api/client';
import { resolveAssetUrl, normalizeUserAssets } from '../utils/assetUrls';
import { userKey, isIssuedByHome, withUserUpdate, type IdentityFields, type PresenceSubject } from '../utils/identity';
import { sortDmChannels } from '../utils/dmSorting';
import { locateDmChannel } from '../utils/dmChannelLookup';
import { deriveMissingOneOnOneKeys, type PeerDmChannel } from '../utils/dmConversationKey';
import { applyDmPinMoves } from '../utils/dmOriginFailover';
import {
  putChannels,
  putSpaceListings,
  dropChannels,
  replaceSpaceChannels,
  channelIdsWhere,
  deriveChannelLookups,
  deriveChannelOriginMap,
  type SpaceChannelIndex,
  type SpaceChannelTables,
} from './spaceChannels';
import {
  EMPTY_DM_CONVERSATIONS,
  mergeOriginListing,
  upsertCopy,
  upsertUnplacedCopy,
  removeCopy,
  patchCopy,
  patchEveryCopy,
  setOriginAvailable,
  dropOrigin,
  pinnedDmChannels,
  pinnedOriginByChannelId,
  conversationCopyIndex,
  copyIdOnOrigin,
  copyOnOrigin,
  type DmConversations,
  type DmOperation,
  type DmPinContext,
} from './dmConversations';
import {
  getApiForOrigin,
  resolveOriginFromHostname,
} from '../utils/crossStoreResolvers';
import { useAuthStore, getMyUserIdForOrigin, isMe } from './authStore';
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

// ─── User-view cache types ────────────────────────────────────────────────────

/**
 * A single cached view of a user, populated from one delivering origin.
 *
 * The userViews cache stores the best-known view of each person (`userKey`)
 * across every connected instance, regardless of whether the carrying channel
 * survived dedup. Mirrors `dmAlternatives` philosophy: information from
 * skipped ready payloads is still load-bearing for rendering.
 *
 * - `deliveredBy`: the origin string used at insert time. Required for
 *   lifecycle pruning (drop entries whose delivering origin is removed from
 *   Connections) — the user's declared `homeInstance` is NOT a substitute,
 *   because a stub view delivered by orbit has homeInstance=nova.
 * - `isHome`: cached at insert time so the preference rule does not need to
 *   re-normalize on every write.
 * - `updatedAt`: same-tier freshness tiebreaker.
 */
export interface UserViewEntry {
  user: User;
  deliveredBy: string;
  isHome: boolean;
  updatedAt: number;
}

// ─── Roster changes during a detail fetch ────────────────────────────────────
// `loadSpaceDetail` replaces `members` with the roster the server sent. A
// `member_joined` or `member_left` that arrives while that fetch is in flight
// is applied to the old list and would be lost when the fetched roster lands,
// since the server may have built its response before the change. So each
// in-flight load keeps the changes for its space in arrival order and replays
// them onto the fetched roster (`replayRosterChange`). Replaying is safe when
// the response already has the change: a replayed join adds the member only
// when the roster lacks them, since the fetched row can be newer than the join
// event (a role assigned during the fetch), and a leave of an absent member
// removes nothing.

type RosterChange =
  | { kind: 'join'; member: MemberWithUser }
  | { kind: 'leave'; userId: string };

// ─── Overlapping detail loads ────────────────────────────────────────────────
// Several loads of one space can be in flight at once: a role change sends
// `space_access_changed` once per write (and a member role edit or a quick
// series of role moves is several writes), the settings panels reload after
// their own writes, a reconnect reloads the open space. Their responses can
// land in any order, and an older one landing last would put back the roles,
// positions and permissions a newer one replaced. So only the newest load of
// a space applies its response; an older one, when its response or its error
// arrives, resolves to whatever the newest one resolves to and changes
// nothing itself.

let detailRequestCount = 0;
/** spaceId → the newest `loadSpaceDetail` started for it. */
const newestDetailRequests = new Map<string, { seq: number; result: Promise<Channel[] | undefined> }>();

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
// `dmConversations` (stores/dmConversations.ts) is the only DM state the
// store writes. `dmChannels`, `dmAlternatives` and the DM entries of
// `channelOriginMap` and `channelLastMessageIds` are derived from it after
// every operation, here, and written nowhere else.

type DmView = Pick<SpaceState, 'dmConversations' | 'dmChannels' | 'dmAlternatives' | 'channelOriginMap' | 'channelLastMessageIds'>;

/**
 * The store fields derived from `conversations`. `previousRows` are the DM
 * rows `channelLastMessageIds` held entries for until now; those entries are
 * replaced, the space-channel entries are kept. `channelOriginMap` is derived
 * whole from the space-channel index and the conversations.
 */
function deriveDmView(
  conversations: DmConversations,
  previousRows: readonly DmChannel[],
  spaceChannelIndex: SpaceChannelIndex,
  channelLastMessageIds: ReadonlyMap<string, string>,
): DmView {
  const lastMessageIds = new Map(channelLastMessageIds);
  for (const dm of previousRows) lastMessageIds.delete(dm.id);
  const rows = pinnedDmChannels(conversations);
  for (const dm of rows) {
    if (dm.lastMessage?.id) lastMessageIds.set(dm.id, dm.lastMessage.id);
  }
  const { unreadChannels, currentChannelId } = useChatStore.getState();
  return {
    dmConversations: conversations,
    dmChannels: sortDmChannels(rows, unreadChannels, currentChannelId),
    dmAlternatives: conversationCopyIndex(conversations),
    channelOriginMap: deriveChannelOriginMap(spaceChannelIndex, pinnedOriginByChannelId(conversations)),
    channelLastMessageIds: lastMessageIds,
  };
}

// ─── Space channels: the index and the lookup maps ───────────────────────────
// `spaceChannelIndex` (stores/spaceChannels.ts) is the one record of which
// space channels exist, where. `channelToSpaceMap`, `voiceChannelIds` and the
// space entries of `channelOriginMap` are derived from it after every change,
// here and in `deriveDmView`, and written nowhere else. `channelPermissions`
// and the space entries of `channelLastMessageIds` change with it.

type ChannelTableFields = Pick<
  SpaceState,
  'spaceChannelIndex' | 'channelPermissions' | 'channelLastMessageIds' | 'channelToSpaceMap' | 'channelOriginMap' | 'voiceChannelIds'
>;

function channelTablesOf(state: SpaceState): SpaceChannelTables {
  return { index: state.spaceChannelIndex, permissions: state.channelPermissions, lastMessageIds: state.channelLastMessageIds };
}

/**
 * The store fields for `tables`, with the lookup maps derived from its index
 * and the DM view of `dmConversations`. Empty when nothing changed, so an
 * event that changes nothing re-renders nothing.
 */
function channelTableFields(
  state: SpaceState,
  tables: SpaceChannelTables,
  dmConversations: DmConversations = state.dmConversations,
): Partial<ChannelTableFields> {
  if (
    tables.index === state.spaceChannelIndex
    && tables.permissions === state.channelPermissions
    && tables.lastMessageIds === state.channelLastMessageIds
  ) {
    return {};
  }
  return {
    spaceChannelIndex: tables.index,
    channelPermissions: tables.permissions,
    channelLastMessageIds: tables.lastMessageIds,
    ...deriveChannelLookups(tables.index, pinnedOriginByChannelId(dmConversations)),
  };
}

/** Whether `spaceId`, as `origin` issued it, is the open space (the one `channels` and `categories` hold). */
function isOpenSpace(state: SpaceState, spaceId: string, origin: string): boolean {
  if (state.currentSpaceId !== spaceId) return false;
  return (state.spaces.find((s) => s.id === spaceId)?._instanceOrigin ?? '') === origin;
}

function byPosition<T extends { position: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.position - b.position);
}

/** `categoryOriginMap` with `categories` recorded under `origin`. */
function withCategoryOrigins(
  categoryOriginMap: ReadonlyMap<string, string>,
  categories: readonly ChannelCategory[],
  origin: string,
): ReadonlyMap<string, string> {
  if (categories.length === 0) return categoryOriginMap;
  const next = new Map(categoryOriginMap);
  for (const category of categories) next.set(category.id, origin);
  return next;
}

/** The pin rule's view of the session: the user's home is `getLayoutHomeOrigin()`. */
function dmPinContext(): DmPinContext {
  return { home: getLayoutHomeOrigin() };
}

/**
 * Store the result of a DM operation, derive the view from it, and apply its
 * pin moves: the chat state and URL of a row follow it to its new channel id
 * (`applyDmPinMoves`), after which the list is re-sorted, since the moves
 * carried unread state to the new ids.
 */
function commitDmOperation(op: DmOperation): void {
  if (op.next !== useSpaceStore.getState().dmConversations) {
    useSpaceStore.setState((state) =>
      deriveDmView(op.next, state.dmChannels, state.spaceChannelIndex, state.channelLastMessageIds),
    );
  }
  if (op.pinMoves.length === 0) return;
  applyDmPinMoves(op.pinMoves);
  useSpaceStore.getState().resortDmChannels();
}

// ─── Store interface ──────────────────────────────────────────────────────────

interface SpaceState {
  spaces: TaggedSpace[];
  currentSpaceId: string | null;
  /**
   * Sticky memory of the most-recently-selected space. Updated on every
   * `setCurrentSpace(non-null)` and when `loadSpaceDetail` lands. Crucially, it
   * is NOT cleared by `setCurrentSpace(null)` (the @me / DMs navigation case)
   * so mobile callers can answer "which space should the Spaces tab return to
   * after a side trip through DMs?" — `currentSpaceId` is wiped on @me by
   * AppLayout's URL effect, which would otherwise force a fallback to
   * `spaces[0]`. Cleared only when the remembered space is actually removed
   * (deleteSpace / leaveSpace / removeSpaceFromState / removeInstanceSpaces /
   * reset). Ephemeral — not persisted, since URL drives initial state on
   * reload.
   */
  lastSelectedSpaceId: string | null;
  channels: Channel[];
  categories: ChannelCategory[];
  members: MemberWithUser[];
  roles: Role[];
  folders: SpaceFolder[];
  spaceLayout: SpaceLayoutItem[] | null;
  /**
   * Every DM copy the client knows, grouped into conversations, with the
   * pinned copy of each (`stores/dmConversations.ts`). The only DM state
   * actions write; the DM fields below are derived from it.
   */
  dmConversations: DmConversations;
  /** Derived: the pinned copy of each conversation, sorted by `sortDmChannels`. The DM list. */
  dmChannels: DmChannel[];
  /**
   * Every space channel the user can see on every connected instance, open
   * space or not: channelId → { spaceId, origin, type } (`stores/spaceChannels.ts`).
   * The only space-channel record actions write; the lookup maps below are
   * derived from it.
   */
  spaceChannelIndex: SpaceChannelIndex;
  /** Derived: space channelId → spaceId. */
  channelToSpaceMap: ReadonlyMap<string, string>;
  /** channelId → last message id a listing reported: space channels by the space actions, DMs derived. */
  channelLastMessageIds: ReadonlyMap<string, string>;
  spacePermissions: ReadonlyMap<string, string>; // spaceId → myPermissions decimal string
  /** Space channelId → myPermissions decimal string. Changes with the index. */
  channelPermissions: ReadonlyMap<string, string>;
  /** Derived: channelId → instance origin ('' = home), space channels and pinned DM copies. */
  channelOriginMap: ReadonlyMap<string, string>;
  /** Derived: the voice channels (excluded from unread). */
  voiceChannelIds: ReadonlySet<string>;
  categoryOriginMap: ReadonlyMap<string, string>; // categoryId → instance origin ('' = home)
  /**
   * Derived: conversation key → (origin → that origin's channel id), for every
   * copy of every keyed conversation, the pinned one included. The index
   * `resolveDmChannelId` reads to place an id another instance sent.
   */
  dmAlternatives: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /**
   * userKey → best-known view of that person. Populated from every wire
   * surface that delivers a User object (DM members, message authors, friends,
   * space members, profile updates). Pruned only on full instance removal
   * (`removeInstanceSpaces`) and `reset`, never on transient WS disconnect —
   * mirrors `dmAlternatives`' no-flapping invariant. Render sites read through
   * `getCanonicalUserView` / `useCanonicalUserView` to surface the home view
   * even when the carrying channel was deduped away.
   */
  userViews: ReadonlyMap<string, UserViewEntry>;
  loadingSpaceId: string | null; // non-null while loadSpaceDetail is fetching
  /**
   * Set of spaceIds whose `loadSpaceDetail` has completed at least once this
   * session. Distinct from `currentSpaceId` (which moves with selection) and
   * from `loadingSpaceId` (which only marks in-flight). Render sites use this
   * to differentiate "load not yet attempted" from "loaded with empty result"
   * — see `MobileSpacesScreen`'s mascot empty state, which must not appear
   * during the pre-skeleton load window.
   *
   * Lifecycle:
   *  - Added on successful `loadSpaceDetail` completion.
   *  - Cleared per-space when the space is removed (`deleteSpace`,
   *    `leaveSpace`, `removeSpace`, `removeInstanceSpaces`).
   *  - Wiped entirely on `reset` (logout).
   *
   * Not persisted (ephemeral).
   */
  loadedSpaceIds: ReadonlySet<string>;
  _layoutUpdatedAt: number;
  setSpaces: (spaces: TaggedSpace[]) => void;
  setCurrentSpace: (spaceId: string | null) => void;
  setChannels: (channels: Channel[]) => void;
  setCategories: (categories: ChannelCategory[]) => void;
  setMembers: (members: MemberWithUser[]) => void;
  setRoles: (roles: Role[]) => void;
  /**
   * A DM channel a server sent outside a listing (`dm_channel_created`, a
   * create response) joins its conversation. Returns the channel id of the
   * conversation's pinned copy, which is where the UI navigates.
   */
  upsertDmCopy: (origin: string, channel: PeerDmChannel, keySource: 'stated' | 'unknown') => string;
  /** A message no listing placed gets an entry of its own under the origin that sent it. */
  placeUnplacedDmMessage: (origin: string, message: DmMessageWithUser) => void;
  /** Change the DM copy with this channel id (its last message, members, metadata). */
  patchDmCopy: (channelId: string, patch: (channel: DmChannel) => DmChannel) => void;
  /**
   * Re-sort the DM list after unread or selection changed. `currentChannelId`
   * overrides the chat store's for this sort.
   */
  resortDmChannels: (currentChannelId?: string | null) => void;
  /** An origin's socket dropped (false) or came back: rows pinned there fail over by the pin rule. */
  setDmOriginAvailable: (origin: string, available: boolean) => void;
  reloadDmsForOrigin: (origin: string) => Promise<void>;
  removeDmChannel: (id: string) => void;
  addDmMember: (dmChannelId: string, user: User) => void;
  removeDmMember: (dmChannelId: string, userId: string) => void;
  updateDmOwner: (
    dmChannelId: string,
    newOwnerId: string,
    newOwnerHomeUserId?: string,
    newOwnerHomeInstance?: string,
  ) => void;
  updateDmMetadata: (dmChannelId: string, patch: { name?: string | null; icon?: string | null }) => void;
  closeDm: (id: string) => Promise<void>;
  leaveDm: (id: string) => Promise<void>;
  loadSpaces: () => Promise<void>;
  /**
   * Fetch a space's detail from its own instance: the viewer's permissions
   * there, and, when it is the open space (`currentSpaceId`), its channels,
   * categories, members and roles. A space that is not open when the detail
   * lands only gets its channel index and permission entries updated. Only
   * the newest load of a space applies its response; an older one resolves
   * to what the newest resolves to. `quiet` is the refresh after `space_access_changed`: no
   * loading state, so no skeleton. Resolves to the channels the viewer can
   * see there, or undefined when nothing was fetched.
   */
  loadSpaceDetail: (spaceId: string, options?: { quiet?: boolean }) => Promise<Channel[] | undefined>;
  createSpace: (data: CreateSpaceRequest) => Promise<Space>;
  updateSpace: (spaceId: string, data: UpdateSpaceRequest) => Promise<void>;
  deleteSpace: (spaceId: string) => Promise<void>;
  joinSpace: (spaceId: string, inviteCode: string) => Promise<void>;
  leaveSpace: (spaceId: string) => Promise<void>;
  joinByCode: (inviteCode: string, origin?: string) => Promise<Space>;
  generateInvite: (spaceId: string) => Promise<string>;
  createChannel: (spaceId: string, name: string, type: 'text' | 'voice', topic?: string, categoryId?: string) => Promise<Channel>;
  /**
   * A space channel the user can see, from an event or a response: its index
   * entry, permissions and, in the open space, its row. Wherever its space is.
   */
  upsertChannel: (channel: Channel, spaceId: string, origin: string) => void;
  /** A space channel the user can no longer see (deleted, or hidden by an override): forgotten everywhere. */
  removeChannel: (channelId: string) => void;
  /**
   * The complete visible channel and category set of `spaceId` on `origin`
   * (`channel_layout_updated`): the space's index entries become exactly these.
   */
  applyChannelLayout: (spaceId: string, origin: string, channels: Channel[], categories: ChannelCategory[]) => void;
  /** A category created or changed on `origin`: recorded, and in the open space added or replaced. */
  upsertCategory: (category: ChannelCategory, origin: string) => void;
  /** A category deleted on `origin`: forgotten, and in the open space its channels become uncategorized. */
  removeCategory: (categoryId: string, spaceId: string, origin: string) => void;
  /** Updates a space channel on its own instance and applies the stored row,
   *  which the server may have normalized (see `normalizeChannelName`). */
  updateChannel: (channelId: string, data: UpdateChannelRequest) => Promise<Channel>;
  deleteChannel: (channelId: string) => Promise<void>;
  createCategory: (spaceId: string, name: string) => Promise<ChannelCategory>;
  /** Updates a category on its space's instance and applies the stored row. */
  updateCategory: (categoryId: string, data: { name?: string; position?: number }) => Promise<ChannelCategory>;
  deleteCategory: (categoryId: string) => Promise<void>;
  updateChannelLayout: (spaceId: string, data: { channels: Array<{ id: string; position: number; categoryId: string | null }>; categories: Array<{ id: string; position: number }> }) => Promise<void>;
  addSpace: (space: Space) => void;
  removeSpace: (spaceId: string) => void;
  /**
   * Set the status of the person `subject` names, as `origin` delivered it,
   * wherever the client shows them: roster rows and cached views, matched by
   * `userKey` (their home identity), never by a raw row id.
   */
  updateMemberPresence: (subject: PresenceSubject, origin: string, status: string) => void;
  /**
   * Apply a `user_updated` row issued by `origin` to the roster and DM member
   * rows it is about (`withUserUpdate`): that instance's row with its id, and
   * other instances' rows of the same person when it is their home's row.
   */
  updateUserEverywhere: (user: User, origin: string) => void;
  /** A member joined `spaceId`, the open space. Also replayed onto an in-flight detail fetch's roster. */
  addMember: (spaceId: string, member: MemberWithUser) => void;
  /** A member left `spaceId`, the open space. Also replayed onto an in-flight detail fetch's roster. */
  removeMember: (spaceId: string, userId: string) => void;
  setSpaceLayout: (layout: SpaceLayoutItem[] | null) => void;
  updateSpaceLayout: (items: SpaceLayoutItem[], folders: Record<string, { name: string | null; color: string | null; spaceIds: string[] }>) => Promise<void>;
  populateFromReady: (origin: string, spaces: SpaceWithChannelsAndMembers[], folders?: SpaceFolder[], dmChannels?: DmChannel[], spaceLayout?: SpaceLayoutItem[] | null, layoutUpdatedAt?: number) => void;
  /**
   * Upsert a User into the userViews cache under the preference rule:
   *   - if no entry: insert
   *   - if existing is home view and incoming is stub: ignore
   *   - if existing is stub and incoming is home view: overwrite (upgrade)
   *   - same tier (both home or both stub): freshness wins (incoming overwrites)
   * Origin is REQUIRED to derive the home/stub tier and to enable pruning by
   * delivering origin on instance removal.
   */
  upsertUserView: (user: User, deliveringOrigin: string) => void;
  addSpaceFromReady: (origin: string, space: SpaceWithChannelsAndMembers) => void;
  removeInstanceSpaces: (origin: string) => void;
  transferOwnership: (spaceId: string, newOwnerId: string) => Promise<void>;
  /**
   * The open 1-on-1 DM with the person `target` names (as `targetOrigin`
   * issued it), matched by `userKey`, or null.
   */
  findExistingDmForUser: (target: IdentityFields, targetOrigin: string) => { dm: DmChannel; origin: string } | null;
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
  lastSelectedSpaceId: null,
  channels: [],
  categories: [],
  members: [],
  roles: [],
  folders: [],
  spaceLayout: null,
  dmConversations: EMPTY_DM_CONVERSATIONS,
  dmChannels: [],
  spaceChannelIndex: new Map(),
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

  reset: () => {
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
      spaceChannelIndex: new Map(),
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

  setSpaces: (spaces) => set({ spaces }),
  setCurrentSpace: (spaceId) =>
    set((state) => ({
      currentSpaceId: spaceId,
      // Only update sticky memory when actually selecting a space. Clearing
      // currentSpaceId (e.g. on @me navigation) must NOT wipe the memory —
      // that's the whole point of this slot.
      lastSelectedSpaceId: spaceId !== null ? spaceId : state.lastSelectedSpaceId,
    })),
  setChannels: (channels) => set({ channels }),
  setCategories: (categories) => set({ categories }),
  setMembers: (members) => set({ members }),
  setRoles: (roles) => set({ roles }),
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

  // Refetch this origin's DM list and merge it as the origin's copies
  // (`mergeOriginListing`). Used after a re-attach reconciles this
  // connection's 1-on-1 keys (merge/re-key) so a split conversation collapses
  // without a full WS reconnect, and by `utils/dmMessageRouting` to learn which
  // conversation an unknown channel id belongs to. Origin '' is the home
  // instance. Throws on a failed fetch; the callers catch.
  //
  // A peer on 1.6.1 or older lists its DMs without `federatedId` and the group
  // metadata. The merge module fills an absent field from the copy it already
  // holds for that channel id, and a 1-on-1 still without a key takes the one
  // derived from its members here (see `completePeerListing`).
  reloadDmsForOrigin: async (origin: string) => {
    const client = getApiForOrigin(origin);
    const listed: PeerDmChannel[] = await client.dm.list();
    // Before normalization: the derivation reads the members' raw homeInstance.
    const derivedKeys = await deriveMissingOneOnOneKeys(listed);

    // Normalize remote-origin DM member asset URLs (home origin serves clean paths).
    if (origin !== '') {
      for (const dm of listed) {
        for (const member of dm.members) {
          normalizeUserAssets(member, origin);
        }
      }
    }

    // Upsert every DM member into the userViews cache (home + remote).
    const { upsertUserView } = get();
    for (const dm of listed) {
      for (const member of dm.members) {
        upsertUserView(member, origin);
      }
    }

    commitDmOperation(mergeOriginListing(get().dmConversations, origin, listed, derivedKeys, dmPinContext()));
  },

  upsertUserView: (user, deliveringOrigin) => set((state) => {
    const key = userKey(user, deliveringOrigin);
    const incomingIsHome = isIssuedByHome(user, deliveringOrigin);
    const existing = state.userViews.get(key);

    // Stub view never overwrites a home view.
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
    // Clean up unread/read state for the closed DM
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
      // Only overwrite the federation routing fields when the caller supplies
      // them. Older servers that omit these fields must not blank out the
      // existing values — the DM would otherwise lose its owner-routing data
      // and `getOwnerInstanceForDm` would silently fall back to '' (home),
      // re-introducing the bug this WS extension fixes.
      if (newOwnerHomeUserId !== undefined) next.ownerHomeUserId = newOwnerHomeUserId;
      if (newOwnerHomeInstance !== undefined) next.ownerHomeInstance = newOwnerHomeInstance;
      return next;
    }));
  },

  // Patches the group DM's display metadata (name + icon). Idempotent: a
  // payload with only one of `name`/`icon` leaves the other field untouched.
  // Mirrors `updateDmOwner` shape; called by the `dm_channel_updated` WS
  // handler after a remote rename / icon change.
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

  loadSpaceDetail: (spaceId: string, options?: { quiet?: boolean }) => {
    const quiet = options?.quiet === true;
    const seq = ++detailRequestCount;
    // Whether a load of this space started after this one.
    const overtaken = (): boolean => newestDetailRequests.get(spaceId)?.seq !== seq;
    const newestResult = (): Promise<Channel[] | undefined> =>
      newestDetailRequests.get(spaceId)?.result ?? Promise.resolve(undefined);
    // Ends the loading state of this space's open, whichever load started it.
    const endLoading = (state: SpaceState): string | null =>
      state.loadingSpaceId === spaceId ? null : state.loadingSpaceId;

    const result = (async (): Promise<Channel[] | undefined> => {
      // Joins and leaves that arrive during the fetch, replayed onto its roster.
      const rosterChanges: RosterChange[] = [];
      try {
        // Resolve the correct API client based on the server's instance origin
        const space = get().spaces.find(s => s.id === spaceId);
        if (!space) return undefined; // Not populated yet — remote WS ready will trigger reload
        if (!quiet) set({ loadingSpaceId: spaceId });
        const origin = space._instanceOrigin ?? '';
        const client = getApiForOrigin(origin);

        const logs = inFlightRosterLogs.get(spaceId) ?? new Set<RosterChange[]>();
        logs.add(rosterChanges);
        inFlightRosterLogs.set(spaceId, logs);

        const detail = await client.spaces.get(spaceId);
        if (overtaken()) return newestResult();
        // Normalize remote asset URLs (avatars, server icon)
        if (origin) {
          if (detail.icon) detail.icon = resolveAssetUrl(detail.icon, origin) ?? detail.icon;
          for (const member of detail.members) {
            normalizeUserAssets(member.user, origin);
          }
        }
        // Upsert every member into the userViews cache (home or remote).
        // Assets are already normalized above for the remote case.
        for (const member of detail.members) {
          get().upsertUserView(member.user, origin);
        }

        // The detail lists every channel of the space the user can see: the
        // space's index entries become exactly these, whether or not it is
        // open. `channels`, `categories`, `members` and `roles` belong to the
        // open space. Every caller opens the space before loading it, so a
        // space that is not open when its detail lands was left (or never
        // opened, for a refresh): it only gets its index and permission
        // entries.
        let dropped: string[] = [];
        set((state) => {
          const replaced = replaceSpaceChannels(channelTablesOf(state), spaceId, origin, detail.channels);
          dropped = replaced.dropped;
          const spacePermissions = new Map(state.spacePermissions);
          if (detail.myPermissions) spacePermissions.set(spaceId, detail.myPermissions);
          const categories = detail.categories ?? [];
          const fields = {
            ...channelTableFields(state, replaced.tables),
            categoryOriginMap: withCategoryOrigins(state.categoryOriginMap, categories, origin),
            spacePermissions,
            loadingSpaceId: endLoading(state),
          };
          if (state.currentSpaceId !== spaceId) return fields;
          const loadedSpaceIds = new Set(state.loadedSpaceIds);
          loadedSpaceIds.add(spaceId);
          return {
            ...fields,
            lastSelectedSpaceId: spaceId,
            channels: byPosition(detail.channels),
            categories: byPosition(categories),
            members: rosterChanges.reduce(replayRosterChange, detail.members),
            roles: detail.roles.sort((a, b) => b.position - a.position),
            loadedSpaceIds,
          };
        });
        if (dropped.length > 0) useChatStore.getState().removeChannelStates(new Set(dropped));
        return detail.channels;
      } catch {
        if (overtaken()) return newestResult();
        set((state) => ({ loadingSpaceId: endLoading(state) }));
        return undefined;
      } finally {
        const logs = inFlightRosterLogs.get(spaceId);
        logs?.delete(rosterChanges);
        if (logs?.size === 0) inFlightRosterLogs.delete(spaceId);
      }
    })();
    newestDetailRequests.set(spaceId, { seq, result });
    return result;
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
    const space =await api.spaces.join(spaceId, { inviteCode });
    set((state) => {
      if (state.spaces.find(s => s.id === space.id)) return state;
      return { spaces: [...state.spaces, { ...space, _instanceOrigin: '' } as TaggedSpace] };
    });
  },

  joinByCode: async (inviteCode: string, origin?: string) => {
    // Normalize: an explicit home origin is equivalent to undefined (local).
    // Mirrors inviteParser's same normalization at the URL boundary.
    if (origin && typeof window !== 'undefined' && origin === window.location.origin) {
      origin = undefined;
    }
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
    // Reconcile through upsertChannel so the new channel's permission entry is
    // written with a fresh map reference (see upsertChannel). The create
    // response carries the creator's myPermissions, so the channel renders
    // immediately without waiting for the channel_created WS event.
    get().upsertChannel(channel, spaceId, origin);
    return channel;
  },

  upsertChannel: (channel: Channel, spaceId: string, origin: string) => {
    set((state) => {
      const fields = channelTableFields(state, putChannels(channelTablesOf(state), spaceId, origin, [channel]));
      // `channels` holds only the open space's list.
      if (!isOpenSpace(state, spaceId, origin)) return fields;
      const exists = state.channels.some(c => c.id === channel.id);
      const channels = byPosition(exists
        ? state.channels.map(c => (c.id === channel.id ? channel : c))
        : [...state.channels, channel]);
      return { ...fields, channels };
    });
  },

  removeChannel: (channelId: string) => {
    set((state) => {
      const channels = state.channels.some(c => c.id === channelId)
        ? state.channels.filter(c => c.id !== channelId)
        : state.channels;
      return { ...channelTableFields(state, dropChannels(channelTablesOf(state), [channelId])), channels };
    });
    useChatStore.getState().removeChannelStates(new Set([channelId]));
  },

  applyChannelLayout: (spaceId, origin, channels, categories) => {
    let dropped: string[] = [];
    set((state) => {
      const replaced = replaceSpaceChannels(channelTablesOf(state), spaceId, origin, channels);
      dropped = replaced.dropped;
      const fields = {
        ...channelTableFields(state, replaced.tables),
        categoryOriginMap: withCategoryOrigins(state.categoryOriginMap, categories, origin),
      };
      if (!isOpenSpace(state, spaceId, origin)) return fields;
      return { ...fields, channels: byPosition(channels), categories: byPosition(categories) };
    });
    if (dropped.length > 0) useChatStore.getState().removeChannelStates(new Set(dropped));
  },

  upsertCategory: (category, origin) => {
    set((state) => {
      const categoryOriginMap = withCategoryOrigins(state.categoryOriginMap, [category], origin);
      if (!isOpenSpace(state, category.spaceId, origin)) return { categoryOriginMap };
      const exists = state.categories.some(c => c.id === category.id);
      const categories = byPosition(exists
        ? state.categories.map(c => (c.id === category.id ? category : c))
        : [...state.categories, category]);
      return { categoryOriginMap, categories };
    });
  },

  removeCategory: (categoryId, spaceId, origin) => {
    set((state) => {
      const categoryOriginMap = new Map(state.categoryOriginMap);
      categoryOriginMap.delete(categoryId);
      if (!isOpenSpace(state, spaceId, origin)) return { categoryOriginMap };
      return {
        categoryOriginMap,
        categories: state.categories.filter(c => c.id !== categoryId),
        // The server uncategorized them too.
        channels: state.channels.map(ch => (ch.categoryId === categoryId ? { ...ch, categoryId: null } : ch)),
      };
    });
  },

  updateChannel: async (channelId: string, data: UpdateChannelRequest) => {
    const origin = get().channelOriginMap.get(channelId) ?? '';
    const channel = await getApiForOrigin(origin).channels.update(channelId, data);
    // The channel_updated WS event carries the same row; applying the
    // response too means the caller sees the stored value without waiting.
    get().upsertChannel(channel, channel.spaceId, origin);
    return channel;
  },

  deleteChannel: async (channelId: string) => {
    const origin = get().channelOriginMap.get(channelId) ?? '';
    const channelApi = getApiForOrigin(origin);
    await channelApi.channels.delete(channelId);
    // The channel_deleted WS event does the same; removing is idempotent.
    get().removeChannel(channelId);
  },

  createCategory: async (spaceId: string, name: string) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    const category = await client.categories.create(spaceId, name);
    // The category_created WS event carries the same row; applying the
    // response too means the caller sees it without waiting.
    get().upsertCategory(category, origin);
    return category;
  },

  updateCategory: async (categoryId: string, data: { name?: string; position?: number }) => {
    const known = get().categories.find(c => c.id === categoryId);
    const space = known ? get().spaces.find(s => s.id === known.spaceId) : undefined;
    const origin = space?._instanceOrigin ?? get().categoryOriginMap.get(categoryId) ?? '';
    const category = await getApiForOrigin(origin).categories.update(categoryId, data);
    // The category_updated WS event carries the same row; applying the
    // response too means the caller sees the stored value without waiting.
    get().upsertCategory(category, origin);
    return category;
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
    const channelIdsToRemove = new Set(channelIdsWhere(get().spaceChannelIndex, (e) => e.spaceId === spaceId));

    set((state) => {
      const spacePermissions = new Map(state.spacePermissions);
      spacePermissions.delete(spaceId);

      const loadedSpaceIds = new Set(state.loadedSpaceIds);
      loadedSpaceIds.delete(spaceId);

      return {
        ...channelTableFields(state, dropChannels(channelTablesOf(state), channelIdsToRemove)),
        spaces: state.spaces.filter(s => s.id !== spaceId),
        currentSpaceId: state.currentSpaceId === spaceId ? null : state.currentSpaceId,
        lastSelectedSpaceId:
          state.lastSelectedSpaceId === spaceId ? null : state.lastSelectedSpaceId,
        spacePermissions,
        loadedSpaceIds,
      };
    });

    // Clean up orphaned unread/read states and cached messages in chatStore
    if (channelIdsToRemove.size > 0) {
      useChatStore.getState().removeChannelStates(channelIdsToRemove);
    }
  },

  updateMemberPresence: (subject: PresenceSubject, origin: string, status: string) => {
    const key = userKey(subject, origin);
    set((state) => {
      const typedStatus = status as 'online' | 'idle' | 'dnd' | 'offline';
      // Mirror the status into the userViews cache so any component reading via
      // useCanonicalUserView (e.g. the FriendItem avatar dot) re-renders with
      // fresh status, not just spaceStore.members which only feeds space UIs.
      // The cache is keyed by the same `userKey`.
      const entry = state.userViews.get(key);
      let changedViews: Map<string, UserViewEntry> | null = null;
      if (entry) {
        changedViews = new Map(state.userViews);
        changedViews.set(key, { ...entry, user: { ...entry.user, status: typedStatus } });
      }
      const nextUserViews = changedViews ?? state.userViews;

      // A roster row is keyed as its space's origin issued it.
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
          userKey(m.user, spaceOriginOf(m.spaceId)) === key ? { ...m, user: { ...m.user, status: typedStatus } } : m
        ),
        userViews: nextUserViews,
      };
    });
  },

  updateUserEverywhere: (user: User, origin: string) => {
    set((state) => {
      // A roster row is issued by its space's origin.
      const spaceOrigins = new Map(state.spaces.map(s => [s.id, s._instanceOrigin ?? '']));
      let changed = false;
      const members = state.members.map(m => {
        const updated = withUserUpdate(m.user, spaceOrigins.get(m.spaceId) ?? '', user, origin);
        if (updated === m.user) return m;
        changed = true;
        return { ...m, user: updated };
      });
      return changed ? { members } : state;
    });
    commitDmOperation(patchEveryCopy(get().dmConversations, (dm, dmOrigin) => {
      let changed = false;
      const members = dm.members.map(m => {
        const updated = withUserUpdate(m, dmOrigin, user, origin);
        if (updated !== m) changed = true;
        return updated;
      });
      return changed ? { ...dm, members } : dm;
    }));
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
      directoryListed: s.directoryListed ?? false,
      description: s.description ?? null,
      createdAt: s.createdAt,
      _instanceOrigin: origin,
    }));

    // Merge by origin: keep servers from other origins, replace all from this origin
    const existingFromOtherOrigins = get().spaces.filter(s => s._instanceOrigin !== origin);
    const mergedSpaces = [...existingFromOtherOrigins, ...taggedSpaces];

    // This origin's listing replaces every space channel it listed before.
    const current = get();
    const originChannelIds = channelIdsWhere(current.spaceChannelIndex, (e) => e.origin === origin);
    const channelTables = putSpaceListings(dropChannels(channelTablesOf(current), originChannelIds), origin, spaces);

    const spacePermissions = new Map(current.spacePermissions);
    for (const s of current.spaces) {
      if (s._instanceOrigin === origin) spacePermissions.delete(s.id);
    }
    for (const srv of spaces) {
      if (srv.myPermissions) spacePermissions.set(srv.id, srv.myPermissions);
    }
    const categoryOriginMap = withCategoryOrigins(
      current.categoryOriginMap,
      spaces.flatMap((srv) => srv.categories ?? []),
      origin,
    );

    // Upsert every space member into the userViews cache. Assets for remote
    // origins were normalized by the ready handler in useWebSocket before
    // populateFromReady was called, so the user objects are already clean here.
    for (const srv of spaces) {
      if (srv.members) {
        const { upsertUserView } = get();
        for (const member of srv.members) {
          upsertUserView(member.user, origin);
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

    // Upsert every DM member from every origin into the userViews cache.
    // This runs unconditionally (home + remote) and BEFORE the dedup pass so
    // members of DMs that are about to be discarded still land in the cache.
    // Assets are already normalized above for the remote case.
    {
      const { upsertUserView } = get();
      for (const dm of incomingDms) {
        for (const member of dm.members) {
          upsertUserView(member, origin);
        }
      }
    }

    // Every DM this origin holds replaces its previous copies; the merge
    // module dedups them against the other origins' copies and pins one copy
    // per conversation. The DM fields of the store are derived from the result.
    const dmOperation = mergeOriginListing(get().dmConversations, origin, incomingDms, new Map(), dmPinContext());
    const dmView = deriveDmView(dmOperation.next, get().dmChannels, channelTables.index, channelTables.lastMessageIds);

    const update: Partial<SpaceState> = {
      ...channelTableFields(get(), channelTables, dmOperation.next),
      // After the channel fields: the DM view adds its entries to both shared maps.
      ...dmView,
      spaces: mergedSpaces,
      spacePermissions,
      categoryOriginMap,
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
      update._layoutUpdatedAt = incomingTs;
    } else {
      // Our layout is newer — push back to this instance
      pushLayoutToOrigin(origin, get().spaceLayout, get().folders, currentTs);
    }

    set(update);
    if (dmOperation.pinMoves.length > 0) {
      applyDmPinMoves(dmOperation.pinMoves);
      get().resortDmChannels();
    }
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
      directoryListed: space.directoryListed ?? false,
      description: space.description,
      createdAt: space.createdAt,
      _instanceOrigin: origin,
    };

    let dropped: string[] = [];
    set((state) => {
      const replaced = replaceSpaceChannels(channelTablesOf(state), space.id, origin, space.channels);
      dropped = replaced.dropped;
      const spacePermissions = new Map(state.spacePermissions);
      if (space.myPermissions) spacePermissions.set(space.id, space.myPermissions);
      return {
        ...channelTableFields(state, replaced.tables),
        spaces: [...state.spaces.filter(s => s.id !== space.id), tagged],
        spacePermissions,
        categoryOriginMap: withCategoryOrigins(state.categoryOriginMap, space.categories ?? [], origin),
      };
    });
    if (dropped.length > 0) useChatStore.getState().removeChannelStates(new Set(dropped));
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

  findExistingDmForUser: (target, targetOrigin) => {
    const { dmChannels, channelOriginMap } = get();
    const targetKey = userKey(target, targetOrigin);

    for (const dm of dmChannels) {
      if (dm.members.length !== 2) continue;
      const origin = channelOriginMap.get(dm.id) || '';
      const other = dm.members.find(m => !isMe(m, origin));
      if (other && userKey(other, origin) === targetKey) return { dm, origin };
    }
    return null;
  },

  removeInstanceSpaces: (origin: string) => {
    // The instance is gone: the id its `ready` gave the user says nothing now.
    useAuthStore.getState().forgetMyRow(origin);

    // Collect channel IDs before set() for chatStore cleanup
    const currentState = get();
    const channelIdsToRemove = new Set<string>();
    for (const [channelId, chOrigin] of currentState.channelOriginMap) {
      if (chOrigin === origin) channelIdsToRemove.add(channelId);
    }

    set((state) => {
      const remainingSpaces = state.spaces.filter(s => s._instanceOrigin !== origin);

      const spacePermissions = new Map(state.spacePermissions);
      for (const s of state.spaces) {
        if (s._instanceOrigin === origin) {
          spacePermissions.delete(s.id);
        }
      }
      const categoryOriginMap = new Map<string, string>();
      for (const [categoryId, categoryOrigin] of state.categoryOriginMap) {
        if (categoryOrigin !== origin) categoryOriginMap.set(categoryId, categoryOrigin);
      }
      const spaceChannelIds = channelIdsWhere(state.spaceChannelIndex, (e) => e.origin === origin);

      // Prune userViews: drop entries delivered by this origin. Symmetrical
      // with the DM copies — full removal evicts; transient disconnect leaves
      // the last-known view in place. If the surviving cache no longer holds
      // a home view for some user, render falls back to whatever the carrying
      // payload supplies (no crash; just degrades to stub view).
      const userViews = new Map<string, UserViewEntry>();
      for (const [key, entry] of state.userViews) {
        if (entry.deliveredBy !== origin) userViews.set(key, entry);
      }

      // Drop loadedSpaceIds entries for spaces removed by this instance teardown
      const removedSpaceIds = new Set(
        state.spaces.filter(s => s._instanceOrigin === origin).map(s => s.id)
      );
      const loadedSpaceIds = new Set<string>();
      for (const id of state.loadedSpaceIds) {
        if (!removedSpaceIds.has(id)) loadedSpaceIds.add(id);
      }

      return {
        ...channelTableFields(state, dropChannels(channelTablesOf(state), spaceChannelIds)),
        spaces: remainingSpaces,
        spacePermissions,
        categoryOriginMap,
        userViews,
        currentSpaceId: remainingSpaces.find(s => s.id === state.currentSpaceId)
          ? state.currentSpaceId
          : null,
        lastSelectedSpaceId: remainingSpaces.find(s => s.id === state.lastSelectedSpaceId)
          ? state.lastSelectedSpaceId
          : null,
        loadedSpaceIds,
      };
    });

    // This origin's DM copies go. A row pinned to one of them moves to
    // another copy of its conversation, and its chat state moves with it,
    // before the states of the removed ids are cleaned up below.
    commitDmOperation(dropOrigin(get().dmConversations, origin, dmPinContext()));

    // Clean up orphaned unread/read states and cached messages in chatStore
    if (channelIdsToRemove.size > 0) {
      useChatStore.getState().removeChannelStates(channelIdsToRemove);
    }
  },
}));

/**
 * What the client knows a channel id to be. `unknown` until a listing or an
 * event names it: before the `ready` of the instance that holds it, or after
 * it was deleted or hidden. Space channel ids and DM channel ids never
 * overlap, so the answer comes from the data alone, never from the URL.
 */
export type ChannelKind = 'space' | 'dm' | 'unknown';

function channelKindIn(
  state: Pick<SpaceState, 'spaceChannelIndex' | 'dmChannels' | 'dmAlternatives'>,
  channelId: string,
): ChannelKind {
  if (state.spaceChannelIndex.has(channelId)) return 'space';
  // A DM is a listed row or another instance's copy of one (ADR 0002).
  if (locateDmChannel(state.dmChannels, state.dmAlternatives, channelId)) return 'dm';
  return 'unknown';
}

/** `ChannelKind` of `channelId` now. For event-time code; render reads `useIsDmChannel`. */
export function getChannelKind(channelId: string): ChannelKind {
  return channelKindIn(useSpaceStore.getState(), channelId);
}

/** Whether `channelId` is a known DM now. An unknown channel is not one. */
export function isDmChannel(channelId: string): boolean {
  return getChannelKind(channelId) === 'dm';
}

/**
 * Reactive `isDmChannel` for render: true for a DM, false for a space
 * channel, undefined while the channel is unknown (see `ChannelKind`). Each
 * caller decides what unknown means for it.
 */
export function useIsDmChannel(channelId: string): boolean | undefined {
  const kind = useSpaceStore((s) => channelKindIn(s, channelId));
  return kind === 'unknown' ? undefined : kind === 'dm';
}

/**
 * Returns the instance origin for a given channel ID.
 * '' = home instance, 'https://...' = remote instance.
 */
export function getChannelOrigin(channelId: string): string {
  return useSpaceStore.getState().channelOriginMap.get(channelId) ?? '';
}

/**
 * The owner's home instance of a group DM as the channel records it
 * (`ownerHomeInstance`, an origin or host), or '' when none is recorded.
 * `utils/groupDmOwnerActions.ts` sends owner-only requests there.
 *
 * Distinct from getChannelOrigin: that function returns the channel's
 * pinned serving origin (where the client's WS connection mirrors the
 * channel), which can differ from the owner's home instance after a
 * manual transfer.
 */
export function getOwnerInstanceForDm(channelId: string): string {
  const dm = useSpaceStore.getState().dmChannels.find(d => d.id === channelId);
  return dm?.ownerHomeInstance ?? '';
}

/**
 * Resolves a raw DM channel ID to its primary `dmChannels` entry ID.
 *
 * - If `rawId` is already a primary entry: returns `rawId` unchanged.
 * - If `rawId` is another origin's copy of a conversation listed in
 *   `dmChannels` (the derived `dmAlternatives` index): returns the primary's ID.
 * - Otherwise: returns `null` (unknown ID — caller should no-op).
 *
 * The lookup itself is `locateDmChannel` (`utils/dmChannelLookup.ts`), shared
 * with `utils/channelUser.ts`.
 *
 * Used by:
 *  - `dm_message_created` WS handler to route messages arriving from alternate
 *    origins to the primary entry (§3.11 of the failover spec).
 *  - Future DM WS handlers that need to dedup alternate-origin deliveries.
 */
export function resolveDmChannelId(rawId: string): string | null {
  const { dmChannels, dmAlternatives } = useSpaceStore.getState();
  return locateDmChannel(dmChannels, dmAlternatives, rawId)?.dm.id ?? null;
}

/**
 * The channel id `origin` holds for the DM conversation of `channelId`, or
 * null when that instance holds no copy of it. A request to an instance must
 * name the conversation by that instance's own id, not by the pinned copy's.
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
// The resolver/setter pairs and the WS-populated user-ID cache live in
// `utils/crossStoreResolvers.ts` — a neutral module with no store imports —
// to break a TDZ cycle: instanceStore registers these at top-level load, but
// a spaceStore-rooted import chain leaves spaceStore mid-load when that code
// runs. Re-exported here for backward compatibility with existing import
// sites. See the header comment in crossStoreResolvers.ts for details.
export {
  setApiForOriginResolver,
  getApiForOrigin,
  setOriginFromHostnameResolver,
  setTokenForOriginResolver,
  getTokenForOrigin,
} from '../utils/crossStoreResolvers';

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

/** The signed-in user's row id on an instance; defined with the record it reads (`authStore.myRowIds`). */
export { getMyUserIdForOrigin };
