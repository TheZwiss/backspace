import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { ServerSidebar } from './ServerSidebar';
import { ChannelSidebar } from './ChannelSidebar';
import { MainContent } from './MainContent';
import { MemberSidebar } from './MemberSidebar';
import { ImagePreview } from '../chat/ImagePreview';
import { CreateServerModal } from '../modals/CreateServer';
import { JoinServerModal } from '../modals/JoinServer';
import { CreateChannelModal } from '../modals/CreateChannel';
import { InviteModal } from '../modals/InviteModal';
import { UserSettingsModal } from '../modals/UserSettings';
import { ServerSettingsModal } from '../modals/ServerSettings';
import { NewDmModal } from '../modals/NewDmModal';
import { IncomingCallModal } from '../voice/IncomingCallModal';
import { PictureInPicture } from '../voice/PictureInPicture';
import { SoundController } from '../voice/SoundController';
import { UserProfilePopout } from '../ui/UserProfilePopout';
import { useAuth } from '../../hooks/useAuth';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useLiveKit } from '../../hooks/useLiveKit';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { AudioManager } from '../../audio/AudioManager';
export function AppLayout() {
    const { serverId, channelId, inviteCode } = useParams();
    // Global interaction handler to resume AudioContext
    useEffect(() => {
        const resume = () => {
            AudioManager.getInstance().resumeContext().then(() => {
                // Wake up all audio/video elements that might be blocked by Autoplay
                document.querySelectorAll('audio, video').forEach(el => {
                    el.play().catch(() => {
                        // Silently fail if still blocked or no source
                    });
                });
                window.removeEventListener('click', resume);
                window.removeEventListener('keydown', resume);
                window.removeEventListener('touchstart', resume);
            });
        };
        window.addEventListener('click', resume);
        window.addEventListener('keydown', resume);
        window.addEventListener('touchstart', resume);
        return () => {
            window.removeEventListener('click', resume);
            window.removeEventListener('keydown', resume);
            window.removeEventListener('touchstart', resume);
        };
    }, []);
    const { user, isLoading } = useAuth();
    const setCurrentServer = useServerStore((s) => s.setCurrentServer);
    const loadServerDetail = useServerStore((s) => s.loadServerDetail);
    const setCurrentChannel = useChatStore((s) => s.setCurrentChannel);
    const loadMessages = useChatStore((s) => s.loadMessages);
    const setIsMobile = useUIStore((s) => s.setIsMobile);
    const setShowDms = useUIStore((s) => s.setShowDms);
    const openModal = useUIStore((s) => s.openModal);
    const sidebarOpen = useUIStore((s) => s.sidebarOpen);
    const isMobile = useUIStore((s) => s.isMobile);
    const userProfilePopout = useUIStore((s) => s.userProfilePopout);
    const closeUserProfile = useUIStore((s) => s.closeUserProfile);
    const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
    const activeDmCall = useVoiceStore((s) => s.activeDmCall);
    const setParticipants = useVoiceStore((s) => s.setParticipants);
    const { connect: connectVoice, connectDm: connectDmVoice, disconnect: disconnectVoice, participants: voiceParticipants, isConnected: isVoiceConnected, isConnecting: isVoiceConnecting, connectedChannelId, } = useLiveKit();
    // Initialize WebSocket
    const { isConnected: isWsConnected } = useWebSocket();
    // Sync participants to store
    useEffect(() => {
        setParticipants(voiceParticipants);
    }, [voiceParticipants, setParticipants]);
    // Track the last channel we attempted to connect to, to prevent effect loops
    const lastAttemptedRef = React.useRef(null);
    // Manage voice connection
    useEffect(() => {
        if (isLoading || !user || !isWsConnected)
            return;
        const manageConnection = async () => {
            // Determine what we SHOULD be connected to
            const targetChannelId = activeDmCall
                ? `dm-${activeDmCall.dmChannelId}`
                : currentVoiceChannelId;
            // 1. If we have a target
            if (targetChannelId) {
                // If we're not connected to the RIGHT place, trigger connect.
                // We IGNORE isVoiceConnecting here to allow "interrupting" a connection
                // or switching rooms immediately.
                if (connectedChannelId !== targetChannelId) {
                    // Prevent spamming the same connection attempt if React re-renders
                    if (lastAttemptedRef.current === targetChannelId && isVoiceConnecting) {
                        return;
                    }
                    console.log(`[AppLayout] Switching/Connecting to: ${targetChannelId}`);
                    lastAttemptedRef.current = targetChannelId;
                    if (activeDmCall) {
                        await connectDmVoice(activeDmCall.dmChannelId);
                    }
                    else {
                        await connectVoice(targetChannelId);
                    }
                }
                else {
                    // We are connected to the right place. Reset ref.
                    lastAttemptedRef.current = null;
                }
                return;
            }
            // 2. No target — ensure disconnected
            if (connectedChannelId !== null || isVoiceConnected || isVoiceConnecting) {
                console.log('[AppLayout] Leaving voice (no target)');
                lastAttemptedRef.current = null;
                await disconnectVoice();
            }
        };
        manageConnection();
    }, [
        currentVoiceChannelId,
        activeDmCall,
        connectedChannelId,
        isVoiceConnected,
        isVoiceConnecting,
        isWsConnected,
        isLoading,
        user,
        connectVoice,
        connectDmVoice,
        disconnectVoice
    ]);
    // Responsive detection
    useEffect(() => {
        const checkMobile = () => setIsMobile(window.innerWidth < 768);
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, [setIsMobile]);
    // Handle route params
    useEffect(() => {
        if (serverId === '@me') {
            setShowDms(true);
            setCurrentServer(null);
        }
        else if (serverId) {
            setShowDms(false);
            setCurrentServer(serverId);
            loadServerDetail(serverId);
        }
    }, [serverId, setCurrentServer, loadServerDetail, setShowDms]);
    useEffect(() => {
        if (inviteCode) {
            openModal('joinServer');
        }
    }, [inviteCode, openModal]);
    useEffect(() => {
        if (channelId) {
            setCurrentChannel(channelId);
            loadMessages(channelId);
        }
        else {
            setCurrentChannel(null);
        }
    }, [channelId, setCurrentChannel, loadMessages]);
    if (isLoading || !user) {
        return (_jsx("div", { className: "h-screen flex items-center justify-center bg-discord-bg-primary", children: _jsxs("div", { className: "text-center", children: [_jsxs("svg", { className: "animate-spin w-10 h-10 text-discord-blurple mx-auto mb-4", viewBox: "0 0 24 24", fill: "none", children: [_jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }), _jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" })] }), _jsx("p", { className: "text-discord-text-muted", children: "Loading Opencord..." })] }) }));
    }
    return (_jsxs("div", { className: "h-screen flex bg-discord-bg-tertiary overflow-hidden", children: [_jsxs("div", { className: `${isMobile ? `fixed z-40 h-full transition-transform ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}` : 'flex h-full'}`, children: [_jsx(ServerSidebar, {}), _jsx(ChannelSidebar, {})] }), _jsxs("div", { className: "flex-1 flex min-w-0 bg-discord-bg-primary relative", children: [_jsx(MainContent, {}), serverId === '@me' ? (_jsx("div", { className: "w-[358px] bg-discord-bg-secondary flex-shrink-0 hidden xl:flex flex-col", children: _jsxs("div", { className: "p-4", children: [_jsx("h3", { className: "text-[20px] font-bold text-discord-text-header mb-4", children: "Active Now" }), _jsxs("div", { className: "text-center py-8", children: [_jsx("div", { className: "text-[16px] font-bold text-discord-text-header mb-1 text-center", children: "It's quiet for now..." }), _jsx("div", { className: "text-[14px] text-discord-text-muted text-center max-w-[200px] mx-auto", children: "When a friend starts an activity\u2014like playing a game or hanging out on voice\u2014we\u2019ll show it here!" })] })] }) })) : (_jsx(MemberSidebar, {}))] }), _jsx(CreateServerModal, {}), _jsx(JoinServerModal, {}), _jsx(CreateChannelModal, {}), _jsx(InviteModal, {}), _jsx(UserSettingsModal, {}), _jsx(ServerSettingsModal, {}), _jsx(NewDmModal, {}), _jsx(IncomingCallModal, {}), _jsx(ImagePreview, {}), _jsx(PictureInPicture, {}), _jsx(SoundController, {}), userProfilePopout.user && userProfilePopout.position && (_jsxs(_Fragment, { children: [_jsx("div", { className: "fixed inset-0 z-[45]", onClick: closeUserProfile }), _jsx(UserProfilePopout, { user: userProfilePopout.user, onClose: closeUserProfile, position: userProfilePopout.position })] }))] }));
}
