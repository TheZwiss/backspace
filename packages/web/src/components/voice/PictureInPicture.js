import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
import { Avatar } from '../ui/Avatar';
const PIP_WIDTH = 320;
const PIP_HEIGHT = 180;
const PIP_MARGIN = 16;
const DRAG_THRESHOLD = 5;
function selectPipStream(participants, focusedId, watchingStreams) {
    // Priority 1: Screen share from a user we're watching
    const screenSharer = participants.find(p => p.screenTrack !== null && watchingStreams.has(p.userId));
    if (screenSharer?.screenTrack) {
        return { participant: screenSharer, track: screenSharer.screenTrack, type: 'screen' };
    }
    // Priority 2: Focused participant with camera
    if (focusedId) {
        const focused = participants.find(p => p.identity === focusedId);
        if (focused?.videoTrack) {
            return { participant: focused, track: focused.videoTrack, type: 'camera' };
        }
    }
    // Priority 3: Remote participant with camera
    const remoteWithCamera = participants.find(p => !p.isLocal && p.videoTrack !== null);
    if (remoteWithCamera?.videoTrack) {
        return { participant: remoteWithCamera, track: remoteWithCamera.videoTrack, type: 'camera' };
    }
    // Priority 4: Local participant with camera
    const localWithCamera = participants.find(p => p.isLocal && p.videoTrack !== null);
    if (localWithCamera?.videoTrack) {
        return { participant: localWithCamera, track: localWithCamera.videoTrack, type: 'camera' };
    }
    return null;
}
export function PictureInPicture() {
    const navigate = useNavigate();
    const videoRef = useRef(null);
    const containerRef = useRef(null);
    // Store state
    const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
    const activeDmCall = useVoiceStore((s) => s.activeDmCall);
    const participants = useVoiceStore((s) => s.participants);
    const focusedParticipantId = useVoiceStore((s) => s.focusedParticipantId);
    const watchingStreams = useVoiceStore((s) => s.watchingStreams);
    const currentChannelId = useChatStore((s) => s.currentChannelId);
    const voiceFullscreen = useUIStore((s) => s.voiceFullscreen);
    const pipCollapsed = useUIStore((s) => s.pipCollapsed);
    const setPipCollapsed = useUIStore((s) => s.setPipCollapsed);
    const channelToServerMap = useServerStore((s) => s.channelToServerMap);
    const channels = useServerStore((s) => s.channels);
    // Drag state
    const [position, setPosition] = useState({ x: -1, y: -1 });
    const [isDragging, setIsDragging] = useState(false);
    const dragOffset = useRef({ x: 0, y: 0 });
    const dragStartPos = useRef({ x: 0, y: 0 });
    const hasMoved = useRef(false);
    // Reset pipCollapsed when joining a new call
    const prevVoiceChannel = useRef(currentVoiceChannelId);
    const prevDmCall = useRef(activeDmCall?.dmChannelId ?? null);
    useEffect(() => {
        const voiceChanged = currentVoiceChannelId !== prevVoiceChannel.current;
        const dmChanged = (activeDmCall?.dmChannelId ?? null) !== prevDmCall.current;
        prevVoiceChannel.current = currentVoiceChannelId;
        prevDmCall.current = activeDmCall?.dmChannelId ?? null;
        if ((voiceChanged && currentVoiceChannelId) || (dmChanged && activeDmCall)) {
            setPipCollapsed(false);
        }
    }, [currentVoiceChannelId, activeDmCall, setPipCollapsed]);
    // Visibility
    const isInServerVoice = currentVoiceChannelId !== null && currentChannelId !== currentVoiceChannelId;
    const isInDmCall = activeDmCall !== null && currentChannelId !== activeDmCall.dmChannelId;
    const shouldShow = (isInServerVoice || isInDmCall) && !voiceFullscreen && !pipCollapsed;
    // Stream selection
    const selectedStream = useMemo(() => selectPipStream(participants, focusedParticipantId, watchingStreams), [participants, focusedParticipantId, watchingStreams]);
    // Fallback participant for avatar (most relevant remote, or first participant)
    const fallbackParticipant = useMemo(() => {
        const speaking = participants.find(p => !p.isLocal && p.isSpeaking);
        if (speaking)
            return speaking;
        const remote = participants.find(p => !p.isLocal);
        if (remote)
            return remote;
        return participants[0] ?? null;
    }, [participants]);
    // Channel name for display
    const channelName = useMemo(() => {
        if (currentVoiceChannelId) {
            const ch = channels.find(c => c.id === currentVoiceChannelId);
            return ch?.name ?? 'Voice';
        }
        return 'Call';
    }, [currentVoiceChannelId, channels]);
    // Video track attachment
    // shouldShow in deps ensures re-run when PiP becomes visible (videoRef was null before)
    useEffect(() => {
        const videoEl = videoRef.current;
        if (!videoEl)
            return;
        if (selectedStream?.track) {
            videoEl.srcObject = new MediaStream([selectedStream.track]);
        }
        else {
            videoEl.srcObject = null;
        }
    }, [selectedStream?.track, shouldShow]);
    // Initialize position to bottom-right
    useEffect(() => {
        if (shouldShow && position.x === -1) {
            setPosition({
                x: window.innerWidth - PIP_WIDTH - PIP_MARGIN,
                y: window.innerHeight - PIP_HEIGHT - PIP_MARGIN,
            });
        }
    }, [shouldShow, position.x]);
    // Window resize: keep PiP in bounds
    useEffect(() => {
        if (!shouldShow)
            return;
        const handleResize = () => {
            setPosition(prev => ({
                x: Math.max(PIP_MARGIN, Math.min(window.innerWidth - PIP_WIDTH - PIP_MARGIN, prev.x)),
                y: Math.max(PIP_MARGIN, Math.min(window.innerHeight - PIP_HEIGHT - PIP_MARGIN, prev.y)),
            }));
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [shouldShow]);
    // Snap to nearest horizontal edge
    const snapToEdge = useCallback((currentX, currentY) => {
        const centerX = currentX + PIP_WIDTH / 2;
        const screenMidX = window.innerWidth / 2;
        const targetX = centerX < screenMidX
            ? PIP_MARGIN
            : window.innerWidth - PIP_WIDTH - PIP_MARGIN;
        const clampedY = Math.max(PIP_MARGIN, Math.min(window.innerHeight - PIP_HEIGHT - PIP_MARGIN, currentY));
        setPosition({ x: targetX, y: clampedY });
    }, []);
    // Drag handlers
    const handlePointerDown = useCallback((e) => {
        if (e.target.closest('[data-pip-action]'))
            return;
        setIsDragging(true);
        hasMoved.current = false;
        dragOffset.current = { x: e.clientX - position.x, y: e.clientY - position.y };
        dragStartPos.current = { x: e.clientX, y: e.clientY };
        containerRef.current?.setPointerCapture(e.pointerId);
    }, [position]);
    const handlePointerMove = useCallback((e) => {
        if (!isDragging)
            return;
        const dx = Math.abs(e.clientX - dragStartPos.current.x);
        const dy = Math.abs(e.clientY - dragStartPos.current.y);
        if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
            hasMoved.current = true;
        }
        const newX = Math.max(PIP_MARGIN, Math.min(window.innerWidth - PIP_WIDTH - PIP_MARGIN, e.clientX - dragOffset.current.x));
        const newY = Math.max(PIP_MARGIN, Math.min(window.innerHeight - PIP_HEIGHT - PIP_MARGIN, e.clientY - dragOffset.current.y));
        setPosition({ x: newX, y: newY });
    }, [isDragging]);
    const handlePointerUp = useCallback((e) => {
        if (!isDragging)
            return;
        setIsDragging(false);
        containerRef.current?.releasePointerCapture(e.pointerId);
        if (!hasMoved.current) {
            // Click — navigate back to voice channel
            if (activeDmCall) {
                navigate(`/channels/@me/${activeDmCall.dmChannelId}`);
            }
            else if (currentVoiceChannelId) {
                const serverId = channelToServerMap.get(currentVoiceChannelId);
                if (serverId) {
                    navigate(`/channels/${serverId}/${currentVoiceChannelId}`);
                }
            }
        }
        else {
            // Drag ended — snap to edge
            snapToEdge(position.x, position.y);
        }
    }, [isDragging, activeDmCall, currentVoiceChannelId, channelToServerMap, navigate, snapToEdge, position]);
    const handleClose = useCallback((e) => {
        e.stopPropagation();
        setPipCollapsed(true);
    }, [setPipCollapsed]);
    if (!shouldShow)
        return null;
    const displayParticipant = selectedStream?.participant ?? fallbackParticipant;
    const displayName = displayParticipant
        ? (displayParticipant.isLocal ? `${displayParticipant.username} (You)` : displayParticipant.username)
        : channelName;
    const hasVideo = selectedStream !== null;
    const isScreen = selectedStream?.type === 'screen';
    return (_jsxs("div", { ref: containerRef, className: `fixed z-[40] overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/10 bg-[#080a0b] select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`, style: {
            width: PIP_WIDTH,
            height: PIP_HEIGHT,
            left: position.x,
            top: position.y,
            transition: isDragging ? 'none' : 'left 0.2s ease, top 0.2s ease',
            touchAction: 'none',
        }, onPointerDown: handlePointerDown, onPointerMove: handlePointerMove, onPointerUp: handlePointerUp, children: [hasVideo ? (_jsx("video", { ref: videoRef, autoPlay: true, playsInline: true, muted: true, className: "w-full h-full object-cover", style: { imageRendering: 'auto' } })) : (_jsx("div", { className: "w-full h-full flex items-center justify-center bg-[#1e1f22]", children: displayParticipant ? (_jsxs("div", { className: "relative", children: [_jsx(Avatar, { name: displayParticipant.username, size: 64 }), displayParticipant.isSpeaking && (_jsx("div", { className: "absolute -inset-1 rounded-full ring-2 ring-discord-green animate-pulse" }))] })) : (_jsxs("div", { className: "flex items-center gap-2 text-discord-text-muted", children: [_jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z" }) }), _jsx("span", { className: "text-sm font-medium", children: channelName })] })) })), isScreen && (_jsx("div", { className: "absolute top-2 left-2 px-1.5 py-0.5 bg-discord-red rounded text-[11px] font-bold text-white uppercase tracking-wide", children: "LIVE" })), _jsx("button", { "data-pip-action": "close", onClick: handleClose, className: "absolute top-2 right-2 w-6 h-6 bg-black/60 hover:bg-black/80 rounded-full flex items-center justify-center text-white/80 hover:text-white transition-colors", children: _jsx("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" }) }) }), _jsxs("div", { className: "absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-black/70 to-transparent", children: [_jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: "text-white text-xs font-semibold truncate", children: displayName }), displayParticipant?.isSpeaking && (_jsx("div", { className: "w-2 h-2 rounded-full bg-discord-green flex-shrink-0 animate-pulse" }))] }), _jsx("div", { className: "text-white/50 text-[10px] truncate", children: channelName })] }), _jsx("div", { className: "absolute bottom-2 right-2 w-5 h-5 flex items-center justify-center text-white/40", children: _jsx("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z" }) }) })] }));
}
