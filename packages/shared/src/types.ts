export * from './federationTypes.js';
export * from './instanceTypes.js';
import type { ErrorCode } from './errors.js';
import type { PeeringNotificationKind } from './federationTypes.js';

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

/**
 * Whether an account owns its chosen status, so its own row is where the choice
 * is stored and read (`users.chosen_status`). True for a native account and for
 * a detached one (its home instance was reset, so it is sovereign here); false
 * for a replicated account, whose choice lives on its home instance. The same
 * authority rule the server applies to profile edits and credential issuance.
 * Accepts the server row (integer flag) and the client `User` (boolean flag).
 * activity-presence.md, "DB Persistence".
 */
export function ownsChosenStatus(account: {
  homeInstance?: string | null;
  federationHomeOrphaned?: number | boolean | null;
}): boolean {
  return !account.homeInstance || account.federationHomeOrphaned === 1 || account.federationHomeOrphaned === true;
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
  /** Display-only title for this space’s owner; null uses the localized default. */
  ownerTitle: string | null;
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

// ─── Notification Settings ──────────────────────────────────────────────────
// Per-user, per-space and per-channel alert preferences. They only decide
// whether a message raises the message sound / OS notification; unread state
// is unaffected. Stored on the instance that hosts the space (like read
// states), so a federated space's settings live on that space's instance.

/** Which messages alert: every message, only ones that mention the user, or none. */
export type NotificationLevel = 'all' | 'mentions' | 'nothing';

export type NotificationTargetType = 'space' | 'channel';

export interface NotificationSetting {
  /** 'space' rows hold the space defaults; 'channel' rows override them for one channel. */
  targetType: NotificationTargetType;
  targetId: string;
  /** null means "inherit": a channel inherits its space, a space inherits the default ('mentions'). */
  level: NotificationLevel | null;
  /** Epoch ms when a timed mute ends, MUTED_FOREVER for an indefinite mute, null when not muted. */
  mutedUntil: number | null;
  /** Space rows only: ignore `@everyone`/`@here`. */
  suppressEveryone: boolean;
  /** Space rows only: ignore role mentions. */
  suppressRoles: boolean;
}

export type UpdateNotificationSettingRequest = Omit<NotificationSetting, 'targetType' | 'targetId'>;

/** `mutedUntil` value of an indefinite mute. Chosen so "mutedUntil > now" is the single "is muted" test. */
export const MUTED_FOREVER = Number.MAX_SAFE_INTEGER;

/** Level a space uses when the user never set one: Discord's default for large spaces. */
export const DEFAULT_NOTIFICATION_LEVEL: NotificationLevel = 'mentions';

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
  | { type: 'channel_poke'; channelId: string; targetUserId: string }
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
  | { type: 'ready'; user: User; spaces: SpaceWithChannelsAndMembers[]; dmChannels: DmChannel[]; folders?: SpaceFolder[]; spaceLayout?: SpaceLayoutItem[] | null; layoutUpdatedAt?: number; voiceStates?: Record<string, string[]>; voiceChannelElapsedSeconds?: Record<string, number>; voiceUserStates?: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>; unreadCounts?: Record<string, number>; supportsPoke?: boolean; readStates?: ReadState[]; notificationSettings?: NotificationSetting[]; activeCalls?: ActiveCallInfo[]; spaceVoiceStates?: Record<string, { spaceMuted: boolean; spaceDeafened: boolean }>; userActivities?: Record<string, Activity[]>; userActivityIdentities?: Record<string, PresenceIdentity>; rejectedPeerOrigins?: string[]; awaitingApprovalPeerOrigins?: string[]; activePeerOrigins?: string[]; pendingApprovalCount?: number }
  | { type: 'channel_poke_failed'; message: string }
  | { type: 'channel_unread_count'; counts: Record<string, number> }
  | { type: 'channel_poke'; channelId: string; userId: string; targetUserId: string; username: string; targetUsername: string }
  | { type: 'message_created'; message: MessageWithUser }
  | { type: 'message_updated'; message: MessageWithUser }
  | { type: 'message_deleted'; messageId: string; channelId: string }
  | { type: 'typing'; channelId: string; userId: string; username: string }
  | ({ type: 'presence_update'; userId: string; status: string; activities?: Activity[] } & Partial<PresenceIdentity>)
  | { type: 'voice_state_update'; channelId: string; userId: string; action: 'join' | 'leave'; channelElapsedSeconds?: number }
  | { type: 'member_joined'; spaceId: string; member: MemberWithUser }
  | { type: 'member_updated'; spaceId: string; member: MemberWithUser }
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
  | { type: 'notification_setting_updated'; setting: NotificationSetting }
  | { type: 'mark_unread'; channelId: string; messageId: string }
  | { type: 'embeds_resolved'; messageId: string; channelId: string; embeds: Embed[] }
  | { type: 'dm_embeds_resolved'; messageId: string; dmChannelId: string; embeds: Embed[] }
  | { type: 'federation_file_rejected'; messageId: string; dmChannelId: string; attachmentId: string; affectedUsers: Array<{ userId: string; username: string; limit: number }> }
  | { type: 'federation_peer_rejected'; peerOrigin: string; peerLabel?: string; reason: string; affectedContexts: Array<{ contextType: 'dm' | 'friend'; contextId: string; contextLabel: string }> }
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
  | { type: 'error'; message: string; code?: ErrorCode };

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
  topic?: string;
  position?: number;
  categoryId?: string | null;
}

export interface UpdateSpaceRequest {
  /** Owner-only; null explicitly restores the localized default heading. */
  ownerTitle?: string | null;
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
  roleIds?: string[];
  /** Space-local name; null explicitly restores the account display name. */
  nickname?: string | null;
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
  limit?: number;
}

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
