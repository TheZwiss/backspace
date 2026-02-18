import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useVoiceStore } from '../../stores/voiceStore';
import { useServerStore } from '../../stores/serverStore';
export function VoiceControls({ onDisconnect, onToggleMic, onToggleCamera, onToggleScreenShare }) {
    const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
    const isMuted = useVoiceStore((s) => s.isMuted);
    const isDeafened = useVoiceStore((s) => s.isDeafened);
    const isCameraOn = useVoiceStore((s) => s.isCameraOn);
    const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
    const toggleMic = useVoiceStore((s) => s.toggleMic);
    const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
    const toggleCamera = useVoiceStore((s) => s.toggleCamera);
    const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare);
    const channels = useServerStore((s) => s.channels);
    if (!currentVoiceChannelId)
        return null;
    const channel = channels.find(c => c.id === currentVoiceChannelId);
    const channelName = channel?.name ?? 'Voice Channel';
    const handleMic = () => {
        toggleMic();
        onToggleMic();
    };
    const handleDeafen = () => {
        toggleDeafen();
    };
    const handleCamera = () => {
        toggleCamera();
        onToggleCamera();
    };
    const handleScreenShare = () => {
        toggleScreenShare();
        onToggleScreenShare();
    };
    return (_jsxs("div", { className: "bg-discord-bg-secondary border-t border-discord-bg-tertiary p-2", children: [_jsx("div", { className: "flex items-center justify-between px-1 mb-2", children: _jsxs("div", { children: [_jsxs("div", { className: "text-xs font-medium text-discord-green flex items-center gap-1", children: [_jsx("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" }) }), "Voice Connected"] }), _jsx("div", { className: "text-xs text-discord-text-muted truncate", children: channelName })] }) }), _jsxs("div", { className: "flex items-center justify-center gap-2", children: [_jsx("button", { onClick: handleMic, className: `p-2 rounded-full transition-colors ${isMuted
                            ? 'bg-discord-red/20 text-discord-red hover:bg-discord-red/30'
                            : 'bg-discord-bg-tertiary text-discord-text-secondary hover:bg-discord-bg-hover hover:text-discord-text-primary'}`, title: isMuted ? 'Unmute' : 'Mute', children: isMuted ? (_jsxs("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: [_jsx("path", { d: "M12 2C10.9 2 10 2.9 10 4V12C10 13.1 10.9 14 12 14C13.1 14 14 13.1 14 12V4C14 2.9 13.1 2 12 2Z" }), _jsx("path", { d: "M2.1 2.1L1.4 2.8L7.6 9L7 12C7 14.8 9.2 17 12 17C12.9 17 13.7 16.7 14.4 16.3L16.2 18.1C15 18.9 13.6 19.4 12 19.5V22H14V24H10V22H12V19.5C8.4 19.1 5.6 16.1 5 12.5H7C7.5 14.8 9.5 16.5 12 16.5C12.5 16.5 13 16.4 13.5 16.2L14.7 17.4C13.9 17.8 13 18 12 18C8.7 18 6 15.3 6 12H4C4 15.7 7 18.8 11 19.4V22H10V24H14V22H13V19.4C14 19.3 14.9 18.9 15.7 18.4L21.9 24.6L22.6 23.9L2.1 2.1Z" })] })) : (_jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M12 2C10.9 2 10 2.9 10 4V12C10 13.1 10.9 14 12 14C13.1 14 14 13.1 14 12V4C14 2.9 13.1 2 12 2ZM17 12C17 14.76 14.76 17 12 17S7 14.76 7 12H5C5 15.53 7.61 18.43 11 18.92V22H13V18.92C16.39 18.43 19 15.53 19 12H17Z" }) })) }), _jsx("button", { onClick: handleDeafen, className: `p-2 rounded-full transition-colors ${isDeafened
                            ? 'bg-discord-red/20 text-discord-red hover:bg-discord-red/30'
                            : 'bg-discord-bg-tertiary text-discord-text-secondary hover:bg-discord-bg-hover hover:text-discord-text-primary'}`, title: isDeafened ? 'Undeafen' : 'Deafen', children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M12 2C6.48 2 2 6.48 2 12V20C2 21.1 2.9 22 4 22H8V12H4.04C4.28 7.57 7.77 4 12 4S19.72 7.57 19.96 12H16V22H20C21.1 22 22 21.1 22 20V12C22 6.48 17.52 2 12 2Z" }) }) }), _jsx("button", { onClick: handleCamera, className: `p-2 rounded-full transition-colors ${isCameraOn
                            ? 'bg-discord-green/20 text-discord-green hover:bg-discord-green/30'
                            : 'bg-discord-bg-tertiary text-discord-text-secondary hover:bg-discord-bg-hover hover:text-discord-text-primary'}`, title: isCameraOn ? 'Turn Off Camera' : 'Turn On Camera', children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M17 10.5V7C17 6.45 16.55 6 16 6H4C3.45 6 3 6.45 3 7V17C3 17.55 3.45 18 4 18H16C16.55 18 17 17.55 17 17V13.5L21 17.5V6.5L17 10.5Z" }) }) }), _jsx("button", { onClick: handleScreenShare, className: `p-2 rounded-full transition-colors ${isScreenSharing
                            ? 'bg-discord-green/20 text-discord-green hover:bg-discord-green/30'
                            : 'bg-discord-bg-tertiary text-discord-text-secondary hover:bg-discord-bg-hover hover:text-discord-text-primary'}`, title: isScreenSharing ? 'Stop Sharing' : 'Share Screen', children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M20 18C21.1 18 22 17.1 22 16V6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6V16C2 17.1 2.9 18 4 18H0V20H24V18H20ZM4 6H20V16H4V6Z" }) }) }), _jsx("button", { onClick: onDisconnect, className: "p-2 rounded-full bg-discord-red/20 text-discord-red hover:bg-discord-red/30 transition-colors", title: "Disconnect", children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M12 9C10.4 9 8.85 9.25 7.4 9.72V12.82C7.4 13.22 7.17 13.56 6.84 13.72C5.86 14.21 4.97 14.84 4.18 15.57C4 15.75 3.75 15.85 3.48 15.85C3.2 15.85 2.95 15.74 2.77 15.56L0.29 13.08C0.11 12.9 0 12.65 0 12.38C0 12.1 0.11 11.85 0.29 11.67C3.34 8.78 7.46 7 12 7S20.66 8.78 23.71 11.67C23.89 11.85 24 12.1 24 12.38C24 12.65 23.89 12.9 23.71 13.08L21.23 15.56C21.05 15.74 20.8 15.85 20.52 15.85C20.25 15.85 20 15.75 19.82 15.57C19.03 14.84 18.14 14.21 17.16 13.72C16.83 13.56 16.6 13.22 16.6 12.82V9.72C15.15 9.25 13.6 9 12 9Z" }) }) })] })] }));
}
