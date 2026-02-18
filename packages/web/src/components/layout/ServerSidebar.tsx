import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { Tooltip } from '../ui/Tooltip';

interface SidebarItemProps {
  id: string;
  name: string;
  icon?: string | null;
  active: boolean;
  onClick: () => void;
  type?: 'server' | 'dm' | 'action';
  actionType?: 'add' | 'join';
  hasUnread?: boolean;
}

function SidebarItem({ name, icon, active, onClick, type = 'server', actionType, hasUnread }: SidebarItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const firstLetter = name.charAt(0).toUpperCase();

  const getPillHeight = () => {
    if (active) return 'h-10';
    if (isHovered) return 'h-5';
    if (hasUnread && !active) return 'h-2';
    return 'h-2 scale-0';
  };

  const getButtonClasses = () => {
    const base = 'w-12 h-12 flex items-center justify-center transition-all duration-200 overflow-hidden relative group';
    
    if (type === 'dm') {
      return `${base} ${active ? 'bg-discord-blurple rounded-[16px] text-white' : 'bg-discord-bg-primary rounded-[24px] hover:rounded-[16px] text-discord-text-primary hover:bg-discord-blurple hover:text-white'}`;
    }
    
    if (type === 'action') {
      return `${base} bg-discord-bg-primary rounded-[24px] hover:rounded-[16px] text-discord-green hover:bg-discord-green hover:text-white`;
    }

    return `${base} ${active ? 'bg-discord-blurple rounded-[16px] text-white' : 'bg-discord-bg-primary rounded-[24px] hover:rounded-[16px] text-discord-text-primary hover:bg-discord-blurple hover:text-white'}`;
  };

  return (
    <div 
      className="relative flex items-center mb-2 w-full justify-center"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Pill Indicator */}
      {(type === 'server' || type === 'dm') && (
        <div className="absolute -left-0 w-2 h-12 flex items-center">
          <div 
            className={`bg-white rounded-r-full transition-all duration-200 origin-left ${getPillHeight()} w-1`}
          />
        </div>
      )}

      <Tooltip content={name} position="right">
        <button onClick={onClick} className={getButtonClasses()}>
          {type === 'dm' ? (
            <svg width="28" height="20" viewBox="0 0 28 20" fill="currentColor">
              <path d="M23.0212 1.67671C21.3107 0.879656 19.5079 0.318797 17.6584 0C17.4062 0.461742 17.1749 0.934541 16.9708 1.4184C15.003 1.12145 12.9974 1.12145 11.0292 1.4184C10.8251 0.934541 10.5938 0.461742 10.3416 0C8.49215 0.318797 6.68934 0.879656 4.97882 1.67671C0.665804 8.44726 -0.364554 15.0614 0.225316 21.5765C2.41849 23.2105 4.70543 24.3115 7.04773 25.043C7.60419 24.2941 8.09868 23.4944 8.52321 22.6521C7.71966 22.3602 6.9466 21.9905 6.21274 21.5543C6.39845 21.4212 6.58011 21.2838 6.75775 21.1429C12.7568 23.8968 19.2811 23.8968 25.2422 21.1429C25.4199 21.2838 25.6015 21.4212 25.7873 21.5543C25.0534 21.9905 24.2804 22.3602 23.4768 22.6521C23.9013 23.4944 24.3958 24.2941 24.9523 25.043C27.2946 24.3115 29.5815 23.2105 31.7747 21.5765C32.4517 14.0051 30.5663 7.45459 26.0212 1.67671H23.0212Z" transform="scale(0.85) translate(0, 0)" />
            </svg>
          ) : type === 'action' ? (
            actionType === 'add' ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z" />
              </svg>
            )
          ) : icon ? (
            <img
              src={icon.startsWith('http') ? icon : `/api/uploads/${icon}`}
              alt={name}
              className="w-full h-full object-cover"
            />
          ) : (
            <span className="text-[16px] font-medium">{firstLetter}</span>
          )}
        </button>
      </Tooltip>
    </div>
  );
}

export function ServerSidebar() {
  const servers = useServerStore((s) => s.servers);
  const currentServerId = useServerStore((s) => s.currentServerId);
  const setCurrentServer = useServerStore((s) => s.setCurrentServer);
  const channelToServerMap = useServerStore((s) => s.channelToServerMap);
  const dmChannels = useServerStore((s) => s.dmChannels);
  const showDms = useUIStore((s) => s.showDms);
  const setShowDms = useUIStore((s) => s.setShowDms);
  const openModal = useUIStore((s) => s.openModal);
  const unreadChannels = useChatStore((s) => s.unreadChannels);
  const navigate = useNavigate();

  // Compute which servers have unread channels
  const unreadServerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const channelId of unreadChannels) {
      const serverId = channelToServerMap.get(channelId);
      if (serverId) ids.add(serverId);
    }
    return ids;
  }, [unreadChannels, channelToServerMap]);

  // Check if any DM channels are unread
  const hasDmUnread = useMemo(() => {
    for (const dm of dmChannels) {
      if (unreadChannels.has(dm.id)) return true;
    }
    return false;
  }, [unreadChannels, dmChannels]);

  const handleServerClick = (serverId: string) => {
    setCurrentServer(serverId);
    setShowDms(false);
    navigate(`/channels/${serverId}`);
  };

  const handleDmClick = () => {
    setShowDms(true);
    setCurrentServer(null);
    navigate('/channels/@me');
  };

  return (
    <nav className="w-[72px] bg-discord-bg-server flex flex-col items-center py-3 overflow-y-auto flex-shrink-0 no-scrollbar select-none">
      <SidebarItem
        id="@me"
        name="Direct Messages"
        active={showDms}
        onClick={handleDmClick}
        type="dm"
        hasUnread={hasDmUnread}
      />

      <div className="w-8 h-[2px] bg-discord-modifier-accent rounded-full mb-2" />

      {servers.map((server) => (
        <SidebarItem
          key={server.id}
          id={server.id}
          name={server.name}
          icon={server.icon}
          active={currentServerId === server.id}
          onClick={() => handleServerClick(server.id)}
          hasUnread={unreadServerIds.has(server.id)}
        />
      ))}

      <SidebarItem
        id="add-server"
        name="Add a Server"
        active={false}
        onClick={() => openModal('createServer')}
        type="action"
        actionType="add"
      />

      <SidebarItem
        id="join-server"
        name="Join a Server"
        active={false}
        onClick={() => openModal('joinServer')}
        type="action"
        actionType="join"
      />
    </nav>
  );
}
