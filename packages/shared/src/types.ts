import type { ErrorCode } from './errors.js';

// ─── Constants ──────────────────────────────────────────────────────────────

export const MAX_MESSAGE_LENGTH = 4000;

// ─── User Types ─────────────────────────────────────────────────────────────

export const AVATAR_COLORS = ['mint', 'sky', 'lavender', 'coral', 'rose', 'teal', 'amber'] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  banner: string | null;
  accentColor: string | null;
  avatarColor: AvatarColor | null;
  bio: string | null;
  status: UserStatus;
  customStatus: string | null;
  isAdmin: boolean;
  isDeleted?: boolean;
  discoverable?: boolean;
  profileUpdatedAt?: number;
  createdAt: number;
  homeInstance: string | null;
  homeUserId: string | null;
  replicatedInstances: ReplicatedInstance[];
  showActivity?: boolean;
  /** Self-view only: this federated account's home instance was reset/lost — it now operates as a sovereign local account (detach spec). */
  federationHomeOrphaned?: boolean;
  /**
   * Self-view only: the home instance a detached account was federated from
   * before it was detached, or null. A detached account is homed on the
   * instance that holds it (`homeInstance` and `homeUserId` are null), so this
   * is the only place its former home is still named; re-attach needs it.
   * Read it through {@link detachedHomeOf}.
   */
  detachedHomeInstance?: string | null;
}

export interface ReplicatedInstance {
  origin: string;   // Full URL with protocol, e.g. "https://orbit.ddns.net"
  username: string;
  domain?: string;  // Legacy field — kept for backward compat with existing data
}

export type FederationRegistryStatus = 'connected' | 'disconnected' | 'unreachable' | 'auth_expired';

export interface FederationRegistryEntry {
  origin: string;
  label: string;
  username: string;
  remoteUserId: string;
  status: FederationRegistryStatus;
  addedAt: number;
  lastConnectedAt: number | null;
  disconnectedAt: number | null;
  errorMessage: string | null;
}

export type UserStatus = 'online' | 'idle' | 'dnd' | 'offline';
/** A status a user can pick. 'offline' is never chosen: it means "no connection". */
export type ChosenUserStatus = Exclude<UserStatus, 'offline'>;

export const CHOSEN_USER_STATUSES: readonly ChosenUserStatus[] = ['online', 'idle', 'dnd'];

export function isChosenUserStatus(value: unknown): value is ChosenUserStatus {
  return typeof value === 'string' && (CHOSEN_USER_STATUSES as readonly string[]).includes(value);
}

/** Whether an account row carries the detached flag (integer on the server row, boolean on the client `User`). */
function isDetached(account: { federationHomeOrphaned?: number | boolean | null }): boolean {
  return account.federationHomeOrphaned === 1 || account.federationHomeOrphaned === true;
}

/**
 * Whether an account owns its chosen status, so its own row is where the choice
 * is stored and read (`users.chosen_status`). True for an account homed on the
 * instance that holds the row: a native account, and a detached one (its home
 * instance was reset, so it is homed here now); false for a replicated
 * account, whose choice lives on its home instance. The same authority rule
 * the server applies to profile edits and credential issuance.
 *
 * Since #310 a detached row carries no `homeInstance` (federation.md,
 * "Detached accounts are homed here"), so `!homeInstance` alone decides for
 * rows from this version. The detached flag still counts on its own for a row
 * served by an instance that predates that rewrite, where a detached account
 * kept its former home in `homeInstance`.
 *
 * Accepts the server row (integer flag) and the client `User` (boolean flag).
 * activity-presence.md, "DB Persistence".
 */
export function ownsChosenStatus(account: {
  homeInstance?: string | null;
  federationHomeOrphaned?: number | boolean | null;
}): boolean {
  return !account.homeInstance || isDetached(account);
}

/**
 * The home instance a detached account was federated from, or null when the
 * account is not detached. Rows from this version name it in
 * `detachedHomeInstance`; a row served by an instance that predates #310 kept
 * it in `homeInstance`, which is read as the fallback.
 */
export function detachedHomeOf(account: {
  homeInstance?: string | null;
  detachedHomeInstance?: string | null;
  federationHomeOrphaned?: number | boolean | null;
}): string | null {
  if (!isDetached(account)) return null;
  return account.detachedHomeInstance || account.homeInstance || null;
}

export interface UserWithPassword extends User {
  passwordHash: string;
}

// ─── Space (Community) Types ─────────────────────────────────────────────────

export type SpaceVisibility = 'public' | 'request' | 'private';

export interface Space {
  id: string;
  name: string;
  icon: string | null;
  banner: string | null;
  avatarColor: AvatarColor | null;
  ownerId: string;
  inviteCode: string | null;
  visibility: SpaceVisibility;
  directoryListed: boolean;
  description: string | null;
  createdAt: number;
}

export interface InvitePreview {
  spaceId: string;
  spaceName: string;
  description: string | null;
  icon: string | null;
  avatarColor: AvatarColor | null;
  memberCount: number;
  instanceName: string;
}

export interface ExploreSpace {
  id: string;
  name: string;
  icon: string | null;
  banner: string | null;
  avatarColor: AvatarColor | null;
  description: string | null;
  visibility: SpaceVisibility;
  memberCount: number;
  createdAt: number;
  joined?: boolean;
}

/** Why the last directory ping did not go through. `reason` is set when `status` is 'fetch'. */
export interface DirectoryPingError {
  at: number;
  status: number | 'network' | 'timeout' | 'origin' | 'fetch';
  reason?: 'unreachable' | 'status' | 'invalid' | 'origin-mismatch';
}

/** One space as an instance serves it on GET /api/directory/spaces. */
export interface DirectoryDocumentSpace {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  banner: string | null;
  avatarColor: AvatarColor | null;
  visibility: 'public' | 'request';
  memberCount: number;
  createdAt: number;
}

/** The document an instance serves. `schema` is fixed at 1 for this release. */
export interface DirectoryDocument {
  schema: 1;
  origin: string;
  instance: { name: string; federatedRegistrationOpen: boolean; version: string | null };
  spaces: DirectoryDocumentSpace[];
}

/** One entry of the hub's feed: a document space plus the origin it came from. */
export interface DirectoryEntry extends DirectoryDocumentSpace {
  origin: string;
  instanceName: string;
  federatedRegistrationOpen: boolean;
}

export interface DirectoryFeed {
  schema: 1;
  spaces: DirectoryEntry[];
}

export interface JoinRequest {
  id: string;
  spaceId: string;
  userId: string;
  message: string | null;
  status: 'pending' | 'accepted' | 'declined';
  decidedBy: string | null;
  createdAt: number;
  decidedAt: number | null;
  user?: User;
}

export interface SpaceWithChannelsAndMembers extends Space {
  channels: Channel[];
  categories: ChannelCategory[];
  members: MemberWithUser[];
  roles: Role[];
  myPermissions?: string; // Computed per-user BigInt decimal string (space-level)
}

// ─── Member Types ───────────────────────────────────────────────────────────

export interface Member {
  spaceId: string;
  userId: string;
  nickname: string | null;
  joinedAt: number;
}

export interface MemberWithUser extends Member {
  user: User;
  roles: Role[];
}

// ─── Role Types ─────────────────────────────────────────────────────────────

export interface Role {
  id: string;
  spaceId: string;
  name: string;
  color: string;
  position: number;
  permissions?: string; // BigInt decimal string (bitwise)
  isEveryone?: boolean; // UI hint: true when role.id === space.id
  createdAt: number;
}

// ─── Folder Types ───────────────────────────────────────────────────────────

export interface SpaceFolder {
  id: string;
  userId: string;
  name: string | null;
  color: string | null;
  position: number;
  spaceIds: string[];
}

// ─── Space Layout Types ────────────────────────────────────────────────────

export type SpaceLayoutItem =
  | { t: 's'; id: string }
  | { t: 'f'; id: string };

// ─── Channel Types ──────────────────────────────────────────────────────────

export type ChannelType = 'text' | 'voice';

export interface ChannelCategory {
  id: string;
  spaceId: string;
  name: string;
  position: number;
  isPrivate?: boolean;
  createdAt: number;
}

export interface CategoryOverride {
  categoryId: string;
  targetType: 'role' | 'member';
  targetId: string;
  allow: string;
  deny: string;
}

export interface Channel {
  id: string;
  spaceId: string;
  name: string;
  type: ChannelType;
  topic: string | null;
  position: number;
  categoryId: string | null;
  isPrivate?: boolean;
  createdAt: number;
  lastMessageId?: string | null;
  myPermissions?: string; // Computed per-user BigInt decimal string
}

export interface ReadState {
  channelId: string;
  lastReadMessageId: string;
}

// ─── Notification Settings ─────────────────────────────────────────────────
// Per-space and per-channel alert preferences, stored on the instance that
// hosts the space (docs/systems/sounds.md, "Notification settings").

/**
 * Which messages of a space channel alert the user (sound and desktop
 * notification). DMs are not governed by it.
 *
 * - `all`: every message from someone else.
 * - `mentions`: only messages that mention the user.
 * - `nothing`: no message, mentions included.
 */
export const NOTIFICATION_LEVELS = ['all', 'mentions', 'nothing'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/** The level of a space with no stored choice, and of every channel that inherits it. */
export const DEFAULT_NOTIFICATION_LEVEL: NotificationLevel = 'mentions';

export function isNotificationLevel(value: unknown): value is NotificationLevel {
  return typeof value === 'string' && (NOTIFICATION_LEVELS as readonly string[]).includes(value);
}

/**
 * How long a mute lasts. The server turns a duration into `mutedUntil` with
 * its own clock, so every session of the user sees the same end time.
 */
export const NOTIFICATION_MUTE_DURATIONS = ['1h', '8h', '24h', 'indefinite'] as const;
export type NotificationMuteDuration = (typeof NOTIFICATION_MUTE_DURATIONS)[number];

/** Length of each timed mute in ms; `indefinite` has none. */
export const NOTIFICATION_MUTE_DURATION_MS: Record<Exclude<NotificationMuteDuration, 'indefinite'>, number> = {
  '1h': 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

export function isNotificationMuteDuration(value: unknown): value is NotificationMuteDuration {
  return typeof value === 'string' && (NOTIFICATION_MUTE_DURATIONS as readonly string[]).includes(value);
}

/**
 * One stored notification setting of the signed-in user, for a whole space
 * (`channelId` null) or for one channel of it. Ids are the hosting
 * instance's.
 *
 * `level` null means "not chosen": a channel then inherits its space's level,
 * and a space uses `DEFAULT_NOTIFICATION_LEVEL`. `muted` with `mutedUntil`
 * null is a mute until the user lifts it; with a time, the mute ends then
 * (epoch ms, the server's clock). A mute that has ended reads as not muted.
 *
 * `updatedAt` is the server's write time. A setting with no choice left
 * (`level` null and not muted) is not stored, and is sent as such so other
 * sessions drop theirs.
 */
export interface NotificationSetting {
  spaceId: string;
  channelId: string | null;
  level: NotificationLevel | null;
  muted: boolean;
  mutedUntil: number | null;
  updatedAt: number;
}

/**
 * Body of `PATCH /api/spaces/:spaceId/notification-settings` and
 * `PATCH /api/channels/:channelId/notification-settings`. An absent field is
 * left as it is. `level: null` clears the choice (inherit / default);
 * `mute: null` lifts the mute.
 */
export interface UpdateNotificationSettingRequest {
  level?: NotificationLevel | null;
  mute?: NotificationMuteDuration | null;
}

export interface NotificationSettingsResponse {
  settings: NotificationSetting[];
}

/** Whether a stored mute is in force at `now`. */
export function isMuteActive(setting: Pick<NotificationSetting, 'muted' | 'mutedUntil'> | null | undefined, now: number): boolean {
  if (!setting || !setting.muted) return false;
  return setting.mutedUntil === null || setting.mutedUntil > now;
}

/** Where a channel's effective level came from. */
export type NotificationLevelSource = 'channel' | 'space' | 'default';

/**
 * What applies to one space channel: its level after inheritance, and
 * whether it is muted (its own mute or its space's). `mutedUntil` is the
 * end of the mute in force (null while indefinite or not muted); with both
 * the channel and the space muted it is the later of the two ends.
 */
export interface ChannelNotificationPolicy {
  level: NotificationLevel;
  levelSource: NotificationLevelSource;
  muted: boolean;
  mutedUntil: number | null;
  /** The channel's own mute is in force (as opposed to only the space's). */
  channelMuted: boolean;
  /** The space's mute is in force. */
  spaceMuted: boolean;
}

/**
 * The inheritance rule, in one place: a channel's own level wins, else its
 * space's, else `DEFAULT_NOTIFICATION_LEVEL`. A channel is muted while its
 * own mute or its space's is in force.
 */
export function resolveChannelNotificationPolicy(
  spaceSetting: NotificationSetting | null | undefined,
  channelSetting: NotificationSetting | null | undefined,
  now: number,
): ChannelNotificationPolicy {
  let level: NotificationLevel = DEFAULT_NOTIFICATION_LEVEL;
  let levelSource: NotificationLevelSource = 'default';
  if (channelSetting?.level) {
    level = channelSetting.level;
    levelSource = 'channel';
  } else if (spaceSetting?.level) {
    level = spaceSetting.level;
    levelSource = 'space';
  }
  const channelMuted = isMuteActive(channelSetting, now);
  const spaceMuted = isMuteActive(spaceSetting, now);
  const ends: Array<number | null> = [];
  if (channelMuted && channelSetting) ends.push(channelSetting.mutedUntil);
  if (spaceMuted && spaceSetting) ends.push(spaceSetting.mutedUntil);
  let mutedUntil: number | null = null;
  if (ends.length > 0 && !ends.includes(null)) {
    mutedUntil = Math.max(...ends.filter((end): end is number => end !== null));
  }
  return { level, levelSource, muted: channelMuted || spaceMuted, mutedUntil, channelMuted, spaceMuted };
}

// ─── Message Types ──────────────────────────────────────────────────────────

export interface Message {
  id: string;
  channelId: string;
  userId: string;
  replyToId: string | null;
  content: string | null;
  type?: 'user' | 'system';
  editedAt: number | null;
  createdAt: number;
}

export interface MessageWithUser extends Message {
  user: User;
  attachments: Attachment[];
  embeds: Embed[];
  reactions: Reaction[];
  replyTo?: MessageWithUser | null;
}

// ─── Reaction Types ────────────────────────────────────────────────────────

export interface Reaction {
  id: string;
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: number;
  user?: User;
}

// ─── Attachment Types ───────────────────────────────────────────────────────

export interface Attachment {
  id: string;
  messageId: string;
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
  thumbnailFilename?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  /**
   * Web-playability for video attachments. `false` = the codec can't be
   * decoded in a browser <video> (e.g. HEVC .mov) so the client renders a
   * download fallback; `true`/`null` = attempt inline playback (null is the
   * optimistic unknown case, also covered by the client's onError fallback).
   */
  playable?: boolean | null;
  federationStatus?: string | null;
  federationMeta?: string | null;
  createdAt: number;
}

// ─── Embed Types ──────────────────────────────────────────────────────────

export type EmbedType = 'generic' | 'video' | 'image' | 'audio' | 'rich';
export type EmbedProvider = 'youtube' | 'vimeo' | 'spotify';

export interface Embed {
  id: string;
  messageId: string | null;
  dmMessageId: string | null;
  url: string;
  embedType: EmbedType;
  provider: EmbedProvider | null;
  title: string | null;
  description: string | null;
  image: string | null;
  embedUrl: string | null;
  width: number | null;
  height: number | null;
  color: string | null;
  createdAt: number;
}

// ─── Active Call Types ───────────────────────────────────────────────────────

export interface ActiveCallInfo {
  dmChannelId: string | null;
  federatedCallId?: string;
  callerId: string;
  participants: string[];
  startedAt: number;
  state: 'ringing' | 'active';
  // Federation fields (present only for federated calls on remote instances)
  federatedCallHost?: string;
  livekitUrl?: string;
  livekitToken?: string;  // this user's LiveKit token (server filters per-user at payload assembly)
}

// ─── DM Types ───────────────────────────────────────────────────────────────

export interface DmLastMessagePreview {
  id: string;
  dmChannelId: string;
  userId: string;
  content: string | null;
  createdAt: number;
  /**
   * 'system' for membership/lifecycle JSON payloads (member_added, member_removed,
   * owner_changed, space_invite). 'user' (or omitted) for normal user-authored
   * messages. The sidebar renderer relies on this to avoid showing raw JSON.
   */
  type?: 'user' | 'system';
  attachments?: Array<{ type: string; filename: string }>;
}

/**
 * A DM conversation as a current server puts it on the wire. Every field is
 * required, nullable where the row can be null, so a server payload that
 * forgets one does not compile; the server builds it only through
 * `utils/dmChannelWire.ts` (ADR 0002).
 */
export interface DmChannel {
  id: string;
  /** The conversation key: `null` only for a group no other instance holds. */
  federatedId: string | null;
  ownerId: string | null;
  ownerHomeUserId: string | null;
  ownerHomeInstance: string | null;
  createdAt: number;
  members: User[];
  lastMessage: DmLastMessagePreview | DmMessageWithUser | null;
  name: string | null;
  icon: string | null;
  metadataUpdatedAt: number;
}

export interface DmMessage {
  id: string;
  dmChannelId: string;
  userId: string;
  content: string | null;
  type?: 'user' | 'system';
  createdAt: number;
  // Compatibility fields
  channelId?: string;
  replyToId?: string | null;
  editedAt?: number | null;
  // Federation relay identity
  sourceMessageId?: string | null;
  sourceInstance?: string | null;
}

export interface DmMessageWithUser extends DmMessage {
  user: User;
  attachments: Attachment[];
  embeds: Embed[];
  reactions: Reaction[];
  replyTo?: DmMessageWithUser | null;
}

// ─── Activity Types ────────────────────────────────────────────────────────

export type ActivityType = 'custom' | 'playing' | 'listening' | 'watching' | 'streaming';

export interface ActivityTimestamps {
  start?: number;
  end?: number;
}

export interface ActivityAssets {
  largeImage?: string;
  largeText?: string;
  smallImage?: string;
  smallText?: string;
}

export interface Activity {
  type: ActivityType;
  name: string;
  details?: string;
  state?: string;
  timestamps?: ActivityTimestamps;
  assets?: ActivityAssets;
  url?: string;
}

// ─── WebSocket Event Types ──────────────────────────────────────────────────

export type DmCallUndeliverableReason =
  | 'peer_rejected'
  | 'peer_awaiting_approval'
  | 'peer_transient_failure'
  | 'livekit_unavailable'
  | 'no_recipient';

export type DmCallPhase = 'start' | 'accept' | 'reject' | 'end' | 'host_unreachable';

export interface DmCallUndeliverableFailure {
  reason: DmCallUndeliverableReason;
  peerOrigin?: string;
  peerLabel?: string;
  affectedUserIds?: string[];
}

// Client → Server Events
export type ClientEvent =
  | { type: 'auth'; token: string; client?: ClientKind }
  | { type: 'message_create'; channelId: string; content: string; replyToId?: string }
  | { type: 'message_edit'; messageId: string; content: string }
  | { type: 'message_delete'; messageId: string }
  | { type: 'typing_start'; channelId: string }
  | { type: 'presence_update'; status: ChosenUserStatus }
  | { type: 'voice_join'; channelId: string }
  | { type: 'voice_leave' }
  | { type: 'dm_message_create'; dmChannelId: string; content?: string; attachments?: string[]; replyToId?: string }
  | { type: 'dm_typing_start'; dmChannelId: string }
  | { type: 'dm_message_edit'; messageId: string; content: string }
  | { type: 'dm_message_delete'; messageId: string }
  | { type: 'reaction_add'; messageId: string; emoji: string }
  | { type: 'reaction_remove'; messageId: string; emoji: string }
  | { type: 'channel_ack'; channelId: string; messageId: string }
  | { type: 'mark_unread'; channelId: string; messageId: string }
  | { type: 'dm_call_start'; dmChannelId: string }
  | { type: 'dm_call_accept'; dmChannelId: string | null; federatedCallId?: string | null }
  | { type: 'dm_call_reject'; dmChannelId: string | null; federatedCallId?: string | null }
  | { type: 'dm_call_end'; dmChannelId: string | null; federatedCallId?: string | null }
  | { type: 'voice_status'; isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }
  | { type: 'voice_space_mute'; userId: string; muted: boolean }
  | { type: 'voice_space_deafen'; userId: string; deafened: boolean }
  | { type: 'voice_move'; userId: string; targetChannelId: string }
  | { type: 'voice_disconnect'; userId: string }
  | { type: 'activity_update'; activities: Activity[] }
  | { type: 'ping' };

/**
 * Who a presence snapshot is about, beyond the delivering instance's local row
 * id: the row's `homeUserId` and `homeInstance`, both null for a user native to
 * the delivering instance. The client keys activities by the federated identity
 * this names (see activityStore), so every instance's view of one person lands
 * on one key. Absent on servers that predate the fields.
 */
export interface PresenceIdentity {
  homeUserId: string | null;
  homeInstance: string | null;
}

// Server → Client Events
export type ServerEvent =
  | { type: 'ready'; user: User; spaces: SpaceWithChannelsAndMembers[]; dmChannels: DmChannel[]; folders?: SpaceFolder[]; spaceLayout?: SpaceLayoutItem[] | null; layoutUpdatedAt?: number; voiceStates?: Record<string, string[]>; voiceChannelElapsedSeconds?: Record<string, number>; voiceUserStates?: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>; readStates?: ReadState[]; activeCalls?: ActiveCallInfo[]; spaceVoiceStates?: Record<string, { spaceMuted: boolean; spaceDeafened: boolean }>; userActivities?: Record<string, Activity[]>; userActivityIdentities?: Record<string, PresenceIdentity>; rejectedPeerOrigins?: string[]; awaitingApprovalPeerOrigins?: string[]; activePeerOrigins?: string[]; pendingApprovalCount?: number }
  | { type: 'message_created'; message: MessageWithUser }
  | { type: 'message_updated'; message: MessageWithUser }
  | { type: 'message_deleted'; messageId: string; channelId: string }
  | { type: 'typing'; channelId: string; userId: string; username: string }
  | ({ type: 'presence_update'; userId: string; status: string; activities?: Activity[] } & Partial<PresenceIdentity>)
  | { type: 'voice_state_update'; channelId: string; userId: string; action: 'join' | 'leave'; channelElapsedSeconds?: number }
  | { type: 'member_joined'; spaceId: string; member: MemberWithUser }
  | { type: 'member_left'; spaceId: string; userId: string }
  | { type: 'dm_message_created'; message: DmMessageWithUser }
  | { type: 'dm_message_updated'; message: DmMessageWithUser }
  | { type: 'dm_message_deleted'; messageId: string; dmChannelId: string }
  | { type: 'dm_typing'; dmChannelId: string; userId: string; username: string }
  | { type: 'dm_typing_stop'; dmChannelId: string; userId: string }
  | { type: 'reaction_added'; messageId: string; reaction: Reaction }
  | { type: 'reaction_removed'; messageId: string; userId: string; emoji: string }
  | { type: 'channel_ack'; channelId: string; messageId: string }
  | { type: 'friend_request_received'; request: FriendRequest }
  | { type: 'friend_request_accepted'; friend: Friend; requestId: string }
  | { type: 'dm_call_incoming'; dmChannelId: string | null; federatedCallId?: string; callerId: string; callerName: string; livekitUrl?: string; livekitToken?: string; callOrigin?: string }
  | { type: 'dm_call_accepted'; dmChannelId: string | null; federatedCallId?: string }
  | { type: 'dm_call_rejected'; dmChannelId: string }
  | { type: 'dm_call_ended'; dmChannelId: string }
  | { type: 'dm_call_undeliverable'; dmChannelId: string | null; federatedCallId: string; terminal: boolean; phase: DmCallPhase; failures: DmCallUndeliverableFailure[] }
  | { type: 'voice_status_update'; userId: string; channelId: string; isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }
  | { type: 'space_voice_state'; spaceId: string; voiceStates: Record<string, string[]>; voiceChannelElapsedSeconds: Record<string, number>; voiceUserStates: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>; spaceVoiceStates: Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted: boolean }> }
  | { type: 'dm_channel_created'; dmChannel: DmChannel }
  | { type: 'dm_channel_closed'; dmChannelId: string }
  | { type: 'dm_channel_updated'; dmChannelId: string; name: string | null; icon: string | null }
  | { type: 'dm_member_added'; dmChannelId: string; user: User }
  | { type: 'dm_member_removed'; dmChannelId: string; userId: string }
  | { type: 'friend_removed'; userId: string }
  | { type: 'friend_request_cancelled'; requestId: string; userId: string }
  | { type: 'friend_request_declined'; requestId: string; userId: string }
  | { type: 'friend_request_sent'; request: FriendRequest }
  | { type: 'friend_request_relay_failed'; requestId: string; reason: 'user_not_found' | 'peer_rejected'; message: string; targetHandle: string }
  | { type: 'channel_created'; channel: Channel; spaceId: string }
  | { type: 'channel_updated'; channel: Channel; spaceId: string }
  | { type: 'channel_deleted'; channelId: string; spaceId: string }
  | { type: 'space_updated'; space: Space }
  | { type: 'join_request_received'; request: JoinRequest }
  | { type: 'join_request_accepted'; request: JoinRequest; space: SpaceWithChannelsAndMembers }
  | { type: 'join_request_declined'; request: JoinRequest }
  | { type: 'voice_space_muted'; userId: string; channelId: string; spaceId: string; muted: boolean }
  | { type: 'voice_space_deafened'; userId: string; channelId: string; spaceId: string; deafened: boolean }
  | { type: 'voice_permission_muted'; userId: string; spaceId: string; muted: boolean }
  | { type: 'voice_moved'; userId: string; oldChannelId: string; newChannelId: string }
  | { type: 'voice_disconnected'; userId: string; channelId: string; reason?: 'displaced' | 'session_closed' | 'rejected' }
  | { type: 'user_updated'; user: User }
  | { type: 'member_banned'; spaceId: string; reason: string | null }
  | { type: 'category_created'; category: ChannelCategory; spaceId: string }
  | { type: 'category_updated'; category: ChannelCategory; spaceId: string }
  | { type: 'category_deleted'; categoryId: string; spaceId: string }
  | { type: 'channel_layout_updated'; spaceId: string; channels: Channel[]; categories: ChannelCategory[] }
  | { type: 'space_layout_updated'; layout: SpaceLayoutItem[]; folders: SpaceFolder[]; updatedAt?: number }
  // One of the user's notification settings on this instance changed (from
  // any of their sessions here). A setting with level null and not muted was
  // cleared. See docs/systems/websocket.md.
  | { type: 'notification_settings_updated'; setting: NotificationSetting }
  | { type: 'mark_unread'; channelId: string; messageId: string }
  | { type: 'embeds_resolved'; messageId: string; channelId: string; embeds: Embed[] }
  | { type: 'dm_embeds_resolved'; messageId: string; dmChannelId: string; embeds: Embed[] }
  | { type: 'federation_file_rejected'; messageId: string; dmChannelId: string; attachmentId: string; affectedUsers: Array<{ userId: string; username: string; limit: number }> }
  | { type: 'federation_peer_rejected'; peerOrigin: string; peerLabel?: string; reason: string; reasonCode?: FederationPeerStatusReason; affectedContexts: Array<{ contextType: 'dm' | 'friend'; contextId: string; contextLabel: string }> }
  | { type: 'federation_peer_active'; peerOrigin: string }
  | { type: 'federation_peers_changed' }
  | { type: 'federation_peer_reset_detected'; origin: string }
  | { type: 'federation_approval_request_received'; origin: string; instanceName?: string }
  | { type: 'peering_subscription_changed' }
  | { type: 'peering_notification_received'; kind: PeeringNotificationKind }
  | {
      type: 'dm_owner_updated';
      dmChannelId: string;
      newOwnerId: string;
      // Federation routing fields. Required for the client to keep
      // `dmChannel.ownerHomeInstance` in sync after a transfer — otherwise
      // owner-only API calls (`updateMetadata`, `kickMember`, `transferOwnership`)
      // continue to route through the previous owner's home instance via
      // `getOwnerInstanceForDm` until the user reconnects and receives a fresh
      // `ready` payload. Always populated on new emissions; tolerated as
      // optional for receivers connected to an older sender.
      newOwnerHomeUserId?: string | null;
      newOwnerHomeInstance?: string | null;
    }
  | { type: 'pong' }
  // `code` is set where the refusal has a stable ErrorCode (e.g. a voice
  // moderation action refused by the role hierarchy); older senders omit it.
  // `dmChannelId` names the DM of a refused `dm_call_start`; a client calling
  // that DM drops its calling state (voice.md, "DM Call State Machine").
  | { type: 'error'; message: string; code?: ErrorCode; dmChannelId?: string }
  // The space's roles or a member's roles changed: what the receiver may see
  // or do there, and how its roles and members look, may be different now.
  // The client refetches that space's detail (docs/systems/websocket.md).
  | { type: 'space_access_changed'; spaceId: string };

// ─── API Request/Response Types ─────────────────────────────────────────────

export interface RegisterRequest {
  username: string;
  password: string;
  displayName?: string;
  avatarColor?: string;
  homeInstance?: string;
  homeUserId?: string;
  inviteToken?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface CreateSpaceRequest {
  name: string;
  icon?: string;
  banner?: string;
  avatarColor?: string;
  visibility?: SpaceVisibility;
  description?: string;
}

export interface CreateChannelRequest {
  name: string;
  type: ChannelType;
  topic?: string;
  categoryId?: string;
}

export interface UpdateChannelRequest {
  name?: string;
  /** `null` or a value that trims to nothing clears the topic. */
  topic?: string | null;
  position?: number;
  categoryId?: string | null;
}

export interface UpdateSpaceRequest {
  name?: string;
  icon?: string;
  banner?: string;
  avatarColor?: string;
  visibility?: SpaceVisibility;
  directoryListed?: boolean;
  description?: string;
}

export interface UpdateUserRequest {
  displayName?: string;
  avatar?: string;
  banner?: string;
  accentColor?: string;
  avatarColor?: string;
  bio?: string;
  customStatus?: string;
  status?: ChosenUserStatus;
  replicatedInstances?: ReplicatedInstance[];
  homeUserId?: string;
  profileUpdatedAt?: number;
  discoverable?: boolean;
  showActivity?: boolean;
}

export interface UpdateMemberRequest {
  roleIds: string[];
}

export interface CreateMessageRequest {
  content: string;
  attachments?: string[];
  replyToId?: string;
}

export interface UpdateMessageRequest {
  content: string;
}

export interface JoinSpaceRequest {
  inviteCode: string;
}

export interface LiveKitTokenRequest {
  channelId: string;
}

export interface LiveKitTokenResponse {
  token: string;
  url: string;
}

export interface CreateDmRequest {
  userId?: string;
  homeUserId?: string;
  homeInstance?: string;
}

export interface AddDmMemberRequest {
  userId?: string;
  homeUserId?: string;
  homeInstance?: string;
}

/**
 * Body of POST /api/dm/:id/transfer.
 *
 * Accepts either a local user id (`newOwnerId`) or a federated identity
 * (`homeUserId` + `homeInstance`). Federated identification mirrors
 * `AddDmMemberRequest` and is required when the caller only knows the
 * target's home identity — typical for federated members surfaced through
 * the client's `userViews` cache, where `id` is the home id and not the
 * owner instance's local replicated id. When both are supplied, the
 * federated args take precedence (strictly more specific).
 */
export interface TransferOwnershipRequest {
  newOwnerId?: string;
  homeUserId?: string;
  homeInstance?: string;
}

export interface GroupDmUserIdentity {
  id: string;
  homeUserId?: string | null;
  homeInstance?: string | null;
}

export interface CreateGroupDmRequest {
  users: GroupDmUserIdentity[];
  fromDmChannelId?: string;
}

export interface CreateDmMessageRequest {
  content?: string;
  attachments?: string[];
  replyToId?: string;
}

// ─── Space Invite via DM ────────────────────────────────────────────────────

export interface SpaceInviteRequest {
  /** Caller-supplied target friend identity. Either local userId, or remote (homeUserId+homeInstance). */
  target: { userId: string } | { homeUserId: string; homeInstance: string };
  /** Space identifier on the space's home instance. */
  spaceId: string;
  /** Space's home instance origin. Empty string for the caller's home. */
  spaceInstanceOrigin: string;
  /** Per-space invite code (already issued; client passes whatever it has loaded). */
  inviteCode: string;
}

export interface SpaceInviteResponse {
  dmChannelId: string;
  messageId: string;
  message: DmMessageWithUser;
}

/** JSON content shape for type='system' space_invite messages. */
export interface SpaceInviteSystemPayload {
  event: 'space_invite';
  spaceId: string;
  spaceInstanceOrigin: string;
  inviteCode: string;
  snapshot: {
    spaceName: string;
    icon: string | null;
    avatarColor: AvatarColor | null;
    memberCount: number;
    description: string | null;
    instanceName: string;
  };
}

export interface PaginatedQuery {
  before?: string;
  after?: string;
  limit?: number;
}

/**
 * Set by the message history endpoints on a response that honoured `after`.
 * A server that predates forward paging ignores `after` and answers with the
 * newest page, without this header. Contract: docs/systems/api.md, "Message
 * history paging".
 */
export const MESSAGE_PAGING_HEADER = 'X-Backspace-Paging';
export const MESSAGE_PAGING_AFTER = 'after';

export interface ApiError {
  error: string;
  statusCode: number;
}

// ─── Social Types ────────────────────────────────────────────────────────────

export interface Friend {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  banner: string | null;
  accentColor: string | null;
  avatarColor: AvatarColor | null;
  bio: string | null;
  status: UserStatus;
  customStatus: string | null;
  createdAt: number;
  addedAt: number;
  homeUserId: string | null;
  homeInstance: string | null;
}

export interface DiscoverUser {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  banner: string | null;
  avatarColor: AvatarColor | null;
  bio: string | null;
  status: UserStatus;
  customStatus: string | null;
  createdAt: number;
  homeInstance: string | null;
  homeUserId: string | null;
  mutualFriendCount: number;
  mutualSpaceCount: number;
  relationship: 'none' | 'friends' | 'outbound_pending' | 'inbound_pending';
  requestId?: string;
}

export type FriendRequestStatus = 'pending' | 'accepted' | 'declined';

export interface FriendRequest {
  id: string;
  fromId: string;
  toId: string;
  status: FriendRequestStatus;
  createdAt: number;
  user?: User; // The other user (if it's an incoming request, the sender; if outgoing, the recipient)
}

/**
 * Body of `POST /api/social/requests`. The target is named one of two ways:
 *
 * - By federated identity (`homeUserId` + `homeInstance`), when the client
 *   already holds the user. Takes precedence over `username`; both fields are
 *   required together. `homeInstance` is a bare domain or a full origin.
 * - By `username`, for a handle the user typed (`name` or `name@domain`).
 *
 * Clients that send an identity also send `username`: a server that predates
 * the identity fields ignores them and reads `username`.
 */
export interface SendFriendRequest {
  username?: string;
  homeUserId?: string;
  homeInstance?: string;
}

export interface UpdateFriendRequest {
  status: 'accepted' | 'declined';
}

// ─── GIF Types ──────────────────────────────────────────────────────────────

export interface GifResult {
  id: string;
  title: string;
  previewUrl: string;
  url: string;
  width: number;
  height: number;
}

// ─── Instance Settings Types ────────────────────────────────────────────────

export interface InstanceAdminSettings {
  instanceName: string;
  registrationOpen: boolean;
  federatedRegistrationOpen: boolean;
  discoveryEnabled: boolean;
  gifApiKey?: string;
  gifEnabled?: boolean;
  maxUploadSizeMb: number;
  federationRelayEnabled: boolean;
  federationRelayTtlDays: number;
  defaultAutoRotateIntervalDays: number;
  autoAcceptPeering: boolean;
  directoryEnabled: boolean;
  /**
   * The other directory axis: whether people on this instance see spaces from
   * other instances in Explore. Independent of `directoryEnabled`, which is
   * what this instance sends out. `DIRECTORY_ENDPOINT` sits above it: with no
   * endpoint there is nothing to browse whatever this says.
   */
  directoryBrowseEnabled: boolean;
  /** Read-only on the wire; the server ignores them on PATCH. */
  directoryLastPingAt: number | null;
  directoryLastError: DirectoryPingError | null;
  /**
   * Spaces here that have opted in to the directory and are not private,
   * counted whatever `directoryEnabled` says. Read-only, ignored on PATCH.
   * The instance switch lists nothing by itself; this is how the admin sees
   * whether any space has taken it up.
   */
  directoryListedSpaceCount: number;
  /**
   * The web client's Backspace page shows the Support card, which links to
   * the project's Ko-fi page. Hides only that card; the server does nothing
   * else with it. Default true. Also on `InstanceInfoResponse`.
   */
  supportCardEnabled: boolean;
}

export interface InstanceStreamingLimits {
  maxBitrateKbps: number;
  minBitrateKbps: number;
  bitrateStepKbps: number;
  allowedResolutions: (number | 'native')[];
  allowedFramerates: number[];
  maxResolution: number;
  maxFramerate: number;
  discoveryEnabled: boolean;
  /** The admin allows spaces here to be listed in the directory. Read-only on this route; PATCH /settings/instance sets it. */
  directoryEnabled: boolean;
  /**
   * This instance has a `DIRECTORY_ENDPOINT` to reach. Read-only and derived
   * from configuration, never stored, never accepted on a PATCH.
   *
   * It rides on this document because this is the one settings document any
   * signed-in user may read, on their own instance or on a peer: a space's
   * own instance answers for itself, which `GET /instance/info` on the home
   * instance cannot do for a space that lives somewhere else. Without it the
   * per-space listing switch was enabled on an instance with no endpoint,
   * writing a flag whose listing document no hub ever fetches.
   */
  directoryConfigured: boolean;
  bitrateMatrixOverrides: Record<string, number> | null;
  allowCustomBitrate: boolean;
}

// ─── Federation Types ──────────────────────────────────────────────────────

export interface InstanceInfoResponse {
  name: string;
  version: string;
  registrationOpen: boolean;
  federatedRegistrationOpen: boolean;
  // Persistent per-instance epoch (incarnation UUID). Minted by ensureDefaults on
  // first boot and stable across restarts; changes only on a wipe/re-provision.
  // Peers use it to detect that a remote has been re-provisioned (self-healing).
  instanceId: string;
  // AGPL-3.0 § 13 network-use source offer: URL to the Corresponding Source of
  // the version this instance is running (operator-configurable via
  // BACKSPACE_SOURCE_URL so forks point at their own source).
  sourceCodeUrl: string;
  // Short git SHA/tag of the running build; null in dev builds with no commit injected.
  commit: string | null;
  // Three independent directory facts (directory.md section 9). They are
  // reported separately because folding any two of them into one boolean
  // leaves a client unable to tell which of them is false, and every surface
  // that says something about the directory needs a different one.
  //
  // directoryConfigured: the operator gave this instance a DIRECTORY_ENDPOINT.
  // Nothing about the directory works without it: no pinger, no proxy, no
  // Outer Space. Every surface that promises the directory will do something
  // gates on this.
  // directoryAvailable: people here browse the directory, which is
  // directoryConfigured and the admin's browse setting together. The Explore
  // page gates Outer Space on it.
  // directoryEnabled: the admin allows spaces here to be listed; the space
  // settings panel reads it.
  directoryConfigured: boolean;
  directoryAvailable: boolean;
  directoryEnabled: boolean;
  // The admin's switch for the Support card on the web client's Backspace
  // page. It only hides that card in the web client and changes nothing the
  // server does.
  supportCardEnabled: boolean;
}

/**
 * What the admin Updates panel renders. Admin-only.
 *
 * `state` is deliberately three-valued. An instance with no outbound internet,
 * or one whose operator turned the lookup off, must be able to say "I do not
 * know" instead of implying it is current.
 */
export interface InstanceUpdateStatus {
  current: {
    version: string;
    /** Short git SHA baked at build time; null in dev builds. */
    commit: string | null;
  };
  latest: {
    version: string;
    url: string;
    /** ISO 8601, or an empty string when the release carried no date. */
    publishedAt: string;
  } | null;
  state: 'up-to-date' | 'update-available' | 'unknown';
  /** Epoch ms of the lookup this answer came from; null when none was made. */
  checkedAt: number | null;
  /** False when BACKSPACE_UPDATE_CHECK=false. */
  checkEnabled: boolean;
  /** Why `state` is unknown, when it is. Null otherwise. */
  reason: 'disabled' | 'unreachable' | 'rate-limited' | 'unparseable' | null;
  /**
   * How this instance gets its image. `unknown` on installs that predate
   * install.sh recording it, which the panel handles by showing both sets of
   * manual commands rather than guessing.
   */
  channel: 'prebuilt' | 'source' | 'unknown';
}

export interface VerifyPasswordRequest {
  password: string;
}

export interface VerifyPasswordResponse {
  valid: boolean;
}

export interface ChangePasswordRequest {
  currentPassword?: string;  // Required on home, optional for federated users
  newPassword: string;
}

export interface ChangePasswordResponse {
  token: string;
}

export interface DeleteAccountRequest {
  password: string;
  username: string;  // Must match — confirmation safeguard
}

// ─── Per-Remote Federation Credentials ───────────────────────────────────
// The credential the client uses to register/log in as this user on ANOTHER
// instance. Issued and stored by the user's HOME instance only, so it stays
// identical across devices and browsing sessions. Never the home password.

export interface FederationCredentialRequest {
  origin: string;            // Remote instance origin, e.g. 'https://orbit.example'
  markProvisioned?: boolean; // Record that the remote account now uses this secret
}

export interface FederationCredentialResponse {
  origin: string;
  secret: string;
  provisioned: boolean;      // True once the remote account is known to use `secret`
}

// ─── Federation Identity Delete Types ────────────────────────────────────

export interface FederationIdentityDeleteRequest {
  origins: string[];
  mode: 'leave' | 'soft' | 'full';
}

export interface FederationIdentityDeleteResult {
  success: boolean;
  error?: string;
  ownedSpaces?: { id: string; name: string }[];
}

export interface FederationIdentityDeleteResponse {
  results: Record<string, FederationIdentityDeleteResult>;
}

export interface FederationIdentityDeleteS2SRequest {
  homeUserId: string;
  homeInstance: string;
  mode: 'soft' | 'full';
}

// ─── Storage Management Types ─────────────────────────────────────────────

export interface StorageBreakdown {
  type: string;   // 'image' | 'video' | 'audio' | 'document' | 'other'
  count: number;
  size: number;
}

export interface StorageStats {
  totalFiles: number;
  totalSize: number;
  referencedFiles: number;
  referencedSize: number;
  orphanedFiles: number;
  orphanedSize: number;
  unlinkedAttachments: number;
  unlinkedSize: number;
  danglingAttachments: number;
  danglingSize: number;
  /** Count of `.tus/` entries (payloads + sidecars) with mtime older than 1h. */
  staleTusSessions: number;
  /** Total size in bytes of those stale `.tus/` entries. */
  staleTusSize: number;
  breakdown: StorageBreakdown[];
}

export interface OrphanedFile {
  filename: string;
  size: number;
  modifiedAt: number;
}

export interface CleanupResult {
  dryRun: boolean;
  deletedFiles: number;
  freedBytes: number;
  deletedAttachmentRecords: number;
  errors: string[];
}

// ─── Admin User Management Types ──────────────────────────────────────────

export interface AdminUser {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  avatarColor: string | null;
  status: string;
  isAdmin: boolean;
  isDeleted: boolean;
  homeInstance: string | null;
  createdAt: number;
}

export interface AdminUserListResponse {
  users: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminResetPasswordResponse {
  temporaryPassword: string;
}

// ─── Federation Relay Types ──────────────────────────────────────────────────

export interface FederationRelayParticipant {
  homeUserId: string;
  homeInstance: string;
  profile?: FederationRelayProfileSnapshot;
}

export interface FederationRelayEvent {
  eventType: 'create' | 'update' | 'delete' | 'reaction_add' | 'reaction_remove'
    | 'member_add' | 'member_remove' | 'ownership_transfer' | 'group_metadata_update'
    | 'friend_request_create' | 'friend_request_update' | 'friend_request_cancel'
    | 'friend_add' | 'friend_remove' | 'file_rejected'
    | 'dm_call_start' | 'dm_call_accept' | 'dm_call_reject' | 'dm_call_end'
    | 'dm_typing_start' | 'dm_typing_stop'
    | 'profile_update' | 'presence_update'
    | 'read_state_update'
    | 'dm_close' | 'dm_reopen';
  contextType?: 'dm' | 'friend' | 'profile';
  dmChannelId?: string;
  messageId: string;
  federatedId?: string;
  encryptionVersion: 0;
  timestamp: number;
  participants?: FederationRelayParticipant[];
  message?: {
    userId: string;
    homeUserId: string;
    homeInstance: string;
    type?: 'user' | 'system';
    content: string | null;
    /** The sender's local id of the replied-to message. Meaningless to a receiver, which never adopts it; see `replyTo`. */
    replyToId: string | null;
    /**
     * The replied-to message in coordinates every instance shares. Optional:
     * absent from older senders and on messages that are not replies. The
     * receiver resolves it inside the conversation the message lands in and
     * stores no reply target when it does not resolve there.
     */
    replyTo?: FederationMessageRef | null;
    /**
     * The users the content's `<@id>` tokens name, each as the sender's id
     * with the federated identity it stands for. Optional: absent from older
     * senders, from system messages and from content that mentions nobody.
     * The receiver rewrites each token to its own row for that identity; see
     * `FederationMentionRef`.
     */
    mentions?: FederationMentionRef[];
    editedAt: number | null;
    createdAt: number;
    attachments?: FederationRelayAttachment[];
  };
  reactions?: FederationRelayReaction[];
  reaction?: FederationRelayReaction;
  /**
   * `update` / `delete`: the message being changed and who is changing it.
   * Optional: older senders omit it and are matched by `messageId` alone. See
   * `FederationMessageTarget` for how a receiver applies it.
   */
  target?: FederationMessageTarget;
  membership?: FederationMembershipPayload;
  ownership?: FederationOwnershipPayload;
  group?: FederationGroupPayload;
  friendship?: FederationFriendshipPayload;
  // file_rejected event fields
  attachmentId?: string;
  sourceFilename?: string;
  rejectionReason?: string;
  rejectionLimit?: number;
  affectedUserIds?: string[];
  /**
   * `file_rejected`: the same users as `affectedUserIds`, each with the
   * instance that homes them, so the receiver matches the whole identity.
   * Optional: absent from older senders, whose bare ids are matched only when
   * exactly one local user carries that home user id.
   */
  affectedUsers?: Array<{ homeUserId: string; homeInstance: string }>;
  call?: FederationCallPayload;
  typing?: {
    homeUserId: string;
    homeInstance: string;
    username: string;
  };
  metadata?: FederationGroupMetadataPayload;
  profileUpdate?: FederationProfileUpdatePayload;
  presenceUpdate?: FederationPresenceUpdatePayload;
  readState?: {
    user: { homeUserId: string; homeInstance: string };
    messageRef: { sourceInstance: string; sourceMessageId: string };
  };
  dmCloseReopen?: {
    homeUserId: string;
    homeInstance: string;
  };
}

export interface FederationCallPayload {
  livekitUrl?: string;
  tokens?: Record<string, string>;  // homeUserId → LiveKit token
  /**
   * The same tokens with each holder's federated identity. Optional: older
   * senders omit it, and every key of `tokens` is then a user homed on the
   * receiving instance. A receiver gives a token only to the local user its
   * identity resolves to; a home user id alone is unique only where issued.
   */
  memberTokens?: Array<{ homeUserId: string; homeInstance: string; token: string }>;
  caller?: { homeUserId: string; homeInstance: string; displayName: string };
  acceptor?: { homeUserId: string; homeInstance: string };
  rejector?: { homeUserId: string; homeInstance: string };
  endedBy?: { homeUserId: string; homeInstance: string };
  participants?: FederationRelayParticipant[];  // All DM members for Path B identity matching
}

export interface FederationMembershipPayload {
  user: FederationRelayParticipant;
  addedBy?: FederationRelayParticipant;
  removedBy?: FederationRelayParticipant;
  reason?: 'kick' | 'leave';
}

export interface FederationOwnershipPayload {
  newOwner: FederationRelayParticipant;
  previousOwner: FederationRelayParticipant;
}

export interface FederationGroupPayload {
  owner: FederationRelayParticipant;
  members: FederationRelayParticipant[];
  // Group metadata snapshot — used by bootstrap path on a fresh peer.
  // Mirrors current owner-instance values at the moment of the member_add event.
  name: string | null;
  icon: string | null;            // absolute URL
  metadataUpdatedAt: number;
}

export interface FederationGroupMetadataPayload {
  name: string | null;     // explicit null = cleared
  icon: string | null;     // absolute URL on the wire; null = cleared
  metadataUpdatedAt: number;
  actor: FederationRelayParticipant; // == owner by authority invariant; used for system-message rendering
}

export interface FederationRelayProfileSnapshot {
  username?: string | null;
  displayName?: string | null;
  avatar?: string | null;
  avatarColor?: string | null;
  banner?: string | null;
  bio?: string | null;
  // Current presence at the moment the snapshot was built. Optional for
  // backwards compatibility with peers that pre-date the field. Receivers use
  // this to seed the stub's status at creation time, so a freshly-friended
  // remote user shows their actual current state instead of defaulting to
  // 'offline' until the next presence_update arrives. presence_update is
  // ephemeral and fires only on transitions, so without this field an
  // already-online remote stays stuck at 'offline' on the receiver until they
  // next change status.
  status?: 'online' | 'idle' | 'dnd' | 'offline' | null;
  /**
   * The user is tombstoned on the instance that built this snapshot.
   * Receivers must not create a new stub for this identity; internal
   * '!deleted:<id>' usernames are never shipped (dead-incarnation spec §3.3).
   */
  deleted?: boolean | null;
}

export interface FederationProfileUpdatePayload {
  homeUserId: string;
  homeInstance: string;
  profileUpdatedAt: number;
  // Home user's canonical username (without @domain suffix). Receivers apply
  // `displayName ?? username` so stubs whose home user has no displayName show
  // the real handle instead of getting clobbered to null. Username itself is
  // immutable on the home instance — receivers do NOT rewrite the stub's
  // username column on profile_update.
  username: string;
  displayName: string | null;
  avatar: string | null;
  banner: string | null;
  accentColor: string | null;
  avatarColor: string | null;
  bio: string | null;
}

/**
 * Presence projection from a home instance to peers. Carries the user's current
 * online status and (optionally) rich activities. Outbox-only on the wire — never
 * written to federation_mutation_log; presence is ephemeral and stale replays on
 * peer activation are wrong (the activation hook re-emits a fresh snapshot).
 */
export interface FederationPresenceUpdatePayload {
  homeUserId: string;
  homeInstance: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  activities?: Activity[];
  ts: number; // emitter clock; receiver may use for last-write-wins
}

export interface FederationFriendshipPayload {
  from: FederationRelayParticipant;
  to: FederationRelayParticipant;
  fromProfile?: FederationRelayProfileSnapshot;
  toProfile?: FederationRelayProfileSnapshot;
  status?: 'pending' | 'accepted' | 'declined';
  createdAt: number;
}

/**
 * A DM message named across instances. Every instance holds its own copy of a
 * federated message under its own local id, so a reference that crosses
 * instances uses the id the message has on the instance it was created on,
 * together with that instance's origin (as its `getOurOrigin()` reports it).
 */
export interface FederationMessageRef {
  messageId: string;
  messageHomeInstance: string;
}

/**
 * One user a relayed message's content mentions.
 *
 * A `<@id>` token carries an id issued by the instance the content was written
 * on, which names nobody on another instance. `id` is that id as it appears in
 * the relayed content; `homeUserId` + `homeInstance` is the federated identity
 * of the user it names there. A receiver resolves the identity to its own row
 * and rewrites `<@id>` to that row's id before storing the content, and keeps
 * the token as written when it holds no row for the identity.
 */
export interface FederationMentionRef {
  id: string;
  homeUserId: string;
  homeInstance: string;
}

/**
 * The message an `update` or `delete` relay changes.
 *
 * `messageId` on the event is the sender's local id, which only identifies the
 * message when the sender created it. A receiver given a target instead
 * resolves `message` inside its copy of the conversation `federatedId`, and
 * applies the change only when `actor` is that message's author, compared as
 * federated identities, and `actor` passes the relay attribution check. The
 * rule is written out in docs/systems/dm-system.md, "Relayed edits and
 * deletes".
 */
export interface FederationMessageTarget {
  message: FederationMessageRef;
  /** The conversation's `federatedId` (1-on-1 and group alike). */
  federatedId: string;
  /** The user editing or deleting, as a federated identity. */
  actor: { homeUserId: string; homeInstance: string };
}

export interface FederationRelayReaction {
  messageId?: string;
  messageHomeInstance?: string;
  userId: string;
  homeUserId: string;
  homeInstance: string;
  emoji: string;
  createdAt: number;
}

export interface FederationRelayAttachment {
  id: string;
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  // Web-playability computed by the origin instance (see Attachment.playable).
  // Propagated so the receiving instance need not re-probe the codec.
  playable?: boolean | null;
  thumbnailFilename?: string;
  sourceUrl: string;
}

export interface FederationRelayRequest {
  version: 1;
  sourceInstance: string;
  // Sender's persistent epoch (incarnation UUID). Optional for wire compatibility
  // with peers that predate epoch self-healing; when present, the receiver can
  // detect that the source instance has been re-provisioned.
  sourceInstanceId?: string;
  /**
   * Relay behaviours the sender implements beyond plain v1. Optional for wire
   * compatibility: a receiver treats a missing or malformed list as empty and
   * answers with v1 behaviour only. See `FederationRelayCapability`.
   */
  capabilities?: FederationRelayCapability[];
  events: FederationRelayEvent[];
}

/**
 * A relay behaviour a sender opts into by listing it in
 * `FederationRelayRequest.capabilities`. Each one gates something the receiver
 * would otherwise not send, so an older sender is never handed an answer it was
 * not built to handle.
 *
 * - `attribution_unproven`: the sender retries an event rejected with the
 *   reason `attribution_unproven` on its normal backoff, until the outbox TTL.
 *   A receiver may then use that reason for a homeward claim whose proof it
 *   does not hold yet; for any other sender it answers the same case with the
 *   terminal `attribution_mismatch`.
 */
export type FederationRelayCapability = 'attribution_unproven';

export interface FederationEpochResponse {
  instanceId: string;
}

export interface FederationRelayResponse {
  accepted: string[];
  rejected: Array<{ messageId: string; reason: string }>;
  /**
   * Third classification (additive, v1.x): events that were processed cleanly
   * but had no reachable recipient. Distinct from `rejected` (data/protocol
   * refusal). Currently used only for `dm_call_start` — other event types
   * keep accepted/rejected semantics unchanged. Omitted when empty for
   * wire-size hygiene and byte-identical responses in the typical case.
   */
  undeliverable?: Array<{ messageId: string; reason: string }>;
  maxUploadSize: number;
}

export interface FederationSyncRequest {
  sinceTimestamp: number;
  /**
   * Keyset tiebreak: with it, the server returns the log rows after the row
   * `(sinceTimestamp, afterId)` in `(mutated_at, id)` order, so rows sharing a
   * millisecond across a page boundary are all served. Older servers ignore it
   * and return rows with `mutated_at > sinceTimestamp`.
   */
  afterId?: string;
  dmChannelId?: string;
  federatedId?: string;
  contextType?: 'dm' | 'friend' | 'profile';
  limit: number;
}

export interface FederationSyncResponse {
  events: FederationRelayEvent[];
  hasMore: boolean;
  checkpoint: number;
  /**
   * The id of the last log row the page covered (before any filtering), to be
   * sent back as `afterId` with `sinceTimestamp: checkpoint`. Absent from older
   * servers, whose next page has to start at `checkpoint - 1`.
   */
  checkpointId?: string;
}

// Detached-account re-attach (re-attach spec §3.1–3.2).
// Minted on the home instance D for a logged-in native user.
export interface AttachProofResponse {
  token: string;
}

// Body of POST /api/users/@me/reattach on the peer R — the one-time proof token
// minted by the home instance, verified with D over signed S2S.
export interface ReattachRequest {
  token: string;
}

// Success response of POST /api/users/@me/reattach — the re-bound self-view.
export interface ReattachResponse {
  success: true;
  user: User;
}

export interface FederationUserLookupRequest {
  username: string;
}

export interface FederationUserLookupProfile {
  displayName: string | null;
  avatar: string | null;
  avatarColor: AvatarColor | null;
  banner: string | null;
  bio: string | null;
  // Carried so the requester can seed the stub's status at creation time.
  // Optional for backwards compat with peers that pre-date the field.
  status?: 'online' | 'idle' | 'dnd' | 'offline' | null;
  // `/users/by-home-id` only, from homes that send it: the profile's version
  // (the value `profile_update` carries; a never-edited profile is at its
  // account's creation time) and the accent colour, so the answer can be
  // applied like a `profile_update`. Absent from older homes.
  profileUpdatedAt?: number | null;
  accentColor?: string | null;
}

export type FederationUserLookupResponse =
  | { found: true; user: { homeUserId: string; username: string; profile: FederationUserLookupProfile } }
  | { found: false; code: 'user_not_found' };

export interface FederationPeer {
  id: string;
  origin: string;
  instanceName: string | null;
  status: 'pending' | 'active' | 'unreachable' | 'revoked' | 'rejected' | 'awaiting_approval' | 'needs_attention';
  lastSeenAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  consecutiveAuthFailures: number;
  lastSyncedAt: number;
  autoRotateIntervalDays: number;
  secretRotatedAt: number | null;
  rotationInProgress: boolean;
  createdAt: number;
  statusReason: FederationPeerStatusReason | null;
}

// ─── Reset-cleanup admin surface (instance-epoch self-healing §6.4) ──────────

/**
 * A real (non-stub) account whose home instance was reset — quarantined via
 * `federation_home_orphaned = 1`. Surfaced to the admin "Reset cleanup" UI with
 * enough context (owned spaces, membership/message counts) to decide Keep or
 * Remove.
 */
export interface FederationOrphanedAccount {
  id: string;
  username: string; // preserved original handle (detach spec); legacy rows may carry '!orphaned:{uid}@domain'
  displayName: string | null;
  avatarColor: string | null;
  ownedSpaces: { id: string; name: string }[];
  spaceMemberCount: number; // # of spaces they're a member of
  messageCount: number; // # of space messages they authored
}

/**
 * A durable row from the `federation_reset_events` journal, augmented with the
 * origin's current orphaned real accounts for admin disposition.
 */
export interface FederationResetEvent {
  origin: string;
  deadEpoch: string;
  newEpoch: string | null;
  detectedAt: number;
  resolvedAt: number | null;
  acknowledgedAt: number | null;
  stubCount: number;
  orphanedAccountCount: number;
  orphanedAccounts: FederationOrphanedAccount[];
}

export interface FederationResetEventsResponse {
  events: FederationResetEvent[];
}

// ─── Outbound peering gate ──────────────────────────────────────────────────

/**
 * Why a user-initiated federation action triggered the outbound peering gate.
 * Recorded on `peer_approval_subscribers.trigger_reason` so admins can see
 * the human-readable cause and the user can recover their original action
 * after approval. Persisted as a string column with this exact set of values.
 *
 * `instance_connect`: the user opened a session on the remote instance
 * (connect, explicit login, token resume, or app start), and the client asked
 * its home instance to peer so DMs written there can be relayed home.
 */
export type PeeringTriggerReason = 'friend_add' | 'space_join' | 'direct_message' | 'instance_connect';

/**
 * The trigger reasons a client may state in `POST /api/federation/peer/ensure`.
 * The server refuses any other value with `validation_failed`, and derives the
 * target itself for each one. `friend_add` is deliberately absent: friend-add
 * peers server-side with a target it has checked, so a client stating it
 * could only put a friend request the admin cannot verify into the queue.
 */
export const PEER_ENSURE_REASONS = ['instance_connect'] as const satisfies readonly PeeringTriggerReason[];
export type PeerEnsureReason = (typeof PEER_ENSURE_REASONS)[number];

/**
 * Body of `POST /api/federation/peer/ensure`. `reason` is optional for clients
 * that predate it; the server reads a missing reason as `instance_connect`,
 * the only thing those clients called the endpoint for.
 */
export interface PeerEnsureRequest {
  remoteOrigin: string;
  reason?: PeerEnsureReason;
}

/**
 * Caller intent passed into `ensurePeered()`. The gate (when
 * `autoAcceptPeering=0` and no peer row exists) branches on `kind`:
 *   - 'user_action': queue an outbound approval request and surface
 *     `admin_required` to the caller so the user sees a clear pending state.
 *   - 'system': skip queueing; surface `admin_required` so the calling
 *     subsystem (e.g. background relay) can fail loudly without spamming
 *     admin queues with rows nobody asked for.
 *
 * `target` is the human-readable target identifier the user acted on
 * (e.g. `username@instance.example` for friend_add, the space invite code
 * for space_join, the federated DM channel id for direct_message, the remote
 * origin for instance_connect).
 */
export type EnsurePeeredCallerIntent =
  | { kind: 'user_action'; userId: string; reason: PeeringTriggerReason; target: string }
  | { kind: 'system' };

/**
 * Terminal-state notification kinds delivered to subscribers when the
 * outbound queue resolves. 'expired' is delivered by the storage janitor
 * before it deletes an unresolved outbound queue row past `expiresAt`.
 */
export type PeeringNotificationKind = 'approved' | 'denied' | 'expired';

/**
 * Per-user pending row joined from `peer_approval_subscribers` to its parent
 * `peer_approval_requests`. Returned from
 * `GET /api/federation/peering-subscriptions`. Used to render the user's own
 * "waiting on admin" surface so they remember which actions are blocked.
 */
export interface PeeringSubscription {
  id: string;
  requestId: string;
  peerOrigin: string;
  peerInstanceName: string | null;
  triggerReason: PeeringTriggerReason;
  triggerTarget: string;
  createdAt: number;
}

/**
 * Terminal-state notification row returned from
 * `GET /api/federation/peering-notifications`. Persists until the user
 * explicitly reads (sets `readAt`) or the janitor cleans up read rows
 * older than the retention window.
 */
export interface PeeringNotification {
  id: string;
  kind: PeeringNotificationKind;
  peerOrigin: string;
  triggerReason: PeeringTriggerReason;
  triggerTarget: string;
  createdAt: number;
  readAt: number | null;
}

/**
 * Subscriber summary embedded in the admin-facing approval request response
 * for outbound rows. Lets the admin see which users are waiting on each
 * outbound request without a separate fetch.
 */
export interface ApprovalRequestSubscriberSummary {
  userId: string;
  username: string;
  triggerReason: PeeringTriggerReason;
  triggerTarget: string;
}

/**
 * Admin-facing approval request row returned from
 * `GET /api/federation/approval-requests`. Inbound rows are remote
 * instances asking to peer with us; outbound rows are local users asking
 * us to peer with a remote instance. Outbound rows include `subscribers`
 * so the admin can see who is waiting.
 */
export interface ApprovalRequest {
  id: string;
  direction: 'inbound' | 'outbound';
  origin: string;
  instanceName: string | null;
  requestedAt: number;
  expiresAt: number;
  /**
   * Subscriber summaries — present (and possibly empty array) only when
   * `direction === 'outbound'`. ABSENT (`undefined`) when `direction === 'inbound'`.
   * Inbound rows have no per-action context; the field is omitted from the server
   * response, not set to `[]`.
   */
  subscribers?: ApprovalRequestSubscriberSummary[];
}

// ─── Invite Links ──────────────────────────────────────────────────────────

/** Derived status of an invite link. Active = usable; expired/exhausted/revoked = archived. */
export type InviteStatus = 'active' | 'expired' | 'exhausted' | 'revoked';

export interface InviteLinkSummary {
  id: string;
  token: string;
  name: string;
  status: InviteStatus;
  maxUses: number | null;
  usedCount: number;
  expiresAt: number | null;
  revokedAt: number | null;
  createdBy: string;
  /** Joined from users.username at read time. `'Deleted User'` when the creator's account is tombstoned. `null` only if the FK is somehow unresolvable (defensive). */
  createdByUsername: string | null;
  createdAt: number;
  /** Epoch ms of the most recent redemption; `null` when the invite has zero redemptions. */
  lastRedeemedAt: number | null;
  /** Server-constructed full URL, e.g. `https://host.example/register?invite=<token>`. Clients must NOT assemble this themselves. */
  url: string;
}

export interface InviteRedemption {
  id: string;
  userId: string | null;
  registrantUsername: string;
  currentUsername: string | null;
  isDeleted: boolean;
  redeemedAt: number;
}

export interface CreateInviteRequest {
  name: string;
  maxUses: number | null;
  expiresAt: number | null;
}

export interface UpdateInviteRequest {
  name?: string;
  maxUses?: number | null;
  expiresAt?: number | null;
}

export interface ReinstateInviteRequest {
  maxUses?: number | null;
  expiresAt?: number | null;
}

export interface ReinstateInviteResponse {
  invite: InviteLinkSummary;
  tokenRotated: boolean;
}

export interface CheckInviteValidResponse {
  valid: true;
  name: string;
}

export interface CheckInviteInvalidResponse {
  valid: false;
  reason: 'expired' | 'exhausted' | 'invalid';
}

export type CheckInviteResponse = CheckInviteValidResponse | CheckInviteInvalidResponse;

export type ClientKind = 'web' | 'desktop' | 'mobile';

/** Schema 1 of the opt-in daily instance report. See docs/systems/telemetry.md. */
export interface TelemetryPayload {
  schema: 1;
  instance: string;
  day: string;
  build: { version: string; commit: string | null; modified: boolean };
  users: { registered: number; active1d: number; active7d: number; active30d: number };
  clients: { web: number; desktop: number; mobile: number };
  content: { spaces: number; channels: number; messages: number; messages7d: number; storageMiB: number };
  features: { voice: boolean; federation: boolean; peers: number; registrationOpen: boolean };
  runtime: { install: 'prebuilt' | 'source' | null; os: string; arch: string; node: number };
  installedAt: string;
}

export interface TelemetryStatus {
  /** null = never asked. */
  enabled: boolean | null;
  lastDay: string | null;
  lastError: { day: string; status: number } | null;
  /** The random telemetry id, minted on the first enable and kept through off; null until then. */
  id: string | null;
  /**
   * Whether an admin should be asked now: always while never answered, never
   * after a yes, and after a no again from the next minor release on.
   */
  askDue: boolean;
}

export type { DmSystemEvent } from './dmSystemEvents.js';

// ─── Federation peer state (docs/systems/federation.md, "Peer state") ────────

/** Every value `federation_peers.status` takes. */
export type FederationPeerStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'active'
  | 'unreachable'
  | 'needs_attention'
  | 'rejected'
  | 'revoked';

/** Why a peer is in `needs_attention`. */
export type FederationNeedsAttentionReason = 'auth_failures' | 'peer_reset_detected' | 'repeer_incomplete';

/**
 * Why a peer is `rejected`. `denied_by_local_admin` is our own refusal; every
 * other value is the remote refusing us, or holding an older peering with us
 * that its admin has to reset (`stale_peering_on_remote`).
 */
export type FederationRejectedReason =
  | 'denied_by_local_admin'
  | 'denied_by_remote'
  | 'revoked_by_remote'
  | 'expired_on_remote'
  | 'stale_peering_on_remote';

/** `federation_peers.status_reason`: set for `needs_attention` and `rejected`, null otherwise. */
export type FederationPeerStatusReason = FederationNeedsAttentionReason | FederationRejectedReason;
