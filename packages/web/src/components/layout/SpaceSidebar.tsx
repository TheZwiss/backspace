import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useInstanceStore } from '../../stores/instanceStore';
import { useAuthStore } from '../../stores/authStore';
import { Tooltip } from '../ui/Tooltip';

import { getSpaceGradient, HOME_GRADIENT } from '../../utils/gradients';

interface SidebarItemProps {
  id: string;
  name: string;
  icon?: string | null;
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  type?: 'space' | 'dm' | 'action';
  actionType?: 'add' | 'join' | 'explore';
  hasUnread?: boolean;
  dimmed?: boolean;
  federationBadge?: boolean;
  federationDisconnected?: boolean;
  tooltipText?: string;
}

function SidebarItem({ id, name, icon, active, onClick, onContextMenu, type = 'space', actionType, hasUnread, dimmed, federationBadge, federationDisconnected, tooltipText }: SidebarItemProps) {
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

  const buttonContent = (
    <button onClick={onClick} className={`${getButtonClasses()} ${dimmed ? 'opacity-40 saturate-50' : ''}`} style={backgroundStyle} title={tooltipText ? undefined : name}>
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
  );

  const innerContent = (
    <div className="relative">
      {buttonContent}
      {federationBadge && (
        <div className="absolute -bottom-0.5 -right-0.5 w-[14px] h-[14px] rounded-full bg-surface-base flex items-center justify-center">
          {federationDisconnected ? (
            <div className="w-[8px] h-[8px] rounded-full bg-accent-amber" />
          ) : (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary/80">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
            </svg>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div
      className="relative flex items-center mb-1.5 w-full justify-center"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onContextMenu={onContextMenu}
    >
      {/* Pill Indicator */}
      {(type === 'space' || type === 'dm') && (
        <div className="absolute -left-0 w-2 h-10 flex items-center">
          <div
            className={`bg-white rounded-r-full transition-all duration-200 origin-left ${getPillHeight()} w-1`}
          />
        </div>
      )}

      {tooltipText ? (
        <Tooltip content={tooltipText} position="right" delay={300}>
          {innerContent}
        </Tooltip>
      ) : (
        innerContent
      )}
    </div>
  );
}

function InstanceDivider({ label, disconnected }: { label: string; disconnected: boolean }) {
  return (
    <Tooltip content={label} position="right" delay={300}>
      <div className="relative flex items-center justify-center w-full my-2">
        <div className="absolute inset-x-5 h-[1px] bg-interactive-muted/30 rounded-full" />
        <div className={`relative z-[1] w-5 h-5 rounded-full bg-surface-base flex items-center justify-center ${
          disconnected ? 'text-accent-amber' : 'text-txt-tertiary'
        }`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="opacity-60">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
          </svg>
        </div>
      </div>
    </Tooltip>
  );
}

function SpaceContextMenu({ spaceId, x, y, onClose }: { spaceId: string; x: number; y: number; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const space = useSpaceStore((s) => s.spaces.find(sp => sp.id === spaceId));
  const currentUserId = useAuthStore((s) => s.user?.id);
  const leaveSpace = useSpaceStore((s) => s.leaveSpace);
  const generateInvite = useSpaceStore((s) => s.generateInvite);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const setCurrentSpace = useSpaceStore((s) => s.setCurrentSpace);
  const setShowDms = useUIStore((s) => s.setShowDms);
  const addToast = useUIStore((s) => s.addToast);
  const navigate = useNavigate();
  const [showTransferModal, setShowTransferModal] = useState(false);

  const isOwner = space?.ownerId === currentUserId;

  // Close on click-outside and scroll
  useEffect(() => {
    if (showTransferModal) return; // Don't close when transfer modal is open
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleScroll = () => onClose();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, showTransferModal]);

  if (!space) return null;

  const handleInvite = async () => {
    try {
      const code = await generateInvite(spaceId);
      const origin = (space as any)._instanceOrigin || window.location.origin;
      const url = `${origin}/invite/${code}`;
      await navigator.clipboard.writeText(url);
      addToast('Invite link copied to clipboard', 'success', 3000);
    } catch {
      addToast('Failed to generate invite', 'warning', 3000);
    }
    onClose();
  };

  if (showTransferModal) {
    return (
      <TransferOwnershipModal
        spaceId={spaceId}
        onClose={onClose}
      />
    );
  }

  // Viewport-aware clamping — always 2 items (Invite + Transfer or Invite + Leave)
  const menuWidth = 200;
  const menuHeight = 2 * 32 + 8;
  const clampedX = Math.min(x, window.innerWidth - menuWidth - 8);
  const clampedY = Math.min(y, window.innerHeight - menuHeight - 8);

  return ReactDOM.createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[160px] bg-surface-overlay rounded-lg border border-white/[0.07] shadow-lg py-1 animate-in fade-in zoom-in-95 duration-100"
      style={{ left: clampedX, top: clampedY }}
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-txt-primary hover:bg-white/[0.06] transition-colors"
        onClick={handleInvite}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
        </svg>
        Invite People
      </button>
      {isOwner ? (
        <button
          className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-accent-amber hover:bg-accent-amber/10 transition-colors"
          onClick={() => setShowTransferModal(true)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 13h-3V3h-2v10H8l4 4 4-4zM4 19v2h16v-2H4z" />
          </svg>
          Transfer Ownership
        </button>
      ) : (
        <button
          className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-accent-rose hover:bg-accent-rose/10 transition-colors"
          onClick={() => {
            if (currentSpaceId === spaceId) {
              navigate('/channels/@me');
              setCurrentSpace(null);
              setShowDms(true);
            }
            leaveSpace(spaceId);
            onClose();
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 00-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 002 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
          </svg>
          Leave Space
        </button>
      )}
    </div>,
    document.body,
  );
}

function TransferOwnershipModal({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const modalRef = useRef<HTMLDivElement>(null);
  const space = useSpaceStore((s) => s.spaces.find(sp => sp.id === spaceId));
  const members = useSpaceStore((s) => s.members);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const transferOwnership = useSpaceStore((s) => s.transferOwnership);
  const addToast = useUIStore((s) => s.addToast);

  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);

  // Filter members: exclude self, filter by search
  const filteredMembers = useMemo(() => {
    const spaceMembers = members.filter(m => m.userId !== currentUserId);
    if (!search.trim()) return spaceMembers;
    const q = search.toLowerCase();
    return spaceMembers.filter(m =>
      m.user.displayName?.toLowerCase().includes(q) ||
      m.user.username.toLowerCase().includes(q)
    );
  }, [members, currentUserId, search]);

  const selectedMember = selectedUserId ? members.find(m => m.userId === selectedUserId) : null;

  // Close on click-outside and escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedUserId) {
          setSelectedUserId(null);
        } else {
          onClose();
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, selectedUserId]);

  if (!space) return null;

  const handleTransfer = async () => {
    if (!selectedUserId) return;
    setTransferring(true);
    try {
      await transferOwnership(spaceId, selectedUserId);
      addToast(`Ownership transferred to ${selectedMember?.user.displayName || selectedMember?.user.username}`, 'success', 3000);
      onClose();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to transfer ownership', 'warning', 3000);
    } finally {
      setTransferring(false);
    }
  };

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50">
      <div
        ref={modalRef}
        className="w-[380px] max-h-[480px] bg-surface-overlay rounded-xl border border-white/[0.07] shadow-2xl flex flex-col animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-white/[0.06]">
          <h3 className="text-base font-semibold text-txt-primary">Transfer Ownership</h3>
          <p className="text-xs text-txt-tertiary mt-0.5">
            Choose a member to become the new owner of <span className="font-medium text-txt-secondary">{space.name}</span>
          </p>
        </div>

        {selectedUserId && selectedMember ? (
          /* Confirm step */
          <div className="p-4 flex flex-col gap-4">
            <div className="p-3 rounded-lg bg-accent-amber/10 border border-accent-amber/20">
              <p className="text-sm text-txt-secondary">
                Transfer ownership of <span className="font-semibold text-txt-primary">{space.name}</span> to{' '}
                <span className="font-semibold text-txt-primary">{selectedMember.user.displayName || selectedMember.user.username}</span>?
              </p>
              <p className="text-xs text-txt-tertiary mt-1.5">You will become a regular member.</p>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setSelectedUserId(null)}
                className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary transition-colors"
                disabled={transferring}
              >
                Cancel
              </button>
              <button
                onClick={handleTransfer}
                disabled={transferring}
                className="px-3 py-1.5 bg-accent-amber hover:bg-accent-amber/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
              >
                {transferring ? 'Transferring...' : 'Transfer'}
              </button>
            </div>
          </div>
        ) : (
          /* Member list */
          <>
            <div className="px-3 pt-3">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search members..."
                className="w-full px-3 py-1.5 bg-surface-input rounded text-sm text-txt-primary placeholder-txt-tertiary outline-none focus:ring-1 focus:ring-accent-primary/50"
                autoFocus
              />
            </div>
            <div className="flex-1 overflow-y-auto p-2 min-h-0">
              {filteredMembers.length === 0 ? (
                <p className="text-xs text-txt-tertiary text-center py-4">No members found</p>
              ) : (
                filteredMembers.map((member) => {
                  const avatarUrl = member.user.avatar
                    ? (member.user.avatar.startsWith('http') ? member.user.avatar : `/api/uploads/${member.user.avatar}`)
                    : null;
                  return (
                    <button
                      key={member.userId}
                      onClick={() => setSelectedUserId(member.userId)}
                      className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06] transition-colors"
                    >
                      <div className="w-8 h-8 rounded-full bg-surface-input flex-shrink-0 overflow-hidden flex items-center justify-center">
                        {avatarUrl ? (
                          <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-xs font-bold text-txt-secondary">
                            {(member.user.displayName || member.user.username).charAt(0).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-col items-start min-w-0">
                        <span className="text-sm text-txt-primary truncate max-w-full">
                          {member.user.displayName || member.user.username}
                        </span>
                        {member.user.displayName && (
                          <span className="text-[11px] text-txt-tertiary truncate max-w-full">
                            {member.user.username}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
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
  const floatingPanelHeight = useUIStore((s) => s.floatingPanelHeight);
  const setCurrentChannel = useChatStore((s) => s.setCurrentChannel);
  const unreadChannels = useChatStore((s) => s.unreadChannels);
  const instances = useInstanceStore((s) => s.instances);
  const navigate = useNavigate();
  const location = useLocation();

  // Single context menu state
  const [contextMenu, setContextMenu] = useState<{ spaceId: string; x: number; y: number } | null>(null);

  const handleSpaceContextMenu = useCallback((spaceId: string, e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ spaceId, x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

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
    <nav data-pip-obstacle="left" className="w-[72px] bg-surface-base flex flex-col items-center py-3 overflow-y-auto flex-shrink-0 no-scrollbar select-none md:fixed md:inset-y-0 md:left-0 md:z-[100] md:glass-strip" style={{ paddingBottom: floatingPanelHeight + 24 }}>
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
          onContextMenu={(e) => handleSpaceContextMenu(space.id, e)}
          hasUnread={unreadSpaceIds.has(space.id)}
          tooltipText={space.name}
        />
      ))}

      {/* Remote instance groups */}
      {groupedSpaces.remoteGroups.map(([origin, groupSpaces]) => {
        const inst = instances.find(i => i.origin === origin);
        const hostLabel = (() => { try { return new URL(origin).host; } catch { return '?'; } })();
        const label = inst?.label || hostLabel;
        const isDimmed = disconnectedOrigins.has(origin);
        return (
          <React.Fragment key={origin}>
            <InstanceDivider
              label={isDimmed ? `${label} (disconnected)` : label}
              disconnected={isDimmed}
            />
            {groupSpaces.map((space) => (
              <SidebarItem
                key={space.id}
                id={space.id}
                name={space.name}
                icon={space.icon}
                active={currentSpaceId === space.id}
                onClick={() => handleSpaceClick(space.id)}
                onContextMenu={(e) => handleSpaceContextMenu(space.id, e)}
                hasUnread={unreadSpaceIds.has(space.id)}
                dimmed={isDimmed}
                federationBadge
                federationDisconnected={isDimmed}
                tooltipText={`${space.name} \u00b7 ${hostLabel}`}
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

      {contextMenu && (
        <SpaceContextMenu
          spaceId={contextMenu.spaceId}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
        />
      )}
    </nav>
  );
}
