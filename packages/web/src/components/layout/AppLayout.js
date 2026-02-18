import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect } from 'react';
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
import { UserProfilePopout } from '../ui/UserProfilePopout';
import { useAuth } from '../../hooks/useAuth';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useLiveKit } from '../../hooks/useLiveKit';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
export function AppLayout() {
    const { serverId, channelId, inviteCode } = useParams();
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
    const setParticipants = useVoiceStore((s) => s.setParticipants);
    const { connect: connectVoice, disconnect: disconnectVoice, participants: voiceParticipants, toggleMic, toggleCamera, toggleScreenShare } = useLiveKit();
    // Initialize WebSocket
    useWebSocket();
    // Sync participants to store
    useEffect(() => {
        setParticipants(voiceParticipants);
    }, [voiceParticipants, setParticipants]);
    // Manage voice connection
    useEffect(() => {
        if (currentVoiceChannelId) {
            connectVoice(currentVoiceChannelId);
        }
        else {
            disconnectVoice();
        }
    }, [currentVoiceChannelId, connectVoice, disconnectVoice]);
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
    return (_jsxs("div", { className: "h-screen flex bg-discord-bg-tertiary overflow-hidden", children: [_jsxs("div", { className: `${isMobile ? `fixed z-40 h-full transition-transform ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}` : 'flex h-full'}`, children: [_jsx(ServerSidebar, {}), _jsx(ChannelSidebar, { onToggleMic: toggleMic, onToggleCamera: toggleCamera, onToggleScreenShare: toggleScreenShare })] }), _jsxs("div", { className: "flex-1 flex min-w-0 bg-discord-bg-primary relative", children: [_jsx(MainContent, {}), serverId === '@me' ? (_jsx("div", { className: "w-[358px] bg-discord-bg-secondary flex-shrink-0 hidden xl:flex flex-col border-l border-discord-modifier-accent", children: _jsxs("div", { className: "p-4", children: [_jsx("h3", { className: "text-[20px] font-bold text-discord-text-header mb-4", children: "Active Now" }), _jsxs("div", { className: "text-center py-8", children: [_jsx("div", { className: "text-[16px] font-bold text-discord-text-header mb-1 text-center", children: "It's quiet for now..." }), _jsx("div", { className: "text-[14px] text-discord-text-muted text-center max-w-[200px] mx-auto", children: "When a friend starts an activity\u2014like playing a game or hanging out on voice\u2014we\u2019ll show it here!" })] })] }) })) : (_jsx(MemberSidebar, {}))] }), _jsx(CreateServerModal, {}), _jsx(JoinServerModal, {}), _jsx(CreateChannelModal, {}), _jsx(InviteModal, {}), _jsx(UserSettingsModal, {}), _jsx(ServerSettingsModal, {}), _jsx(ImagePreview, {}), userProfilePopout.user && userProfilePopout.position && (_jsxs(_Fragment, { children: [_jsx("div", { className: "fixed inset-0 z-[45]", onClick: closeUserProfile }), _jsx(UserProfilePopout, { user: userProfilePopout.user, onClose: closeUserProfile, position: userProfilePopout.position })] }))] }));
}
