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
}

// ─── Message Types ──────────────────────────────────────────────────────────

export interface Message {
  id: string;
  channelId: string;
  userId: string;
  content: string | null;
  editedAt: number | null;
  createdAt: number;
}

export interface MessageWithUser extends Message {
  user: User;
  attachments: Attachment[];
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
}

export interface DmMessageWithUser extends DmMessage {
  user: User;
}

// ─── WebSocket Event Types ──────────────────────────────────────────────────

// Client → Server Events
export type ClientEvent =
  | { type: 'auth'; token: string }
  | { type: 'message_create'; channelId: string; content: string }
  | { type: 'message_edit'; messageId: string; content: string }
  | { type: 'message_delete'; messageId: string }
  | { type: 'typing_start'; channelId: string }
  | { type: 'presence_update'; status: 'online' | 'idle' | 'dnd' }
  | { type: 'voice_join'; channelId: string }
  | { type: 'voice_leave' }
  | { type: 'dm_message_create'; dmChannelId: string; content: string };

// Server → Client Events
export type ServerEvent =
  | { type: 'ready'; user: User; servers: ServerWithChannelsAndMembers[]; dmChannels: DmChannel[] }
  | { type: 'message_created'; message: MessageWithUser }
  | { type: 'message_updated'; message: MessageWithUser }
  | { type: 'message_deleted'; messageId: string; channelId: string }
  | { type: 'typing'; channelId: string; userId: string; username: string }
  | { type: 'presence_update'; userId: string; status: string }
  | { type: 'voice_state_update'; channelId: string; userId: string; action: 'join' | 'leave' }
  | { type: 'member_joined'; serverId: string; member: MemberWithUser }
  | { type: 'member_left'; serverId: string; userId: string }
  | { type: 'dm_message_created'; message: DmMessageWithUser }
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
}

export interface UpdateMemberRequest {
  role: MemberRole;
}

export interface CreateMessageRequest {
  content: string;
  attachments?: string[];
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
