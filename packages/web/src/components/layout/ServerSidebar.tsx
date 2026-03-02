import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';

import { getServerGradient, HOME_GRADIENT } from '../../utils/gradients';

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

function SidebarItem({ id, name, icon, active, onClick, type = 'server', actionType, hasUnread }: SidebarItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const firstLetter = name.charAt(0).toUpperCase();

  const getPillHeight = () => {
    if (active) return 'h-8';
    if (isHovered) return 'h-4';
    if (hasUnread && !active) return 'h-2';
    return 'h-2 scale-0';
  };

  const backgroundStyle = useMemo((): React.CSSProperties | undefined => {
    if (type === 'action') {
      return {
        background: isHovered ? 'rgba(134, 239, 172, 0.12)' : 'rgba(255, 255, 255, 0.04)',
      };
    }

    if (type === 'dm') {
      return { background: HOME_GRADIENT.gradient };
    }

    // Server type — if it has a custom icon image, no gradient needed
    if (icon) return undefined;

    const serverGrad = getServerGradient(id, name);
    return { background: serverGrad.gradient };
  }, [type, id, name, icon, isHovered]);

  const getButtonClasses = () => {
    const base = 'w-10 h-10 flex items-center justify-center duration-200 overflow-hidden [transition:border-radius_0.2s,background_0.2s,color_0.2s]';

    if (type === 'dm') {
      return `${base} text-white ${active ? 'rounded-[13px]' : 'rounded-[20px] hover:rounded-[13px]'}`;
    }

    if (type === 'action') {
      return `${base} rounded-[20px] hover:rounded-[13px] text-accent-mint`;
    }

    if (icon) {
      return `${base} ${active ? 'rounded-[13px]' : 'rounded-[20px] hover:rounded-[13px]'}`;
    }

    return `${base} text-white ${active ? 'rounded-[13px]' : 'rounded-[20px] hover:rounded-[13px]'}`;
  };

  return (
    <div
      className="relative flex items-center mb-1.5 w-full justify-center"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Pill Indicator */}
      {(type === 'server' || type === 'dm') && (
        <div className="absolute -left-0 w-2 h-10 flex items-center">
          <div
            className={`bg-white rounded-r-full transition-all duration-200 origin-left ${getPillHeight()} w-1`}
          />
        </div>
      )}

      <button onClick={onClick} className={getButtonClasses()} style={backgroundStyle} title={name}>
        {type === 'dm' ? (
          <span className="text-[17px] font-bold">B</span>
        ) : type === 'action' ? (
          actionType === 'add' ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
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
          <span className="text-[15px] font-bold">{firstLetter}</span>
        )}
      </button>
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

      <div className="w-8 h-[2px] bg-interactive-muted rounded-full mb-1.5" />

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

      <div className="w-8 h-[2px] bg-interactive-muted rounded-full mb-1.5" />

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
