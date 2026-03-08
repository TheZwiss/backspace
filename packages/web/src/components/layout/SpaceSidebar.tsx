import React, { useState, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useInstanceStore } from '../../stores/instanceStore';

import { getSpaceGradient, HOME_GRADIENT } from '../../utils/gradients';

interface SidebarItemProps {
  id: string;
  name: string;
  icon?: string | null;
  active: boolean;
  onClick: () => void;
  type?: 'space' | 'dm' | 'action';
  actionType?: 'add' | 'join' | 'explore';
  hasUnread?: boolean;
  dimmed?: boolean;
}

function SidebarItem({ id, name, icon, active, onClick, type = 'space', actionType, hasUnread, dimmed }: SidebarItemProps) {
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

    // Space type — if it has a custom icon image, no gradient needed
    if (icon) return undefined;

    const spaceGrad = getSpaceGradient(id, name);
    return { background: spaceGrad.gradient };
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
      {(type === 'space' || type === 'dm') && (
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

export function SpaceSidebar() {
  const spaces = useSpaceStore((s) => s.spaces);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const setCurrentSpace = useSpaceStore((s) => s.setCurrentSpace);
  const channelToSpaceMap = useSpaceStore((s) => s.channelToSpaceMap);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const showDms = useUIStore((s) => s.showDms);
  const setShowDms = useUIStore((s) => s.setShowDms);
  const openModal = useUIStore((s) => s.openModal);
  const addToast = useUIStore((s) => s.addToast);
  const setCurrentChannel = useChatStore((s) => s.setCurrentChannel);
  const unreadChannels = useChatStore((s) => s.unreadChannels);
  const instances = useInstanceStore((s) => s.instances);
  const navigate = useNavigate();
  const location = useLocation();

  // Group spaces by origin
  const groupedSpaces = useMemo(() => {
    const home = spaces.filter(s => !(s as any)._instanceOrigin);
    const remoteMap = new Map<string, typeof spaces>();
    for (const s of spaces) {
      const origin = (s as any)._instanceOrigin;
      if (!origin) continue;
      const list = remoteMap.get(origin) || [];
      list.push(s);
      remoteMap.set(origin, list);
    }
    return { home, remoteGroups: Array.from(remoteMap.entries()) };
  }, [spaces]);

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

  // Compute which spaces have unread channels
  const unreadSpaceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const channelId of unreadChannels) {
      const spaceId = channelToSpaceMap.get(channelId);
      if (spaceId) ids.add(spaceId);
    }
    return ids;
  }, [unreadChannels, channelToSpaceMap]);

  // Check if any DM channels are unread
  const hasDmUnread = useMemo(() => {
    for (const dm of dmChannels) {
      if (unreadChannels.has(dm.id)) return true;
    }
    return false;
  }, [unreadChannels, dmChannels]);

  const handleSpaceClick = (spaceId: string) => {
    const space = spaces.find(s => s.id === spaceId);
    const origin = (space as any)?._instanceOrigin;
    if (origin && disconnectedOrigins.has(origin)) {
      const inst = instances.find(i => i.origin === origin);
      addToast(`Reconnecting to ${inst?.label || 'remote instance'}...`, 'warning', 4000);
      return;
    }
    setCurrentSpace(spaceId);
    setShowDms(false);
    navigate(`/channels/${spaceId}`);
  };

  const handleDmClick = () => {
    setShowDms(true);
    setCurrentSpace(null);
    setCurrentChannel(null);
    navigate('/channels/@me');
  };

  const handleExploreClick = () => {
    setCurrentSpace(null);
    setCurrentChannel(null);
    navigate('/explore');
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

      {/* Home spaces */}
      {groupedSpaces.home.map((space) => (
        <SidebarItem
          key={space.id}
          id={space.id}
          name={space.name}
          icon={space.icon}
          active={currentSpaceId === space.id}
          onClick={() => handleSpaceClick(space.id)}
          hasUnread={unreadSpaceIds.has(space.id)}
        />
      ))}

      {/* Remote instance groups */}
      {groupedSpaces.remoteGroups.map(([origin, groupSpaces]) => {
        const inst = instances.find(i => i.origin === origin);
        const label = inst?.label || (() => { try { return new URL(origin).host; } catch { return '?'; } })();
        const isDimmed = disconnectedOrigins.has(origin);
        return (
          <React.Fragment key={origin}>
            <div className="w-8 h-[2px] bg-interactive-muted/50 rounded-full my-1" />
            <div className="text-[9px] text-txt-tertiary font-medium uppercase tracking-wider mb-1 truncate max-w-[52px] text-center" title={label}>
              {label}
            </div>
            {groupSpaces.map((space) => (
              <SidebarItem
                key={space.id}
                id={space.id}
                name={space.name}
                icon={space.icon}
                active={currentSpaceId === space.id}
                onClick={() => handleSpaceClick(space.id)}
                hasUnread={unreadSpaceIds.has(space.id)}
                dimmed={isDimmed}
              />
            ))}
          </React.Fragment>
        );
      })}

      <div className="w-8 h-[2px] bg-interactive-muted rounded-full mb-1.5" />

      <SidebarItem
        id="add-space"
        name="Add a Space"
        active={false}
        onClick={() => openModal('createSpace')}
        type="action"
        actionType="add"
      />

      <SidebarItem
        id="join-space"
        name="Join a Space"
        active={false}
        onClick={() => openModal('joinSpace')}
        type="action"
        actionType="join"
      />

      <SidebarItem
        id="explore"
        name="Explore Spaces"
        active={location.pathname === '/explore'}
        onClick={handleExploreClick}
        type="action"
        actionType="explore"
      />

    </nav>
  );
}
