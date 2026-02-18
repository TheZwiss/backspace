import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useNavigate } from 'react-router-dom';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { Tooltip } from '../ui/Tooltip';
export function ServerSidebar() {
    const servers = useServerStore((s) => s.servers);
    const currentServerId = useServerStore((s) => s.currentServerId);
    const setCurrentServer = useServerStore((s) => s.setCurrentServer);
    const showDms = useUIStore((s) => s.showDms);
    const setShowDms = useUIStore((s) => s.setShowDms);
    const openModal = useUIStore((s) => s.openModal);
    const navigate = useNavigate();
    const handleServerClick = (serverId) => {
        setCurrentServer(serverId);
        setShowDms(false);
        navigate(`/channels/${serverId}`);
    };
    const handleDmClick = () => {
        setShowDms(true);
        setCurrentServer(null);
        navigate('/channels/@me');
    };
    return (_jsxs("div", { className: "w-[72px] bg-discord-bg-tertiary flex flex-col items-center py-3 overflow-y-auto flex-shrink-0 gap-2", children: [_jsx(Tooltip, { content: "Direct Messages", position: "right", children: _jsx("button", { onClick: handleDmClick, className: `w-12 h-12 rounded-[24px] hover:rounded-[16px] transition-all duration-200 flex items-center justify-center ${showDms
                        ? 'bg-discord-blurple rounded-[16px]'
                        : 'bg-discord-bg-primary hover:bg-discord-blurple'}`, children: _jsx("svg", { width: "28", height: "20", viewBox: "0 0 28 20", fill: "white", children: _jsx("path", { d: "M23.0212 1.67671C21.3107 0.879656 19.5079 0.318797 17.6584 0C17.4062 0.461742 17.1749 0.934541 16.9708 1.4184C15.003 1.12145 12.9974 1.12145 11.0292 1.4184C10.8251 0.934541 10.5938 0.461742 10.3416 0C8.49215 0.318797 6.68934 0.879656 4.97882 1.67671C0.665804 8.44726 -0.364554 15.0614 0.225316 21.5765C2.41849 23.2105 4.70543 24.3115 7.04773 25.043C7.60419 24.2941 8.09868 23.4944 8.52321 22.6521C7.71966 22.3602 6.9466 21.9905 6.21274 21.5543C6.39845 21.4212 6.58011 21.2838 6.75775 21.1429C12.7568 23.8968 19.2811 23.8968 25.2422 21.1429C25.4199 21.2838 25.6015 21.4212 25.7873 21.5543C25.0534 21.9905 24.2804 22.3602 23.4768 22.6521C23.9013 23.4944 24.3958 24.2941 24.9523 25.043C27.2946 24.3115 29.5815 23.2105 31.7747 21.5765C32.4517 14.0051 30.5663 7.45459 26.0212 1.67671H23.0212Z", transform: "scale(0.85) translate(0, 0)" }) }) }) }), _jsx("div", { className: "w-8 h-0.5 bg-discord-bg-primary rounded-full" }), servers.map((server) => {
                const isActive = currentServerId === server.id;
                const firstLetter = server.name.charAt(0).toUpperCase();
                return (_jsxs("div", { className: "relative", children: [isActive && (_jsx("div", { className: "absolute -left-1 top-1/2 -translate-y-1/2 w-1 h-10 bg-white rounded-r-full" })), _jsx(Tooltip, { content: server.name, position: "right", children: _jsx("button", { onClick: () => handleServerClick(server.id), className: `w-12 h-12 transition-all duration-200 flex items-center justify-center text-lg font-semibold ${isActive
                                    ? 'bg-discord-blurple rounded-[16px] text-white'
                                    : 'bg-discord-bg-primary hover:bg-discord-blurple rounded-[24px] hover:rounded-[16px] text-discord-text-primary hover:text-white'}`, children: server.icon ? (_jsx("img", { src: server.icon.startsWith('http') ? server.icon : `/api/uploads/${server.icon}`, alt: server.name, className: "w-full h-full rounded-inherit object-cover" })) : (firstLetter) }) })] }, server.id));
            }), _jsx(Tooltip, { content: "Add a Server", position: "right", children: _jsx("button", { onClick: () => openModal('createServer'), className: "w-12 h-12 rounded-[24px] hover:rounded-[16px] transition-all duration-200 bg-discord-bg-primary hover:bg-discord-green text-discord-green hover:text-white flex items-center justify-center", children: _jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" }) }) }) }), _jsx(Tooltip, { content: "Join a Server", position: "right", children: _jsx("button", { onClick: () => openModal('joinServer'), className: "w-12 h-12 rounded-[24px] hover:rounded-[16px] transition-all duration-200 bg-discord-bg-primary hover:bg-discord-green text-discord-green hover:text-white flex items-center justify-center", children: _jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z" }) }) }) })] }));
}
