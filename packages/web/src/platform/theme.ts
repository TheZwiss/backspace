import { useThemeStore, type ThemeId } from '../stores/themeStore';

/** Browser chrome colour (address bar, PWA title bar) that matches each theme's base surface. */
const THEME_COLOR: Record<ThemeId, string> = {
  'aether-drift': '#0b0b10',
  light: '#e4e2ec',
  oled: '#000000',
  anime: '#0e0a1c',
  msn: '#2a5fae',
};

function applyTheme(theme: ThemeId, msnFrames: boolean): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.msnFrames = msnFrames ? 'xp' : 'flat';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

/** Apply before React mounts, so the persisted theme also covers login and portals. */
export function initializeTheme(): () => void {
  const initial = useThemeStore.getState();
  applyTheme(initial.theme, initial.msnFrames);
  return useThemeStore.subscribe(state => applyTheme(state.theme, state.msnFrames));
}
