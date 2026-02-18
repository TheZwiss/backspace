import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { ServerSidebar } from './ServerSidebar';
import { ChannelSidebar } from './ChannelSidebar';
import { MainContent } from './MainContent';
import { MemberSidebar } from './MemberSidebar';
import { MobileNav } from './MobileNav';
import { ImagePreview } from '../chat/ImagePreview';
import { CreateServerModal } from '../modals/CreateServer';
import { JoinServerModal } from '../modals/JoinServer';
import { CreateChannelModal } from '../modals/CreateChannel';
import { InviteModal } from '../modals/InviteModal';
import { UserSettingsModal } from '../modals/UserSettings';
import { ServerSettingsModal } from '../modals/ServerSettings';
import { useAuth } from '../../hooks/useAuth';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
export function AppLayout() {
    const { serverId, channelId } = useParams();
    const { user, isLoading } = useAuth();
    const setCurrentServer = useServerStore((s) => s.setCurrentServer);
    const loadServerDetail = useServerStore((s) => s.loadServerDetail);
    const setCurrentChannel = useChatStore((s) => s.setCurrentChannel);
    const loadMessages = useChatStore((s) => s.loadMessages);
    const setIsMobile = useUIStore((s) => s.setIsMobile);
    const setShowDms = useUIStore((s) => s.setShowDms);
    const sidebarOpen = useUIStore((s) => s.sidebarOpen);
    const isMobile = useUIStore((s) => s.isMobile);
    // Initialize WebSocket
    useWebSocket();
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
    return (_jsxs("div", { className: "h-screen flex overflow-hidden", children: [_jsx(MobileNav, {}), _jsx("div", { className: `${isMobile ? `fixed z-40 h-full transition-transform ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}` : ''}`, children: _jsxs("div", { className: "flex h-full", children: [_jsx(ServerSidebar, {}), _jsx(ChannelSidebar, {})] }) }), _jsxs("div", { className: "flex-1 flex min-w-0", children: [_jsx(MainContent, {}), _jsx(MemberSidebar, {})] }), _jsx(CreateServerModal, {}), _jsx(JoinServerModal, {}), _jsx(CreateChannelModal, {}), _jsx(InviteModal, {}), _jsx(UserSettingsModal, {}), _jsx(ServerSettingsModal, {}), _jsx(ImagePreview, {})] }));
}
