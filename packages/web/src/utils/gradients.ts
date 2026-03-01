/**
 * Aether Drift gradient palettes for avatars and server icons.
 * Deterministic color assignment based on entity ID (snowflake) or name.
 */

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

// ── Server icon gradients (server fallbacks) ──
const SERVER_GRADIENTS: GradientEntry[] = [
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

/** Deterministic gradient for a user avatar. Prefers ID for stability; falls back to name. */
export function getAvatarGradient(id?: string | null, name?: string): GradientEntry {
  const key = id || name || 'unknown';
  return AVATAR_GRADIENTS[hashString(key) % AVATAR_GRADIENTS.length]!;
}

/** Deterministic gradient for a server icon. Prefers ID for stability; falls back to name. */
export function getServerGradient(id?: string | null, name?: string): GradientEntry {
  const key = id || name || 'unknown';
  return SERVER_GRADIENTS[hashString(key) % SERVER_GRADIENTS.length]!;
}
