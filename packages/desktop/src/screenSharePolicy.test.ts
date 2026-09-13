import { describe, it, expect } from 'vitest';
import {
  screenSharePickerMode,
  isPendingSelectionFresh,
  screenEnumerationDecision,
  PENDING_SCREEN_SELECTION_TTL_MS,
  SCREEN_SOURCES_CACHE_MS,
} from './screenSharePolicy';

describe('screenSharePickerMode', () => {
  it('lists sources in-app on macOS and Windows whatever the environment says', () => {
    expect(screenSharePickerMode('darwin', { XDG_SESSION_TYPE: 'wayland' })).toBe('app');
    expect(screenSharePickerMode('win32', { WAYLAND_DISPLAY: 'wayland-0' })).toBe('app');
  });

  it('defers to the system picker on a Wayland session', () => {
    expect(screenSharePickerMode('linux', { XDG_SESSION_TYPE: 'wayland' })).toBe('system');
    expect(screenSharePickerMode('linux', { XDG_SESSION_TYPE: 'Wayland' })).toBe('system');
    expect(screenSharePickerMode('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe('system');
  });

  it('lists sources in-app on X11, including XWayland where WAYLAND_DISPLAY is still set', () => {
    expect(screenSharePickerMode('linux', { XDG_SESSION_TYPE: 'x11' })).toBe('app');
    expect(screenSharePickerMode('linux', { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' })).toBe('app');
    expect(screenSharePickerMode('linux', {})).toBe('app');
  });
});

describe('isPendingSelectionFresh', () => {
  const pending = { sourceId: 'screen:0:0', shareAudio: false, at: 1_000 };

  it('rejects the absent selection', () => {
    expect(isPendingSelectionFresh(null, 1_000)).toBe(false);
  });

  it('accepts a selection inside the TTL', () => {
    expect(isPendingSelectionFresh(pending, 1_000)).toBe(true);
    expect(isPendingSelectionFresh(pending, 1_000 + PENDING_SCREEN_SELECTION_TTL_MS)).toBe(true);
  });

  it('rejects a selection past the TTL, so it cannot hijack a later share', () => {
    expect(isPendingSelectionFresh(pending, 1_000 + PENDING_SCREEN_SELECTION_TTL_MS + 1)).toBe(false);
  });
});

describe('screenEnumerationDecision', () => {
  const base = { fromMainWindow: true, windowFocused: true, lastEnumeratedAt: null, now: 10_000 };

  it('enumerates for the focused app window', () => {
    expect(screenEnumerationDecision(base)).toBe('enumerate');
  });

  it('denies any sender that is not the app window', () => {
    expect(screenEnumerationDecision({ ...base, fromMainWindow: false })).toBe('deny');
  });

  it('never takes a fresh capture while the app is in the background', () => {
    expect(screenEnumerationDecision({ ...base, windowFocused: false })).toBe('serve-cache');
  });

  it('serves the last snapshot to a caller polling inside the cache window', () => {
    expect(screenEnumerationDecision({ ...base, lastEnumeratedAt: 10_000 - (SCREEN_SOURCES_CACHE_MS - 1) }))
      .toBe('serve-cache');
  });

  it('enumerates again once the cache window has passed', () => {
    expect(screenEnumerationDecision({ ...base, lastEnumeratedAt: 10_000 - SCREEN_SOURCES_CACHE_MS }))
      .toBe('enumerate');
  });
});
