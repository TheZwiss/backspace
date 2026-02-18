import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { VoiceChannel } from '../voice/VoiceChannel';
import { VoiceControls } from '../voice/VoiceControls';
import { useVoiceStore } from '../../stores/voiceStore';
import { Avatar } from '../ui/Avatar';
import { wsSend } from '../../hooks/useWebSocket';

export function ChannelSidebar() {
  const servers = useServerStore((s) => s.servers);
  const currentServerId = useServerStore((s) => s.currentServerId);
  const channels = useServerStore((s) => s.channels);
  const currentChannelId = useChatStore((s) => s.currentChannelId);
  const setCurrentChannel = useChatStore((s) => s.setCurrentChannel);
  const openModal = useUIStore((s) => s.openModal);
  const user = useAuthStore((s) => s.user);
  const members = useServerStore((s) => s.members);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const setCurrentVoiceChannel = useVoiceStore((s) => s.setCurrentVoiceChannel);
  const navigate = useNavigate();

  const server = servers.find(s => s.id === currentServerId);
  const currentMember = members.find(m => m.userId === user?.id);
  const isAdminUser = currentMember?.role === 'admin' || currentMember?.role === 'owner';

  const textChannels = channels.filter(c => c.type === 'text');
  const voiceChannels = channels.filter(c => c.type === 'voice' || c.type === 'video');

  const handleChannelClick = (channelId: string) => {
    setCurrentChannel(channelId);
    navigate(`/channels/${currentServerId}/${channelId}`);
  };

  const handleVoiceJoin = (channelId: string) => {
    setCurrentVoiceChannel(channelId);
    wsSend({ type: 'voice_join', channelId });
  };

  const handleVoiceDisconnect = () => {
    setCurrentVoiceChannel(null);
    wsSend({ type: 'voice_leave' });
  };

  if (!server) {
    return (
      <div className="w-60 bg-discord-bg-secondary flex flex-col flex-shrink-0">
        <div className="h-12 px-4 flex items-center border-b border-discord-bg-tertiary">
          <span className="font-semibold text-discord-text-primary">Direct Messages</span>
        </div>
        <div className="flex-1 p-2 text-discord-text-muted text-sm">
          <p className="px-2 py-4">Select or create a DM conversation</p>
        </div>
        {/* User area at bottom */}
        {user && (
          <div className="h-[52px] px-2 bg-discord-bg-members flex items-center gap-2">
            <Avatar src={user.avatar} name={user.displayName ?? user.username} size={32} status={user.status} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{user.displayName ?? user.username}</div>
              <div className="text-[10px] text-discord-text-muted truncate">@{user.username}</div>
            </div>
            <button
              onClick={() => openModal('userSettings')}
              className="p-1 text-discord-text-muted hover:text-discord-text-primary transition-colors"
              title="User Settings"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
              </svg>
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-60 bg-discord-bg-secondary flex flex-col flex-shrink-0">
      {/* Server header */}
      <button
        onClick={() => openModal('serverSettings')}
        className="h-12 px-4 flex items-center justify-between border-b border-discord-bg-tertiary hover:bg-discord-bg-hover transition-colors"
      >
        <span className="font-bold text-discord-text-primary truncate">{server.name}</span>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" className="text-discord-text-muted flex-shrink-0">
          <path d="M5.293 7.293a1 1 0 011.414 0L9 9.586l2.293-2.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" />
        </svg>
      </button>

      {/* Channels */}
      <div className="flex-1 overflow-y-auto p-2 space-y-4">
        {/* Text Channels */}
        {textChannels.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-1 mb-1">
              <span className="text-xs font-bold text-discord-text-muted uppercase tracking-wide">Text Channels</span>
              {isAdminUser && (
                <button
                  onClick={() => openModal('createChannel')}
                  className="text-discord-text-muted hover:text-discord-text-secondary transition-colors"
                  title="Create Channel"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z" />
                  </svg>
                </button>
              )}
            </div>
            {textChannels.map((channel) => (
              <button
                key={channel.id}
                onClick={() => handleChannelClick(channel.id)}
                className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-sm group ${
                  currentChannelId === channel.id
                    ? 'bg-discord-bg-active text-white'
                    : 'text-discord-text-muted hover:text-discord-text-secondary hover:bg-discord-bg-hover'
                }`}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0 opacity-60">
                  <path d="M5.88657 21C5.57547 21 5.3399 20.7189 5.39427 20.4126L6.00001 17H2.59511C2.28449 17 2.04905 16.7198 2.10259 16.4138L2.27759 15.4138C2.31946 15.1746 2.52722 15 2.77011 15H6.35001L7.41001 9H4.00511C3.69449 9 3.45905 8.71977 3.51259 8.41381L3.68759 7.41381C3.72946 7.17456 3.93722 7 4.18011 7H7.76001L8.39677 3.41262C8.43914 3.17391 8.64664 3 8.88907 3H9.87344C10.1845 3 10.4201 3.28107 10.3657 3.58738L9.76001 7H15.76L16.3968 3.41262C16.4391 3.17391 16.6466 3 16.8891 3H17.8734C18.1845 3 18.4201 3.28107 18.3657 3.58738L17.76 7H21.1649C21.4755 7 21.711 7.28023 21.6574 7.58619L21.4824 8.58619C21.4406 8.82544 21.2328 9 20.9899 9H17.41L16.35 15H19.7549C20.0655 15 20.301 15.2802 20.2474 15.5862L20.0724 16.5862C20.0306 16.8254 19.8228 17 19.5799 17H16L15.3632 20.5874C15.3209 20.8261 15.1134 21 14.8709 21H13.8866C13.5755 21 13.3399 20.7189 13.3943 20.4126L14 17H8.00001L7.36325 20.5874C7.32088 20.8261 7.11337 21 6.87094 21H5.88657ZM9.41001 9L8.35001 15H14.35L15.41 9H9.41001Z" />
                </svg>
                <span className="truncate">{channel.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* Voice Channels */}
        {voiceChannels.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-1 mb-1">
              <span className="text-xs font-bold text-discord-text-muted uppercase tracking-wide">Voice Channels</span>
              {isAdminUser && (
                <button
                  onClick={() => openModal('createChannel')}
                  className="text-discord-text-muted hover:text-discord-text-secondary transition-colors"
                  title="Create Channel"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z" />
                  </svg>
                </button>
              )}
            </div>
            {voiceChannels.map((channel) => (
              <VoiceChannel
                key={channel.id}
                channelId={channel.id}
                channelName={channel.name}
                onClick={() => handleVoiceJoin(channel.id)}
              />
            ))}
          </div>
        )}

        {/* Invite button */}
        <button
          onClick={() => openModal('invite')}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-discord-text-muted hover:text-discord-text-secondary hover:bg-discord-bg-hover"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M14 2.5a.5.5 0 00-.5-.5h-6a.5.5 0 000 1h4.793L2.146 13.146a.5.5 0 00.708.708L13 3.707V8.5a.5.5 0 001 0v-6z" />
          </svg>
          Invite People
        </button>
      </div>

      {/* Voice controls */}
      {currentVoiceChannelId && (
        <VoiceControls
          onDisconnect={handleVoiceDisconnect}
          onToggleMic={() => {}}
          onToggleCamera={() => {}}
          onToggleScreenShare={() => {}}
        />
      )}

      {/* User area */}
      {user && (
        <div className="h-[52px] px-2 bg-discord-bg-members flex items-center gap-2">
          <Avatar src={user.avatar} name={user.displayName ?? user.username} size={32} status={user.status} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{user.displayName ?? user.username}</div>
            <div className="text-[10px] text-discord-text-muted truncate">@{user.username}</div>
          </div>
          <button
            onClick={() => openModal('userSettings')}
            className="p-1 text-discord-text-muted hover:text-discord-text-primary transition-colors"
            title="User Settings"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
