import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const THEMES = ['aether-drift', 'light', 'oled', 'anime', 'msn', 'msn-dark'] as const;
export type ThemeId = (typeof THEMES)[number];

export const DEFAULT_THEME: ThemeId = 'aether-drift';

export function normalizeTheme(value: unknown): ThemeId {
  return THEMES.find(theme => theme === value) ?? DEFAULT_THEME;
}

/** The MSN family: both variants share `theme-msn.css` and the XP-frames option. */
export function isMsnTheme(theme: ThemeId): boolean {
  return theme === 'msn' || theme === 'msn-dark';
}

/** Themes drawn on light surfaces: they take light code, emoji and similar palettes. */
export function isLightTheme(theme: ThemeId): boolean {
  return theme === 'light' || theme === 'msn';
}

interface ThemeState {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  /** MSN theme only: Windows XP (Luna) bevelled frames on or off. */
  msnFrames: boolean;
  setMsnFrames: (enabled: boolean) => void;
}

export const DEFAULT_MSN_FRAMES = true;

export function normalizeMsnFrames(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_MSN_FRAMES;
}

export const useThemeStore = create<ThemeState>()(persist(
  set => ({
    theme: DEFAULT_THEME,
    setTheme: theme => set({ theme: normalizeTheme(theme) }),
    msnFrames: DEFAULT_MSN_FRAMES,
    setMsnFrames: enabled => set({ msnFrames: normalizeMsnFrames(enabled) }),
  }),
  {
    name: 'backspace-theme',
    partialize: state => ({ theme: state.theme, msnFrames: state.msnFrames }),
    merge: (stored, current) => ({
      ...current,
      theme: normalizeTheme((stored as Partial<ThemeState> | undefined)?.theme),
      msnFrames: normalizeMsnFrames((stored as Partial<ThemeState> | undefined)?.msnFrames),
    }),
  },
));
