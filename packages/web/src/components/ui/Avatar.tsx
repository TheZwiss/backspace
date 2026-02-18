import React from 'react';
import type { User } from '@opencord/shared';
import { useUIStore } from '../../stores/uiStore';

interface AvatarProps {
  src?: string | null;
  name: string;
  size?: number;
  status?: 'online' | 'idle' | 'dnd' | 'offline' | null;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
  user?: User;
}

const statusColors: Record<string, string> = {
  online: 'bg-discord-green',
  idle: 'bg-discord-yellow',
  dnd: 'bg-discord-red',
  offline: 'bg-discord-text-muted',
};

export function Avatar({ src, name, size = 40, status, className = '', onClick, user }: AvatarProps) {
  const openUserProfile = useUIStore((s) => s.openUserProfile);
  const initials = name.charAt(0).toUpperCase();
  const fontSize = size < 32 ? 'text-xs' : size < 48 ? 'text-sm' : 'text-lg';

  const handleClick = (e: React.MouseEvent) => {
    if (onClick) {
      onClick(e);
    } else if (user) {
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      openUserProfile(user, {
        top: Math.min(rect.top, window.innerHeight - 450),
        left: rect.right + 16,
      });
    }
  };

  return (
    <div
      className={`relative inline-flex flex-shrink-0 ${(onClick || user) ? 'cursor-pointer' : ''} ${className}`}
      style={{ width: size, height: size }}
      onClick={handleClick}
    >
      {src ? (
        <img
          src={src.startsWith('http') ? src : `/api/uploads/${src}`}
          alt={name}
          className="w-full h-full rounded-full object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
            const parent = (e.target as HTMLImageElement).parentElement;
            if (parent) {
              const fallback = parent.querySelector('.avatar-fallback') as HTMLElement;
              if (fallback) fallback.style.display = 'flex';
            }
          }}
        />
      ) : null}
      <div
        className={`avatar-fallback w-full h-full rounded-full bg-discord-blurple flex items-center justify-center ${fontSize} font-semibold text-white ${src ? 'hidden' : 'flex'}`}
        style={src ? { display: 'none' } : undefined}
      >
        {initials}
      </div>
      {status && (
        <div
          className={`absolute -bottom-0.5 -right-0.5 rounded-full border-[3px] border-discord-bg-secondary ${statusColors[status] ?? 'bg-discord-text-muted'}`}
          style={{
            width: size * 0.35,
            height: size * 0.35,
            minWidth: 12,
            minHeight: 12,
          }}
        />
      )}
    </div>
  );
}
