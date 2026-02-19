import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { VoiceChannel } from '../voice/VoiceChannel';
import { VoiceControls } from '../voice/VoiceControls';
import { useVoiceStore } from '../../stores/voiceStore';
import { Avatar } from '../ui/Avatar';
import { wsSend } from '../../hooks/useWebSocket';
import { getActiveRoom } from '../../hooks/useLiveKit';
export function ChannelSidebar() {
    const servers = useServerStore((s) => s.servers);
    const currentServerId = useServerStore((s) => s.currentServerId);
    const channels = useServerStore((s) => s.channels);
    const dmChannels = useServerStore((s) => s.dmChannels);
    const currentChannelId = useChatStore((s) => s.currentChannelId);
    const setCurrentChannel = useChatStore((s) => s.setCurrentChannel);
    const unreadChannels = useChatStore((s) => s.unreadChannels);
    const openModal = useUIStore((s) => s.openModal);
    const user = useAuthStore((s) => s.user);
    const members = useServerStore((s) => s.members);
    const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
    const setCurrentVoiceChannel = useVoiceStore((s) => s.setCurrentVoiceChannel);
    const isMuted = useVoiceStore((s) => s.isMuted);
    const isDeafened = useVoiceStore((s) => s.isDeafened);
    const toggleMic = useVoiceStore((s) => s.toggleMic);
    const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
    const navigate = useNavigate();
    const handleMicToggle = async () => {
        const room = getActiveRoom();
        if (room) {
            try {
                await room.localParticipant.setMicrophoneEnabled(isMuted);
            }
            catch (err) {
                console.error('[ChannelSidebar] Failed to toggle mic:', err);
            }
        }
        toggleMic();
    };
    const handleDeafenToggle = () => {
        toggleDeafen();
    };
    const server = servers.find(s => s.id === currentServerId);
    const currentMember = members.find(m => m.userId === user?.id);
    const isAdminUser = currentMember?.role === 'admin' || currentMember?.role === 'owner';
    const textChannels = channels.filter(c => c.type === 'text');
    const voiceChannels = channels.filter(c => c.type === 'voice' || c.type === 'video');
    const handleChannelClick = (channelId) => {
        setCurrentChannel(channelId);
        navigate(`/channels/${currentServerId || '@me'}/${channelId}`);
    };
    const handleHomeClick = () => {
        setCurrentChannel(null);
        navigate('/channels/@me');
    };
    const handleVoiceJoin = (channelId) => {
        // Don't re-join the same channel — prevents duplicate LiveKit connections
        if (currentVoiceChannelId === channelId) {
            navigate(`/channels/${currentServerId}/${channelId}`);
            return;
        }
        setCurrentVoiceChannel(channelId);
        wsSend({ type: 'voice_join', channelId });
        navigate(`/channels/${currentServerId}/${channelId}`);
    };
    if (!server) {
        return (_jsxs("div", { className: "w-60 bg-discord-bg-secondary flex flex-col flex-shrink-0 select-none", children: [_jsx("div", { className: "h-12 px-[10px] flex items-center shadow-header z-10", children: _jsx("button", { className: "flex-1 bg-discord-bg-tertiary text-discord-text-muted text-[13px] font-medium py-[5px] px-2 rounded-[4px] text-left hover:bg-discord-bg-tertiary/80 transition-colors", children: "Find or start a conversation" }) }), _jsxs("div", { className: "flex-1 overflow-y-auto pt-4 px-2 no-scrollbar", children: [_jsxs("div", { onClick: handleHomeClick, className: `flex items-center gap-3 px-2 h-[42px] rounded-[4px] cursor-pointer mb-[2px] transition-colors group ${!currentChannelId
                                ? 'bg-discord-modifier-selected text-white'
                                : 'text-discord-text-muted hover:bg-discord-modifier-hover hover:text-discord-text-secondary'}`, children: [_jsxs("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", className: `flex-shrink-0 ${!currentChannelId ? 'text-white' : 'opacity-70 group-hover:opacity-100'}`, children: [_jsx("path", { d: "M13 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-2-4a2 2 0 1 1 4 0 2 2 0 0 1-4 0Z" }), _jsx("path", { d: "M3 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-1c0-2.76-5.37-4-8-4s-8 1.24-8 4v1Z" }), _jsx("path", { d: "M3.5 13.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", opacity: ".5" })] }), _jsx("span", { className: "font-medium text-[16px]", children: "Friends" })] }), _jsxs("div", { className: "flex items-center gap-3 px-2 h-[42px] rounded-[4px] cursor-pointer mb-[2px] transition-colors group text-discord-text-muted hover:bg-discord-modifier-hover hover:text-discord-text-secondary", children: [_jsxs("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", className: "flex-shrink-0 opacity-70 group-hover:opacity-100", children: [_jsx("path", { d: "M2.98966977,9.35789159 C2.98966977,9.77582472 2.63542482,10.1300697 2.21749169,10.1300697 L2.21749169,10.1300697 C1.79955856,10.1300697 1.44531361,9.77582472 1.44531361,9.35789159 L1.44531361,9.35789159 C1.44531361,8.93995846 1.79955856,8.58571351 2.21749169,8.58571351 L2.21749169,8.58571351 C2.63542482,8.58571351 2.98966977,8.93995846 2.98966977,9.35789159 Z", transform: "translate(12, 12) scale(1.2) translate(-12, -12)" }), _jsx("path", { d: "M21.7,9.358 L12.957,2.46 C12.396,2.014 11.604,2.014 11.043,2.46 L2.3,9.358 C2.113,9.507 2,9.734 2,9.975 L2,19.5 C2,20.881 3.119,22 4.5,22 L19.5,22 C20.881,22 22,20.881 22,19.5 L22,9.975 C22,9.734 21.887,9.507 21.7,9.358 Z M12,17.5 C10.619,17.5 9.5,16.381 9.5,15 C9.5,13.619 10.619,12.5 12,12.5 C13.381,12.5 14.5,13.619 14.5,15 C14.5,16.381 13.381,17.5 12,17.5 Z" })] }), _jsx("span", { className: "font-medium text-[16px]", children: "Nitro" })] }), _jsxs("div", { className: "flex items-center gap-3 px-2 h-[42px] rounded-[4px] cursor-pointer mb-[2px] transition-colors group text-discord-text-muted hover:bg-discord-modifier-hover hover:text-discord-text-secondary", children: [_jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", className: "flex-shrink-0 opacity-70 group-hover:opacity-100", children: _jsx("path", { d: "M2 5.5A1.5 1.5 0 0 1 3.5 4h17A1.5 1.5 0 0 1 22 5.5V7H2V5.5ZM2 9v9.5A1.5 1.5 0 0 0 3.5 20h17a1.5 1.5 0 0 0 1.5-1.5V9H2Zm9.5 3a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5Zm-4-1h2a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1Z" }) }), _jsx("span", { className: "font-medium text-[16px]", children: "Shop" })] }), _jsxs("div", { className: "mt-[18px] px-2 mb-1 flex items-center justify-between group", children: [_jsx("span", { className: "text-[12px] font-bold text-discord-text-muted uppercase tracking-wider", children: "Direct Messages" }), _jsx("button", { onClick: () => openModal('newDm'), className: "text-discord-text-muted hover:text-discord-text-primary transition-colors", title: "New Direct Message", children: _jsx("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "currentColor", children: _jsx("path", { d: "M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z" }) }) })] }), _jsxs("div", { className: "space-y-[2px]", children: [dmChannels.map((dm) => {
                                    const otherUser = dm.members.find(m => m.id !== user?.id);
                                    if (!otherUser)
                                        return null;
                                    const isDmUnread = unreadChannels.has(dm.id) && currentChannelId !== dm.id;
                                    return (_jsxs("div", { onClick: () => handleChannelClick(dm.id), className: `relative flex items-center gap-3 px-2 h-[42px] rounded-[4px] cursor-pointer transition-colors group ${currentChannelId === dm.id
                                            ? 'bg-discord-modifier-selected text-white'
                                            : isDmUnread
                                                ? 'text-white hover:bg-discord-modifier-hover'
                                                : 'text-discord-text-muted hover:bg-discord-modifier-hover hover:text-discord-text-secondary'}`, children: [isDmUnread && (_jsx("div", { className: "absolute -left-1 w-1 h-2 bg-white rounded-r-full" })), _jsx(Avatar, { src: otherUser.avatar, name: otherUser.displayName ?? otherUser.username, size: 32, status: otherUser.status }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("div", { className: `text-[15px] truncate leading-tight ${currentChannelId === dm.id ? 'text-white font-medium'
                                                            : isDmUnread ? 'text-white font-bold'
                                                                : 'text-discord-text-muted group-hover:text-discord-text-secondary font-medium'}`, children: otherUser.displayName ?? otherUser.username }), dm.lastMessage && (_jsx("div", { className: "text-[12px] text-discord-channels-default truncate leading-tight mt-0.5", children: dm.lastMessage.content }))] }), _jsx("button", { onClick: (e) => { e.stopPropagation(); }, className: "opacity-0 group-hover:opacity-100 text-discord-text-muted hover:text-discord-text-primary transition-opacity flex-shrink-0 ml-1", title: "Close DM", children: _jsx("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" }) }) })] }, dm.id));
                                }), dmChannels.length === 0 && (_jsx("p", { className: "px-2 py-4 text-[13px] text-discord-text-muted italic opacity-60", children: "No DM conversations yet." }))] })] }), currentVoiceChannelId && _jsx(VoiceControls, {}), user && (_jsx(UserAreaPanel, { user: user, isMuted: isMuted, isDeafened: isDeafened, onMicToggle: handleMicToggle, onDeafenToggle: handleDeafenToggle, onSettingsClick: () => openModal('userSettings') }))] }));
    }
    return (_jsxs("div", { className: "w-60 bg-discord-bg-secondary flex flex-col flex-shrink-0 select-none", children: [_jsxs("button", { onClick: () => openModal('serverSettings'), className: "h-12 px-4 flex items-center justify-between shadow-header z-10 hover:bg-discord-modifier-hover transition-colors group", children: [_jsx("span", { className: "font-bold text-[16px] text-discord-text-primary truncate leading-tight", children: server.name }), _jsx("svg", { width: "18", height: "18", viewBox: "0 0 18 18", fill: "currentColor", className: "text-discord-text-muted flex-shrink-0 group-hover:text-discord-text-secondary", children: _jsx("path", { d: "M5.293 7.293a1 1 0 011.414 0L9 9.586l2.293-2.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" }) })] }), _jsxs("div", { className: "flex-1 overflow-y-auto pt-3 px-2 space-y-[21px] no-scrollbar", children: [_jsxs("div", { children: [_jsxs("div", { className: "flex items-center justify-between px-1 mb-1 group cursor-pointer", children: [_jsxs("div", { className: "flex items-center gap-0.5 text-discord-text-muted hover:text-discord-text-secondary transition-colors", children: [_jsx("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "currentColor", className: "opacity-70", children: _jsx("path", { d: "M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z" }) }), _jsx("span", { className: "text-[12px] font-bold uppercase tracking-wider", children: "Text Channels" })] }), isAdminUser && (_jsx("button", { onClick: (e) => {
                                            e.stopPropagation();
                                            openModal('createChannel');
                                        }, className: "text-discord-text-muted hover:text-discord-text-primary transition-colors", title: "Create Channel", children: _jsx("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "currentColor", children: _jsx("path", { d: "M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z" }) }) }))] }), _jsx("div", { className: "space-y-[2px]", children: textChannels.map((channel) => {
                                    const isUnread = unreadChannels.has(channel.id) && currentChannelId !== channel.id;
                                    return (_jsxs("button", { onClick: () => handleChannelClick(channel.id), className: `w-full flex items-center gap-1.5 px-2 h-8 rounded-[4px] group transition-colors ${currentChannelId === channel.id
                                            ? 'bg-discord-modifier-selected text-white'
                                            : isUnread
                                                ? 'text-white hover:text-white hover:bg-discord-modifier-hover'
                                                : 'text-discord-text-muted hover:text-discord-text-secondary hover:bg-discord-modifier-hover'}`, children: [isUnread && (_jsx("div", { className: "absolute -left-0.5 w-1 h-2 bg-white rounded-r-full" })), _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", className: "flex-shrink-0 opacity-60", children: _jsx("path", { d: "M5.88657 21C5.57547 21 5.3399 20.7189 5.39427 20.4126L6.00001 17H2.59511C2.28449 17 2.04905 16.7198 2.10259 16.4138L2.27759 15.4138C2.31946 15.1746 2.52722 15 2.77011 15H6.35001L7.41001 9H4.00511C3.69449 9 3.45905 8.71977 3.51259 8.41381L3.68759 7.41381C3.72946 7.17456 3.93722 7 4.18011 7H7.76001L8.39677 3.41262C8.43914 3.17391 8.64664 3 8.88907 3H9.87344C10.1845 3 10.4201 3.28107 10.3657 3.58738L9.76001 7H15.76L16.3968 3.41262C16.4391 3.17391 16.6466 3 16.8891 3H17.8734C18.1845 3 18.4201 3.28107 18.3657 3.58738L17.76 7H21.1649C21.4755 7 21.711 7.28023 21.6574 7.58619L21.4824 8.58619C21.4406 8.82544 21.2328 9 20.9899 9H17.41L16.35 15H19.7549C20.0655 15 20.301 15.2802 20.2474 15.5862L20.0724 16.5862C20.0306 16.8254 19.8228 17 19.5799 17H16L15.3632 20.5874C15.3209 20.8261 15.1134 21 14.8709 21H13.8866C13.5755 21 13.3399 20.7189 13.3943 20.4126L14 17H8.00001L7.36325 20.5874C7.32088 20.8261 7.11337 21 6.87094 21H5.88657ZM9.41001 9L8.35001 15H14.35L15.41 9H9.41001Z" }) }), _jsx("span", { className: `truncate text-[15px] ${isUnread ? 'font-bold' : 'font-medium'}`, children: channel.name })] }, channel.id));
                                }) })] }), _jsxs("div", { children: [_jsxs("div", { className: "flex items-center justify-between px-1 mb-1 group cursor-pointer", children: [_jsxs("div", { className: "flex items-center gap-0.5 text-discord-text-muted hover:text-discord-text-secondary transition-colors", children: [_jsx("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "currentColor", className: "opacity-70", children: _jsx("path", { d: "M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z" }) }), _jsx("span", { className: "text-[12px] font-bold uppercase tracking-wider", children: "Voice Channels" })] }), isAdminUser && (_jsx("button", { onClick: (e) => {
                                            e.stopPropagation();
                                            openModal('createChannel');
                                        }, className: "text-discord-text-muted hover:text-discord-text-primary transition-colors", title: "Create Channel", children: _jsx("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "currentColor", children: _jsx("path", { d: "M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z" }) }) }))] }), _jsx("div", { className: "space-y-[2px]", children: voiceChannels.map((channel) => (_jsx(VoiceChannel, { channelId: channel.id, channelName: channel.name, onClick: () => handleVoiceJoin(channel.id) }, channel.id))) })] }), _jsx("div", { className: "pt-2", children: _jsxs("button", { onClick: () => openModal('invite'), className: "w-full flex items-center gap-2 px-2 h-8 rounded-[4px] text-[15px] font-medium text-discord-text-muted hover:text-discord-text-secondary hover:bg-discord-modifier-hover transition-colors", children: [_jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", className: "opacity-60", children: _jsx("path", { d: "M13 13v5h-2v-5H6v-2h5V6h2v5h5v2h-5z" }) }), "Invite People"] }) })] }), currentVoiceChannelId && _jsx(VoiceControls, {}), user && (_jsx(UserAreaPanel, { user: user, isMuted: isMuted, isDeafened: isDeafened, onMicToggle: handleMicToggle, onDeafenToggle: handleDeafenToggle, onSettingsClick: () => openModal('userSettings') }))] }));
}
/* ─── User Area Panel ──────────────────────────────────────────────────────── */
function UserAreaPanel({ user, isMuted, isDeafened, onMicToggle, onDeafenToggle, onSettingsClick, }) {
    const [openPanel, setOpenPanel] = useState(null);
    const [inputDevices, setInputDevices] = useState([]);
    const [outputDevices, setOutputDevices] = useState([]);
    const [selectedInput, setSelectedInput] = useState('default');
    const [selectedOutput, setSelectedOutput] = useState('default');
    const [selectedInputLabel, setSelectedInputLabel] = useState('Default');
    const [selectedOutputLabel, setSelectedOutputLabel] = useState('Default');
    const inputVolume = useVoiceStore((s) => s.inputVolume);
    const storeSetInputVolume = useVoiceStore((s) => s.setInputVolume);
    const outputVolume = useVoiceStore((s) => s.outputVolume);
    const storeSetOutputVolume = useVoiceStore((s) => s.setOutputVolume);
    const [showInputDeviceList, setShowInputDeviceList] = useState(false);
    const [showOutputDeviceList, setShowOutputDeviceList] = useState(false);
    const [micLevel, setMicLevel] = useState(0);
    const panelRef = useRef(null);
    const analyserRef = useRef(null);
    const animFrameRef = useRef(0);
    const loadDevices = useCallback(async () => {
        try {
            // Need to request permission first to get labels
            await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
            const devices = await navigator.mediaDevices.enumerateDevices();
            setInputDevices(devices.filter(d => d.kind === 'audioinput'));
            setOutputDevices(devices.filter(d => d.kind === 'audiooutput'));
        }
        catch {
            // permission denied
        }
    }, []);
    // Start mic level monitoring when input panel opens
    useEffect(() => {
        if (openPanel !== 'input') {
            if (animFrameRef.current)
                cancelAnimationFrame(animFrameRef.current);
            analyserRef.current = null;
            setMicLevel(0);
            return;
        }
        let stream = null;
        let ctx = null;
        const start = async () => {
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: selectedInput !== 'default' ? selectedInput : undefined } });
                ctx = new AudioContext();
                const source = ctx.createMediaStreamSource(stream);
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 256;
                source.connect(analyser);
                analyserRef.current = analyser;
                const data = new Uint8Array(analyser.frequencyBinCount);
                const tick = () => {
                    if (!analyserRef.current)
                        return;
                    analyserRef.current.getByteFrequencyData(data);
                    const avg = data.reduce((a, b) => a + b, 0) / data.length;
                    setMicLevel(Math.min(avg / 128, 1));
                    animFrameRef.current = requestAnimationFrame(tick);
                };
                tick();
            }
            catch { /* no mic access */ }
        };
        start();
        return () => {
            if (animFrameRef.current)
                cancelAnimationFrame(animFrameRef.current);
            analyserRef.current = null;
            stream?.getTracks().forEach(t => t.stop());
            ctx?.close();
        };
    }, [openPanel, selectedInput]);
    useEffect(() => {
        const handleClick = (e) => {
            if (panelRef.current && !panelRef.current.contains(e.target)) {
                setOpenPanel(null);
                setShowInputDeviceList(false);
                setShowOutputDeviceList(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);
    const togglePanel = (panel) => {
        if (openPanel === panel) {
            setOpenPanel(null);
        }
        else {
            loadDevices();
            setOpenPanel(panel);
            setShowInputDeviceList(false);
            setShowOutputDeviceList(false);
        }
    };
    const selectInput = (device) => {
        setSelectedInput(device.deviceId);
        setSelectedInputLabel(device.label || 'Default');
        setShowInputDeviceList(false);
        const room = getActiveRoom();
        if (room)
            room.switchActiveDevice('audioinput', device.deviceId).catch(() => { });
    };
    const selectOutput = (device) => {
        setSelectedOutput(device.deviceId);
        setSelectedOutputLabel(device.label || 'Default');
        setShowOutputDeviceList(false);
        const room = getActiveRoom();
        if (room)
            room.switchActiveDevice('audiooutput', device.deviceId).catch(() => { });
    };
    // Generate mic level bars (20 bars like Discord)
    const micBars = 20;
    const activeBars = Math.round(micLevel * micBars * (inputVolume / 100));
    return (_jsxs("div", { className: "relative", ref: panelRef, children: [openPanel === 'input' && (_jsxs("div", { className: "absolute bottom-full left-0 right-0 mb-0 bg-[#2b2d31] rounded-t-lg shadow-lg z-50 border-t border-x border-discord-bg-tertiary", children: [_jsxs("div", { className: "relative", children: [_jsxs("button", { onClick: () => setShowInputDeviceList(!showInputDeviceList), className: "w-full px-4 py-3 flex items-center justify-between hover:bg-discord-modifier-hover transition-colors", children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "text-[15px] font-semibold text-discord-text-primary text-left", children: "Input Device" }), _jsx("div", { className: "text-[13px] text-discord-text-muted truncate text-left", children: selectedInputLabel })] }), _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", className: "text-discord-text-muted flex-shrink-0 ml-2", children: _jsx("path", { d: "M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" }) })] }), showInputDeviceList && (_jsx("div", { className: "bg-discord-bg-floating rounded-lg shadow-lg mx-2 mb-2 py-1 border border-discord-bg-tertiary", children: inputDevices.map(d => (_jsxs("button", { onClick: () => selectInput(d), className: `w-full px-3 py-2 text-left text-[13px] hover:bg-discord-modifier-hover transition-colors flex items-center gap-2 ${selectedInput === d.deviceId ? 'text-discord-text-primary' : 'text-discord-text-secondary'}`, children: [selectedInput === d.deviceId && (_jsx("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "currentColor", className: "text-discord-blurple flex-shrink-0", children: _jsx("path", { d: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" }) })), _jsx("span", { className: selectedInput === d.deviceId ? '' : 'pl-6', children: d.label || 'Default' })] }, d.deviceId))) }))] }), _jsx("div", { className: "mx-4 border-t border-[#3f4147]" }), _jsxs("div", { className: "px-4 py-3", children: [_jsx("div", { className: "text-[15px] font-semibold text-discord-text-primary mb-2", children: "Input Volume" }), _jsx("input", { type: "range", min: 0, max: 200, value: inputVolume, onChange: (e) => {
                                    const vol = Number(e.target.value);
                                    storeSetInputVolume(vol);
                                    // Apply gain to mic: at 0 = mute, 100 = normal, 200 = 2x boost
                                    const room = getActiveRoom();
                                    if (room && room.localParticipant.isMicrophoneEnabled) {
                                        if (vol === 0) {
                                            room.localParticipant.setMicrophoneEnabled(false).catch(() => { });
                                        }
                                        else {
                                            // Re-enable mic if it was muted by volume slider
                                            room.localParticipant.setMicrophoneEnabled(true).catch(() => { });
                                        }
                                    }
                                }, className: "w-full h-1.5 rounded-full appearance-none cursor-pointer accent-discord-blurple bg-discord-bg-tertiary [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md", style: {
                                    background: `linear-gradient(to right, #5865f2 0%, #5865f2 ${inputVolume / 2}%, #4e5058 ${inputVolume / 2}%, #4e5058 100%)`,
                                } }), _jsx("div", { className: "flex items-center gap-[3px] mt-2.5", children: Array.from({ length: micBars }).map((_, i) => (_jsx("div", { className: `flex-1 h-[6px] rounded-[1px] transition-colors duration-75 ${i < activeBars ? 'bg-discord-text-muted' : 'bg-[#3f4147]'}` }, i))) })] }), _jsx("div", { className: "mx-4 border-t border-[#3f4147]" }), _jsxs("button", { onClick: onSettingsClick, className: "w-full px-4 py-3 flex items-center justify-between hover:bg-discord-modifier-hover transition-colors", children: [_jsx("span", { className: "text-[15px] font-semibold text-discord-text-primary", children: "Voice Settings" }), _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", className: "text-discord-text-muted", children: _jsx("path", { d: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" }) })] })] })), openPanel === 'output' && (_jsxs("div", { className: "absolute bottom-full left-0 right-0 mb-0 bg-[#2b2d31] rounded-t-lg shadow-lg z-50 border-t border-x border-discord-bg-tertiary", children: [_jsxs("div", { className: "relative", children: [_jsxs("button", { onClick: () => setShowOutputDeviceList(!showOutputDeviceList), className: "w-full px-4 py-3 flex items-center justify-between hover:bg-discord-modifier-hover transition-colors", children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "text-[15px] font-semibold text-discord-text-primary text-left", children: "Output Device" }), _jsx("div", { className: "text-[13px] text-discord-text-muted truncate text-left", children: selectedOutputLabel })] }), _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", className: "text-discord-text-muted flex-shrink-0 ml-2", children: _jsx("path", { d: "M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" }) })] }), showOutputDeviceList && (_jsx("div", { className: "bg-discord-bg-floating rounded-lg shadow-lg mx-2 mb-2 py-1 border border-discord-bg-tertiary", children: outputDevices.map(d => (_jsxs("button", { onClick: () => selectOutput(d), className: `w-full px-3 py-2 text-left text-[13px] hover:bg-discord-modifier-hover transition-colors flex items-center gap-2 ${selectedOutput === d.deviceId ? 'text-discord-text-primary' : 'text-discord-text-secondary'}`, children: [selectedOutput === d.deviceId && (_jsx("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "currentColor", className: "text-discord-blurple flex-shrink-0", children: _jsx("path", { d: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" }) })), _jsx("span", { className: selectedOutput === d.deviceId ? '' : 'pl-6', children: d.label || 'Default' })] }, d.deviceId))) }))] }), _jsx("div", { className: "mx-4 border-t border-[#3f4147]" }), _jsxs("div", { className: "px-4 py-3", children: [_jsx("div", { className: "text-[15px] font-semibold text-discord-text-primary mb-2", children: "Output Volume" }), _jsx("input", { type: "range", min: 0, max: 200, value: outputVolume, onChange: (e) => {
                                    const vol = Number(e.target.value);
                                    storeSetOutputVolume(vol);
                                    // Apply volume to all remote participants
                                    const room = getActiveRoom();
                                    if (room) {
                                        const scaled = vol / 100; // 0-2 range (0%=0, 100%=1, 200%=2)
                                        room.remoteParticipants.forEach((participant) => {
                                            participant.setVolume(scaled);
                                        });
                                    }
                                }, className: "w-full h-1.5 rounded-full appearance-none cursor-pointer bg-discord-bg-tertiary [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md", style: {
                                    background: `linear-gradient(to right, #5865f2 0%, #5865f2 ${outputVolume / 2}%, #4e5058 ${outputVolume / 2}%, #4e5058 100%)`,
                                } })] }), _jsx("div", { className: "mx-4 border-t border-[#3f4147]" }), _jsxs("button", { onClick: onSettingsClick, className: "w-full px-4 py-3 flex items-center justify-between hover:bg-discord-modifier-hover transition-colors", children: [_jsx("span", { className: "text-[15px] font-semibold text-discord-text-primary", children: "Voice Settings" }), _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", className: "text-discord-text-muted", children: _jsx("path", { d: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" }) })] })] })), _jsxs("div", { className: "h-[52px] px-2 bg-discord-bg-user-area flex items-center select-none", children: [_jsxs("div", { className: "p-1 hover:bg-discord-modifier-hover rounded-[4px] flex items-center gap-2 flex-1 min-w-0 cursor-pointer transition-colors group", children: [_jsx(Avatar, { src: user.avatar, name: user.displayName ?? user.username, size: 32, status: user.status, user: user }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("div", { className: "text-[13px] font-semibold text-discord-text-primary truncate leading-tight", children: user.displayName ?? user.username }), _jsxs("div", { className: "text-[11px] text-discord-text-muted truncate leading-tight group-hover:text-discord-text-secondary", children: ["@", user.username] })] })] }), _jsxs("div", { className: "flex items-center", children: [_jsx("button", { onClick: onMicToggle, className: `w-8 h-8 flex items-center justify-center hover:bg-discord-modifier-hover rounded-l-[4px] transition-colors ${isMuted ? 'text-discord-red' : 'text-discord-text-muted hover:text-discord-text-primary'}`, title: isMuted ? 'Unmute' : 'Mute', children: _jsxs("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: [_jsx("path", { d: "M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" }), _jsx("path", { d: "M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" }), isMuted && _jsx("line", { x1: "3", y1: "3", x2: "21", y2: "21", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round" })] }) }), _jsx("button", { onClick: () => togglePanel('input'), className: `w-[18px] h-8 flex items-center justify-center hover:bg-discord-modifier-hover rounded-r-[4px] transition-colors ${openPanel === 'input' ? 'text-discord-text-primary bg-discord-modifier-hover' : 'text-discord-text-muted hover:text-discord-text-primary'}`, title: "Input Devices", children: _jsx("svg", { width: "10", height: "10", viewBox: "0 0 24 24", fill: "currentColor", className: `transition-transform ${openPanel === 'input' ? 'rotate-180' : ''}`, children: _jsx("path", { d: "M7 10l5 5 5-5z" }) }) }), _jsx("button", { onClick: onDeafenToggle, className: `w-8 h-8 flex items-center justify-center hover:bg-discord-modifier-hover rounded-l-[4px] transition-colors ${isDeafened ? 'text-discord-red' : 'text-discord-text-muted hover:text-discord-text-primary'}`, title: isDeafened ? 'Undeafen' : 'Deafen', children: _jsxs("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: [_jsx("path", { d: "M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h2v-7H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2v7h2c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z" }), isDeafened && _jsx("line", { x1: "3", y1: "3", x2: "21", y2: "21", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round" })] }) }), _jsx("button", { onClick: () => togglePanel('output'), className: `w-[18px] h-8 flex items-center justify-center hover:bg-discord-modifier-hover rounded-r-[4px] transition-colors ${openPanel === 'output' ? 'text-discord-text-primary bg-discord-modifier-hover' : 'text-discord-text-muted hover:text-discord-text-primary'}`, title: "Output Devices", children: _jsx("svg", { width: "10", height: "10", viewBox: "0 0 24 24", fill: "currentColor", className: `transition-transform ${openPanel === 'output' ? 'rotate-180' : ''}`, children: _jsx("path", { d: "M7 10l5 5 5-5z" }) }) }), _jsx("button", { onClick: onSettingsClick, className: "w-8 h-8 flex items-center justify-center text-discord-text-muted hover:text-discord-text-primary hover:bg-discord-modifier-hover rounded-[4px] transition-colors", title: "User Settings", children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" }) }) })] })] })] }));
}
