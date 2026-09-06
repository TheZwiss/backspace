export interface PortalKeybindStatus {
  state: 'idle' | 'pending' | 'ready' | 'unavailable';
  shortcuts: Record<string, string>;
}

export function isWayland(platform = process.platform, env = process.env): boolean {
  return platform === 'linux' && (env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY);
}
