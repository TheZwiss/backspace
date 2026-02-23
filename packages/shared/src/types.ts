// ─── User Types ─────────────────────────────────────────────────────────────

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  status: UserStatus;
  customStatus: string | null;
  createdAt: number;
}

export type UserStatus = 'online' | 'idle' | 'dnd' | 'offline';

export interface UserWithPassword extends User {
  passwordHash: string;
}

// ─── Server (Guild) Types ───────────────────────────────────────────────────

export interface Server {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string;
  inviteCode: string | null;
  createdAt: number;
}

export interface ServerWithChannelsAndMembers extends Server {
  channels: Channel[];
  members: MemberWithUser[];
  roles: Role[];
}

// ─── Member Types ───────────────────────────────────────────────────────────

export type MemberRole = 'owner' | 'admin' | 'member';

export interface Member {
  serverId: string;
  userId: string;
  role: MemberRole;
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
  serverId: string;
  name: string;
  color: string;
  position: number;
  permissions?: string[];
  createdAt: number;
}

// ─── Folder Types ───────────────────────────────────────────────────────────

export interface ServerFolder {
  id: string;
  userId: string;
  name: string | null;
  color: string | null;
  position: number;
  serverIds: string[];
}

// ─── Channel Types ──────────────────────────────────────────────────────────

export type ChannelType = 'text' | 'voice' | 'video';

export interface Channel {
  id: string;
  serverId: string;
  name: string;
  type: ChannelType;
  topic: string | null;
  position: number;
  createdAt: number;
  lastMessageId?: string | null;
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

// ─── DM Types ───────────────────────────────────────────────────────────────

export interface DmChannel {
  id: string;
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
  attachments?: Attachment[];
  reactions?: Reaction[];
  replyTo?: MessageWithUser | null;
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
  | { type: 'dm_message_create'; dmChannelId: string; content: string; replyToId?: string }
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
  | { type: 'ping' };

// Server → Client Events
export type ServerEvent =
  | { type: 'ready'; user: User; servers: ServerWithChannelsAndMembers[]; dmChannels: DmChannel[]; folders?: ServerFolder[]; voiceStates?: Record<string, string[]>; voiceUserStates?: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>; readStates?: ReadState[] }
  | { type: 'message_created'; message: MessageWithUser }
  | { type: 'message_updated'; message: MessageWithUser }
  | { type: 'message_deleted'; messageId: string; channelId: string }
  | { type: 'typing'; channelId: string; userId: string; username: string }
  | { type: 'presence_update'; userId: string; status: string }
  | { type: 'voice_state_update'; channelId: string; userId: string; action: 'join' | 'leave' }
  | { type: 'member_joined'; serverId: string; member: MemberWithUser }
  | { type: 'member_left'; serverId: string; userId: string }
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
  | { type: 'friend_removed'; userId: string }
  | { type: 'channel_created'; channel: Channel; serverId: string }
  | { type: 'channel_updated'; channel: Channel; serverId: string }
  | { type: 'channel_deleted'; channelId: string; serverId: string }
  | { type: 'server_updated'; server: Server }
  | { type: 'pong' }
  | { type: 'error'; message: string };

// ─── API Request/Response Types ─────────────────────────────────────────────

export interface RegisterRequest {
  username: string;
  password: string;
  displayName?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface CreateServerRequest {
  name: string;
  icon?: string;
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

export interface UpdateServerRequest {
  name?: string;
  icon?: string;
}

export interface UpdateUserRequest {
  displayName?: string;
  avatar?: string;
  customStatus?: string;
  status?: UserStatus;
}

export interface UpdateMemberRequest {
  role: MemberRole;
}

export interface CreateMessageRequest {
  content: string;
  attachments?: string[];
  replyToId?: string;
}

export interface UpdateMessageRequest {
  content: string;
}

export interface JoinServerRequest {
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

export interface CreateDmMessageRequest {
  content: string;
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
  status: UserStatus;
  customStatus: string | null;
  createdAt: number;
  addedAt: number;
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
