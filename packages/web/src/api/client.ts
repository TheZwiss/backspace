import type {
  AuthResponse,
  RegisterRequest,
  LoginRequest,
  User,
  Server,
  ServerWithChannelsAndMembers,
  Channel,
  MessageWithUser,
  MemberWithUser,
  Attachment,
  DmChannel,
  DmMessageWithUser,
  CreateServerRequest,
  UpdateServerRequest,
  CreateChannelRequest,
  UpdateChannelRequest,
  CreateMessageRequest,
  UpdateMessageRequest,
  UpdateUserRequest,
  JoinServerRequest,
  UpdateMemberRequest,
  LiveKitTokenResponse,
  CreateDmRequest,
  CreateDmMessageRequest,
  Friend,
  FriendRequest,
} from '@opencord/shared';

const BASE_URL = '/api';

function getToken(): string | null {
  return localStorage.getItem('opencord_token');
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  requireAuth = true,
): Promise<T> {
  const headers: Record<string, string> = {};

  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  if (requireAuth) {
    const token = getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error((error as { error: string }).error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function uploadFile(file: File): Promise<Attachment> {
  const formData = new FormData();
  formData.append('file', file);

  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${BASE_URL}/uploads`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error((error as { error: string }).error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<Attachment>;
}

export const api = {
  auth: {
    register: (data: RegisterRequest) =>
      request<AuthResponse>('POST', '/auth/register', data, false),
    login: (data: LoginRequest) =>
      request<AuthResponse>('POST', '/auth/login', data, false),
  },

  users: {
    me: () => request<User>('GET', '/users/@me'),
    update: (data: UpdateUserRequest) => request<User>('PATCH', '/users/@me', data),
    get: (id: string) => request<User>('GET', `/users/${id}`),
  },

  servers: {
    list: () => request<Server[]>('GET', '/servers'),
    get: (id: string) => request<ServerWithChannelsAndMembers>('GET', `/servers/${id}`),
    create: (data: CreateServerRequest) => request<Server>('POST', '/servers', data),
    update: (id: string, data: UpdateServerRequest) => request<Server>('PATCH', `/servers/${id}`, data),
    delete: (id: string) => request<{ success: boolean }>('DELETE', `/servers/${id}`),
    invite: (id: string) => request<{ inviteCode: string }>('POST', `/servers/${id}/invite`),
    join: (id: string, data: JoinServerRequest) => request<Server>('POST', `/servers/${id}/join`, data),
    joinByCode: (inviteCode: string) => request<Server>('POST', '/servers/join', { inviteCode }),
    members: (id: string) => request<MemberWithUser[]>('GET', `/servers/${id}/members`),
    updateMember: (serverId: string, userId: string, data: UpdateMemberRequest) =>
      request<MemberWithUser>('PATCH', `/servers/${serverId}/members/${userId}`, data),
    removeMember: (serverId: string, userId: string) =>
      request<{ success: boolean }>('DELETE', `/servers/${serverId}/members/${userId}`),
  },

  channels: {
    list: (serverId: string) => request<Channel[]>('GET', `/servers/${serverId}/channels`),
    create: (serverId: string, data: CreateChannelRequest) =>
      request<Channel>('POST', `/servers/${serverId}/channels`, data),
    update: (id: string, data: UpdateChannelRequest) => request<Channel>('PATCH', `/channels/${id}`, data),
    delete: (id: string) => request<{ success: boolean }>('DELETE', `/channels/${id}`),
    messages: (id: string, before?: string, limit = 50) => {
      const params = new URLSearchParams();
      if (before) params.set('before', before);
      params.set('limit', String(limit));
      return request<MessageWithUser[]>('GET', `/channels/${id}/messages?${params}`);
    },
    sendMessage: (channelId: string, data: CreateMessageRequest) =>
      request<MessageWithUser>('POST', `/channels/${channelId}/messages`, data),
  },

  messages: {
    update: (id: string, data: UpdateMessageRequest) => request<MessageWithUser>('PATCH', `/messages/${id}`, data),
    delete: (id: string) => request<{ success: boolean }>('DELETE', `/messages/${id}`),
  },

  uploads: {
    upload: uploadFile,
    url: (filename: string) => `${BASE_URL}/uploads/${filename}`,
  },

  dm: {
    list: () => request<DmChannel[]>('GET', '/dm'),
    create: (data: CreateDmRequest) => request<DmChannel>('POST', '/dm', data),
    messages: (id: string, before?: string, limit = 50) => {
      const params = new URLSearchParams();
      if (before) params.set('before', before);
      params.set('limit', String(limit));
      return request<DmMessageWithUser[]>('GET', `/dm/${id}/messages?${params}`);
    },
    sendMessage: (id: string, data: CreateDmMessageRequest) =>
      request<DmMessageWithUser>('POST', `/dm/${id}/messages`, data),
    updateMessage: (id: string, data: UpdateMessageRequest) =>
      request<DmMessageWithUser>('PATCH', `/dm/messages/${id}`, data),
    deleteMessage: (id: string) =>
      request<{ success: boolean }>('DELETE', `/dm/messages/${id}`),
  },

  social: {
    friends: () => request<Friend[]>('GET', '/social/friends'),
    requests: () => request<FriendRequest[]>('GET', '/social/requests'),
    sendRequest: (username: string) => request<{ success: boolean }>('POST', '/social/requests', { username }),
    updateRequest: (id: string, status: 'accepted' | 'declined') =>
      request<{ success: boolean }>('PATCH', `/social/requests/${id}`, { status }),
    removeFriend: (id: string) => request<{ success: boolean }>('DELETE', `/social/friends/${id}`),
    cancelRequest: (id: string) => request<{ success: boolean }>('DELETE', `/social/requests/${id}`),
    search: (q: string) => request<User[]>('GET', `/social/search?q=${encodeURIComponent(q)}`),
  },

  livekit: {
    token: (channelId: string) =>
      request<LiveKitTokenResponse>('POST', '/livekit/token', { channelId }),
    dmToken: (dmChannelId: string) =>
      request<LiveKitTokenResponse>('POST', '/livekit/token', { dmChannelId }),
  },
};
