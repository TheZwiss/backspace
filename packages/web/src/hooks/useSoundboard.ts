import { useEffect } from 'react';
import { soundboardKey, useSoundboardStore } from '../stores/soundboardStore';
import { useAuthStore } from '../stores/authStore';

export function useSoundboard(origin: string, spaceId: string) {
  useAuthStore(s => s.user?.id);
  const key = soundboardKey(origin, spaceId);
  const entry = useSoundboardStore(s => s.entries[key]);
  const load = useSoundboardStore(s => s.load);
  useEffect(() => { if (spaceId) void load(origin, spaceId); }, [load, key, origin, spaceId]);
  return { ...entry, reload: () => load(origin, spaceId) };
}
