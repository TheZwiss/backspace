import React from 'react';
import { Avatar } from '../ui/Avatar';

export interface VoiceUserRowProps {
  userId: string;
  displayName: string;
  avatar: string | null;
  avatarColor?: string;
  isMuted?: boolean;
  isDeafened?: boolean;
  isCameraOn?: boolean;
  isScreenSharing?: boolean;
  isServerMuted?: boolean;
  isServerDeafened?: boolean;
  isPermissionMuted?: boolean;
  isLocallyMuted?: boolean;
  isSpeaking?: boolean;
  size?: 'compact' | 'default';
  className?: string;
}

export function VoiceUserRow({
  userId,
  displayName,
  avatar,
  avatarColor,
  isMuted,
  isDeafened,
  isCameraOn,
  isScreenSharing,
  isServerMuted,
  isServerDeafened,
  isPermissionMuted,
  isLocallyMuted,
  isSpeaking,
  size = 'default',
  className = '',
}: VoiceUserRowProps) {
  const avatarSize = size === 'compact' ? 20 : 24;

  // Mic icon priority: server muted/deafened/permission muted (amber) > self-muted (danger)
  const showServerMicIcon = isServerMuted || isServerDeafened || isPermissionMuted;
  const showSelfMicIcon = !showServerMicIcon && isMuted;

  // Deafen icon priority: server deafened (amber) > self-deafened (danger)
  const showServerDeafIcon = isServerDeafened;
  const showSelfDeafIcon = !isServerDeafened && isDeafened;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <Avatar
        src={avatar}
        name={displayName}
        size={avatarSize}
        userId={userId}
        avatarColor={avatarColor}
        className={isSpeaking ? 'rounded-full ring-2 ring-status-online' : ''}
      />
      <span className="text-[13px] text-txt-secondary truncate flex-1 min-w-0">
        {displayName}
      </span>
      {/* Status badges */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {/* Server muted / space deafened / permission muted — amber mic with slash */}
        {showServerMicIcon && (
          <span
            title={
              isPermissionMuted
                ? 'Muted (No Speak Permission)'
                : isServerMuted
                  ? 'Space Muted'
                  : 'Muted (Space Deafened)'
            }
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-accent-amber">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
              <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </span>
        )}
        {/* Server deafened — amber headphone with slash */}
        {showServerDeafIcon && (
          <span title="Space Deafened">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-accent-amber">
              <path d="M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h2v-7H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2v7h2c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z" />
              <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </span>
        )}
        {/* Self-muted — danger mic with slash */}
        {showSelfMicIcon && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-txt-danger">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        )}
        {/* Self-deafened — danger headphone with slash */}
        {showSelfDeafIcon && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-txt-danger">
            <path d="M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h2v-7H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2v7h2c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z" />
            <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        )}
        {/* Camera active */}
        {isCameraOn && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
            <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
          </svg>
        )}
        {/* Screen sharing LIVE badge */}
        {isScreenSharing && (
          <span className="bg-accent-rose text-white text-[9px] font-bold px-1 rounded leading-[14px]">LIVE</span>
        )}
        {/* Locally muted — volume X icon */}
        {isLocallyMuted && (
          <span title="Locally Muted">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
              <path d="M3 9v6h4l5 5V4L7 9H3z" />
              <line x1="17" y1="7" x2="23" y2="13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              <line x1="23" y1="7" x2="17" y2="13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </span>
        )}
      </div>
    </div>
  );
}
