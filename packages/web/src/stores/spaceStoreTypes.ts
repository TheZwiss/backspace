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
import type { PresenceSubject } from '../utils/identity';
import type { PeerDmChannel } from '../utils/dmConversationKey';
import type { DmConversations } from './dmConversations';
import type { TaggedSpace, UserViewEntry } from './spaceStore';

export interface SpaceState {
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
  channelToSpaceMap: Map<string, string>;
  channelLastMessageIds: Map<string, string>;
  spacePermissions: Map<string, string>; // spaceId → myPermissions decimal string
  channelPermissions: Map<string, string>; // channelId → myPermissions decimal string
  channelOriginMap: Map<string, string>; // channelId → instance origin ('' = home)
  voiceChannelIds: Set<string>; // channelIds that are voice channels (excluded from unread)
  categoryOriginMap: Map<string, string>; // categoryId → instance origin ('' = home)
  /**
   * Derived: conversation key → (origin → that origin's channel id), for every
   * copy of every keyed conversation, the pinned one included. The index
   * `resolveDmChannelId` reads to place an id another instance sent.
   */
  dmAlternatives: Map<string, Map<string, string>>;
  /**
   * canonicalUserKey → best-known view of that user. Populated from every wire
   * surface that delivers a User object (DM members, message authors, friends,
   * space members, profile updates). Pruned only on full instance removal
   * (`removeInstanceSpaces`) and `reset`, never on transient WS disconnect —
   * mirrors `dmAlternatives`' no-flapping invariant. Render sites read through
   * `getCanonicalUserView` / `useCanonicalUserView` to surface the home view
   * even when the carrying channel was deduped away.
   */
  userViews: Map<string, UserViewEntry>;
  loadingSpaceId: string | null; // non-null while loadSpaceDetail is fetching
  /**
   * Set of spaceIds whose `loadSpaceDetail` has completed at least once this
   * session. Distinct from `currentSpaceId` (which moves with selection) and
   * from `loadingSpaceId` (which only marks in-flight). Render sites use this
   * to differentiate "load not yet attempted" from "loaded with empty result"
   * — see `MobileSpacesScreen`'s mascot empty state, which must not appear
   * during the pre-skeleton load window.
   */
  loadedSpaceIds: Set<string>;
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
  setDmChannels: (channels: DmChannel[]) => void;
  addDmChannel: (channel: DmChannel, origin?: string) => void;
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
  loadSpaceDetail: (spaceId: string) => Promise<void>;
  createSpace: (data: CreateSpaceRequest) => Promise<Space>;
  updateSpace: (spaceId: string, data: UpdateSpaceRequest) => Promise<void>;
  deleteSpace: (spaceId: string) => Promise<void>;
  joinSpace: (spaceId: string, inviteCode: string) => Promise<void>;
  leaveSpace: (spaceId: string) => Promise<void>;
  joinByCode: (inviteCode: string, origin?: string) => Promise<Space>;
  generateInvite: (spaceId: string) => Promise<string>;
  createChannel: (spaceId: string, name: string, type: 'text' | 'voice', topic?: string, categoryId?: string) => Promise<Channel>;
  upsertChannel: (channel: Channel, spaceId: string, origin: string) => void;
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
   * `activityKey` (their home identity), never by a raw row id.
   */
  updateMemberPresence: (subject: PresenceSubject, origin: string, status: string) => void;
  updateUserEverywhere: (user: User) => void;
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
  findExistingDmForUser: (targetUser: { id: string; homeUserId?: string | null }) => { dm: DmChannel; origin: string } | null;
  reset: () => void;
}
