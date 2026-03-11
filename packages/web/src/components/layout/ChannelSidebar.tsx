import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSpaceStore, getChannelOrigin, getMyUserIdForOrigin } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { useInstanceStore } from '../../stores/instanceStore';
import { VoiceChannel } from '../voice/VoiceChannel';
import { VoiceControls } from '../voice/VoiceControls';
import { useVoiceStore } from '../../stores/voiceStore';
import { Avatar } from '../ui/Avatar';
import { Username } from '../ui/Username';
import { wsSend } from '../../hooks/useWebSocket';
import { AudioManager } from '../../audio/AudioManager';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { parseFederatedUsername, isSelf } from '../../utils/identity';
import { joinVoiceChannel, broadcastVoiceStatus, broadcastDeafenViaLiveKit } from '../../utils/voice';
import { ContextMenu } from '../ui/ContextMenu';

export function ChannelSidebar() {
  const spaces = useSpaceStore((s) => s.spaces);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const channels = useSpaceStore((s) => s.channels);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const currentChannelId = useChatStore((s) => s.currentChannelId);
  const setCurrentChannel = useChatStore((s) => s.setCurrentChannel);
  const unreadChannels = useChatStore((s) => s.unreadChannels);
  const openModal = useUIStore((s) => s.openModal);
  const user = useAuthStore((s) => s.user);
  const members = useSpaceStore((s) => s.members);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const activeDmCall = useVoiceStore((s) => s.activeDmCall);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const toggleMic = useVoiceStore((s) => s.toggleMic);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const spaceId = useSpaceStore((s) => currentVoiceChannelId ? s.channelToSpaceMap.get(currentVoiceChannelId) : null);
  const myOriginId = useSpaceStore((s) => currentVoiceChannelId ? getMyUserIdForOrigin(getChannelOrigin(currentVoiceChannelId)) : s.members.find(m => m.userId === user?.id)?.userId ?? user?.id);
  const spaceMutedUserIds = useVoiceStore((s) => s.spaceMutedUserIds);
  const spaceDeafenedUserIds = useVoiceStore((s) => s.spaceDeafenedUserIds);
  const permissionMutedUserIds = useVoiceStore((s) => s.permissionMutedUserIds);

  // Drag-and-drop state for moving users between voice channels
  const [voiceDragState, setVoiceDragState] = useState<{ userId: string; fromChannelId: string } | null>(null);
  const isSpaceMuted = !!(myOriginId && spaceId && spaceMutedUserIds.has(`${spaceId}:${myOriginId}`));
  const isSpaceDeafened = !!(myOriginId && spaceId && spaceDeafenedUserIds.has(`${spaceId}:${myOriginId}`));
  const isPermissionMuted = !!(myOriginId && spaceId && permissionMutedUserIds.has(`${spaceId}:${myOriginId}`));
  const navigate = useNavigate();
  const location = useLocation();

  const floatingPanelRef = useRef<HTMLDivElement>(null);
  const floatingPanelHeight = useUIStore((s) => s.floatingPanelHeight);
  const setFloatingPanelHeight = useUIStore((s) => s.setFloatingPanelHeight);

  useEffect(() => {
    const el = floatingPanelRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setFloatingPanelHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [setFloatingPanelHeight]);

  const handleMicToggle = async () => {
    if (isSpaceMuted || isSpaceDeafened || isPermissionMuted) return;
    const wasDeafened = useVoiceStore.getState().isDeafened;
    toggleMic();
    broadcastVoiceStatus();
    // If unmuting while deafened cleared deafen, broadcast via LiveKit data channel
    if (wasDeafened && !useVoiceStore.getState().isDeafened) {
      broadcastDeafenViaLiveKit();
    }
  };

  const handleDeafenToggle = async () => {
    if (isSpaceDeafened) return;
    toggleDeafen();
    broadcastVoiceStatus();
    broadcastDeafenViaLiveKit();
  };

  const spacePermissions = useSpaceStore((s) => s.spacePermissions);
  const space = spaces.find(s => s.id === currentSpaceId);
  const mySpacePerms = currentSpaceId ? spacePermissions.get(currentSpaceId) : undefined;

  const federationInstances = useInstanceStore((s) => s.instances);
  const instanceLabel = useMemo(() => {
    const origin = (space as any)?._instanceOrigin;
    if (!origin) return null;
    const inst = federationInstances.find(i => i.origin === origin);
    if (inst) return inst.label;
    try { return new URL(origin).host; } catch { return origin; }
  }, [space, federationInstances]);
  const channelPermissions = useSpaceStore((s) => s.channelPermissions);
  const canManageChannels = hasPermissionBit(mySpacePerms, PermissionBits.MANAGE_CHANNELS);
  const canCreateInvite = hasPermissionBit(mySpacePerms, PermissionBits.CREATE_INVITE);

  const textChannels = channels.filter(c => c.type === 'text');
  const voiceChannels = channels.filter(c => c.type === 'voice' || c.type === 'video');

  const handleChannelClick = (channelId: string) => {
    setCurrentChannel(channelId);
    navigate(`/channels/${currentSpaceId || '@me'}/${channelId}`);
  };

  const handleHomeClick = () => {
    setCurrentChannel(null);
    navigate('/channels/@me');
  };

  const handleVoiceJoin = (channelId: string) => {
    // Don't re-join the same channel — prevents duplicate LiveKit connections
    if (currentVoiceChannelId === channelId) {
      navigate(`/channels/${currentSpaceId}/${channelId}`);
      return;
    }
    joinVoiceChannel(channelId);
    navigate(`/channels/${currentSpaceId}/${channelId}`);
  };

  // Floating bottom panel — shared between DM view and server view
  const floatingPanel = user ? (
    <div ref={floatingPanelRef} data-pip-obstacle="bottom" className="fixed bottom-0 left-0 right-0 z-[105] p-2 md:right-auto md:w-[296px] md:bottom-[10px] md:left-[10px] md:p-0">
      <div className="glass-bubble rounded-[14px]">
        {/* Voice controls (expands when connected) */}
        {(currentVoiceChannelId || activeDmCall) && <VoiceControls />}
        {/* Separator between voice and user area */}
        {(currentVoiceChannelId || activeDmCall) && <div className="mx-3 border-t border-white/[0.06]" />}
        {/* User area (always visible) */}
        <UserAreaPanel
          user={user}
          isMuted={isMuted}
          isDeafened={isDeafened}
          isSpaceMuted={isSpaceMuted}
          isSpaceDeafened={isSpaceDeafened}
          isPermissionMuted={isPermissionMuted}
          onMicToggle={handleMicToggle}
          onDeafenToggle={handleDeafenToggle}
          onSettingsClick={(tab) => openModal('userSettings', tab ? { tab } : {})}
        />
      </div>
    </div>
  ) : null;

  if (!space) {
    return (
      <>
      <div className="w-60 md:w-full bg-surface-channel flex flex-col flex-shrink-0 select-none md:pl-[72px] border-r border-border-hard">
        <div className="h-12 px-[10px] flex items-center border-b border-border-hard z-10">
          <button className="flex-1 bg-surface-base text-txt-tertiary text-[13px] font-medium py-[5px] px-2 rounded-[4px] text-left hover:bg-surface-base transition-colors">
            Find or start a conversation
          </button>
        </div>
        <div className="flex-1 overflow-y-auto pt-4 px-2 no-scrollbar" style={{ paddingBottom: floatingPanelHeight + 24 }}>
          <div
            onClick={handleHomeClick}
            className={`flex items-center gap-3 px-2 h-[42px] rounded-[4px] cursor-pointer mb-[2px] transition-colors group ${
              !currentChannelId && location.pathname !== '/explore'
                ? 'bg-interactive-selected text-white'
                : 'text-txt-tertiary hover:bg-interactive-hover hover:text-txt-secondary'
            }`}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className={`flex-shrink-0 ${!currentChannelId ? 'text-white' : 'opacity-70 group-hover:opacity-100'}`}>
              <path d="M13 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-2-4a2 2 0 1 1 4 0 2 2 0 0 1-4 0Z" />
              <path d="M3 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-1c0-2.76-5.37-4-8-4s-8 1.24-8 4v1Z" />
              <path d="M3.5 13.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" opacity=".5" />
            </svg>
            <span className="font-medium text-[16px]">Friends</span>
          </div>

          {/* Placeholder nav items */}
          <div
            className="flex items-center gap-3 px-2 h-[42px] rounded-[4px] mb-[2px] text-txt-tertiary cursor-default opacity-50"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
            </svg>
            <span className="font-medium text-[16px]">Coming Soon</span>
          </div>
          <div
            className="flex items-center gap-3 px-2 h-[42px] rounded-[4px] mb-[2px] text-txt-tertiary cursor-default opacity-50"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
              <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z" />
            </svg>
            <span className="font-medium text-[16px]">Coming Soon</span>
          </div>

          <div className="mt-[18px] px-2 mb-1 flex items-center justify-between group">
            <span className="text-[12px] font-bold text-txt-tertiary uppercase tracking-wider">Direct Messages</span>
            <button
              onClick={() => openModal('newDm')}
              className="text-txt-tertiary hover:text-txt-primary transition-colors"
              title="New Direct Message"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z" />
              </svg>
            </button>
          </div>

          <div className="space-y-[2px]">
            {dmChannels.map((dm) => {
              const otherMembers = dm.members.filter(m => !isSelf(m, user));
              if (otherMembers.length === 0) return null;
              const isGroup = dm.members.length > 2;
              const isDmUnread = unreadChannels.has(dm.id) && currentChannelId !== dm.id;

              const dmDisplayName = isGroup
                ? otherMembers.map(m => m.displayName ?? parseFederatedUsername(m.username).baseName).join(', ')
                : otherMembers[0]?.displayName ?? otherMembers[0]?.username;

              const dmItem = (
                <div
                  key={dm.id}
                  onClick={() => handleChannelClick(dm.id)}
                  className={`relative flex items-center gap-3 px-2 h-[42px] rounded-[4px] cursor-pointer transition-colors group ${
                    currentChannelId === dm.id
                      ? 'bg-interactive-selected text-white'
                      : isDmUnread
                        ? 'text-white hover:bg-interactive-hover'
                        : 'text-txt-tertiary hover:bg-interactive-hover hover:text-txt-secondary'
                  }`}
                >
                  {isDmUnread && (
                    <div className="absolute -left-1 w-1 h-2 bg-white rounded-r-full" />
                  )}
                  {isGroup ? (
                    <div className="relative w-8 h-8 flex-shrink-0">
                      {otherMembers.slice(0, 2).map((m, i) => (
                        <div
                          key={m.id}
                          className="absolute rounded-full overflow-hidden border-2 border-surface-channel"
                          style={{
                            width: 22, height: 22,
                            left: i * 10,
                            top: i * 6,
                            zIndex: 2 - i,
                          }}
                        >
                          <Avatar src={m.avatar} name={m.displayName ?? parseFederatedUsername(m.username).baseName} size={22} userId={m.homeUserId ?? m.id} user={m} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Avatar src={otherMembers[0]?.avatar} name={otherMembers[0]?.displayName ?? parseFederatedUsername(otherMembers[0]?.username ?? '').baseName} size={32} status={otherMembers[0]?.status as any} userId={otherMembers[0]?.homeUserId ?? otherMembers[0]?.id} user={otherMembers[0]} />
                  )}
                  <div className="flex-1 min-w-0">
                    <Username
                      username={dmDisplayName ?? ''}
                      className={`text-[15px] truncate leading-tight block ${
                        currentChannelId === dm.id ? 'text-white font-medium'
                          : isDmUnread ? 'text-white font-bold'
                          : 'text-txt-tertiary group-hover:text-txt-secondary font-medium'
                      }`}
                    />
                    {isGroup ? (
                      <div className="text-[12px] text-txt-tertiary truncate leading-tight mt-0.5">
                        {dm.members.length} Members
                      </div>
                    ) : dm.lastMessage ? (
                      <div className="text-[12px] text-txt-tertiary truncate leading-tight mt-0.5">
                        {dm.lastMessage.content}
                      </div>
                    ) : null}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      // Navigate away if currently viewing this DM
                      if (currentChannelId === dm.id) {
                        navigate('/channels/@me');
                        setCurrentChannel(null);
                      }
                      useSpaceStore.getState().closeDm(dm.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-txt-tertiary hover:text-txt-primary transition-opacity flex-shrink-0 ml-1"
                    title="Close DM"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
                    </svg>
                  </button>
                </div>
              );

              if (isGroup) {
                return (
                  <ContextMenu
                    key={dm.id}
                    items={[
                      {
                        label: 'Leave Group',
                        danger: true,
                        icon: (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 00-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 002 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                          </svg>
                        ),
                        onClick: () => {
                          if (currentChannelId === dm.id) {
                            navigate('/channels/@me');
                            setCurrentChannel(null);
                          }
                          useSpaceStore.getState().leaveDm(dm.id);
                        },
                      },
                    ]}
                  >
                    {dmItem}
                  </ContextMenu>
                );
              }

              return dmItem;
            })}
            {dmChannels.length === 0 && (
              <p className="px-2 py-4 text-[13px] text-txt-tertiary italic opacity-60">No DM conversations yet.</p>
            )}
          </div>
        </div>

      </div>
      {floatingPanel}
      </>
    );
  }

  return (
    <>
    <div className="w-60 md:w-full bg-surface-channel flex flex-col flex-shrink-0 select-none md:pl-[72px] border-r border-border-hard">
      {/* Space header */}
      <div className="h-12 flex items-center border-b border-border-hard z-10 group/header">
        <button
          onClick={() => openModal('spaceSettings')}
          className="flex-1 h-full px-4 flex items-center justify-between hover:bg-interactive-hover transition-colors min-w-0"
        >
          <div className="min-w-0">
            <span className="font-bold text-[15px] tracking-[-0.02em] text-txt-primary truncate leading-tight block">{space.name}</span>
            {instanceLabel && (
              <span className="text-[10px] text-txt-tertiary font-medium truncate block leading-tight">
                {instanceLabel}
              </span>
            )}
          </div>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" className="text-txt-tertiary flex-shrink-0">
            <path d="M5.293 7.293a1 1 0 011.414 0L9 9.586l2.293-2.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" />
          </svg>
        </button>
        {canCreateInvite && (
          <button
            onClick={() => openModal('invite')}
            className="w-10 h-full flex items-center justify-center text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover transition-all flex-shrink-0"
            title="Invite People"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21 3H24V5H21V8H19V5H16V3H19V0H21V3ZM10 12C12.21 12 14 10.21 14 8C14 5.79 12.21 4 10 4C7.79 4 6 5.79 6 8C6 10.21 7.79 12 10 12ZM10 13C6.69 13 1 14.66 1 18V20H19V18C19 14.66 13.31 13 10 13Z" />
            </svg>
          </button>
        )}
      </div>

      {/* Channels */}
      <div className="flex-1 overflow-y-auto pt-3 px-2 space-y-[21px] no-scrollbar" style={{ paddingBottom: floatingPanelHeight + 24 }}>
        {/* Text Channels */}
        <div>
          <div className="flex items-center justify-between px-1 mb-1 group cursor-pointer">
            <div className="flex items-center gap-0.5 text-txt-tertiary hover:text-txt-secondary transition-colors">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="opacity-70">
                <path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z" />
              </svg>
              <span className="text-[11px] font-medium uppercase tracking-[0.06em]" style={{ color: '#484854' }}>Text Channels</span>
            </div>
            {canManageChannels && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openModal('createChannel');
                }}
                className="text-txt-tertiary hover:text-txt-primary transition-colors"
                title="Create Channel"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z" />
                </svg>
              </button>
            )}
          </div>
          <div className="space-y-[2px]">
            {textChannels.map((channel) => {
              const isActive = currentChannelId === channel.id;
              const isUnread = unreadChannels.has(channel.id) && !isActive;
              return (
                <button
                  key={channel.id}
                  onClick={() => handleChannelClick(channel.id)}
                  className={`relative w-full flex items-center gap-1.5 px-[10px] h-8 rounded-[6px] group transition-colors ${
                    isActive
                      ? 'bg-surface-elevated text-txt-primary'
                      : isUnread
                        ? 'text-white hover:text-white hover:bg-interactive-hover'
                        : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
                  }`}
                >
                  {isActive && (
                    <div
                      className="absolute -left-[2px] top-1/2 -translate-y-1/2 w-[3px] bg-white rounded-r-full"
                      style={{ height: '55%', opacity: 0.7 }}
                    />
                  )}
                  {isUnread && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-accent-rose" />
                  )}
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0 text-[#6e6e7a]">
                    <path d="M5.88657 21C5.57547 21 5.3399 20.7189 5.39427 20.4126L6.00001 17H2.59511C2.28449 17 2.04905 16.7198 2.10259 16.4138L2.27759 15.4138C2.31946 15.1746 2.52722 15 2.77011 15H6.35001L7.41001 9H4.00511C3.69449 9 3.45905 8.71977 3.51259 8.41381L3.68759 7.41381C3.72946 7.17456 3.93722 7 4.18011 7H7.76001L8.39677 3.41262C8.43914 3.17391 8.64664 3 8.88907 3H9.87344C10.1845 3 10.4201 3.28107 10.3657 3.58738L9.76001 7H15.76L16.3968 3.41262C16.4391 3.17391 16.6466 3 16.8891 3H17.8734C18.1845 3 18.4201 3.28107 18.3657 3.58738L17.76 7H21.1649C21.4755 7 21.711 7.28023 21.6574 7.58619L21.4824 8.58619C21.4406 8.82544 21.2328 9 20.9899 9H17.41L16.35 15H19.7549C20.0655 15 20.301 15.2802 20.2474 15.5862L20.0724 16.5862C20.0306 16.8254 19.8228 17 19.5799 17H16L15.3632 20.5874C15.3209 20.8261 15.1134 21 14.8709 21H13.8866C13.5755 21 13.3399 20.7189 13.3943 20.4126L14 17H8.00001L7.36325 20.5874C7.32088 20.8261 7.11337 21 6.87094 21H5.88657ZM9.41001 9L8.35001 15H14.35L15.41 9H9.41001Z" />
                  </svg>
                  <span className={`truncate text-[15px] flex-1 text-left ${isUnread ? 'font-semibold' : 'font-medium'}`}>{channel.name}</span>
                  {canManageChannels && (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className="flex-shrink-0 opacity-0 group-hover:opacity-100 text-txt-tertiary hover:text-txt-primary transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        openModal('channelSettings', { channelId: channel.id });
                      }}
                    >
                      <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Voice Channels */}
        <div>
          <div className="flex items-center justify-between px-1 mb-1 group cursor-pointer">
            <div className="flex items-center gap-0.5 text-txt-tertiary hover:text-txt-secondary transition-colors">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="opacity-70">
                <path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z" />
              </svg>
              <span className="text-[11px] font-medium uppercase tracking-[0.06em]" style={{ color: '#484854' }}>Voice Channels</span>
            </div>
            {canManageChannels && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openModal('createChannel');
                }}
                className="text-txt-tertiary hover:text-txt-primary transition-colors"
                title="Create Channel"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z" />
                </svg>
              </button>
            )}
          </div>
          <div className="space-y-[2px]">
            {voiceChannels.map((channel) => {
              const chPerms = channelPermissions.get(channel.id);
              const canConnect = hasPermissionBit(chPerms, PermissionBits.CONNECT);
              return (
                <VoiceChannel
                  key={channel.id}
                  channelId={channel.id}
                  channelName={channel.name}
                  onClick={() => canConnect && handleVoiceJoin(channel.id)}
                  locked={!canConnect}
                  dragState={voiceDragState}
                  onDragStart={(userId: string) => setVoiceDragState({ userId, fromChannelId: channel.id })}
                  onDragEnd={() => setVoiceDragState(null)}
                />
              );
            })}
          </div>
        </div>

      </div>

    </div>
    {floatingPanel}
    </>
  );
}

/* ─── User Area Panel ──────────────────────────────────────────────────────── */

function UserAreaPanel({
  user,
  isMuted,
  isDeafened,
  isSpaceMuted,
  isSpaceDeafened,
  isPermissionMuted,
  onMicToggle,
  onDeafenToggle,
  onSettingsClick,
}: {
  user: any;
  isMuted: boolean;
  isDeafened: boolean;
  isSpaceMuted: boolean;
  isSpaceDeafened: boolean;
  isPermissionMuted: boolean;
  onMicToggle: () => void;
  onDeafenToggle: () => void;
  onSettingsClick: (tab?: string) => void;
}) {
  const [openPanel, setOpenPanel] = useState<'input' | 'output' | null>(null);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const inputDeviceId = useVoiceStore((s) => s.inputDeviceId);
  const outputDeviceId = useVoiceStore((s) => s.outputDeviceId);
  const setInputDevice = useVoiceStore((s) => s.setInputDevice);
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice);
  
  const [selectedInputLabel, setSelectedInputLabel] = useState<string>('Default');
  const [selectedOutputLabel, setSelectedOutputLabel] = useState<string>('Default');

  const inputVolume = useVoiceStore((s) => s.inputVolume);
  const storeSetInputVolume = useVoiceStore((s) => s.setInputVolume);
  const outputVolume = useVoiceStore((s) => s.outputVolume);
  const storeSetOutputVolume = useVoiceStore((s) => s.setOutputVolume);
  const [showInputDeviceList, setShowInputDeviceList] = useState(false);
  const [showOutputDeviceList, setShowOutputDeviceList] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);

  const loadDevices = useCallback(async () => {
    try {
      // Need to request permission first to get labels
      if (!AudioManager.getInstance().getContext()) {
        await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      // Deduplicate by deviceId — USB devices sharing the same audio chipset
      // (e.g. C-Media 0d8c:0134) appear as multiple entries with identical IDs.
      const dedup = (list: MediaDeviceInfo[]): MediaDeviceInfo[] => {
        const seen = new Set<string>();
        return list.filter(d => {
          if (seen.has(d.deviceId)) return false;
          seen.add(d.deviceId);
          return true;
        });
      };
      const inputs = dedup(devices.filter(d => d.kind === 'audioinput'));
      const outputs = dedup(devices.filter(d => d.kind === 'audiooutput'));
      setInputDevices(inputs);
      setOutputDevices(outputs);
      
      const currentInput = inputs.find(d => d.deviceId === inputDeviceId);
      if (currentInput) setSelectedInputLabel(currentInput.label || 'Default');
      
      const currentOutput = outputs.find(d => d.deviceId === outputDeviceId);
      if (currentOutput) setSelectedOutputLabel(currentOutput.label || 'Default');
    } catch {
      // permission denied
    }
  }, [inputDeviceId, outputDeviceId]);

  // Start mic level monitoring when input panel opens
  useEffect(() => {
    if (openPanel !== 'input') {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      analyserRef.current = null;
      setMicLevel(0);
      return;
    }

    const start = async () => {
      try {
        await AudioManager.getInstance().resumeContext();
        const analyser = AudioManager.getInstance().getAnalyserNode();
        analyser.fftSize = 256;
        analyserRef.current = analyser;
        
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (!analyserRef.current) return;
          analyserRef.current.getByteFrequencyData(data);
          const avg = data.reduce((a, b) => a + b, 0) / data.length;
          setMicLevel(Math.min(avg / 128, 1));
          animFrameRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch { /* no mic access */ }
    };
    start();
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      analyserRef.current = null;
    };
  }, [openPanel]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpenPanel(null);
        setShowInputDeviceList(false);
        setShowOutputDeviceList(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const togglePanel = (panel: 'input' | 'output') => {
    if (openPanel === panel) {
      setOpenPanel(null);
    } else {
      loadDevices();
      setOpenPanel(panel);
      setShowInputDeviceList(false);
      setShowOutputDeviceList(false);
      // Explicitly resume on interaction
      AudioManager.getInstance().resumeContext();
    }
  };

  const selectInput = (device: MediaDeviceInfo) => {
    setInputDevice(device.deviceId); // Pure state update → triggers syncMic if in voice call
    AudioManager.getInstance().setInputDevice(device.deviceId); // Immediate preview for mic level meter
    setSelectedInputLabel(device.label || 'Default');
    setShowInputDeviceList(false);
  };

  const selectOutput = (device: MediaDeviceInfo) => {
    setOutputDevice(device.deviceId);
    setSelectedOutputLabel(device.label || 'Default');
    setShowOutputDeviceList(false);
    AudioManager.getInstance().setOutputDevice(device.deviceId);
  };

  // Generate mic level bars (20 bars like Discord)
  const micBars = 20;
  const activeBars = Math.round(micLevel * micBars * (inputVolume / 100));

  return (
    <div className="relative" ref={panelRef}>
      {/* Input settings panel */}
      {openPanel === 'input' && (
        <div className="absolute bottom-full left-0 right-0 mb-0 bg-surface-channel rounded-t-lg shadow-lg z-[150] border-t border-x border-border-hard">
          {/* Input Device */}
          <div className="relative">
            <button
              onClick={() => setShowInputDeviceList(!showInputDeviceList)}
              className="w-full px-4 py-3 flex items-center justify-between hover:bg-interactive-hover transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold text-txt-primary text-left">Input Device</div>
                <div className="text-[13px] text-txt-tertiary truncate text-left">{selectedInputLabel}</div>
              </div>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary flex-shrink-0 ml-2">
                <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
              </svg>
            </button>
            {showInputDeviceList && (
              <div className="bg-surface-base rounded-lg shadow-lg mx-2 mb-2 py-1 border border-border-hard">
                {inputDevices.map(d => (
                  <button
                    key={d.deviceId}
                    onClick={() => selectInput(d)}
                    className={`w-full px-3 py-2 text-left text-[13px] hover:bg-interactive-hover transition-colors flex items-center gap-2 ${
                      inputDeviceId === d.deviceId ? 'text-txt-primary' : 'text-txt-secondary'
                    }`}
                  >
                    {inputDeviceId === d.deviceId && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-accent-primary flex-shrink-0">
                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                      </svg>
                    )}
                    <span className={inputDeviceId === d.deviceId ? '' : 'pl-6'}>{d.label || 'Default'}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mx-4 border-t border-border-soft" />

                      {/* Input Volume */}
                      <div className="px-4 py-3">
                        <div className="text-[15px] font-semibold text-txt-primary mb-2">Input Volume</div>
                        <input
                          type="range"
                          min={0}
                          max={200}
                          value={inputVolume}
                          onChange={(e) => {
                            const vol = Number(e.target.value);
                            storeSetInputVolume(vol);
                          }}
                          className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-accent-primary bg-surface-base [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md"
                          style={{
                            background: `linear-gradient(to right, rgb(var(--accent-primary)) 0%, rgb(var(--accent-primary)) ${inputVolume / 2}%, rgb(var(--interactive-muted)) ${inputVolume / 2}%, rgb(var(--interactive-muted)) 100%)`,
                          }}
                        />
                        {/* Mic level meter */}
                        <div className="flex items-center gap-[3px] mt-2.5">
                          {Array.from({ length: micBars }).map((_, i) => (
                            <div
                              key={i}
                              className={`flex-1 h-[6px] rounded-[1px] transition-colors duration-75 ${
                                i < activeBars ? 'bg-txt-tertiary' : 'bg-interactive-muted'
                              }`}
                            />
                          ))}
                        </div>
                      </div>
          
                      <div className="mx-4 border-t border-border-soft" />
          
                      {/* Voice Settings link */}
                      <button
                        onClick={() => onSettingsClick('voice')}
                        className="w-full px-4 py-3 flex items-center justify-between hover:bg-interactive-hover transition-colors"
                      >
                        <span className="text-[15px] font-semibold text-txt-primary">Voice Settings</span>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
                          <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                        </svg>
                      </button>
                    </div>
                  )}
          
                  {/* Output settings panel */}
                  {openPanel === 'output' && (
                    <div className="absolute bottom-full left-0 right-0 mb-0 bg-surface-channel rounded-t-lg shadow-lg z-[150] border-t border-x border-border-hard">
                      {/* Output Device */}
                      <div className="relative">
                        <button
                          onClick={() => setShowOutputDeviceList(!showOutputDeviceList)}
                          className="w-full px-4 py-3 flex items-center justify-between hover:bg-interactive-hover transition-colors"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-[15px] font-semibold text-txt-primary text-left">Output Device</div>
                            <div className="text-[13px] text-txt-tertiary truncate text-left">{selectedOutputLabel}</div>
                          </div>
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary flex-shrink-0 ml-2">
                            <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
                          </svg>
                        </button>
                        {showOutputDeviceList && (
                          <div className="bg-surface-base rounded-lg shadow-lg mx-2 mb-2 py-1 border border-border-hard">
                            {outputDevices.map(d => (
                              <button
                                key={d.deviceId}
                                onClick={() => selectOutput(d)}
                                className={`w-full px-3 py-2 text-left text-[13px] hover:bg-interactive-hover transition-colors flex items-center gap-2 ${
                                  outputDeviceId === d.deviceId ? 'text-txt-primary' : 'text-txt-secondary'
                                }`}
                              >
                                {outputDeviceId === d.deviceId && (
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-accent-primary flex-shrink-0">
                                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                                  </svg>
                                )}
                                <span className={outputDeviceId === d.deviceId ? '' : 'pl-6'}>{d.label || 'Default'}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
          
                      <div className="mx-4 border-t border-border-soft" />
          
                      {/* Output Volume */}
                      <div className="px-4 py-3">
                        <div className="text-[15px] font-semibold text-txt-primary mb-2">Output Volume</div>
                        <input
                          type="range"
                          min={0}
                          max={200}
                          value={outputVolume}
                          onChange={(e) => {
                            const vol = Number(e.target.value);
                            storeSetOutputVolume(vol);
                          }}
                          className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-surface-base [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md"
                          style={{
                            background: `linear-gradient(to right, rgb(var(--accent-primary)) 0%, rgb(var(--accent-primary)) ${outputVolume / 2}%, rgb(var(--interactive-muted)) ${outputVolume / 2}%, rgb(var(--interactive-muted)) 100%)`,
                          }}
                        />
                      </div>
          <div className="mx-4 border-t border-border-soft" />

          {/* Voice Settings link */}
          <button
            onClick={() => onSettingsClick('voice')}
            className="w-full px-4 py-3 flex items-center justify-between hover:bg-interactive-hover transition-colors"
          >
            <span className="text-[15px] font-semibold text-txt-primary">Voice Settings</span>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
            </svg>
          </button>
        </div>
      )}

      {/* User area bar */}
      <div className="h-[52px] px-2 flex items-center select-none">
        {/* Avatar + name */}
        <div className="p-1 hover:bg-interactive-hover rounded-[4px] flex items-center gap-2 flex-1 min-w-0 cursor-pointer transition-colors group">
          <Avatar src={user.avatar} name={user.displayName ?? user.username} size={34} status={user.status as any} user={user} />
          <div className="flex-1 min-w-0">
            <div className="text-[13.5px] font-semibold text-txt-primary truncate leading-tight">{user.displayName ?? user.username}</div>
            <div className="text-[11px] text-txt-tertiary truncate leading-tight group-hover:text-txt-secondary">@{user.username}</div>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center">
          {/* Mic */}
          <button
            onClick={onMicToggle}
            className={`w-8 h-8 flex items-center justify-center hover:bg-interactive-hover rounded-l-[4px] transition-colors ${
              (isSpaceMuted || isSpaceDeafened || isPermissionMuted) ? 'text-accent-amber cursor-not-allowed'
                : isMuted || isDeafened ? 'text-txt-danger' : 'text-txt-tertiary hover:text-txt-primary'
            }`}
            title={(isPermissionMuted) ? 'Muted (No Speak Permission)' : (isSpaceMuted || isSpaceDeafened) ? 'Space Muted' : isMuted ? 'Unmute' : 'Mute'}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
              {(isMuted || isDeafened || isSpaceMuted || isSpaceDeafened || isPermissionMuted) && <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />}
            </svg>
          </button>
          {/* Input chevron */}
          <button
            onClick={() => togglePanel('input')}
            className={`w-[18px] h-8 flex items-center justify-center hover:bg-interactive-hover rounded-r-[4px] transition-colors ${
              openPanel === 'input' ? 'text-txt-primary bg-interactive-hover' : 'text-txt-tertiary hover:text-txt-primary'
            }`}
            title="Input Devices"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className={`transition-transform ${openPanel === 'input' ? 'rotate-180' : ''}`}>
              <path d="M7 10l5 5 5-5z" />
            </svg>
          </button>

          {/* Headphones */}
          <button
            onClick={onDeafenToggle}
            className={`w-8 h-8 flex items-center justify-center hover:bg-interactive-hover rounded-l-[4px] transition-colors ${
              isSpaceDeafened ? 'text-accent-amber cursor-not-allowed'
                : isDeafened ? 'text-txt-danger' : 'text-txt-tertiary hover:text-txt-primary'
            }`}
            title={isSpaceDeafened ? 'Space Deafened' : isDeafened ? 'Undeafen' : 'Deafen'}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h2v-7H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2v7h2c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z" />
              {(isDeafened || isSpaceDeafened) && <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />}
            </svg>
          </button>
          {/* Output chevron */}
          <button
            onClick={() => togglePanel('output')}
            className={`w-[18px] h-8 flex items-center justify-center hover:bg-interactive-hover rounded-r-[4px] transition-colors ${
              openPanel === 'output' ? 'text-txt-primary bg-interactive-hover' : 'text-txt-tertiary hover:text-txt-primary'
            }`}
            title="Output Devices"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className={`transition-transform ${openPanel === 'output' ? 'rotate-180' : ''}`}>
              <path d="M7 10l5 5 5-5z" />
            </svg>
          </button>

          {/* Settings */}
          <button
            onClick={() => onSettingsClick()}
            className="w-8 h-8 flex items-center justify-center text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover rounded-[4px] transition-colors"
            title="Settings"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
