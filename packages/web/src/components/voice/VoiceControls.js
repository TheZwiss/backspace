import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useVoiceStore } from '../../stores/voiceStore';
import { useServerStore } from '../../stores/serverStore';
import { getActiveRoom } from '../../hooks/useLiveKit';
import { wsSend } from '../../hooks/useWebSocket';
export function VoiceControls() {
    const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
    const isCameraOn = useVoiceStore((s) => s.isCameraOn);
    const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
    const toggleCamera = useVoiceStore((s) => s.toggleCamera);
    const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare);
    const connectionError = useVoiceStore((s) => s.connectionError);
    const isLiveKitConnected = useVoiceStore((s) => s.isLiveKitConnected);
    const channels = useServerStore((s) => s.channels);
    if (!currentVoiceChannelId)
        return null;
    const channel = channels.find(c => c.id === currentVoiceChannelId);
    const channelName = channel?.name ?? 'Voice Channel';
    const handleCamera = async () => {
        const room = getActiveRoom();
        if (!room) {
            console.warn('[VoiceControls] handleCamera: no active room');
            return;
        }
        try {
            await room.localParticipant.setCameraEnabled(!isCameraOn);
            toggleCamera();
        }
        catch (err) {
            console.error('[VoiceControls] Failed to toggle camera:', err);
        }
    };
    const handleScreenShare = async () => {
        const room = getActiveRoom();
        if (!room) {
            console.warn('[VoiceControls] handleScreenShare: no active room');
            return;
        }
        try {
            await room.localParticipant.setScreenShareEnabled(!isScreenSharing);
            toggleScreenShare();
        }
        catch (err) {
            console.error('[VoiceControls] Failed to toggle screen share:', err);
        }
    };
    const handleDisconnect = () => {
        wsSend({ type: 'voice_leave' });
        useVoiceStore.getState().leaveVoice();
    };
    return (_jsxs("div", { className: "bg-discord-bg-secondary border-t border-discord-bg-tertiary px-2 py-[10px]", children: [_jsxs("div", { className: "flex items-center justify-between mb-1", children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: `text-[13px] font-semibold leading-[18px] ${connectionError ? 'text-discord-red' : isLiveKitConnected ? 'text-discord-green' : 'text-discord-yellow'}`, children: connectionError ? 'Connection Failed' : isLiveKitConnected ? 'Voice Connected' : 'Connecting...' }), _jsx("div", { className: "text-[13px] text-discord-text-muted truncate leading-[18px]", children: connectionError ? connectionError : channelName })] }), _jsx("button", { onClick: handleDisconnect, className: "w-8 h-8 flex items-center justify-center text-discord-text-muted hover:text-discord-text-primary hover:bg-discord-modifier-hover rounded-[4px] transition-colors flex-shrink-0", title: "Disconnect", children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M12 9C10.4 9 8.85 9.25 7.4 9.72V12.82C7.4 13.22 7.17 13.56 6.84 13.72C5.86 14.21 4.97 14.84 4.18 15.57C4 15.75 3.75 15.85 3.48 15.85C3.2 15.85 2.95 15.74 2.77 15.56L0.29 13.08C0.11 12.9 0 12.65 0 12.38C0 12.1 0.11 11.85 0.29 11.67C3.34 8.78 7.46 7 12 7S20.66 8.78 23.71 11.67C23.89 11.85 24 12.1 24 12.38C24 12.65 23.89 12.9 23.71 13.08L21.23 15.56C21.05 15.74 20.8 15.85 20.52 15.85C20.25 15.85 20 15.75 19.82 15.57C19.03 14.84 18.14 14.21 17.16 13.72C16.83 13.56 16.6 13.22 16.6 12.82V9.72C15.15 9.25 13.6 9 12 9Z" }) }) })] }), _jsxs("div", { className: "flex items-center justify-center gap-1", children: [_jsx("button", { onClick: handleCamera, className: `w-8 h-8 flex items-center justify-center rounded-[4px] transition-colors ${isCameraOn ? 'text-discord-green bg-discord-green/10 hover:bg-discord-green/20' : 'text-discord-text-muted hover:text-discord-text-primary hover:bg-discord-modifier-hover'}`, title: isCameraOn ? 'Turn Off Camera' : 'Turn On Camera', children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M17 10.5V7C17 6.45 16.55 6 16 6H4C3.45 6 3 6.45 3 7V17C3 17.55 3.45 18 4 18H16C16.55 18 17 17.55 17 17V13.5L21 17.5V6.5L17 10.5Z" }) }) }), _jsx("button", { onClick: handleScreenShare, className: `w-8 h-8 flex items-center justify-center rounded-[4px] transition-colors ${isScreenSharing ? 'text-discord-green bg-discord-green/10 hover:bg-discord-green/20' : 'text-discord-text-muted hover:text-discord-text-primary hover:bg-discord-modifier-hover'}`, title: isScreenSharing ? 'Stop Sharing' : 'Share Screen', children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M20 18C21.1 18 22 17.1 22 16V6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6V16C2 17.1 2.9 18 4 18H0V20H24V18H20ZM4 6H20V16H4V6Z" }) }) })] })] }));
}
