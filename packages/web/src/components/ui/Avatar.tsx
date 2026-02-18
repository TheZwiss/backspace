import React from 'react';

interface AvatarProps {
  src?: string | null;
  name: string;
  size?: number;
  status?: 'online' | 'idle' | 'dnd' | 'offline' | null;
  className?: string;
  onClick?: () => void;
}

const statusColors: Record<string, string> = {
  online: 'bg-discord-green',
  idle: 'bg-discord-yellow',
  dnd: 'bg-discord-red',
  offline: 'bg-gray-500',
};

export function Avatar({ src, name, size = 40, status, className = '', onClick }: AvatarProps) {
  const initials = name.charAt(0).toUpperCase();
  const fontSize = size < 32 ? 'text-xs' : size < 48 ? 'text-sm' : 'text-lg';

  return (
    <div
      className={`relative inline-flex flex-shrink-0 ${onClick ? 'cursor-pointer' : ''} ${className}`}
      style={{ width: size, height: size }}
      onClick={onClick}
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
          className={`absolute -bottom-0.5 -right-0.5 rounded-full border-[3px] border-discord-bg-secondary ${statusColors[status] ?? 'bg-gray-500'}`}
          style={{
            width: size * 0.35,
            height: size * 0.35,
            minWidth: 10,
            minHeight: 10,
          }}
        />
      )}
    </div>
  );
}
