import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const THEMES = ['aether-drift', 'light', 'oled', 'anime', 'msn'] as const;
export type ThemeId = (typeof THEMES)[number];

export const DEFAULT_THEME: ThemeId = 'aether-drift';

export function normalizeTheme(value: unknown): ThemeId {
  return THEMES.find(theme => theme === value) ?? DEFAULT_THEME;
}

/** Themes drawn on light surfaces: they take light code, emoji and similar palettes. */
export function isLightTheme(theme: ThemeId): boolean {
  return theme === 'light' || theme === 'msn';
}

interface ThemeState {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
}

export const useThemeStore = create<ThemeState>()(persist(
  set => ({ theme: DEFAULT_THEME, setTheme: theme => set({ theme: normalizeTheme(theme) }) }),
  {
    name: 'backspace-theme',
    partialize: state => ({ theme: state.theme }),
    merge: (stored, current) => ({
      ...current,
      theme: normalizeTheme((stored as Partial<ThemeState> | undefined)?.theme),
    }),
  },
));
