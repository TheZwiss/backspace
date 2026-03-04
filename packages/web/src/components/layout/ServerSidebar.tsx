import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useInstanceStore } from '../../stores/instanceStore';

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
  dimmed?: boolean;
}

function SidebarItem({ id, name, icon, active, onClick, type = 'server', actionType, hasUnread, dimmed }: SidebarItemProps) {
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

      <button onClick={onClick} className={`${getButtonClasses()} ${dimmed ? 'opacity-40 saturate-50' : ''}`} style={backgroundStyle} title={name}>
        {type === 'dm' ? (
          <span className="text-[17px] font-bold">B</span>
        ) : type === 'action' ? (
          actionType === 'add' ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
            </svg>
          ) : actionType === 'explore' ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-2.5l7.51-3.49L17.5 6.5 9.99 9.99 6.5 17.5zm5.5-6.6c.61 0 1.1.49 1.1 1.1s-.49 1.1-1.1 1.1-1.1-.49-1.1-1.1.49-1.1 1.1-1.1z" />
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
  const showExplore = useUIStore((s) => s.showExplore);
  const setShowExplore = useUIStore((s) => s.setShowExplore);
  const openModal = useUIStore((s) => s.openModal);
  const addToast = useUIStore((s) => s.addToast);
  const unreadChannels = useChatStore((s) => s.unreadChannels);
  const instances = useInstanceStore((s) => s.instances);
  const navigate = useNavigate();

  // Group servers by origin
  const groupedServers = useMemo(() => {
    const home = servers.filter(s => !(s as any)._instanceOrigin);
    const remoteMap = new Map<string, typeof servers>();
    for (const s of servers) {
      const origin = (s as any)._instanceOrigin;
      if (!origin) continue;
      const list = remoteMap.get(origin) || [];
      list.push(s);
      remoteMap.set(origin, list);
    }
    return { home, remoteGroups: Array.from(remoteMap.entries()) };
  }, [servers]);

  // Set of disconnected origins
  const disconnectedOrigins = useMemo(() => {
    const set = new Set<string>();
    for (const inst of instances) {
      if (inst.status === 'disconnected' || inst.status === 'error') {
        set.add(inst.origin);
      }
    }
    return set;
  }, [instances]);

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
    const server = servers.find(s => s.id === serverId);
    const origin = (server as any)?._instanceOrigin;
    if (origin && disconnectedOrigins.has(origin)) {
      const inst = instances.find(i => i.origin === origin);
      addToast(`Reconnecting to ${inst?.label || 'remote instance'}...`, 'warning', 4000);
      return;
    }
    setCurrentServer(serverId);
    setShowDms(false);
    setShowExplore(false);
    navigate(`/channels/${serverId}`);
  };

  const handleDmClick = () => {
    setShowDms(true);
    setCurrentServer(null);
    navigate('/channels/@me');
  };

  const handleExploreClick = () => {
    setShowExplore(true);
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

      {/* Home servers */}
      {groupedServers.home.map((server) => (
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

      {/* Remote instance groups */}
      {groupedServers.remoteGroups.map(([origin, groupServers]) => {
        const inst = instances.find(i => i.origin === origin);
        const label = inst?.label || (() => { try { return new URL(origin).host; } catch { return '?'; } })();
        const isDimmed = disconnectedOrigins.has(origin);
        return (
          <React.Fragment key={origin}>
            <div className="w-8 h-[2px] bg-interactive-muted/50 rounded-full my-1" />
            <div className="text-[9px] text-txt-tertiary font-medium uppercase tracking-wider mb-1 truncate max-w-[52px] text-center" title={label}>
              {label}
            </div>
            {groupServers.map((server) => (
              <SidebarItem
                key={server.id}
                id={server.id}
                name={server.name}
                icon={server.icon}
                active={currentServerId === server.id}
                onClick={() => handleServerClick(server.id)}
                hasUnread={unreadServerIds.has(server.id)}
                dimmed={isDimmed}
              />
            ))}
          </React.Fragment>
        );
      })}

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

      <SidebarItem
        id="explore"
        name="Explore Servers"
        active={showExplore}
        onClick={handleExploreClick}
        type="action"
        actionType="explore"
      />

    </nav>
  );
}
