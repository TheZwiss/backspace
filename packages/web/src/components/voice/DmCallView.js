import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { getActiveRoom } from '../../hooks/useLiveKit';
import { wsSend } from '../../hooks/useWebSocket';
import { VideoPreset } from 'livekit-client';
const QUALITY_MAP = {
    '1080p60': new VideoPreset(1920, 1080, 15_000_000, 60),
    '1080p': new VideoPreset(1920, 1080, 8_000_000, 30),
    '720p60': new VideoPreset(1280, 720, 8_000_000, 60),
    '720p': new VideoPreset(1280, 720, 5_000_000, 30),
    '540p': new VideoPreset(960, 540, 2_000_000, 30),
    '360p': new VideoPreset(640, 360, 1_000_000, 30),
};
export function DmCallView() {
    const activeDmCall = useVoiceStore((s) => s.activeDmCall);
    const participants = useVoiceStore((s) => s.participants);
    const isMuted = useVoiceStore((s) => s.isMuted);
    const isDeafened = useVoiceStore((s) => s.isDeafened);
    const isCameraOn = useVoiceStore((s) => s.isCameraOn);
    const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
    const toggleMic = useVoiceStore((s) => s.toggleMic);
    const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
    const toggleCamera = useVoiceStore((s) => s.toggleCamera);
    const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare);
    const setActiveDmCall = useVoiceStore((s) => s.setActiveDmCall);
    const leaveVoice = useVoiceStore((s) => s.leaveVoice);
    const dmChannels = useServerStore((s) => s.dmChannels);
    const authUser = useAuthStore((s) => s.user);
    const dmChannel = dmChannels.find(dm => dm.id === activeDmCall?.dmChannelId);
    const otherUser = dmChannel?.members.find(m => m.id !== authUser?.id);
    const otherName = otherUser?.displayName ?? otherUser?.username ?? 'User';
    const handleMute = () => {
        const room = getActiveRoom();
        if (room) {
            room.localParticipant.setMicrophoneEnabled(isMuted);
        }
        toggleMic();
    };
    const handleDeafen = () => {
        const room = getActiveRoom();
        if (room) {
            const newDeafened = !isDeafened;
            room.remoteParticipants.forEach((p) => {
                p.audioTrackPublications.forEach((pub) => {
                    if (pub.track) {
                        pub.track.setVolume?.(newDeafened ? 0 : 1);
                    }
                });
            });
            if (newDeafened) {
                room.localParticipant.setMicrophoneEnabled(false);
            }
            else if (!isMuted) {
                room.localParticipant.setMicrophoneEnabled(true);
            }
        }
        toggleDeafen();
    };
    const handleCamera = async () => {
        const room = getActiveRoom();
        if (room) {
            const willEnable = !isCameraOn;
            if (willEnable) {
                const videoQuality = useVoiceStore.getState().videoQuality;
                const preset = QUALITY_MAP[videoQuality];
                if (preset) {
                    await room.localParticipant.setCameraEnabled(true, { resolution: preset.resolution }, {
                        videoEncoding: preset.encoding,
                        simulcast: videoQuality === '1080p' || videoQuality === '720p'
                    });
                }
                else {
                    await room.localParticipant.setCameraEnabled(true);
                }
            }
            else {
                await room.localParticipant.setCameraEnabled(false);
            }
        }
        toggleCamera();
    };
    const handleScreenShare = () => {
        const room = getActiveRoom();
        if (room) {
            room.localParticipant.setScreenShareEnabled(!isScreenSharing);
        }
        toggleScreenShare();
    };
    const handleEndCall = () => {
        if (activeDmCall) {
            wsSend({ type: 'dm_call_end', dmChannelId: activeDmCall.dmChannelId });
        }
        setActiveDmCall(null);
        leaveVoice();
    };
    // Attach video elements
    useEffect(() => {
        participants.forEach((p) => {
            if (p.videoTrack) {
                const el = document.getElementById(`dm-video-${p.userId}`);
                if (el && el.srcObject?.getVideoTracks()[0]?.id !== p.videoTrack.id) {
                    el.srcObject = new MediaStream([p.videoTrack]);
                }
            }
        });
    }, [participants]);
    if (!activeDmCall)
        return null;
    const localParticipant = participants.find(p => p.isLocal);
    const remoteParticipant = participants.find(p => !p.isLocal);
    return (_jsxs("div", { className: "flex-1 flex flex-col bg-[#111214] min-w-0", children: [_jsx("div", { className: "h-12 px-4 flex items-center justify-between shadow-header flex-shrink-0 bg-[#111214]", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", className: "text-discord-green", children: _jsx("path", { d: "M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" }) }), _jsx("span", { className: "font-bold text-discord-text-primary", children: otherName }), _jsx("span", { className: "text-xs text-discord-green font-medium ml-2", children: "In Call" })] }) }), _jsxs("div", { className: "flex-1 flex items-center justify-center gap-8 p-8", children: [_jsxs("div", { className: "flex flex-col items-center gap-4", children: [remoteParticipant?.videoTrack ? (_jsxs("div", { className: "w-[360px] h-[270px] rounded-xl overflow-hidden bg-[#2b2d31] relative", children: [_jsx("video", { id: `dm-video-${remoteParticipant.userId}`, autoPlay: true, playsInline: true, muted: false, className: "w-full h-full object-cover" }), _jsx("div", { className: "absolute bottom-2 left-2 px-2 py-1 bg-black/60 rounded text-xs text-white", children: otherName })] })) : (_jsxs("div", { className: "w-[200px] h-[200px] rounded-full bg-[#2b2d31] flex items-center justify-center relative", children: [_jsx("div", { className: "w-24 h-24 rounded-full bg-discord-blurple flex items-center justify-center text-white text-4xl font-bold", children: otherName.charAt(0).toUpperCase() }), remoteParticipant?.isSpeaking && (_jsx("div", { className: "absolute inset-0 rounded-full ring-[3px] ring-discord-green" }))] })), _jsx("span", { className: "text-discord-text-secondary text-sm font-medium", children: remoteParticipant ? otherName : 'Connecting...' }), remoteParticipant?.isMuted && (_jsxs("span", { className: "text-discord-text-muted text-xs flex items-center gap-1", children: [_jsx("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" }) }), "Muted"] }))] }), _jsxs("div", { className: "flex flex-col items-center gap-4", children: [localParticipant?.videoTrack ? (_jsxs("div", { className: "w-[360px] h-[270px] rounded-xl overflow-hidden bg-[#2b2d31] relative", children: [_jsx("video", { id: `dm-video-${localParticipant.userId}`, autoPlay: true, playsInline: true, muted: true, className: "w-full h-full object-cover mirror", style: { transform: 'scaleX(-1)' } }), _jsx("div", { className: "absolute bottom-2 left-2 px-2 py-1 bg-black/60 rounded text-xs text-white", children: "You" })] })) : (_jsxs("div", { className: "w-[200px] h-[200px] rounded-full bg-[#2b2d31] flex items-center justify-center relative", children: [_jsx("div", { className: "w-24 h-24 rounded-full bg-discord-blurple flex items-center justify-center text-white text-4xl font-bold", children: (authUser?.displayName ?? authUser?.username ?? 'Y').charAt(0).toUpperCase() }), localParticipant?.isSpeaking && (_jsx("div", { className: "absolute inset-0 rounded-full ring-[3px] ring-discord-green" }))] })), _jsxs("span", { className: "text-discord-text-secondary text-sm font-medium", children: [authUser?.displayName ?? authUser?.username ?? 'You', " (You)"] })] })] }), _jsxs("div", { className: "h-[72px] bg-[#1e1f22] flex items-center justify-center gap-4 px-4 flex-shrink-0", children: [_jsx("button", { onClick: handleMute, className: `w-12 h-12 rounded-full flex items-center justify-center transition-colors ${isMuted ? 'bg-discord-red/20 text-discord-red hover:bg-discord-red/30' : 'bg-[#2b2d31] text-discord-text-primary hover:bg-[#36373d]'}`, title: isMuted ? 'Unmute' : 'Mute', children: isMuted ? (_jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" }) })) : (_jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" }) })) }), _jsx("button", { onClick: handleDeafen, className: `w-12 h-12 rounded-full flex items-center justify-center transition-colors ${isDeafened ? 'bg-discord-red/20 text-discord-red hover:bg-discord-red/30' : 'bg-[#2b2d31] text-discord-text-primary hover:bg-[#36373d]'}`, title: isDeafened ? 'Undeafen' : 'Deafen', children: isDeafened ? (_jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M3.63 3.63a.996.996 0 000 1.41L7.29 8.7 7 9H4c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1h3l3.29 3.29c.63.63 1.71.18 1.71-.71v-4.17l4.18 4.18c-.49.37-1.02.68-1.6.91-.36.15-.58.53-.58.92 0 .72.73 1.18 1.39.91.8-.33 1.55-.77 2.22-1.31l1.34 1.34a.996.996 0 101.41-1.41L5.05 3.63c-.39-.39-1.02-.39-1.42 0zM19 12c0 .82-.15 1.61-.41 2.34l1.53 1.53c.56-1.17.88-2.48.88-3.87 0-3.83-2.4-7.11-5.78-8.4-.59-.23-1.22.23-1.22.86v.19c0 .38.25.71.61.85C17.18 6.54 19 9.06 19 12zm-8.71-6.29l-.17.17L12 7.76V6.41c0-.89-1.08-1.33-1.71-.7zM16.5 12A4.5 4.5 0 0014 7.97v1.79l2.48 2.48c.01-.08.02-.16.02-.24z" }) })) : (_jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" }) })) }), _jsx("button", { onClick: handleCamera, className: `w-12 h-12 rounded-full flex items-center justify-center transition-colors ${isCameraOn ? 'bg-discord-blurple/20 text-discord-blurple hover:bg-discord-blurple/30' : 'bg-[#2b2d31] text-discord-text-primary hover:bg-[#36373d]'}`, title: isCameraOn ? 'Turn Off Camera' : 'Turn On Camera', children: isCameraOn ? (_jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" }) })) : (_jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z" }) })) }), _jsx("button", { onClick: handleScreenShare, className: `w-12 h-12 rounded-full flex items-center justify-center transition-colors ${isScreenSharing ? 'bg-discord-blurple/20 text-discord-blurple hover:bg-discord-blurple/30' : 'bg-[#2b2d31] text-discord-text-primary hover:bg-[#36373d]'}`, title: isScreenSharing ? 'Stop Sharing' : 'Share Screen', children: _jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z" }) }) }), _jsx("div", { className: "w-[1px] h-8 bg-[#3f4147] mx-2" }), _jsx("button", { onClick: handleEndCall, className: "w-12 h-12 rounded-full bg-discord-red hover:bg-discord-red/80 flex items-center justify-center transition-colors text-white", title: "End Call", children: _jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" }) }) })] })] }));
}
