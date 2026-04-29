import type {
  AuthResponse,
  RegisterRequest,
  LoginRequest,
  User,
  Space,
  SpaceWithChannelsAndMembers,
  Channel,
  ChannelCategory,
  MessageWithUser,
  MemberWithUser,
  Attachment,
  DmChannel,
  DmMessageWithUser,
  CreateSpaceRequest,
  UpdateSpaceRequest,
  CreateChannelRequest,
  UpdateChannelRequest,
  CreateMessageRequest,
  UpdateMessageRequest,
  UpdateUserRequest,
  JoinSpaceRequest,
  UpdateMemberRequest,
  LiveKitTokenResponse,
  CreateDmRequest,
  AddDmMemberRequest,
  CreateGroupDmRequest,
  CreateDmMessageRequest,
  Friend,
  FriendRequest,
  DiscoverUser,
  InstanceStreamingLimits,
  InstanceAdminSettings,
  InstanceInfoResponse,
  VerifyPasswordResponse,
  ChangePasswordRequest,
  ChangePasswordResponse,
  DeleteAccountRequest,
  StorageStats,
  OrphanedFile,
  CleanupResult,
  AdminUserListResponse,
  AdminUser,
  AdminResetPasswordResponse,
  ExploreSpace,
  JoinRequest,
  Role,
  SpaceLayoutItem,
  SpaceFolder,
  InvitePreview,
  GifResult,
  FederationRegistryEntry,
  FederationIdentityDeleteRequest,
  FederationIdentityDeleteResponse,
  FederationPeer,
  ApprovalRequest,
  PeeringSubscription,
  PeeringNotification,
  InviteLinkSummary,
  InviteRedemption,
  CreateInviteRequest,
  UpdateInviteRequest,
  ReinstateInviteRequest,
  ReinstateInviteResponse,
  CheckInviteResponse,
  SpaceInviteRequest,
  SpaceInviteResponse,
} from '@backspace/shared';

export type { FederationPeer, ApprovalRequest, PeeringSubscription, PeeringNotification };

export class RateLimitError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super('Rate limit exceeded');
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class BackspaceApiClient {
  readonly auth: {
    register: (data: RegisterRequest) => Promise<AuthResponse>;
    login: (data: LoginRequest) => Promise<AuthResponse>;
    checkUsername: (username: string) => Promise<{ available: boolean; reason?: string }>;
    checkInvite: (token: string) => Promise<CheckInviteResponse>;
  };

  readonly users: {
    me: () => Promise<User>;
    update: (data: UpdateUserRequest) => Promise<User>;
    get: (id: string) => Promise<User>;
    verifyPassword: (password: string) => Promise<VerifyPasswordResponse>;
    changePassword: (data: ChangePasswordRequest) => Promise<ChangePasswordResponse>;
    deleteAccount: (data: DeleteAccountRequest) => Promise<{ success: boolean }>;
    getMutuals: (id: string, homeUserId?: string) => Promise<{ mutualFriends: User[]; mutualSpaces: { id: string; name: string; icon: string | null; avatarColor: string | null }[] }>;
    getFederationRegistry: () => Promise<{ registry: FederationRegistryEntry[]; updatedAt: number }>;
    putFederationRegistry: (data: { registry: FederationRegistryEntry[]; updatedAt: number }) => Promise<{ ok: boolean; updatedAt: number }>;
    deleteFederationIdentity: (data: FederationIdentityDeleteRequest) => Promise<FederationIdentityDeleteResponse>;
  };

  readonly spaceLayout: {
    update: (data: { items: SpaceLayoutItem[]; folders: Record<string, { name: string | null; color: string | null; spaceIds: string[] }>; updatedAt?: number }) => Promise<{ items: SpaceLayoutItem[]; folders: SpaceFolder[]; updatedAt?: number }>;
  };

  readonly spaces: {
    list: () => Promise<Space[]>;
    get: (id: string) => Promise<SpaceWithChannelsAndMembers>;
    create: (data: CreateSpaceRequest) => Promise<Space>;
    update: (id: string, data: UpdateSpaceRequest) => Promise<Space>;
    delete: (id: string) => Promise<{ success: boolean }>;
    invite: (id: string) => Promise<{ inviteCode: string }>;
    join: (id: string, data: JoinSpaceRequest) => Promise<Space>;
    joinByCode: (inviteCode: string) => Promise<Space>;
    members: (id: string) => Promise<MemberWithUser[]>;
    updateMember: (spaceId: string, userId: string, data: UpdateMemberRequest) => Promise<MemberWithUser>;
    removeMember: (spaceId: string, userId: string) => Promise<{ success: boolean }>;
    getBans: (spaceId: string) => Promise<{ spaceId: string; userId: string; reason: string | null; bannedBy: string; createdAt: number; user: any; moderator: any }[]>;
    ban: (spaceId: string, userId: string, reason?: string) => Promise<{ success: boolean }>;
    unban: (spaceId: string, userId: string) => Promise<{ success: boolean }>;
    transferOwnership: (spaceId: string, newOwnerId: string) => Promise<Space>;
    invitePreview: (code: string) => Promise<InvitePreview>;
  };

  readonly channels: {
    list: (spaceId: string) => Promise<Channel[]>;
    create: (spaceId: string, data: CreateChannelRequest) => Promise<Channel>;
    update: (id: string, data: UpdateChannelRequest) => Promise<Channel>;
    delete: (id: string) => Promise<{ success: boolean }>;
    messages: (id: string, before?: string, limit?: number) => Promise<MessageWithUser[]>;
    messagesAround: (id: string, messageId: string) => Promise<MessageWithUser[]>;
    sendMessage: (channelId: string, data: CreateMessageRequest) => Promise<MessageWithUser>;
    getOverrides: (channelId: string) => Promise<{ channelId: string; targetType: string; targetId: string; allow: string; deny: string }[]>;
    putOverride: (channelId: string, data: { targetType: string; targetId: string; allow: string; deny: string }) => Promise<{ success: boolean }>;
    deleteOverride: (channelId: string, targetType: string, targetId: string) => Promise<{ success: boolean }>;
    updateLayout: (spaceId: string, data: { channels: Array<{ id: string; position: number; categoryId: string | null }>; categories: Array<{ id: string; position: number }> }) => Promise<{ success: boolean }>;
  };

  readonly categories: {
    create: (spaceId: string, name: string) => Promise<ChannelCategory>;
    update: (id: string, data: { name?: string; position?: number }) => Promise<ChannelCategory>;
    delete: (id: string) => Promise<{ success: boolean }>;
    getOverrides: (categoryId: string) => Promise<{ categoryId: string; targetType: string; targetId: string; allow: string; deny: string }[]>;
    putOverride: (categoryId: string, data: { targetType: string; targetId: string; allow: string; deny: string }) => Promise<{ success: boolean }>;
    deleteOverride: (categoryId: string, targetType: string, targetId: string) => Promise<{ success: boolean }>;
  };

  readonly messages: {
    update: (id: string, data: UpdateMessageRequest) => Promise<MessageWithUser>;
    delete: (id: string) => Promise<{ success: boolean }>;
  };

  readonly uploads: {
    upload: (file: File) => Promise<Attachment>;
    uploadWithProgress: (file: File, onProgress: (loaded: number, total: number) => void) => Promise<Attachment>;
    url: (filename: string) => string;
  };

  readonly dm: {
    list: () => Promise<DmChannel[]>;
    create: (data: CreateDmRequest) => Promise<DmChannel>;
    createGroup: (data: CreateGroupDmRequest) => Promise<DmChannel>;
    close: (id: string) => Promise<{ success: boolean }>;
    messages: (id: string, before?: string, limit?: number) => Promise<DmMessageWithUser[]>;
    messagesAround: (id: string, messageId: string) => Promise<DmMessageWithUser[]>;
    sendMessage: (id: string, data: CreateDmMessageRequest) => Promise<DmMessageWithUser>;
    updateMessage: (id: string, data: UpdateMessageRequest) => Promise<DmMessageWithUser>;
    deleteMessage: (id: string) => Promise<{ success: boolean }>;
    addMember: (dmChannelId: string, data: AddDmMemberRequest) => Promise<DmChannel>;
    leave: (dmChannelId: string) => Promise<{ success: boolean }>;
    spaceInvite: (body: SpaceInviteRequest) => Promise<SpaceInviteResponse>;
  };

  readonly social: {
    friends: () => Promise<Friend[]>;
    requests: () => Promise<FriendRequest[]>;
    sendRequest: (username: string) => Promise<{ success: boolean; requestId?: string }>;
    updateRequest: (id: string, status: 'accepted' | 'declined') => Promise<{ success: boolean }>;
    removeFriend: (id: string) => Promise<{ success: boolean }>;
    cancelRequest: (id: string) => Promise<{ success: boolean }>;
    search: (q: string) => Promise<User[]>;
    discover: (q?: string, limit?: number, offset?: number) => Promise<{ users: DiscoverUser[]; total: number }>;
  };

  readonly livekit: {
    token: (channelId: string) => Promise<LiveKitTokenResponse>;
    dmToken: (dmChannelId: string) => Promise<LiveKitTokenResponse>;
  };

  readonly settings: {
    getStreaming: () => Promise<InstanceStreamingLimits>;
    updateStreaming: (data: Partial<InstanceStreamingLimits>) => Promise<InstanceStreamingLimits>;
    getInstance: () => Promise<InstanceAdminSettings>;
    updateInstance: (data: Partial<InstanceAdminSettings>) => Promise<InstanceAdminSettings>;
  };

  readonly instance: {
    info: () => Promise<InstanceInfoResponse>;
  };

  readonly roles: {
    create: (spaceId: string, data: { name: string; color?: string; permissions?: string }) => Promise<Role>;
    update: (spaceId: string, roleId: string, data: { name?: string; color?: string; position?: number; permissions?: string }) => Promise<Role>;
    delete: (spaceId: string, roleId: string) => Promise<{ success: boolean }>;
  };

  readonly search: {
    channel: (channelId: string, params: { q?: string; from?: string; has?: string; before?: string; after?: string; offset?: number; limit?: number }) => Promise<{ results: MessageWithUser[]; totalCount: number }>;
    dm: (dmChannelId: string, params: { q?: string; from?: string; has?: string; before?: string; after?: string; offset?: number; limit?: number }) => Promise<{ results: DmMessageWithUser[]; totalCount: number }>;
  };

  readonly explore: {
    list: (q?: string, limit?: number, offset?: number) => Promise<{ spaces: ExploreSpace[]; total: number; totalAll: number; discoveryEnabled: boolean }>;
    publicJoin: (spaceId: string) => Promise<SpaceWithChannelsAndMembers>;
    requestJoin: (spaceId: string, message?: string) => Promise<JoinRequest>;
    getJoinRequests: (spaceId: string, status?: string) => Promise<{ requests: JoinRequest[] }>;
    decideJoinRequest: (spaceId: string, requestId: string, action: 'accept' | 'decline') => Promise<JoinRequest>;
    myJoinRequests: (status?: string) => Promise<{ requests: JoinRequest[] }>;
  };

  readonly gif: {
    trending: (limit?: number, pos?: string) => Promise<{ results: GifResult[]; next: string }>;
    search: (q: string, limit?: number, pos?: string) => Promise<{ results: GifResult[]; next: string }>;
    enabled: () => Promise<{ enabled: boolean }>;
  };

  readonly federation: {
    initiatePeering: (data: { remoteOrigin: string }) => Promise<{ peer: FederationPeer }>;
    ensurePeered: (data: { remoteOrigin: string }) => Promise<{ peeringStatus: string; peerId?: string; error?: string }>;
    peers: () => Promise<{ peers: FederationPeer[] }>;
    revokePeer: (id: string) => Promise<{ success: boolean }>;
    resetPeer: (id: string) => Promise<{ success: boolean }>;
    rotatePeerSecret: (id: string) => Promise<{ success: boolean; gracePeriodMs: number }>;
    updatePeer: (id: string, data: { autoRotateIntervalDays: number }) => Promise<{ peer: FederationPeer }>;
    deletePeerPermanently: (id: string) => Promise<{ success: boolean }>;
    approvalRequests: () => Promise<{ requests: ApprovalRequest[] }>;
    approveRequest: (id: string) => Promise<{ success: boolean; peer?: FederationPeer }>;
    denyRequest: (id: string) => Promise<{ success: boolean }>;
    peeringSubscriptions: () => Promise<{ subscriptions: PeeringSubscription[] }>;
    cancelPeeringSubscription: (id: string) => Promise<{ success: boolean }>;
    peeringNotifications: (unreadOnly?: boolean) => Promise<{ notifications: PeeringNotification[] }>;
    markPeeringNotificationRead: (id: string) => Promise<{ success: boolean }>;
    markAllPeeringNotificationsRead: () => Promise<{ success: boolean; count: number }>;
  };

  readonly invites: {
    list: (status?: 'active' | 'archived') => Promise<{ invites: InviteLinkSummary[] }>;
    create: (body: CreateInviteRequest) => Promise<InviteLinkSummary>;
    update: (id: string, body: UpdateInviteRequest) => Promise<InviteLinkSummary>;
    revoke: (id: string) => Promise<{ invite: InviteLinkSummary }>;
    reinstate: (id: string, body: ReinstateInviteRequest) => Promise<ReinstateInviteResponse>;
    delete: (id: string) => Promise<{ success: boolean }>;
    redemptions: (id: string) => Promise<{ redemptions: InviteRedemption[] }>;
  };

  readonly admin: {
    storageStats: () => Promise<StorageStats>;
    storageOrphans: () => Promise<{ orphans: OrphanedFile[] }>;
    storageCleanup: (dryRun?: boolean) => Promise<CleanupResult>;
    cleanupOldMedia: (maxAgeDays: number, dryRun?: boolean) => Promise<CleanupResult>;
    listUsers: (params?: { q?: string; page?: number; pageSize?: number; showDeleted?: boolean; homeInstance?: string; role?: string; joinedAfter?: string; joinedBefore?: string; sort?: string }) => Promise<AdminUserListResponse>;
    listInstances: () => Promise<{ instances: string[] }>;
    setUserRole: (userId: string, isAdmin: boolean) => Promise<AdminUser>;
    resetUserPassword: (userId: string) => Promise<AdminResetPasswordResponse>;
    deleteUser: (userId: string) => Promise<{ success: boolean }>;
  };

  constructor(baseUrl: string, getToken: () => string | null, onUnauthorized?: () => void) {
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

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      let response: Response;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new Error('Request timed out');
        }
        throw err;
      }
      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 401 && requireAuth && onUnauthorized) {
          onUnauthorized();
        }
        if (response.status === 429) {
          const body = await response.json().catch(() => ({}));
          const retryAfter = (body as { retryAfter?: number }).retryAfter
            ?? (parseInt(response.headers.get('retry-after') || '', 10) || 60);
          throw new RateLimitError(retryAfter);
        }
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

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/uploads`, {
          method: 'POST',
          headers,
          body: formData,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new Error('Request timed out');
        }
        throw err;
      }
      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 401 && onUnauthorized) {
          onUnauthorized();
        }
        if (response.status === 429) {
          const body = await response.json().catch(() => ({}));
          const retryAfter = (body as { retryAfter?: number }).retryAfter
            ?? (parseInt(response.headers.get('retry-after') || '', 10) || 60);
          throw new RateLimitError(retryAfter);
        }
        const error = await response.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error((error as { error: string }).error || `HTTP ${response.status}`);
      }

      return response.json() as Promise<Attachment>;
    }

    function uploadFileWithProgress(file: File, onProgress: (loaded: number, total: number) => void): Promise<Attachment> {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        formData.append('file', file);

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) onProgress(e.loaded, e.total);
        });

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)); }
            catch { reject(new Error('Invalid server response')); }
          } else if (xhr.status === 401 && onUnauthorized) {
            onUnauthorized();
            reject(new Error('Unauthorized'));
          } else if (xhr.status === 413) {
            reject(new Error('File too large'));
          } else {
            try {
              const body = JSON.parse(xhr.responseText);
              reject(new Error(body.error || `Upload failed (${xhr.status})`));
            } catch { reject(new Error(`Upload failed (${xhr.status})`)); }
          }
        });

        xhr.addEventListener('error', () => reject(new Error('Upload failed — network error')));
        xhr.addEventListener('timeout', () => reject(new Error('Upload timed out')));

        xhr.open('POST', `${baseUrl}/uploads`);
        xhr.timeout = 10 * 60 * 1000; // 10 minutes for large files
        const token = getToken();
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.send(formData);
      });
    }

    this.auth = {
      register: (data: RegisterRequest) =>
        request<AuthResponse>('POST', '/auth/register', data, false),
      login: (data: LoginRequest) =>
        request<AuthResponse>('POST', '/auth/login', data, false),
      checkUsername: (username: string) =>
        request<{ available: boolean; reason?: string }>('GET', `/auth/check-username?username=${encodeURIComponent(username)}`, undefined, false),
      checkInvite: (token: string) =>
        request<CheckInviteResponse>('GET', `/auth/check-invite?token=${encodeURIComponent(token)}`, undefined, false),
    };

    this.users = {
      me: () => request<User>('GET', '/users/@me'),
      update: (data: UpdateUserRequest) => request<User>('PATCH', '/users/@me', data),
      get: (id: string) => request<User>('GET', `/users/${id}`),
      verifyPassword: (password: string) =>
        request<VerifyPasswordResponse>('POST', '/users/@me/verify-password', { password }),
      changePassword: (data: ChangePasswordRequest) =>
        request<ChangePasswordResponse>('POST', '/users/@me/change-password', data),
      deleteAccount: (data: DeleteAccountRequest) =>
        request<{ success: boolean }>('DELETE', '/users/@me', data),
      getMutuals: (id: string, homeUserId?: string) => {
        const params = new URLSearchParams();
        if (homeUserId) params.set('homeUserId', homeUserId);
        const qs = params.toString();
        return request<{ mutualFriends: User[]; mutualSpaces: { id: string; name: string; icon: string | null; avatarColor: string | null }[] }>(
          'GET', `/users/${id}/mutuals${qs ? `?${qs}` : ''}`
        );
      },
      getFederationRegistry: () =>
        request<{ registry: FederationRegistryEntry[]; updatedAt: number }>(
          'GET', '/users/@me/federation-registry'
        ),
      putFederationRegistry: (data: { registry: FederationRegistryEntry[]; updatedAt: number }) =>
        request<{ ok: boolean; updatedAt: number }>(
          'PUT', '/users/@me/federation-registry', data
        ),
      deleteFederationIdentity: (data: FederationIdentityDeleteRequest) =>
        request<FederationIdentityDeleteResponse>(
          'POST', '/users/@me/federation-identity/delete', data
        ),
    };

    this.spaceLayout = {
      update: (data) =>
        request<{ items: SpaceLayoutItem[]; folders: SpaceFolder[]; updatedAt?: number }>('PUT', '/users/@me/space-layout', data),
    };

    this.spaces = {
      list: () => request<Space[]>('GET', '/spaces'),
      get: (id: string) => request<SpaceWithChannelsAndMembers>('GET', `/spaces/${id}`),
      create: (data: CreateSpaceRequest) => request<Space>('POST', '/spaces', data),
      update: (id: string, data: UpdateSpaceRequest) => request<Space>('PATCH', `/spaces/${id}`, data),
      delete: (id: string) => request<{ success: boolean }>('DELETE', `/spaces/${id}`),
      invite: (id: string) => request<{ inviteCode: string }>('POST', `/spaces/${id}/invite`),
      join: (id: string, data: JoinSpaceRequest) => request<Space>('POST', `/spaces/${id}/join`, data),
      joinByCode: (inviteCode: string) => request<Space>('POST', '/spaces/join', { inviteCode }),
      members: (id: string) => request<MemberWithUser[]>('GET', `/spaces/${id}/members`),
      updateMember: (spaceId: string, userId: string, data: UpdateMemberRequest) =>
        request<MemberWithUser>('PATCH', `/spaces/${spaceId}/members/${userId}`, data),
      removeMember: (spaceId: string, userId: string) =>
        request<{ success: boolean }>('DELETE', `/spaces/${spaceId}/members/${userId}`),
      getBans: (spaceId: string) =>
        request<any[]>('GET', `/spaces/${spaceId}/bans`),
      ban: (spaceId: string, userId: string, reason?: string) =>
        request<{ success: boolean }>('POST', `/spaces/${spaceId}/bans`, { userId, reason }),
      unban: (spaceId: string, userId: string) =>
        request<{ success: boolean }>('DELETE', `/spaces/${spaceId}/bans/${userId}`),
      transferOwnership: (spaceId: string, newOwnerId: string) =>
        request<Space>('PATCH', `/spaces/${spaceId}/transfer-ownership`, { newOwnerId }),
      invitePreview: (code: string) =>
        request<InvitePreview>('GET', `/spaces/invite/${encodeURIComponent(code)}/preview`, undefined, false),
    };

    this.channels = {
      list: (spaceId: string) => request<Channel[]>('GET', `/spaces/${spaceId}/channels`),
      create: (spaceId: string, data: CreateChannelRequest) =>
        request<Channel>('POST', `/spaces/${spaceId}/channels`, data),
      update: (id: string, data: UpdateChannelRequest) => request<Channel>('PATCH', `/channels/${id}`, data),
      delete: (id: string) => request<{ success: boolean }>('DELETE', `/channels/${id}`),
      messages: (id: string, before?: string, limit = 50) => {
        const params = new URLSearchParams();
        if (before) params.set('before', before);
        params.set('limit', String(limit));
        return request<MessageWithUser[]>('GET', `/channels/${id}/messages?${params}`);
      },
      messagesAround: (id: string, messageId: string) => {
        const params = new URLSearchParams();
        params.set('messageId', messageId);
        return request<MessageWithUser[]>('GET', `/channels/${id}/messages/around?${params}`);
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
      updateLayout: (spaceId: string, data: { channels: Array<{ id: string; position: number; categoryId: string | null }>; categories: Array<{ id: string; position: number }> }) =>
        request<{ success: boolean }>('PATCH', `/spaces/${spaceId}/channel-layout`, data),
    };

    this.categories = {
      create: (spaceId: string, name: string) =>
        request<ChannelCategory>('POST', `/spaces/${spaceId}/categories`, { name }),
      update: (id: string, data: { name?: string; position?: number }) =>
        request<ChannelCategory>('PATCH', `/categories/${id}`, data),
      delete: (id: string) =>
        request<{ success: boolean }>('DELETE', `/categories/${id}`),
      getOverrides: (categoryId: string) =>
        request<{ categoryId: string; targetType: string; targetId: string; allow: string; deny: string }[]>(
          'GET', `/categories/${categoryId}/overrides`
        ),
      putOverride: (categoryId: string, data: { targetType: string; targetId: string; allow: string; deny: string }) =>
        request<{ success: boolean }>('PUT', `/categories/${categoryId}/overrides`, data),
      deleteOverride: (categoryId: string, targetType: string, targetId: string) =>
        request<{ success: boolean }>('DELETE', `/categories/${categoryId}/overrides/${targetType}/${targetId}`),
    };

    this.messages = {
      update: (id: string, data: UpdateMessageRequest) => request<MessageWithUser>('PATCH', `/messages/${id}`, data),
      delete: (id: string) => request<{ success: boolean }>('DELETE', `/messages/${id}`),
    };

    this.uploads = {
      upload: uploadFile,
      uploadWithProgress: uploadFileWithProgress,
      url: (filename: string) => `${baseUrl}/uploads/${filename}`,
    };

    this.dm = {
      list: () => request<DmChannel[]>('GET', '/dm'),
      create: (data: CreateDmRequest) => request<DmChannel>('POST', '/dm', data),
      createGroup: (data: CreateGroupDmRequest) => request<DmChannel>('POST', '/dm/group', data),
      close: (id: string) => request<{ success: boolean }>('DELETE', `/dm/${id}`),
      messages: (id: string, before?: string, limit = 50) => {
        const params = new URLSearchParams();
        if (before) params.set('before', before);
        params.set('limit', String(limit));
        return request<DmMessageWithUser[]>('GET', `/dm/${id}/messages?${params}`);
      },
      messagesAround: (id: string, messageId: string) => {
        const params = new URLSearchParams();
        params.set('messageId', messageId);
        return request<DmMessageWithUser[]>('GET', `/dm/${id}/messages/around?${params}`);
      },
      sendMessage: (id: string, data: CreateDmMessageRequest) =>
        request<DmMessageWithUser>('POST', `/dm/${id}/messages`, data),
      updateMessage: (id: string, data: UpdateMessageRequest) =>
        request<DmMessageWithUser>('PATCH', `/dm/messages/${id}`, data),
      deleteMessage: (id: string) =>
        request<{ success: boolean }>('DELETE', `/dm/messages/${id}`),
      addMember: (dmChannelId: string, data: AddDmMemberRequest) =>
        request<DmChannel>('POST', `/dm/${dmChannelId}/members`, data),
      leave: (dmChannelId: string) =>
        request<{ success: boolean }>('DELETE', `/dm/${dmChannelId}/members`),
      spaceInvite: (body) =>
        request<SpaceInviteResponse>('POST', '/dm/space-invite', body),
    };

    this.social = {
      friends: () => request<Friend[]>('GET', '/social/friends'),
      requests: () => request<FriendRequest[]>('GET', '/social/requests'),
      sendRequest: (username: string) => request<{ success: boolean; requestId?: string }>('POST', '/social/requests', { username }),
      updateRequest: (id: string, status: 'accepted' | 'declined') =>
        request<{ success: boolean }>('PATCH', `/social/requests/${id}`, { status }),
      removeFriend: (id: string) => request<{ success: boolean }>('DELETE', `/social/friends/${id}`),
      cancelRequest: (id: string) => request<{ success: boolean }>('DELETE', `/social/requests/${id}`),
      search: (q: string) => request<User[]>('GET', `/social/search?q=${encodeURIComponent(q)}`),
      discover: (q?: string, limit = 24, offset = 0) => {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        params.set('limit', String(limit));
        params.set('offset', String(offset));
        return request<{ users: DiscoverUser[]; total: number }>('GET', `/social/discover?${params}`);
      },
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
      getInstance: () => request<InstanceAdminSettings>('GET', '/settings/instance'),
      updateInstance: (data: Partial<InstanceAdminSettings>) =>
        request<InstanceAdminSettings>('PATCH', '/settings/instance', data),
    };

    this.instance = {
      info: () => request<InstanceInfoResponse>('GET', '/instance/info', undefined, false),
    };

    this.roles = {
      create: (spaceId: string, data: { name: string; color?: string; permissions?: string }) =>
        request<Role>('POST', `/spaces/${spaceId}/roles`, data),
      update: (spaceId: string, roleId: string, data: { name?: string; color?: string; position?: number; permissions?: string }) =>
        request<Role>('PATCH', `/spaces/${spaceId}/roles/${roleId}`, data),
      delete: (spaceId: string, roleId: string) =>
        request<{ success: boolean }>('DELETE', `/spaces/${spaceId}/roles/${roleId}`),
    };

    this.search = {
      channel: (channelId: string, params: { q?: string; from?: string; has?: string; before?: string; after?: string; offset?: number; limit?: number }) => {
        const qs = new URLSearchParams();
        if (params.q) qs.set('q', params.q);
        if (params.from) qs.set('from', params.from);
        if (params.has) qs.set('has', params.has);
        if (params.before) qs.set('before', params.before);
        if (params.after) qs.set('after', params.after);
        if (params.offset !== undefined) qs.set('offset', String(params.offset));
        if (params.limit !== undefined) qs.set('limit', String(params.limit));
        return request<{ results: MessageWithUser[]; totalCount: number }>('GET', `/channels/${channelId}/search?${qs}`);
      },
      dm: (dmChannelId: string, params: { q?: string; from?: string; has?: string; before?: string; after?: string; offset?: number; limit?: number }) => {
        const qs = new URLSearchParams();
        if (params.q) qs.set('q', params.q);
        if (params.from) qs.set('from', params.from);
        if (params.has) qs.set('has', params.has);
        if (params.before) qs.set('before', params.before);
        if (params.after) qs.set('after', params.after);
        if (params.offset !== undefined) qs.set('offset', String(params.offset));
        if (params.limit !== undefined) qs.set('limit', String(params.limit));
        return request<{ results: DmMessageWithUser[]; totalCount: number }>('GET', `/dm/${dmChannelId}/search?${qs}`);
      },
    };

    this.explore = {
      list: (q?: string, limit = 50, offset = 0) => {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        params.set('limit', String(limit));
        params.set('offset', String(offset));
        return request<{ spaces: ExploreSpace[]; total: number; totalAll: number; discoveryEnabled: boolean }>(
          'GET', `/spaces/explore?${params}`
        );
      },
      publicJoin: (spaceId: string) =>
        request<SpaceWithChannelsAndMembers>('POST', `/spaces/${spaceId}/public-join`),
      requestJoin: (spaceId: string, message?: string) =>
        request<JoinRequest>('POST', `/spaces/${spaceId}/request-join`, message ? { message } : {}),
      getJoinRequests: (spaceId: string, status?: string) => {
        const params = new URLSearchParams();
        if (status) params.set('status', status);
        return request<{ requests: JoinRequest[] }>('GET', `/spaces/${spaceId}/join-requests?${params}`);
      },
      decideJoinRequest: (spaceId: string, requestId: string, action: 'accept' | 'decline') =>
        request<JoinRequest>('PATCH', `/spaces/${spaceId}/join-requests/${requestId}`, { action }),
      myJoinRequests: (status?: string) => {
        const params = new URLSearchParams();
        if (status) params.set('status', status);
        return request<{ requests: JoinRequest[] }>('GET', `/users/@me/join-requests?${params}`);
      },
    };

    this.gif = {
      trending: (limit = 30, pos?: string) => {
        const params = new URLSearchParams();
        params.set('limit', String(limit));
        if (pos) params.set('pos', pos);
        return request<{ results: GifResult[]; next: string }>('GET', `/gif/trending?${params}`);
      },
      search: (q: string, limit = 30, pos?: string) => {
        const params = new URLSearchParams();
        params.set('q', q);
        params.set('limit', String(limit));
        if (pos) params.set('pos', pos);
        return request<{ results: GifResult[]; next: string }>('GET', `/gif/search?${params}`);
      },
      enabled: () => request<{ enabled: boolean }>('GET', '/gif/enabled'),
    };

    this.federation = {
      initiatePeering: (data: { remoteOrigin: string }) =>
        request<{ peer: FederationPeer }>(
          'POST', '/federation/peer/initiate', data
        ),
      ensurePeered: (data: { remoteOrigin: string }) =>
        request<{ peeringStatus: string; peerId?: string; error?: string }>(
          'POST', '/federation/peer/ensure', data
        ),
      peers: () =>
        request<{ peers: FederationPeer[] }>(
          'GET', '/federation/peers'
        ),
      revokePeer: (id: string) =>
        request<{ success: boolean }>('DELETE', `/federation/peers/${id}`),
      resetPeer: (id: string) =>
        request<{ success: boolean }>('POST', `/federation/peers/${id}/reset`),
      rotatePeerSecret: (id: string) =>
        request<{ success: boolean; gracePeriodMs: number }>('POST', `/federation/peers/${id}/rotate`),
      updatePeer: (id: string, data: { autoRotateIntervalDays: number }) =>
        request<{ peer: FederationPeer }>('PATCH', `/federation/peers/${id}`, data),
      deletePeerPermanently: (id: string) =>
        request<{ success: boolean }>('DELETE', `/federation/peers/${id}/permanent`),
      approvalRequests: () =>
        request<{ requests: ApprovalRequest[] }>(
          'GET', '/federation/approval-requests'
        ),
      approveRequest: (id: string) =>
        request<{ success: boolean; peer?: FederationPeer }>(
          'POST', `/federation/approval-requests/${id}/approve`
        ),
      denyRequest: (id: string) =>
        request<{ success: boolean }>(
          'POST', `/federation/approval-requests/${id}/deny`
        ),
      peeringSubscriptions: () =>
        request<{ subscriptions: PeeringSubscription[] }>(
          'GET', '/federation/peering-subscriptions'
        ),
      cancelPeeringSubscription: (id: string) =>
        request<{ success: boolean }>(
          'DELETE', `/federation/peering-subscriptions/${id}`
        ),
      peeringNotifications: (unreadOnly = false) =>
        request<{ notifications: PeeringNotification[] }>(
          'GET',
          `/federation/peering-notifications${unreadOnly ? '?unread=1' : ''}`,
        ),
      markPeeringNotificationRead: (id: string) =>
        request<{ success: boolean }>(
          'POST', `/federation/peering-notifications/${id}/read`
        ),
      markAllPeeringNotificationsRead: () =>
        request<{ success: boolean; count: number }>(
          'POST', '/federation/peering-notifications/read-all'
        ),
    };

    this.invites = {
      list: (status: 'active' | 'archived' = 'active') =>
        request<{ invites: InviteLinkSummary[] }>('GET', `/admin/invites?status=${status}`),
      create: (body: CreateInviteRequest) =>
        request<InviteLinkSummary>('POST', '/admin/invites', body),
      update: (id: string, body: UpdateInviteRequest) =>
        request<InviteLinkSummary>('PATCH', `/admin/invites/${id}`, body),
      revoke: (id: string) =>
        request<{ invite: InviteLinkSummary }>('POST', `/admin/invites/${id}/revoke`),
      reinstate: (id: string, body: ReinstateInviteRequest) =>
        request<ReinstateInviteResponse>('POST', `/admin/invites/${id}/reinstate`, body),
      delete: (id: string) =>
        request<{ success: boolean }>('DELETE', `/admin/invites/${id}`),
      redemptions: (id: string) =>
        request<{ redemptions: InviteRedemption[] }>('GET', `/admin/invites/${id}/redemptions`),
    };

    this.admin = {
      storageStats: () => request<StorageStats>('GET', '/admin/storage/stats'),
      storageOrphans: () => request<{ orphans: OrphanedFile[] }>('GET', '/admin/storage/orphans'),
      storageCleanup: (dryRun = false) => request<CleanupResult>('POST', '/admin/storage/cleanup', { dryRun }),
      cleanupOldMedia: (maxAgeDays: number, dryRun = false) =>
        request<CleanupResult>('POST', '/admin/storage/cleanup-media', { maxAgeDays, dryRun }),
      listUsers: (params) => {
        const qs = new URLSearchParams();
        if (params?.q) qs.set('q', params.q);
        if (params?.page !== undefined) qs.set('page', String(params.page));
        if (params?.pageSize !== undefined) qs.set('pageSize', String(params.pageSize));
        if (params?.showDeleted) qs.set('showDeleted', 'true');
        if (params?.homeInstance) qs.set('homeInstance', params.homeInstance);
        if (params?.role) qs.set('role', params.role);
        if (params?.joinedAfter) qs.set('joinedAfter', params.joinedAfter);
        if (params?.joinedBefore) qs.set('joinedBefore', params.joinedBefore);
        if (params?.sort) qs.set('sort', params.sort);
        return request<AdminUserListResponse>('GET', `/admin/users?${qs}`);
      },
      listInstances: () => request<{ instances: string[] }>('GET', '/admin/users/instances'),
      setUserRole: (userId, isAdmin) =>
        request<AdminUser>('PATCH', `/admin/users/${userId}/role`, { isAdmin }),
      resetUserPassword: (userId) =>
        request<AdminResetPasswordResponse>('POST', `/admin/users/${userId}/reset-password`),
      deleteUser: (userId) =>
        request<{ success: boolean }>('DELETE', `/admin/users/${userId}`),
    };
  }
}

function handleUnauthorized(): void {
  localStorage.removeItem('backspace_token');
  if (
    !window.location.pathname.startsWith('/login') &&
    !window.location.pathname.startsWith('/register')
  ) {
    window.location.href = '/login';
  }
}

export const api = new BackspaceApiClient(
  '/api',
  () => localStorage.getItem('backspace_token'),
  handleUnauthorized,
);

export function createApiClient(origin: string, getToken: () => string | null, onUnauthorized?: () => void): BackspaceApiClient {
  const baseUrl = origin ? `${origin}/api` : '/api';
  return new BackspaceApiClient(baseUrl, getToken, onUnauthorized);
}

