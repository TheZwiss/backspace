import { useEffect, useRef } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';
import { useChatStore } from '../stores/chatStore';
import { useVoiceStore } from '../stores/voiceStore';
let globalWs = null;
let reconnectAttempts = 0;
let reconnectTimer;
let currentToken = null;
let isInitialized = false;
function handleEvent(event) {
    const { setUser } = useAuthStore.getState();
    const { populateFromReady, loadServerDetail, currentServerId, updateMemberPresence, addMember, removeMember } = useServerStore.getState();
    const { addMessage, updateMessage, removeMessage, setTyping, onReactionAdded, onReactionRemoved } = useChatStore.getState();
    const { addVoiceUser, removeVoiceUser } = useVoiceStore.getState();
    switch (event.type) {
        case 'ready':
            setUser(event.user);
            populateFromReady(event.servers, event.folders, event.dmChannels);
            if (currentServerId) {
                loadServerDetail(currentServerId);
            }
            break;
        case 'message_created':
            addMessage(event.message.channelId, event.message);
            break;
        case 'message_updated':
            updateMessage(event.message);
            break;
        case 'message_deleted':
            removeMessage(event.messageId, event.channelId);
            break;
        case 'typing':
            setTyping(event.channelId, event.userId, event.username);
            break;
        case 'presence_update':
            updateMemberPresence(event.userId, event.status);
            break;
        case 'voice_state_update':
            if (event.action === 'join') {
                addVoiceUser(event.channelId, event.userId);
            }
            else {
                removeVoiceUser(event.channelId, event.userId);
            }
            break;
        case 'member_joined':
            addMember(event.member);
            break;
        case 'member_left':
            removeMember(event.userId);
            break;
        case 'dm_message_created':
            addMessage(event.message.dmChannelId, event.message);
            break;
        case 'reaction_added':
            onReactionAdded(event.messageId, event.reaction);
            break;
        case 'reaction_removed':
            onReactionRemoved(event.messageId, event.userId, event.emoji);
            break;
        case 'error':
            console.error('WebSocket error:', event.message);
            break;
    }
}
function connect() {
    if (!currentToken)
        return;
    if (globalWs && (globalWs.readyState === WebSocket.OPEN || globalWs.readyState === WebSocket.CONNECTING)) {
        return;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    globalWs = ws;
    ws.onopen = () => {
        reconnectAttempts = 0;
        ws.send(JSON.stringify({ type: 'auth', token: currentToken }));
    };
    ws.onmessage = (e) => {
        try {
            const event = JSON.parse(e.data);
            handleEvent(event);
        }
        catch {
            console.error('Failed to parse WebSocket message');
        }
    };
    ws.onclose = () => {
        globalWs = null;
        if (currentToken) {
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
            reconnectAttempts++;
            reconnectTimer = setTimeout(connect, delay);
        }
    };
    ws.onerror = () => {
        ws.close();
    };
}
function disconnect() {
    currentToken = null;
    isInitialized = false;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
    }
    if (globalWs) {
        globalWs.close();
        globalWs = null;
    }
}
/** Send an event over the WebSocket. Can be used outside of React components. */
export function wsSend(event) {
    if (globalWs && globalWs.readyState === WebSocket.OPEN) {
        globalWs.send(JSON.stringify(event));
    }
}
/**
 * Hook to initialize the WebSocket connection. Should only be called ONCE
 * from the top-level layout component (AppLayout). Other components should
 * use the exported `wsSend` function directly.
 */
export function useWebSocket() {
    const token = useAuthStore((s) => s.token);
    const prevToken = useRef(token);
    useEffect(() => {
        if (token && (!isInitialized || token !== prevToken.current)) {
            currentToken = token;
            isInitialized = true;
            connect();
        }
        else if (!token && isInitialized) {
            disconnect();
        }
        prevToken.current = token;
    }, [token]);
    useEffect(() => {
        return () => {
            disconnect();
        };
    }, []);
    return { send: wsSend };
}
