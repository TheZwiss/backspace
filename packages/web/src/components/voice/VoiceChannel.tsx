import React from 'react';
import { useVoiceStore } from '../../stores/voiceStore';

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
  const members = useServerStore((s) => s.members);
  const isActive = currentVoiceChannel === channelId;

  return (
    <div>
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-sm group ${
          isActive
            ? 'bg-discord-bg-active text-white'
            : 'text-discord-text-muted hover:text-discord-text-secondary hover:bg-discord-bg-hover'
        }`}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0 opacity-60">
          <path d="M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46ZM19.07 4.93C20.91 6.77 22 9.28 22 12C22 14.72 20.91 17.23 19.07 19.07L17.66 17.66C19.11 16.21 20 14.21 20 12C20 9.79 19.11 7.79 17.66 6.34L19.07 4.93Z" />
        </svg>
        <span className="truncate">{channelName}</span>
      </button>

      {/* Connected users */}
      {voiceUsers.length > 0 && (
        <div className="ml-6 mt-0.5 space-y-0.5">
          {voiceUsers.map((userId) => {
            const member = members.find(m => m.userId === userId);
            if (!member) return null;
            const displayName = member.user.displayName ?? member.user.username;
            return (
              <div key={userId} className="flex items-center gap-2 px-2 py-0.5 rounded hover:bg-discord-bg-hover transition-colors">
                <Avatar
                  src={member.user.avatar}
                  name={displayName}
                  size={20}
                  status={member.user.status}
                />
                <span className="text-xs text-discord-text-secondary truncate">{displayName}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
