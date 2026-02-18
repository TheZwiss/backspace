import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { MessageList } from '../chat/MessageList';
import { MessageInput } from '../chat/MessageInput';
import { TypingIndicator } from '../chat/TypingIndicator';
import { VoiceGrid } from '../voice/VoiceGrid';
import { FriendsPage } from '../chat/FriendsPage';
import { Avatar } from '../ui/Avatar';
import { useVoiceStore } from '../../stores/voiceStore';
import { wsSend } from '../../hooks/useWebSocket';
export function MainContent() {
    const channels = useServerStore((s) => s.channels);
    const currentChannelId = useChatStore((s) => s.currentChannelId);
    const currentServerId = useServerStore((s) => s.currentServerId);
    const toggleMemberList = useUIStore((s) => s.toggleMemberList);
    const memberListOpen = useUIStore((s) => s.memberListOpen);
    const participants = useVoiceStore((s) => s.participants);
    const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
    const showDms = useUIStore((s) => s.showDms);
    const dmChannels = useServerStore((s) => s.dmChannels);
    const authUser = useAuthStore((s) => s.user);
    const channel = channels.find(c => c.id === currentChannelId);
    const isVoiceChannel = channel?.type === 'voice' || channel?.type === 'video';
    // DM view or no server selected
    if (showDms || !currentServerId) {
        if (!currentChannelId) {
            return _jsx(FriendsPage, {});
        }
        const dmChannel = dmChannels.find(dm => dm.id === currentChannelId);
        const otherUser = dmChannel?.members.find(m => m.id !== authUser?.id);
        const dmName = otherUser?.displayName ?? otherUser?.username ?? 'Direct Message';
        const dmStatus = otherUser?.status;
        return (_jsxs("div", { className: "flex-1 flex flex-col bg-discord-bg-primary min-w-0 relative", children: [_jsx("div", { className: "h-12 px-4 flex items-center shadow-header flex-shrink-0 z-10", children: _jsxs("div", { className: "flex items-center gap-2 min-w-0", children: [_jsx("span", { className: "text-discord-text-muted font-bold text-lg", children: "@" }), otherUser && _jsx(Avatar, { src: otherUser.avatar, name: dmName, size: 24, status: dmStatus }), _jsx("span", { className: "font-bold text-discord-text-primary truncate", children: dmName }), otherUser?.status && otherUser.status !== 'offline' && _jsx("span", { className: "text-xs text-discord-text-muted capitalize", children: otherUser.status })] }) }), _jsx(MessageList, { channelId: currentChannelId }), _jsx(TypingIndicator, { channelId: currentChannelId }), _jsx(MessageInput, { channelId: currentChannelId, channelName: `@${dmName}` })] }));
    }
    // No channel selected
    if (!currentChannelId || !channel) {
        return (_jsxs("div", { className: "flex-1 flex flex-col bg-discord-bg-primary", children: [_jsx("div", { className: "h-12 px-4 flex items-center shadow-header", children: _jsx("span", { className: "text-discord-text-muted", children: "Select a channel" }) }), _jsx("div", { className: "flex-1 flex items-center justify-center text-discord-text-muted", children: _jsx("p", { children: "Select a text or voice channel to get started" }) })] }));
    }
    // Voice/Video channel view
    if (isVoiceChannel) {
        const isInThisChannel = currentVoiceChannelId === currentChannelId;
        const isMuted = useVoiceStore.getState().isMuted;
        const isCameraOn = useVoiceStore.getState().isCameraOn;
        const isScreenSharing = useVoiceStore.getState().isScreenSharing;
        return (_jsxs("div", { className: "flex-1 flex flex-col bg-discord-bg-primary", children: [_jsx("div", { className: "h-12 px-4 flex items-center justify-between shadow-header", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", className: "text-discord-text-muted", children: _jsx("path", { d: "M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z" }) }), _jsx("span", { className: "font-bold text-discord-text-primary", children: channel.name }), isInThisChannel && (_jsx("span", { className: "text-xs text-discord-green font-medium ml-2", children: "Connected" }))] }) }), isInThisChannel ? (_jsx(VoiceGrid, { participants: participants })) : (_jsxs("div", { className: "flex-1 flex flex-col items-center justify-center gap-6", children: [_jsxs("div", { className: "text-center", children: [_jsx("svg", { width: "80", height: "80", viewBox: "0 0 24 24", fill: "currentColor", className: "text-discord-text-muted mx-auto mb-4 opacity-40", children: _jsx("path", { d: "M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46ZM19.07 4.93C20.91 6.77 22 9.28 22 12C22 14.72 20.91 17.23 19.07 19.07L17.66 17.66C19.11 16.21 20 14.21 20 12C20 9.79 19.11 7.79 17.66 6.34L19.07 4.93Z" }) }), _jsx("h2", { className: "text-[24px] font-bold text-discord-text-header mb-2", children: channel.name }), _jsx("p", { className: "text-discord-text-muted text-[14px]", children: "No one is currently in this voice channel." })] }), _jsx("button", { onClick: () => {
                                useVoiceStore.getState().setCurrentVoiceChannel(currentChannelId);
                                wsSend({ type: 'voice_join', channelId: currentChannelId });
                            }, className: "px-8 py-3 bg-discord-green hover:bg-discord-green/80 text-white font-medium rounded-[3px] transition-colors text-[14px]", children: "Join Voice" })] }))] }));
    }
    // Text channel view
    return (_jsxs("div", { className: "flex-1 flex flex-col bg-discord-bg-primary min-w-0 relative", children: [_jsxs("div", { className: "h-12 px-4 flex items-center justify-between shadow-header flex-shrink-0 z-10 bg-discord-bg-primary", children: [_jsxs("div", { className: "flex items-center gap-2 min-w-0", children: [_jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", className: "text-discord-text-muted flex-shrink-0", children: _jsx("path", { d: "M5.88657 21C5.57547 21 5.3399 20.7189 5.39427 20.4126L6.00001 17H2.59511C2.28449 17 2.04905 16.7198 2.10259 16.4138L2.27759 15.4138C2.31946 15.1746 2.52722 15 2.77011 15H6.35001L7.41001 9H4.00511C3.69449 9 3.45905 8.71977 3.51259 8.41381L3.68759 7.41381C3.72946 7.17456 3.93722 7 4.18011 7H7.76001L8.39677 3.41262C8.43914 3.17391 8.64664 3 8.88907 3H9.87344C10.1845 3 10.4201 3.28107 10.3657 3.58738L9.76001 7H15.76L16.3968 3.41262C16.4391 3.17391 16.6466 3 16.8891 3H17.8734C18.1845 3 18.4201 3.28107 18.3657 3.58738L17.76 7H21.1649C21.4755 7 21.711 7.28023 21.6574 7.58619L21.4824 8.58619C21.4406 8.82544 21.2328 9 20.9899 9H17.41L16.35 15H19.7549C20.0655 15 20.301 15.2802 20.2474 15.5862L20.0724 16.5862C20.0306 16.8254 19.8228 17 19.5799 17H16L15.3632 20.5874C15.3209 20.8261 15.1134 21 14.8709 21H13.8866C13.5755 21 13.3399 20.7189 13.3943 20.4126L14 17H8.00001L7.36325 20.5874C7.32088 20.8261 7.11337 21 6.87094 21H5.88657ZM9.41001 9L8.35001 15H14.35L15.41 9H9.41001Z" }) }), _jsx("span", { className: "font-bold text-discord-text-primary truncate leading-tight", children: channel.name }), channel.topic && (_jsxs(_Fragment, { children: [_jsx("div", { className: "w-[1px] h-6 bg-discord-bg-accent mx-2" }), _jsx("span", { className: "text-xs text-discord-text-muted truncate leading-tight", children: channel.topic })] }))] }), _jsx("div", { className: "flex items-center gap-4 flex-shrink-0", children: _jsx("button", { onClick: toggleMemberList, className: `p-1 transition-colors ${memberListOpen ? 'text-discord-text-primary' : 'text-discord-text-muted hover:text-discord-text-secondary'}`, title: "Toggle Member List", children: _jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M14 8.00598C14 10.211 12.206 12.006 10 12.006C7.795 12.006 6 10.211 6 8.00598C6 5.80098 7.794 4.00598 10 4.00598C12.206 4.00598 14 5.80098 14 8.00598ZM2 19.006C2 15.473 5.29 13.006 10 13.006C14.711 13.006 18 15.473 18 19.006V20.006H2V19.006ZM20 20.006H22V19.006C22 16.451 20.178 14.471 17.532 13.471C19.461 14.601 20 16.561 20 19.006V20.006Z" }) }) }) })] }), _jsx(MessageList, { channelId: currentChannelId }), _jsx(TypingIndicator, { channelId: currentChannelId }), _jsx(MessageInput, { channelId: currentChannelId, channelName: channel.name })] }));
}
