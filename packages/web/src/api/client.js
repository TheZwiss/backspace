const BASE_URL = '/api';
function getToken() {
    return localStorage.getItem('opencord_token');
}
async function request(method, path, body, requireAuth = true) {
    const headers = {};
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
        throw new Error(error.error || `HTTP ${response.status}`);
    }
    return response.json();
}
async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    const token = getToken();
    const headers = {};
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
        throw new Error(error.error || `HTTP ${response.status}`);
    }
    return response.json();
}
export const api = {
    auth: {
        register: (data) => request('POST', '/auth/register', data, false),
        login: (data) => request('POST', '/auth/login', data, false),
    },
    users: {
        me: () => request('GET', '/users/@me'),
        update: (data) => request('PATCH', '/users/@me', data),
        get: (id) => request('GET', `/users/${id}`),
    },
    servers: {
        list: () => request('GET', '/servers'),
        get: (id) => request('GET', `/servers/${id}`),
        create: (data) => request('POST', '/servers', data),
        update: (id, data) => request('PATCH', `/servers/${id}`, data),
        delete: (id) => request('DELETE', `/servers/${id}`),
        invite: (id) => request('POST', `/servers/${id}/invite`),
        join: (id, data) => request('POST', `/servers/${id}/join`, data),
        joinByCode: (inviteCode) => request('POST', '/servers/join', { inviteCode }),
        members: (id) => request('GET', `/servers/${id}/members`),
        updateMember: (serverId, userId, data) => request('PATCH', `/servers/${serverId}/members/${userId}`, data),
        removeMember: (serverId, userId) => request('DELETE', `/servers/${serverId}/members/${userId}`),
    },
    channels: {
        list: (serverId) => request('GET', `/servers/${serverId}/channels`),
        create: (serverId, data) => request('POST', `/servers/${serverId}/channels`, data),
        update: (id, data) => request('PATCH', `/channels/${id}`, data),
        delete: (id) => request('DELETE', `/channels/${id}`),
        messages: (id, before, limit = 50) => {
            const params = new URLSearchParams();
            if (before)
                params.set('before', before);
            params.set('limit', String(limit));
            return request('GET', `/channels/${id}/messages?${params}`);
        },
        sendMessage: (channelId, data) => request('POST', `/channels/${channelId}/messages`, data),
    },
    messages: {
        update: (id, data) => request('PATCH', `/messages/${id}`, data),
        delete: (id) => request('DELETE', `/messages/${id}`),
    },
    uploads: {
        upload: uploadFile,
        url: (filename) => `${BASE_URL}/uploads/${filename}`,
    },
    dm: {
        list: () => request('GET', '/dm'),
        create: (data) => request('POST', '/dm', data),
        close: (id) => request('DELETE', `/dm/${id}`),
        messages: (id, before, limit = 50) => {
            const params = new URLSearchParams();
            if (before)
                params.set('before', before);
            params.set('limit', String(limit));
            return request('GET', `/dm/${id}/messages?${params}`);
        },
        sendMessage: (id, data) => request('POST', `/dm/${id}/messages`, data),
        updateMessage: (id, data) => request('PATCH', `/dm/messages/${id}`, data),
        deleteMessage: (id) => request('DELETE', `/dm/messages/${id}`),
    },
    social: {
        friends: () => request('GET', '/social/friends'),
        requests: () => request('GET', '/social/requests'),
        sendRequest: (username) => request('POST', '/social/requests', { username }),
        updateRequest: (id, status) => request('PATCH', `/social/requests/${id}`, { status }),
        removeFriend: (id) => request('DELETE', `/social/friends/${id}`),
        cancelRequest: (id) => request('DELETE', `/social/requests/${id}`),
        search: (q) => request('GET', `/social/search?q=${encodeURIComponent(q)}`),
    },
    livekit: {
        token: (channelId) => request('POST', '/livekit/token', { channelId }),
        dmToken: (dmChannelId) => request('POST', '/livekit/token', { dmChannelId }),
    },
};
