/**
 * Aether Drift gradient palettes for avatars and server icons.
 * Deterministic color assignment based on entity ID (snowflake) or name.
 */

import type { AvatarColor } from '@backspace/shared';

export interface GradientEntry {
  gradient: string;
  glow: string;
}

// ── Avatar gradients (user fallbacks) ──
const AVATAR_GRADIENTS: GradientEntry[] = [
  { gradient: 'linear-gradient(135deg, #059669, #10b981)', glow: '#10b981' },   // mint
  { gradient: 'linear-gradient(135deg, #3b82f6, #6366f1)', glow: '#6366f1' },   // sky
  { gradient: 'linear-gradient(135deg, #a78bfa, #c084fc)', glow: '#c084fc' },   // lavender
  { gradient: 'linear-gradient(135deg, #f97316, #ef4444)', glow: '#f97316' },   // coral
  { gradient: 'linear-gradient(135deg, #f43f5e, #ec4899)', glow: '#ec4899' },   // rose
  { gradient: 'linear-gradient(135deg, #14b8a6, #06b6d4)', glow: '#06b6d4' },   // teal
  { gradient: 'linear-gradient(135deg, #f59e0b, #eab308)', glow: '#f59e0b' },   // amber
];

export const AVATAR_GRADIENT_MAP: Record<AvatarColor, GradientEntry> = {
  mint:     AVATAR_GRADIENTS[0]!,
  sky:      AVATAR_GRADIENTS[1]!,
  lavender: AVATAR_GRADIENTS[2]!,
  coral:    AVATAR_GRADIENTS[3]!,
  rose:     AVATAR_GRADIENTS[4]!,
  teal:     AVATAR_GRADIENTS[5]!,
  amber:    AVATAR_GRADIENTS[6]!,
};

// ── Space icon gradients (space fallbacks) ──
const SPACE_GRADIENTS: GradientEntry[] = [
  { gradient: 'linear-gradient(135deg, #ef4444, #f97316)', glow: '#f97316' },   // red-orange
  { gradient: 'linear-gradient(135deg, #ec4899, #f472b6)', glow: '#ec4899' },   // pink
  { gradient: 'linear-gradient(135deg, #14b8a6, #06b6d4)', glow: '#06b6d4' },   // teal-cyan
  { gradient: 'linear-gradient(135deg, #f59e0b, #eab308)', glow: '#f59e0b' },   // amber-yellow
  { gradient: 'linear-gradient(135deg, #3b82f6, #6366f1)', glow: '#6366f1' },   // blue-indigo
  { gradient: 'linear-gradient(135deg, #a78bfa, #c084fc)', glow: '#c084fc' },   // lavender
  { gradient: 'linear-gradient(135deg, #059669, #10b981)', glow: '#10b981' },   // mint
];

// ── Home button (DM / Backspace) — fixed indigo-purple gradient ──
export const HOME_GRADIENT: GradientEntry = {
  gradient: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
  glow: '#8b5cf6',
};

/** djb2 hash → stable unsigned 32-bit integer. */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** Deterministic gradient for a user avatar. Uses stored avatarColor if available; falls back to hash. */
export function getAvatarGradient(id?: string | null, name?: string, avatarColor?: string | null): GradientEntry {
  if (avatarColor && avatarColor in AVATAR_GRADIENT_MAP) {
    return AVATAR_GRADIENT_MAP[avatarColor as AvatarColor];
  }
  const key = id || name || 'unknown';
  return AVATAR_GRADIENTS[hashString(key) % AVATAR_GRADIENTS.length]!;
}

/** Deterministic gradient for a space icon. Prefers ID for stability; falls back to name. */
export function getSpaceGradient(id?: string | null, name?: string): GradientEntry {
  const key = id || name || 'unknown';
  return SPACE_GRADIENTS[hashString(key) % SPACE_GRADIENTS.length]!;
}

/** Flat accent-color presets derived from the avatar gradient palette. Both stops per gradient. */
export const ACCENT_PRESETS: string[] = AVATAR_GRADIENTS.flatMap(g => {
  const matches = g.gradient.match(/#[0-9a-fA-F]{6}/g);
  return matches ?? [];
});

/** Shift each RGB component of a hex color by `amount` (positive = lighter, negative = darker). */
export function adjustColor(hex: string, amount: number): string {
  const r = Math.max(0, Math.min(255, parseInt(hex.slice(1, 3), 16) + amount));
  const g = Math.max(0, Math.min(255, parseInt(hex.slice(3, 5), 16) + amount));
  const b = Math.max(0, Math.min(255, parseInt(hex.slice(5, 7), 16) + amount));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
