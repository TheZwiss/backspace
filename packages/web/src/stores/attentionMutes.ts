import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { userKey, type IdentityFields } from '../utils/identity';
export type AttentionMuteTarget = IdentityFields & { id: string; username: string; displayName?: string | null; avatar?: string | null };
export const ATTENTION_MUTE_DURATIONS = [15 * 60_000, 60 * 60_000, 8 * 60 * 60_000, 24 * 60 * 60_000] as const;
export interface AttentionMute { owner: string; key: string; aliases: string[]; name: string; avatar?: string | null; until: number | null }
const keysFor = (user: IdentityFields, origin: string) => [...new Set([userKey(user, origin), userKey({ id: user.id }, origin)])];
export const useAttentionMutes = create<{
  entries: AttentionMute[];
  mute: (owner: string, user: AttentionMuteTarget, origin: string, duration: number | null) => void;
  unmute: (owner: string, key: string) => void;
}>()(persist(set => ({
  entries: [],
  mute: (owner, user, origin, duration) => {
    if (!owner || (duration !== null && !ATTENTION_MUTE_DURATIONS.some(value => value === duration))) return;
    const aliases = keysFor(user, origin), key = userKey(user, origin);
    set(state => ({ entries: [...state.entries.filter(entry => entry.owner !== owner || !entry.aliases.some(alias => aliases.includes(alias))), { owner, key, aliases, name: user.displayName || user.username, avatar: user.avatar, until: duration === null ? null : Date.now() + duration }] }));
  },
  unmute: (owner, key) => set(state => ({ entries: state.entries.filter(entry => entry.owner !== owner || entry.key !== key) })),
}), { name: 'backspace-attention-mutes' }));
export function attentionMuted(owner: string, user: IdentityFields, origin: string, now = Date.now()): boolean {
  const keys = keysFor(user, origin);
  return useAttentionMutes.getState().entries.some(entry => entry.owner === owner && (entry.until === null || entry.until > now) && entry.aliases.some(alias => keys.includes(alias)));
}
