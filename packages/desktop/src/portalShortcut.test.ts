import { expect, it } from 'vitest';
import { isWayland } from './portalShortcut';

it('selects the portal for Wayland including XWayland, not other platforms or X11', () => {
  expect(isWayland('linux', { XDG_SESSION_TYPE: 'wayland' })).toBe(true);
  expect(isWayland('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })).toBe(true);
  expect(isWayland('linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' })).toBe(false);
  expect(isWayland('win32', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(false);
});
