import { useThemeStore, type ThemeId } from '../stores/themeStore';

/** Browser chrome colour (address bar, PWA title bar) that matches each theme's base surface. */
const THEME_COLOR: Record<ThemeId, string> = {
  'aether-drift': '#0b0b10',
  light: '#e4e2ec',
  oled: '#000000',
  anime: '#0e0a1c',
  msn: '#2a5fae',
};

function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

/** Apply before React mounts, so the persisted theme also covers login and portals. */
export function initializeTheme(): () => void {
  applyTheme(useThemeStore.getState().theme);
  return useThemeStore.subscribe(state => applyTheme(state.theme));
}
