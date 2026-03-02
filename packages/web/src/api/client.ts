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
  InstanceStreamingLimits,
  InstanceInfoResponse,
  VerifyPasswordResponse,
} from '@backspace/shared';

export class BackspaceApiClient {
  readonly auth: {
    register: (data: RegisterRequest) => Promise<AuthResponse>;
    login: (data: LoginRequest) => Promise<AuthResponse>;
  };

  readonly users: {
    me: () => Promise<User>;
    update: (data: UpdateUserRequest) => Promise<User>;
    get: (id: string) => Promise<User>;
    verifyPassword: (password: string) => Promise<VerifyPasswordResponse>;
  };

  readonly servers: {
    list: () => Promise<Server[]>;
    get: (id: string) => Promise<ServerWithChannelsAndMembers>;
    create: (data: CreateServerRequest) => Promise<Server>;
    update: (id: string, data: UpdateServerRequest) => Promise<Server>;
    delete: (id: string) => Promise<{ success: boolean }>;
    invite: (id: string) => Promise<{ inviteCode: string }>;
    join: (id: string, data: JoinServerRequest) => Promise<Server>;
    joinByCode: (inviteCode: string) => Promise<Server>;
    members: (id: string) => Promise<MemberWithUser[]>;
    updateMember: (serverId: string, userId: string, data: UpdateMemberRequest) => Promise<MemberWithUser>;
    removeMember: (serverId: string, userId: string) => Promise<{ success: boolean }>;
  };

  readonly channels: {
    list: (serverId: string) => Promise<Channel[]>;
    create: (serverId: string, data: CreateChannelRequest) => Promise<Channel>;
    update: (id: string, data: UpdateChannelRequest) => Promise<Channel>;
    delete: (id: string) => Promise<{ success: boolean }>;
    messages: (id: string, before?: string, limit?: number) => Promise<MessageWithUser[]>;
    sendMessage: (channelId: string, data: CreateMessageRequest) => Promise<MessageWithUser>;
    getOverrides: (channelId: string) => Promise<{ channelId: string; targetType: string; targetId: string; allow: string; deny: string }[]>;
    putOverride: (channelId: string, data: { targetType: string; targetId: string; allow: string; deny: string }) => Promise<{ success: boolean }>;
    deleteOverride: (channelId: string, targetType: string, targetId: string) => Promise<{ success: boolean }>;
  };

  readonly messages: {
    update: (id: string, data: UpdateMessageRequest) => Promise<MessageWithUser>;
    delete: (id: string) => Promise<{ success: boolean }>;
  };

  readonly uploads: {
    upload: (file: File) => Promise<Attachment>;
    url: (filename: string) => string;
  };

  readonly dm: {
    list: () => Promise<DmChannel[]>;
    create: (data: CreateDmRequest) => Promise<DmChannel>;
    close: (id: string) => Promise<{ success: boolean }>;
    messages: (id: string, before?: string, limit?: number) => Promise<DmMessageWithUser[]>;
    sendMessage: (id: string, data: CreateDmMessageRequest) => Promise<DmMessageWithUser>;
    updateMessage: (id: string, data: UpdateMessageRequest) => Promise<DmMessageWithUser>;
    deleteMessage: (id: string) => Promise<{ success: boolean }>;
    addMember: (dmChannelId: string, data: { userId: string }) => Promise<DmChannel>;
    leave: (dmChannelId: string) => Promise<{ success: boolean }>;
  };

  readonly social: {
    friends: () => Promise<Friend[]>;
    requests: () => Promise<FriendRequest[]>;
    sendRequest: (username: string) => Promise<{ success: boolean }>;
    updateRequest: (id: string, status: 'accepted' | 'declined') => Promise<{ success: boolean }>;
    removeFriend: (id: string) => Promise<{ success: boolean }>;
    cancelRequest: (id: string) => Promise<{ success: boolean }>;
    search: (q: string) => Promise<User[]>;
  };

  readonly livekit: {
    token: (channelId: string) => Promise<LiveKitTokenResponse>;
    dmToken: (dmChannelId: string) => Promise<LiveKitTokenResponse>;
  };

  readonly settings: {
    getStreaming: () => Promise<InstanceStreamingLimits>;
    updateStreaming: (data: Partial<InstanceStreamingLimits>) => Promise<InstanceStreamingLimits>;
  };

  readonly instance: {
    info: () => Promise<InstanceInfoResponse>;
  };

  constructor(baseUrl: string, getToken: () => string | null) {
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

      const response = await fetch(`${baseUrl}${path}`, {
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

      const response = await fetch(`${baseUrl}/uploads`, {
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

    this.auth = {
      register: (data: RegisterRequest) =>
        request<AuthResponse>('POST', '/auth/register', data, false),
      login: (data: LoginRequest) =>
        request<AuthResponse>('POST', '/auth/login', data, false),
    };

    this.users = {
      me: () => request<User>('GET', '/users/@me'),
      update: (data: UpdateUserRequest) => request<User>('PATCH', '/users/@me', data),
      get: (id: string) => request<User>('GET', `/users/${id}`),
      verifyPassword: (password: string) =>
        request<VerifyPasswordResponse>('POST', '/users/@me/verify-password', { password }),
    };

    this.servers = {
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
    };

    this.channels = {
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
      getOverrides: (channelId: string) =>
        request<{ channelId: string; targetType: string; targetId: string; allow: string; deny: string }[]>(
          'GET', `/channels/${channelId}/overrides`
        ),
      putOverride: (channelId: string, data: { targetType: string; targetId: string; allow: string; deny: string }) =>
        request<{ success: boolean }>('PUT', `/channels/${channelId}/overrides`, data),
      deleteOverride: (channelId: string, targetType: string, targetId: string) =>
        request<{ success: boolean }>('DELETE', `/channels/${channelId}/overrides/${targetType}/${targetId}`),
    };

    this.messages = {
      update: (id: string, data: UpdateMessageRequest) => request<MessageWithUser>('PATCH', `/messages/${id}`, data),
      delete: (id: string) => request<{ success: boolean }>('DELETE', `/messages/${id}`),
    };

    this.uploads = {
      upload: uploadFile,
      url: (filename: string) => `${baseUrl}/uploads/${filename}`,
    };

    this.dm = {
      list: () => request<DmChannel[]>('GET', '/dm'),
      create: (data: CreateDmRequest) => request<DmChannel>('POST', '/dm', data),
      close: (id: string) => request<{ success: boolean }>('DELETE', `/dm/${id}`),
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
      addMember: (dmChannelId: string, data: { userId: string }) =>
        request<DmChannel>('POST', `/dm/${dmChannelId}/members`, data),
      leave: (dmChannelId: string) =>
        request<{ success: boolean }>('DELETE', `/dm/${dmChannelId}/members`),
    };

    this.social = {
      friends: () => request<Friend[]>('GET', '/social/friends'),
      requests: () => request<FriendRequest[]>('GET', '/social/requests'),
      sendRequest: (username: string) => request<{ success: boolean }>('POST', '/social/requests', { username }),
      updateRequest: (id: string, status: 'accepted' | 'declined') =>
        request<{ success: boolean }>('PATCH', `/social/requests/${id}`, { status }),
      removeFriend: (id: string) => request<{ success: boolean }>('DELETE', `/social/friends/${id}`),
      cancelRequest: (id: string) => request<{ success: boolean }>('DELETE', `/social/requests/${id}`),
      search: (q: string) => request<User[]>('GET', `/social/search?q=${encodeURIComponent(q)}`),
    };

    this.livekit = {
      token: (channelId: string) =>
        request<LiveKitTokenResponse>('POST', '/livekit/token', { channelId }),
      dmToken: (dmChannelId: string) =>
        request<LiveKitTokenResponse>('POST', '/livekit/token', { dmChannelId }),
    };

    this.settings = {
      getStreaming: () => request<InstanceStreamingLimits>('GET', '/settings/streaming'),
      updateStreaming: (data: Partial<InstanceStreamingLimits>) =>
        request<InstanceStreamingLimits>('PATCH', '/settings/streaming', data),
    };

    this.instance = {
      info: () => request<InstanceInfoResponse>('GET', '/instance/info', undefined, false),
    };
  }
}

export const api = new BackspaceApiClient('/api', () => localStorage.getItem('backspace_token'));

export function createApiClient(origin: string, getToken: () => string | null): BackspaceApiClient {
  const baseUrl = origin ? `${origin}/api` : '/api';
  return new BackspaceApiClient(baseUrl, getToken);
}
