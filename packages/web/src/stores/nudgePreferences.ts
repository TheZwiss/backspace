import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NudgeRules } from '../utils/nudgePolicy';

export type NudgeMode = 'full' | 'reduced' | 'notification';
export const useNudgePreferences = create<NudgeRules & {
  setMode: (mode: NudgeMode) => void;
  update: (rules: Partial<NudgeRules>) => void;
}>()(persist(set => ({
  mode: typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full',
  scope: 'both', sound: true, volume: 60, monitor: 'all', gameDetection: 'auto', gameTrigger: 'foreground', gameMonitor: 'auto',
  gameAction: 'notification', gameFallback: 'notification',
  setMode: mode => set({ mode }),
  update: rules => set(rules),
}), { name: 'backspace-nudge-preferences' }));
