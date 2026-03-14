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
  ring?: { width: number; color: string };
  avatarColor?: string | null;
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
function buildCutoutMask(avatarSize: number, ringWidth: number = 0): string {
  const outerSize = avatarSize + ringWidth * 2;
  const { dot, gap, inset } = getDotMetrics(avatarSize, ringWidth);
  const cx = outerSize - inset;
  const cy = outerSize - inset;
  const r = dot / 2 + gap;
  return `radial-gradient(circle at ${cx}px ${cy}px, transparent ${r}px, black ${r + 0.5}px)`;
}

/** Returns visible dot diameter, gap width, and center inset from outer edge. */
function getDotMetrics(avatarSize: number, ringWidth: number = 0) {
  let dot: number, gap: number, avatarInset: number;
  if (avatarSize <= 24) {
    dot = 5; gap = 2; avatarInset = 3;
  } else if (avatarSize <= 48) {
    dot = 6; gap = 3; avatarInset = 4;
  } else {
    dot = Math.round(avatarSize * 0.15);
    gap = Math.round(avatarSize * 0.05);
    avatarInset = Math.round(avatarSize * 0.10);
  }
  return { dot, gap, inset: avatarInset + ringWidth };
}

export function Avatar({ src, name, size = 40, status, className = '', onClick, user, userId, ring, avatarColor }: AvatarProps) {
  const openUserProfile = useUIStore((s) => s.openUserProfile);
  const initials = name.charAt(0).toUpperCase();
  const fontPx = Math.round(size * 0.4);
  const gradient = getAvatarGradient(userId ?? user?.homeUserId ?? user?.id, name, avatarColor ?? user?.avatarColor);

  const ringWidth = ring?.width ?? 0;
  const outerSize = size + ringWidth * 2;

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
  const cutoutMask = status ? buildCutoutMask(size, ringWidth) : undefined;
  const maskStyle: React.CSSProperties | undefined = cutoutMask
    ? { maskImage: cutoutMask, WebkitMaskImage: cutoutMask }
    : undefined;

  const { dot: dotDiameter, inset: dotInset } = getDotMetrics(size, ringWidth);

  return (
    <div
      className={`relative inline-flex flex-shrink-0 ${(onClick || user) ? 'cursor-pointer' : ''} ${className}`}
      style={{ width: outerSize, height: outerSize }}
      onClick={handleClick}
    >
      {/* Inner masked circle — ring background + avatar content */}
      <div
        className="w-full h-full rounded-full"
        style={{
          padding: ringWidth,
          backgroundColor: ring?.color,
          ...maskStyle,
        }}
      >
        {src ? (
          <img
            src={(src.startsWith('http') || src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('/'))
              ? src : `/api/uploads/${src}`}
            alt={name}
            loading="lazy"
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
          className={`avatar-fallback w-full h-full rounded-full flex items-center justify-center font-bold text-white ${src ? 'hidden' : 'flex'}`}
          style={src ? { display: 'none' } : { background: gradient.gradient, fontSize: fontPx }}
        >
          {initials}
        </div>
      </div>
      {/* Status dot — outside the masked div so it isn't clipped */}
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
