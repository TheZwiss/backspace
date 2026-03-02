import React from 'react';
import type { User } from '@backspace/shared';
import { useUIStore } from '../../stores/uiStore';
import { getAvatarGradient } from '../../utils/gradients';

interface AvatarProps {
  src?: string | null;
  name: string;
  size?: number;
  status?: 'online' | 'idle' | 'dnd' | 'offline' | null;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
  user?: User;
  userId?: string;
}

const statusColors: Record<string, string> = {
  online: 'bg-status-online',
  idle: 'bg-status-idle',
  dnd: 'bg-status-dnd',
  offline: 'bg-status-offline',
};

export function Avatar({ src, name, size = 40, status, className = '', onClick, user, userId }: AvatarProps) {
  const openUserProfile = useUIStore((s) => s.openUserProfile);
  const initials = name.charAt(0).toUpperCase();
  const fontSize = size < 32 ? 'text-xs' : size < 48 ? 'text-sm' : 'text-lg';
  const gradient = getAvatarGradient(userId ?? user?.id, name);

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
        className={`avatar-fallback w-full h-full rounded-full flex items-center justify-center ${fontSize} font-semibold text-white ${src ? 'hidden' : 'flex'}`}
        style={src ? { display: 'none' } : { background: gradient.gradient }}
      >
        {initials}
      </div>
      {status && (
        <div
          className={`absolute -bottom-0.5 -right-0.5 rounded-full border-[3px] border-surface-channel ${statusColors[status] ?? 'bg-status-offline'}`}
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
