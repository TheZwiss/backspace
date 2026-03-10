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

/**
 * Builds a CSS radial-gradient mask that punches a circular hole in the avatar
 * where the status dot sits. The hole reveals the parent background, creating
 * a true cutout effect on any surface — no border-color matching needed.
 *
 * Prototype reference (.m-dot): 12px box with 3px border (border-box) = 6px
 * visible color, positioned at bottom:-2 right:-2 → center 4px from corner.
 */
function buildCutoutMask(size: number): string {
  const { dot, gap, inset } = getDotMetrics(size);
  const cx = size - inset;
  const cy = size - inset;
  const r = dot / 2 + gap;
  return `radial-gradient(circle at ${cx}px ${cy}px, transparent ${r}px, black ${r + 0.5}px)`;
}

/** Returns visible dot diameter, gap width, and center inset from avatar edge. */
function getDotMetrics(size: number) {
  if (size <= 24) return { dot: 5, gap: 2, inset: 3 };
  return { dot: 6, gap: 3, inset: 4 };
}

export function Avatar({ src, name, size = 40, status, className = '', onClick, user, userId }: AvatarProps) {
  const openUserProfile = useUIStore((s) => s.openUserProfile);
  const initials = name.charAt(0).toUpperCase();
  // Match prototype: 24px→10px, 32-34px→12px, 40px→15px, 56px+→18px
  const fontPx = size <= 24 ? 10 : size <= 34 ? 12 : size <= 44 ? 15 : 18;
  const gradient = getAvatarGradient(userId ?? user?.homeUserId ?? user?.id, name, user?.avatarColor);

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

  // Only compute mask when status dot is visible
  const cutoutMask = status ? buildCutoutMask(size) : undefined;
  const maskStyle: React.CSSProperties | undefined = cutoutMask
    ? { maskImage: cutoutMask, WebkitMaskImage: cutoutMask }
    : undefined;

  const { dot: dotDiameter, inset: dotInset } = getDotMetrics(size);

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
          style={maskStyle}
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
        className={`avatar-fallback w-full h-full rounded-full flex items-center justify-center font-bold text-white ${src ? 'hidden' : 'flex'}`}
        style={src ? { display: 'none' } : { background: gradient.gradient, fontSize: fontPx, ...maskStyle }}
      >
        {initials}
      </div>
      {status && (
        <div
          className={`absolute rounded-full ${statusColors[status] ?? 'bg-status-offline'}`}
          style={{
            width: dotDiameter,
            height: dotDiameter,
            bottom: dotInset - dotDiameter / 2,
            right: dotInset - dotDiameter / 2,
          }}
        />
      )}
    </div>
  );
}
