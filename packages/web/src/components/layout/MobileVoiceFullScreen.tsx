import React from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { Avatar } from '../ui/Avatar';
import { useContextMenuStore, type ContextMenuItem } from '../../stores/contextMenuStore';
import { buildVoiceModMenuItems, VolumeSliderItem } from '../voice/voiceMenuItems';
import { wsSend } from '../../hooks/useWebSocket';
import { getChannelOrigin } from '../../stores/spaceStore';

export function MobileVoiceFullScreen() {
  const popMobileScreen = useUIStore((s) => s.popMobileScreen);
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);

  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
  const toggleMute = useVoiceStore((s) => s.toggleMic);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare);
  const leaveVoice = useVoiceStore((s) => s.leaveVoice);
  const voiceUsers = useVoiceStore((s) => s.voiceUsers);
  const voiceUserStates = useVoiceStore((s) => s.voiceUserStates);
  const participants = useVoiceStore((s) => s.participants);
  const spaceMutedUserIds = useVoiceStore((s) => s.spaceMutedUserIds);
  const spaceDeafenedUserIds = useVoiceStore((s) => s.spaceDeafenedUserIds);
  const permissionMutedUserIds = useVoiceStore((s) => s.permissionMutedUserIds);

  const channels = useSpaceStore((s) => s.channels);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const spaces = useSpaceStore((s) => s.spaces);
  const channelToSpaceMap = useSpaceStore((s) => s.channelToSpaceMap);
  const members = useSpaceStore((s) => s.members);

  const authUser = useAuthStore((s) => s.user);

  const openContextMenu = useContextMenuStore((s) => s.open);

  if (!currentVoiceChannelId) {
    popMobileScreen();
    return null;
  }

  const isDmCall = currentVoiceChannelId.startsWith('dm-');
  let channelName = 'Voice Call';
  let spaceName = '';

  if (isDmCall) {
    const dmId = currentVoiceChannelId.replace('dm-', '');
    const dm = dmChannels.find(d => d.id === dmId);
    if (dm) {
      const others = dm.members.filter(m => m.id !== authUser?.id);
      channelName = others.map(m => m.displayName ?? m.username).join(', ');
    }
  } else {
    const ch = channels.find(c => c.id === currentVoiceChannelId);
    if (ch) {
      channelName = ch.name;
      const spaceId = channelToSpaceMap.get(ch.id);
      const space = spaceId ? spaces.find(s => s.id === spaceId) : null;
      if (space) spaceName = space.name;
    }
  }

  const participantIds = voiceUsers.get(currentVoiceChannelId) || [];

  // Resolve participant display info from members list or DM members
  const getParticipantInfo = (userId: string) => {
    const member = members.find(m => m.userId === userId);
    if (member) {
      return {
        name: member.nickname ?? member.user?.displayName ?? member.user?.username ?? userId,
        avatar: member.user?.avatar ? `/api/uploads/${member.user.avatar}` : null,
        avatarColor: member.user?.avatarColor ?? null,
      };
    }
    // Check DM members
    for (const dm of dmChannels) {
      const dmMember = dm.members.find(m => m.id === userId);
      if (dmMember) {
        return {
          name: dmMember.displayName ?? dmMember.username,
          avatar: dmMember.avatar ? `/api/uploads/${dmMember.avatar}` : null,
          avatarColor: dmMember.avatarColor,
        };
      }
    }
    // Fall back to LiveKit participant metadata
    const participant = participants.find(p => p.userId === userId);
    if (participant?.username) {
      return { name: participant.username, avatar: null, avatarColor: null };
    }
    return { name: userId, avatar: null, avatarColor: null };
  };

  const handleDisconnect = () => {
    const { activeDmCall, disconnectFn } = useVoiceStore.getState();
    if (activeDmCall) {
      wsSend({ type: 'dm_call_end', dmChannelId: activeDmCall.dmChannelId }, getChannelOrigin(activeDmCall.dmChannelId));
      useVoiceStore.getState().setActiveDmCall(null);
    } else if (currentVoiceChannelId) {
      wsSend({ type: 'voice_leave' }, getChannelOrigin(currentVoiceChannelId));
      leaveVoice();
    }
    if (disconnectFn) disconnectFn();
    popMobileScreen();
  };

  const handleParticipantContextMenu = (e: React.MouseEvent, userId: string) => {
    if (userId === authUser?.id || !currentVoiceChannelId || isDmCall) return;
    e.preventDefault();
    e.stopPropagation();

    const modItems = buildVoiceModMenuItems(userId, currentVoiceChannelId);
    const items: ContextMenuItem[] = [...modItems];

    if (modItems.length > 0) {
      items.push({ key: 'mod-end-sep', type: 'separator' });
    }

    // Local mute checkbox
    const isUserMuted = useVoiceStore.getState().participantMutes.get(userId) ?? false;
    items.push({
      key: 'mute-user',
      type: 'checkbox',
      label: 'Mute User',
      checked: isUserMuted,
      onChange: (checked) => useVoiceStore.getState().setParticipantMute(userId, checked),
    });

    items.push({ key: 'vol-sep', type: 'separator' });

    // Volume slider
    items.push({
      key: 'volume',
      type: 'custom',
      render: () => <VolumeSliderItem userId={userId} />,
    });

    if (items.length === 0) return;
    openContextMenu({ x: e.clientX, y: e.clientY }, items);
  };

  return (
    <div className="flex flex-col h-full bg-surface-base">
      {/* Header */}
      <header className="h-12 flex items-center gap-2 px-3 border-b border-border-soft shrink-0">
        <button onClick={popMobileScreen} className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-txt-primary truncate">{channelName}</h1>
          {spaceName && <p className="text-[11px] text-txt-tertiary truncate">{spaceName}</p>}
        </div>
        <span className="text-xs text-txt-tertiary">{participantIds.length} connected</span>
        {!isDmCall && (
          <button
            onClick={() => pushMobileScreen('members')}
            className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
            </svg>
          </button>
        )}
      </header>

      {/* Participant grid */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className={`grid gap-3 ${
          participantIds.length <= 2 ? 'grid-cols-1' : 'grid-cols-2'
        }`}>
          {participantIds.map(userId => {
            const info = getParticipantInfo(userId);
            const wsStatus = voiceUserStates.get(userId);
            const participant = participants.find(p => p.userId === userId);
            const isMe = userId === authUser?.id;

            // Resolve mute/deafen: local state for self, LiveKit participant then WS fallback for others
            const isUserMuted = isMe
              ? isMuted
              : (participant?.isMuted ?? wsStatus?.isMuted ?? false);
            const isUserDeafened = isMe
              ? isDeafened
              : (participant?.isDeafened ?? wsStatus?.isDeafened ?? false);

            // Server-enforced states
            const spaceId = !isDmCall && currentVoiceChannelId
              ? channelToSpaceMap.get(currentVoiceChannelId)
              : undefined;
            const isSpaceMuted = spaceId ? spaceMutedUserIds.has(`${spaceId}:${userId}`) : false;
            const isSpaceDeafened = spaceId ? spaceDeafenedUserIds.has(`${spaceId}:${userId}`) : false;
            const isPermissionMuted = spaceId ? permissionMutedUserIds.has(`${spaceId}:${userId}`) : false;

            // Any muted indicator: self-mute, server mute, or permission mute
            const showMuted = isUserMuted || isSpaceMuted || isPermissionMuted;
            // Any deafened indicator: self-deafen or server deafen
            const showDeafened = isUserDeafened || isSpaceDeafened;

            return (
              <div
                key={userId}
                data-context-menu
                className={`rounded-xl bg-surface-channel p-4 flex flex-col items-center gap-3 ${
                  participantIds.length <= 2 ? 'py-8' : 'py-4'
                }`}
                onContextMenu={(e) => handleParticipantContextMenu(e, userId)}
              >
                <div className="relative">
                  <Avatar
                    src={info.avatar}
                    name={info.name}
                    avatarColor={info.avatarColor}
                    size={participantIds.length <= 2 ? 80 : 56}
                  />
                  {(showMuted || showDeafened) && (
                    <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-accent-rose/90 flex items-center justify-center">
                      {showDeafened ? (
                        <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                        </svg>
                      )}
                    </div>
                  )}
                </div>
                <span className="text-sm text-txt-primary font-medium truncate max-w-full">
                  {info.name}{isMe ? ' (You)' : ''}
                </span>
              </div>
            );
          })}
        </div>

        {participantIds.length === 0 && (
          <div className="flex items-center justify-center h-40 text-txt-tertiary text-sm">
            No one else is here yet
          </div>
        )}
      </div>

      {/* Control bar */}
      <div className="glass-bubble mx-2 mb-2 rounded-2xl flex items-center justify-center gap-4 px-4 py-3 shrink-0"
        style={{ marginBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}
      >
        {/* Mute */}
        <button
          onClick={toggleMute}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
            isMuted ? 'bg-accent-rose/20 text-accent-rose' : 'bg-surface-elevated text-txt-primary hover:bg-interactive-hover'
          }`}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
            {isMuted && <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />}
          </svg>
        </button>

        {/* Deafen */}
        <button
          onClick={toggleDeafen}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
            isDeafened ? 'bg-accent-rose/20 text-accent-rose' : 'bg-surface-elevated text-txt-primary hover:bg-interactive-hover'
          }`}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
            {isDeafened && <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />}
          </svg>
        </button>

        {/* Camera */}
        <button
          onClick={toggleCamera}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
            isCameraOn ? 'bg-accent-mint/20 text-accent-mint' : 'bg-surface-elevated text-txt-primary hover:bg-interactive-hover'
          }`}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9.75a2.25 2.25 0 002.25-2.25V7.5a2.25 2.25 0 00-2.25-2.25H4.5A2.25 2.25 0 002.25 7.5v9A2.25 2.25 0 004.5 18.75z" />
          </svg>
        </button>

        {/* Screen share */}
        <button
          onClick={toggleScreenShare}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
            isScreenSharing ? 'bg-accent-mint/20 text-accent-mint' : 'bg-surface-elevated text-txt-primary hover:bg-interactive-hover'
          }`}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a9 9 0 01-9 9m0 0a9 9 0 01-9-9" />
          </svg>
        </button>

        {/* Disconnect */}
        <button
          onClick={handleDisconnect}
          className="w-12 h-12 rounded-full bg-accent-rose flex items-center justify-center text-white hover:bg-accent-rose/80 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
          </svg>
        </button>
      </div>
    </div>
  );
}
