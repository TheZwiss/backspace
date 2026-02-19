import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { MessageList } from '../chat/MessageList';
import { MessageInput } from '../chat/MessageInput';
import { TypingIndicator } from '../chat/TypingIndicator';
import { useUIStore } from '../../stores/uiStore';
export function VoiceChatPanel({ channelId, channelName }) {
    const toggleVoiceChat = useUIStore((s) => s.toggleVoiceChat);
    return (_jsxs("div", { className: "w-[340px] flex-shrink-0 bg-discord-bg-primary flex flex-col border-l border-[#2b2d31]", children: [_jsxs("div", { className: "h-12 px-4 flex items-center justify-between shadow-header flex-shrink-0", children: [_jsx("span", { className: "font-bold text-discord-text-primary text-[16px]", children: "Chat" }), _jsx("button", { onClick: toggleVoiceChat, className: "w-7 h-7 flex items-center justify-center text-discord-text-muted hover:text-discord-text-primary transition-colors rounded", title: "Close Chat", children: _jsx("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" }) }) })] }), _jsx(MessageList, { channelId: channelId }), _jsx(TypingIndicator, { channelId: channelId }), _jsx(MessageInput, { channelId: channelId, channelName: channelName })] }));
}
