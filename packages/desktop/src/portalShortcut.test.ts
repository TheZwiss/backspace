import { describe, expect, it } from 'vitest';
import { hashCode, isWayland, preferredTrigger } from './portalShortcut';

const trigger = (codes: string[], mouseButton?: number) => preferredTrigger({
  actionId: 'pushToTalk', keys: codes.map(hashCode), mouseButton,
});

describe('portal shortcut translation', () => {
  it('normalizes modifier sides and order', () => {
    expect(trigger(['KeyV', 'ShiftRight', 'ControlLeft'])).toBe('CTRL+SHIFT+v');
    expect(trigger(['MetaRight', 'AltLeft', 'F12'])).toBe('ALT+LOGO+F12');
    expect(trigger(['ControlLeft', 'ControlRight', 'KeyA'])).toBe('CTRL+a');
  });
  it.each([
    ['Space', 'space'], ['Enter', 'Return'], ['PageUp', 'Prior'],
    ['NumpadEnter', 'KP_Enter'], ['Numpad5', 'KP_5'], ['Quote', 'apostrophe'], ['F24', 'F24'],
  ])('converts %s to %s', (code, symbol) => expect(trigger([code])).toBe(symbol));
  it('rejects unknown keys, mouse buttons, modifier-only and multiple main keys', () => {
    for (const codes of [[], ['ControlLeft'], ['KeyA', 'KeyB'], ['Unknown']]) {
      expect(trigger(codes)).toBeUndefined();
    }
    expect(trigger(['KeyA'], 4)).toBeUndefined();
  });
  it('selects the portal for Wayland including XWayland, not other platforms or X11', () => {
    expect(isWayland('linux', { XDG_SESSION_TYPE: 'wayland' })).toBe(true);
    expect(isWayland('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })).toBe(true);
    expect(isWayland('linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' })).toBe(false);
    expect(isWayland('win32', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(false);
  });
});
