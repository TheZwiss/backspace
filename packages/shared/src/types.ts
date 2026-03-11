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
  createdAt: number;
  homeInstance: string | null;
  homeUserId: string | null;
  replicatedInstances: ReplicatedInstance[];
}

export interface ReplicatedInstance {
  origin: string;   // Full URL with protocol, e.g. "https://orbit.ddns.net"
  username: string;
  domain?: string;  // Legacy field — kept for backward compat with existing data
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
  ownerId: string;
  inviteCode: string | null;
  visibility: SpaceVisibility;
  description: string | null;
  createdAt: number;
}

export interface ExploreSpace {
  id: string;
  name: string;
  icon: string | null;
  banner: string | null;
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

// ─── Channel Types ──────────────────────────────────────────────────────────

export type ChannelType = 'text' | 'voice' | 'video';

export interface Channel {
  id: string;
  spaceId: string;
  name: string;
  type: ChannelType;
  topic: string | null;
  position: number;
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
  editedAt: number | null;
  createdAt: number;
}

export interface MessageWithUser extends Message {
  user: User;
  attachments: Attachment[];
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
  createdAt: number;
}

// ─── Active Call Types ───────────────────────────────────────────────────────

export interface ActiveCallInfo {
  dmChannelId: string;
  callerId: string;
  participants: string[];
  startedAt: number;
  state: 'ringing' | 'active';
}

// ─── DM Types ───────────────────────────────────────────────────────────────

export interface DmChannel {
  id: string;
  ownerId?: string | null;
  createdAt: number;
  members: User[];
  lastMessage?: DmMessage | null;
}

export interface DmMessage {
  id: string;
  dmChannelId: string;
  userId: string;
  content: string | null;
  createdAt: number;
  // Compatibility fields
  channelId?: string;
  replyToId?: string | null;
  editedAt?: number | null;
}

export interface DmMessageWithUser extends DmMessage {
  user: User;
  attachments: Attachment[];
  reactions: Reaction[];
  replyTo?: DmMessageWithUser | null;
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
  | { type: 'dm_call_start'; dmChannelId: string }
  | { type: 'dm_call_accept'; dmChannelId: string }
  | { type: 'dm_call_reject'; dmChannelId: string }
  | { type: 'dm_call_end'; dmChannelId: string }
  | { type: 'voice_status'; isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }
  | { type: 'voice_server_mute'; userId: string; muted: boolean }
  | { type: 'voice_server_deafen'; userId: string; deafened: boolean }
  | { type: 'voice_move'; userId: string; targetChannelId: string }
  | { type: 'voice_disconnect'; userId: string }
  | { type: 'ping' };

// Server → Client Events
export type ServerEvent =
  | { type: 'ready'; user: User; spaces: SpaceWithChannelsAndMembers[]; dmChannels: DmChannel[]; folders?: SpaceFolder[]; voiceStates?: Record<string, string[]>; voiceUserStates?: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>; readStates?: ReadState[]; activeCalls?: ActiveCallInfo[]; serverVoiceStates?: Record<string, { serverMuted: boolean; serverDeafened: boolean }> }
  | { type: 'message_created'; message: MessageWithUser }
  | { type: 'message_updated'; message: MessageWithUser }
  | { type: 'message_deleted'; messageId: string; channelId: string }
  | { type: 'typing'; channelId: string; userId: string; username: string }
  | { type: 'presence_update'; userId: string; status: string }
  | { type: 'voice_state_update'; channelId: string; userId: string; action: 'join' | 'leave' }
  | { type: 'member_joined'; spaceId: string; member: MemberWithUser }
  | { type: 'member_left'; spaceId: string; userId: string }
  | { type: 'dm_message_created'; message: DmMessageWithUser }
  | { type: 'dm_message_updated'; message: DmMessageWithUser }
  | { type: 'dm_message_deleted'; messageId: string; dmChannelId: string }
  | { type: 'dm_typing'; dmChannelId: string; userId: string; username: string }
  | { type: 'reaction_added'; messageId: string; reaction: Reaction }
  | { type: 'reaction_removed'; messageId: string; userId: string; emoji: string }
  | { type: 'channel_ack'; channelId: string; messageId: string }
  | { type: 'friend_request_received'; request: FriendRequest }
  | { type: 'friend_request_accepted'; friend: Friend; requestId: string }
  | { type: 'dm_call_incoming'; dmChannelId: string; callerId: string; callerName: string }
  | { type: 'dm_call_accepted'; dmChannelId: string }
  | { type: 'dm_call_rejected'; dmChannelId: string }
  | { type: 'dm_call_ended'; dmChannelId: string }
  | { type: 'voice_status_update'; userId: string; channelId: string; isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }
  | { type: 'dm_channel_created'; dmChannel: DmChannel }
  | { type: 'dm_channel_closed'; dmChannelId: string }
  | { type: 'dm_member_added'; dmChannelId: string; user: User }
  | { type: 'dm_member_removed'; dmChannelId: string; userId: string }
  | { type: 'friend_removed'; userId: string }
  | { type: 'channel_created'; channel: Channel; spaceId: string }
  | { type: 'channel_updated'; channel: Channel; spaceId: string }
  | { type: 'channel_deleted'; channelId: string; spaceId: string }
  | { type: 'space_updated'; space: Space }
  | { type: 'join_request_received'; request: JoinRequest }
  | { type: 'join_request_accepted'; request: JoinRequest; space: SpaceWithChannelsAndMembers }
  | { type: 'join_request_declined'; request: JoinRequest }
  | { type: 'voice_server_muted'; userId: string; channelId: string; spaceId: string; muted: boolean }
  | { type: 'voice_server_deafened'; userId: string; channelId: string; spaceId: string; deafened: boolean }
  | { type: 'voice_permission_muted'; userId: string; spaceId: string; muted: boolean }
  | { type: 'voice_moved'; userId: string; oldChannelId: string; newChannelId: string }
  | { type: 'voice_disconnected'; userId: string; channelId: string }
  | { type: 'user_updated'; user: User }
  | { type: 'member_banned'; spaceId: string; reason: string | null }
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
  visibility?: SpaceVisibility;
  description?: string;
}

export interface CreateChannelRequest {
  name: string;
  type: ChannelType;
  topic?: string;
}

export interface UpdateChannelRequest {
  name?: string;
  topic?: string;
  position?: number;
}

export interface UpdateSpaceRequest {
  name?: string;
  icon?: string;
  banner?: string;
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
  userId: string;
}

export interface AddDmMemberRequest {
  userId: string;
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

// ─── Instance Settings Types ────────────────────────────────────────────────

export interface InstanceAdminSettings {
  instanceName: string;
  registrationOpen: boolean;
  discoveryEnabled: boolean;
}

export interface InstanceStreamingLimits {
  maxBitrateKbps: number;
  minBitrateKbps: number;
  bitrateStepKbps: number;
  allowedResolutions: number[];
  allowedFramerates: number[];
  maxResolution: number;
  maxFramerate: number;
  discoveryEnabled: boolean;
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
