/**
 * Aether Drift gradient palettes for avatars and server icons.
 * Deterministic color assignment based on entity ID (snowflake) or name.
 */

import type { AvatarColor } from '@backspace/shared';

export interface GradientEntry {
  from: string;      // hex start color
  to: string;        // hex end color
  gradient: string;  // CSS linear-gradient (derived from from/to)
  glow: string;      // hex glow color (hand-curated most prominent color)
}

function grad(from: string, to: string, glow: string): GradientEntry {
  return { from, to, gradient: `linear-gradient(135deg, ${from}, ${to})`, glow };
}

// ── Avatar gradients (user fallbacks) ──
const AVATAR_GRADIENTS: GradientEntry[] = [
  grad('#059669', '#10b981', '#10b981'),   // mint
  grad('#3b82f6', '#6366f1', '#6366f1'),   // sky
  grad('#a78bfa', '#c084fc', '#c084fc'),   // lavender
  grad('#f97316', '#ef4444', '#f97316'),   // coral
  grad('#f43f5e', '#ec4899', '#ec4899'),   // rose
  grad('#14b8a6', '#06b6d4', '#06b6d4'),   // teal
  grad('#f59e0b', '#eab308', '#f59e0b'),   // amber
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
export const SPACE_GRADIENTS: GradientEntry[] = [
  grad('#ef4444', '#f97316', '#f97316'),   // red-orange
  grad('#ec4899', '#f472b6', '#ec4899'),   // pink
  grad('#14b8a6', '#06b6d4', '#06b6d4'),   // teal-cyan
  grad('#f59e0b', '#eab308', '#f59e0b'),   // amber-yellow
  grad('#3b82f6', '#6366f1', '#6366f1'),   // blue-indigo
  grad('#a78bfa', '#c084fc', '#c084fc'),   // lavender
  grad('#059669', '#10b981', '#10b981'),   // mint
];

export const SPACE_GRADIENT_MAP: Record<AvatarColor, GradientEntry> = {
  coral:    SPACE_GRADIENTS[0]!,   // red-orange
  rose:     SPACE_GRADIENTS[1]!,   // pink
  teal:     SPACE_GRADIENTS[2]!,   // teal-cyan
  amber:    SPACE_GRADIENTS[3]!,   // amber-yellow
  sky:      SPACE_GRADIENTS[4]!,   // blue-indigo
  lavender: SPACE_GRADIENTS[5]!,   // lavender
  mint:     SPACE_GRADIENTS[6]!,   // mint
};

// ── Home button (DM / Backspace) — fixed indigo-purple gradient ──
export const HOME_GRADIENT: GradientEntry = grad('#6366f1', '#8b5cf6', '#8b5cf6');

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

/** Deterministic gradient for a space icon. Uses stored avatarColor if available; falls back to hash. */
export function getSpaceGradient(id?: string | null, name?: string, avatarColor?: string | null): GradientEntry {
  if (avatarColor && avatarColor in SPACE_GRADIENT_MAP) {
    return SPACE_GRADIENT_MAP[avatarColor as AvatarColor];
  }
  const key = id || name || 'unknown';
  return SPACE_GRADIENTS[hashString(key) % SPACE_GRADIENTS.length]!;
}

/** Banner-color presets: 7 families × 3 shades (deep, vibrant, soft). */
export const BANNER_COLOR_PRESETS: string[][] = [
  ['#047857', '#10b981', '#6ee7b7'],   // mint
  ['#4338ca', '#6366f1', '#a5b4fc'],   // sky
  ['#7c3aed', '#c084fc', '#e9d5ff'],   // lavender
  ['#c2410c', '#f97316', '#fdba74'],   // coral
  ['#be185d', '#ec4899', '#f9a8d4'],   // rose
  ['#0e7490', '#06b6d4', '#67e8f9'],   // teal
  ['#b45309', '#f59e0b', '#fcd34d'],   // amber
];

/** @deprecated Use BANNER_COLOR_PRESETS instead. */
export const ACCENT_PRESETS: string[] = BANNER_COLOR_PRESETS.map(f => f[1]!);

/** Convert 6-digit hex (#rrggbb) to rgba string. */
export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Build a banner-style muted gradient from two hex colors with baked-in alpha. */
export function mutedGradient(from: string, to: string, alpha = 0.6): string {
  return `linear-gradient(135deg, ${hexToRgba(from, alpha)}, ${hexToRgba(to, alpha)})`;
}

/** Shift each RGB component of a hex color by `amount` (positive = lighter, negative = darker). */
export function adjustColor(hex: string, amount: number): string {
  const r = Math.max(0, Math.min(255, parseInt(hex.slice(1, 3), 16) + amount));
  const g = Math.max(0, Math.min(255, parseInt(hex.slice(3, 5), 16) + amount));
  const b = Math.max(0, Math.min(255, parseInt(hex.slice(5, 7), 16) + amount));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
