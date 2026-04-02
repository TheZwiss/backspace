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
  dmChannelId: string;
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
  attachments?: Array<{ type: string; filename: string }>;
}

export interface DmChannel {
  id: string;
  ownerId?: string | null;
  createdAt: number;
  members: User[];
  lastMessage?: DmLastMessagePreview | DmMessageWithUser | null;
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

// Client → Server Events
export type ClientEvent =
  | { type: 'auth'; token: string }
  | { type: 'message_create'; channelId: string; content: string; replyToId?: string }
  | { type: 'message_edit'; messageId: string; content: string }
  | { type: 'message_delete'; messageId: string }
  | { type: 'typing_start'; channelId: string }
  | { type: 'presence_update'; status: 'online' | 'idle' | 'dnd' }
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
  | { type: 'dm_call_accept'; dmChannelId: string }
  | { type: 'dm_call_reject'; dmChannelId: string }
  | { type: 'dm_call_end'; dmChannelId: string }
  | { type: 'voice_status'; isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }
  | { type: 'voice_space_mute'; userId: string; muted: boolean }
  | { type: 'voice_space_deafen'; userId: string; deafened: boolean }
  | { type: 'voice_move'; userId: string; targetChannelId: string }
  | { type: 'voice_disconnect'; userId: string }
  | { type: 'activity_update'; activities: Activity[] }
  | { type: 'ping' };

// Server → Client Events
export type ServerEvent =
  | { type: 'ready'; user: User; spaces: SpaceWithChannelsAndMembers[]; dmChannels: DmChannel[]; folders?: SpaceFolder[]; spaceLayout?: SpaceLayoutItem[] | null; layoutUpdatedAt?: number; voiceStates?: Record<string, string[]>; voiceUserStates?: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>; readStates?: ReadState[]; activeCalls?: ActiveCallInfo[]; spaceVoiceStates?: Record<string, { spaceMuted: boolean; spaceDeafened: boolean }>; userActivities?: Record<string, Activity[]> }
  | { type: 'message_created'; message: MessageWithUser }
  | { type: 'message_updated'; message: MessageWithUser }
  | { type: 'message_deleted'; messageId: string; channelId: string }
  | { type: 'typing'; channelId: string; userId: string; username: string }
  | { type: 'presence_update'; userId: string; status: string; activities?: Activity[] }
  | { type: 'voice_state_update'; channelId: string; userId: string; action: 'join' | 'leave' }
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
  | { type: 'dm_call_incoming'; dmChannelId: string; callerId: string; callerName: string; livekitUrl?: string; livekitToken?: string }
  | { type: 'dm_call_accepted'; dmChannelId: string }
  | { type: 'dm_call_rejected'; dmChannelId: string }
  | { type: 'dm_call_ended'; dmChannelId: string }
  | { type: 'voice_status_update'; userId: string; channelId: string; isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }
  | { type: 'dm_channel_created'; dmChannel: DmChannel }
  | { type: 'dm_channel_closed'; dmChannelId: string }
  | { type: 'dm_member_added'; dmChannelId: string; user: User }
  | { type: 'dm_member_removed'; dmChannelId: string; userId: string }
  | { type: 'friend_removed'; userId: string }
  | { type: 'friend_request_cancelled'; requestId: string; userId: string }
  | { type: 'friend_request_declined'; requestId: string; userId: string }
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
  | { type: 'voice_disconnected'; userId: string; channelId: string; reason?: 'displaced' | 'session_closed' }
  | { type: 'user_updated'; user: User }
  | { type: 'member_banned'; spaceId: string; reason: string | null }
  | { type: 'category_created'; category: ChannelCategory; spaceId: string }
  | { type: 'category_updated'; category: ChannelCategory; spaceId: string }
  | { type: 'category_deleted'; categoryId: string; spaceId: string }
  | { type: 'channel_layout_updated'; spaceId: string; channels: Channel[]; categories: ChannelCategory[] }
  | { type: 'space_layout_updated'; layout: SpaceLayoutItem[]; folders: SpaceFolder[]; updatedAt?: number }
  | { type: 'mark_unread'; channelId: string; messageId: string }
  | { type: 'embeds_resolved'; messageId: string; channelId: string; embeds: Embed[] }
  | { type: 'dm_embeds_resolved'; messageId: string; dmChannelId: string; embeds: Embed[] }
  | { type: 'federation_file_rejected'; messageId: string; dmChannelId: string; attachmentId: string; affectedUsers: Array<{ userId: string; username: string; limit: number }> }
  | { type: 'dm_owner_updated'; dmChannelId: string; newOwnerId: string }
  | { type: 'pong' }
  | { type: 'error'; message: string };

// ─── API Request/Response Types ─────────────────────────────────────────────

export interface RegisterRequest {
  username: string;
  password: string;
  displayName?: string;
  avatarColor?: string;
  homeInstance?: string;
  homeUserId?: string;
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
  name?: string;
  icon?: string;
  banner?: string;
  avatarColor?: string;
  visibility?: SpaceVisibility;
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
  status?: UserStatus;
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

export interface SendFriendRequest {
  username: string;
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
  discoveryEnabled: boolean;
  gifApiKey?: string;
  gifEnabled?: boolean;
  maxUploadSizeMb: number;
  federationRelayEnabled: boolean;
  federationRelayTtlDays: number;
  defaultAutoRotateIntervalDays: number;
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
  bitrateMatrixOverrides: Record<string, number> | null;
  allowCustomBitrate: boolean;
}

// ─── Federation Types ──────────────────────────────────────────────────────

export interface InstanceInfoResponse {
  name: string;
  version: string;
  registrationOpen: boolean;
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
    | 'member_add' | 'member_remove' | 'ownership_transfer'
    | 'friend_request_create' | 'friend_request_update' | 'friend_request_cancel'
    | 'friend_add' | 'friend_remove' | 'file_rejected'
    | 'dm_call_start' | 'dm_call_accept' | 'dm_call_reject' | 'dm_call_end'
    | 'dm_typing_start' | 'dm_typing_stop';
  contextType?: 'dm' | 'friend';
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
    content: string | null;
    replyToId: string | null;
    editedAt: number | null;
    createdAt: number;
    attachments?: FederationRelayAttachment[];
  };
  reactions?: FederationRelayReaction[];
  reaction?: FederationRelayReaction;
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
  call?: FederationCallPayload;
  typing?: {
    homeUserId: string;
    homeInstance: string;
    username: string;
  };
}

export interface FederationCallPayload {
  livekitUrl?: string;
  tokens?: Record<string, string>;  // homeUserId → LiveKit token
  caller?: { homeUserId: string; homeInstance: string; displayName: string };
  acceptor?: { homeUserId: string; homeInstance: string };
  rejector?: { homeUserId: string; homeInstance: string };
  endedBy?: { homeUserId: string; homeInstance: string };
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
}

export interface FederationRelayProfileSnapshot {
  username?: string | null;
  displayName?: string | null;
  avatar?: string | null;
  avatarColor?: string | null;
  banner?: string | null;
  bio?: string | null;
}

export interface FederationFriendshipPayload {
  from: FederationRelayParticipant;
  to: FederationRelayParticipant;
  fromProfile?: FederationRelayProfileSnapshot;
  toProfile?: FederationRelayProfileSnapshot;
  status?: 'pending' | 'accepted' | 'declined';
  createdAt: number;
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
  thumbnailFilename?: string;
  sourceUrl: string;
}

export interface FederationRelayRequest {
  version: 1;
  sourceInstance: string;
  events: FederationRelayEvent[];
}

export interface FederationRelayResponse {
  accepted: string[];
  rejected: Array<{ messageId: string; reason: string }>;
  maxUploadSize: number;
}

export interface FederationSyncRequest {
  sinceTimestamp: number;
  dmChannelId?: string;
  federatedId?: string;
  contextType?: 'dm' | 'friend';
  limit: number;
}

export interface FederationSyncResponse {
  events: FederationRelayEvent[];
  hasMore: boolean;
  checkpoint: number;
}

export interface FederationPeer {
  id: string;
  origin: string;
  instanceName: string | null;
  status: 'pending' | 'active' | 'unreachable' | 'revoked';
  lastSeenAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  lastSyncedAt: number;
  createdAt: number;
}
