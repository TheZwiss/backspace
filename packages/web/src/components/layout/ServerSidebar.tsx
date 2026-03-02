import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { Tooltip } from '../ui/Tooltip';
import { getServerGradient, HOME_GRADIENT } from '../../utils/gradients';

interface SidebarItemProps {
  id: string;
  name: string;
  icon?: string | null;
  active: boolean;
  onClick: () => void;
  type?: 'server' | 'dm' | 'action';
  actionType?: 'add' | 'join' | 'explore';
  hasUnread?: boolean;
}

function SidebarItem({ id, name, icon, active, onClick, type = 'server', actionType, hasUnread }: SidebarItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const firstLetter = name.charAt(0).toUpperCase();

  const getPillHeight = () => {
    if (active) return 'h-10';
    if (isHovered) return 'h-5';
    if (hasUnread && !active) return 'h-2';
    return 'h-2 scale-0';
  };

  const backgroundStyle = useMemo((): React.CSSProperties | undefined => {
    if (type === 'action') return undefined;

    if (type === 'dm') {
      return {
        background: HOME_GRADIENT.gradient,
        ...(isHovered ? { boxShadow: `0 0 12px ${HOME_GRADIENT.glow}40` } : {}),
      };
    }

    // Server type — if it has a custom icon image, no gradient needed
    if (icon) return undefined;

    const serverGrad = getServerGradient(id, name);
    return {
      background: serverGrad.gradient,
      ...(isHovered ? { boxShadow: `0 0 12px ${serverGrad.glow}40` } : {}),
    };
  }, [type, id, name, icon, active, isHovered]);

  const getButtonClasses = () => {
    const base = 'w-12 h-12 flex items-center justify-center transition-all duration-200 overflow-hidden relative group';

    if (type === 'dm') {
      return `${base} text-white ${active ? 'rounded-[16px]' : 'rounded-[24px] hover:rounded-[16px]'}`;
    }

    if (type === 'action') {
      return `${base} bg-surface-chat rounded-[24px] hover:rounded-[16px] text-status-online hover:bg-status-online hover:text-white`;
    }

    if (icon) {
      return `${base} ${active ? 'rounded-[16px]' : 'rounded-[24px] hover:rounded-[16px]'}`;
    }

    return `${base} text-white ${active ? 'rounded-[16px]' : 'rounded-[24px] hover:rounded-[16px]'}`;
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
        <button onClick={onClick} className={getButtonClasses()} style={backgroundStyle}>
          {type === 'dm' ? (
            <span className="text-[20px] font-bold">B</span>
          ) : type === 'action' ? (
            actionType === 'add' ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
              </svg>
            ) : actionType === 'explore' ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2zm0 18c-4.411 0-8-3.589-8-8s3.589-8 8-8 8 3.589 8 8-3.589 8-8 8zm-3.146-5.351l2.78-1.042 1.042-2.78-2.78 1.042-1.042 2.78zM14.5 7.5l-2.5 5-5 2.5 2.5-5 5-2.5z" />
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
    <nav data-pip-obstacle="left" className="w-[72px] bg-surface-base flex flex-col items-center py-3 overflow-y-auto flex-shrink-0 no-scrollbar select-none md:fixed md:inset-y-0 md:left-0 md:z-[100] md:glass-strip">
      <SidebarItem
        id="@me"
        name="Direct Messages"
        active={showDms}
        onClick={handleDmClick}
        type="dm"
        hasUnread={hasDmUnread}
      />

      <div className="w-8 h-[2px] bg-interactive-muted rounded-full mb-2" />

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

      <SidebarItem
        id="explore"
        name="Explore Discoverable Servers"
        active={false}
        onClick={() => {}}
        type="action"
        actionType="explore"
      />
    </nav>
  );
}
