import React from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';

const EMPTY_VOICE_USERS: string[] = [];
import { useServerStore } from '../../stores/serverStore';
import { Avatar } from '../ui/Avatar';

interface VoiceChannelProps {
  channelId: string;
  channelName: string;
  onClick: () => void;
}

export function VoiceChannel({ channelId, channelName, onClick }: VoiceChannelProps) {
  const voiceUsers = useVoiceStore((s) => s.voiceUsers.get(channelId)) ?? EMPTY_VOICE_USERS;
  const currentVoiceChannel = useVoiceStore((s) => s.currentVoiceChannelId);
  const participants = useVoiceStore((s) => s.participants);
  const localIsDeafened = useVoiceStore((s) => s.isDeafened);
  const localIsMuted = useVoiceStore((s) => s.isMuted);
  const voiceUserStates = useVoiceStore((s) => s.voiceUserStates);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const members = useServerStore((s) => s.members);
  const isActive = currentVoiceChannel === channelId;

  return (
    <div>
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-1.5 px-2 h-8 rounded-[4px] group transition-colors ${
          isActive
            ? 'bg-discord-modifier-selected text-white'
            : 'text-discord-text-muted hover:text-discord-text-secondary hover:bg-discord-modifier-hover'
        }`}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0 opacity-60">
          <path d="M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46ZM19.07 4.93C20.91 6.77 22 9.28 22 12C22 14.72 20.91 17.23 19.07 19.07L17.66 17.66C19.11 16.21 20 14.21 20 12C20 9.79 19.11 7.79 17.66 6.34L19.07 4.93Z" />
        </svg>
        <span className="truncate text-[15px] font-medium">{channelName}</span>
      </button>

      {/* Connected users */}
      {voiceUsers.length > 0 && (
        <div className="ml-6 mt-0.5 space-y-0.5">
          {voiceUsers.map((userId) => {
            const member = members.find(m => m.userId === userId);
            const participant = participants.find(p => p.userId === userId);
            const displayName = member?.user.displayName ?? member?.user.username ?? participant?.username ?? userId;
            const avatar = member?.user.avatar ?? null;
            const status = member?.user.status;
            // Resolve status: for local user use store directly, for remote users
            // try LiveKit participant first, then fall back to WebSocket voiceUserStates
            const wsStatus = voiceUserStates.get(userId);
            const isParticipantDeafened = userId === currentUserId
              ? localIsDeafened
              : (participant?.isDeafened ?? wsStatus?.isDeafened ?? false);
            const isMuted = userId === currentUserId
              ? localIsMuted
              : (participant?.isMuted ?? wsStatus?.isMuted ?? false);
            const hasCamera = participant?.isCameraOn ?? false;
            const isScreenSharing = participant?.isScreenSharing ?? false;

            return (
              <div key={userId} className="flex items-center gap-2 px-2 py-0.5 rounded hover:bg-discord-modifier-hover transition-colors">
                <Avatar
                  src={avatar}
                  name={displayName}
                  size={20}
                  status={status}
                />
                <span className="text-[13px] text-discord-text-secondary truncate flex-1 min-w-0">{displayName}</span>
                {/* Status badges */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {isMuted && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-discord-red">
                      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                      <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                      <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                  )}
                  {isParticipantDeafened && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-discord-red">
                      <path d="M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h2v-7H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2v7h2c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z" />
                      <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                  )}
                  {hasCamera && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-discord-text-muted">
                      <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                    </svg>
                  )}
                  {isScreenSharing && (
                    <span className="bg-discord-red text-white text-[9px] font-bold px-1 rounded leading-[14px]">LIVE</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
