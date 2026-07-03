import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import {
  RecoveryStateStore,
  extractErrorCode,
  buildTrayMenuTemplate,
  buildAppMenuTemplate,
  type RecoveryState,
  armBootTimer,
  clearBootTimer,
  isBootArmed,
  handleRendererReady,
  resetBootTimerStateForTest,
} from './recovery';

// Mock electron with isPackaged=true so the real arm path executes in all tests below.
vi.mock('electron', () => ({
  app: { isPackaged: true },
}));

describe('RecoveryStateStore', () => {
  it('returns the initial state', () => {
    const store = new RecoveryStateStore();
    const s = store.get();
    expect(s.mode).toBe('normal');
    expect(s.reason).toBeNull();
    expect(s.updateState).toBe('idle');
    expect(s.updateVersion).toBeNull();
    expect(s.lastUpdateError).toBeNull();
    expect(s.lastCheckResult).toBeNull();
  });

  it('shallow-merges partial updates', () => {
    const store = new RecoveryStateStore();
    store.update({ updateState: 'checking' });
    expect(store.get().updateState).toBe('checking');
    expect(store.get().mode).toBe('normal');
    store.update({ updateVersion: '1.2.3' });
    expect(store.get().updateState).toBe('checking');
    expect(store.get().updateVersion).toBe('1.2.3');
  });

  it('fires listeners on every update', () => {
    const store = new RecoveryStateStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.update({ updateState: 'checking' });
    store.update({ updateState: 'idle' });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('subscribers receive the latest snapshot', () => {
    const store = new RecoveryStateStore();
    let received: RecoveryState | null = null;
    store.subscribe((s) => { received = s; });
    store.update({ updateState: 'downloaded', updateVersion: '2.0.0' });
    expect(received).not.toBeNull();
    expect(received!.updateState).toBe('downloaded');
    expect(received!.updateVersion).toBe('2.0.0');
  });

  it('unsubscribe stops callbacks', () => {
    const store = new RecoveryStateStore();
    const cb = vi.fn();
    const unsub = store.subscribe(cb);
    store.update({ updateState: 'checking' });
    unsub();
    store.update({ updateState: 'idle' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers all receive updates', () => {
    const store = new RecoveryStateStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.update({ updateState: 'checking' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('isInRecoveryMode is false initially, true after markRecoveryEntered, false after markRecoveryExited', () => {
    const store = new RecoveryStateStore();
    expect(store.isInRecoveryMode()).toBe(false);
    store.markRecoveryEntered();
    expect(store.isInRecoveryMode()).toBe(true);
    store.markRecoveryExited();
    expect(store.isInRecoveryMode()).toBe(false);
  });

  it('a throwing listener does not stop other listeners', () => {
    const store = new RecoveryStateStore();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = vi.fn(() => { throw new Error('boom'); });
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    expect(() => store.update({ updateState: 'checking' })).not.toThrow();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('a listener can unsubscribe itself during notification without breaking the pass', () => {
    const store = new RecoveryStateStore();
    const b = vi.fn();
    let unsubA: (() => void) | null = null;
    unsubA = store.subscribe(() => { unsubA?.(); });
    store.subscribe(b);
    expect(() => store.update({ updateState: 'checking' })).not.toThrow();
    // Second update: the self-unsubscribed listener should be gone, b still fires
    store.update({ updateState: 'idle' });
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('returned state is frozen — accidental external mutation throws in strict mode', () => {
    const store = new RecoveryStateStore();
    store.update({ updateState: 'checking' });
    const s = store.get();
    expect(Object.isFrozen(s)).toBe(true);
  });
});

describe('extractErrorCode', () => {
  it('extracts string code from Error-like object', () => {
    const err = new Error('boom') as Error & { code: string };
    err.code = 'ENOSPC';
    expect(extractErrorCode(err)).toBe('ENOSPC');
  });

  it('returns null for Error without code', () => {
    expect(extractErrorCode(new Error('boom'))).toBeNull();
  });

  it('returns null when code is non-string', () => {
    const err = { code: 42 };
    expect(extractErrorCode(err)).toBeNull();
  });

  it('returns null for null/undefined/primitives', () => {
    expect(extractErrorCode(null)).toBeNull();
    expect(extractErrorCode(undefined)).toBeNull();
    expect(extractErrorCode('string')).toBeNull();
    expect(extractErrorCode(42)).toBeNull();
  });

  it('handles plain objects with code', () => {
    expect(extractErrorCode({ code: 'NET_FAIL' })).toBe('NET_FAIL');
  });
});

function defaultState(overrides?: Partial<RecoveryState>): RecoveryState {
  return {
    mode: 'normal',
    reason: null,
    updateState: 'idle',
    updateVersion: null,
    lastUpdateError: null,
    lastCheckResult: null,
    ...overrides,
  };
}

describe('buildTrayMenuTemplate', () => {
  it('includes Show/Hide/Change Instance/Quit base items', () => {
    const items = buildTrayMenuTemplate(defaultState());
    const labels = items.map((i) => i.label);
    expect(labels).toContain('Show Backspace');
    expect(labels).toContain('Hide');
    expect(labels).toContain('Change Instance');
    expect(labels).toContain('Quit');
  });

  it('includes Check for Updates with idle label when updateState=idle', () => {
    const items = buildTrayMenuTemplate(defaultState({ updateState: 'idle' }));
    const item = items.find((i) => i.id === 'check-for-updates');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Check for Updates…');
    expect(item!.enabled).toBe(true);
  });

  it('disables Check for Updates while checking', () => {
    const items = buildTrayMenuTemplate(defaultState({ updateState: 'checking' }));
    const item = items.find((i) => i.id === 'check-for-updates');
    expect(item!.label).toBe('Checking for Updates…');
    expect(item!.enabled).toBe(false);
  });

  it('disables Check for Updates while downloading', () => {
    const items = buildTrayMenuTemplate(defaultState({ updateState: 'downloading' }));
    const item = items.find((i) => i.id === 'check-for-updates');
    expect(item!.label).toBe('Downloading Update…');
    expect(item!.enabled).toBe(false);
  });

  it('shows Update Ready label when downloaded, with Check disabled (Restart is the action)', () => {
    const items = buildTrayMenuTemplate(defaultState({ updateState: 'downloaded' }));
    const item = items.find((i) => i.id === 'check-for-updates');
    expect(item!.label).toBe('Update Ready');
    expect(item!.enabled).toBe(false);
  });

  it('shows error suffix on Check for Updates label when updateState=error', () => {
    const items = buildTrayMenuTemplate(defaultState({ updateState: 'error' }));
    const item = items.find((i) => i.id === 'check-for-updates');
    expect(item!.label).toBe('Check for Updates… (last attempt failed)');
    expect(item!.enabled).toBe(true);
  });

  it('inserts Restart to Install Update only when updateState=downloaded', () => {
    expect(
      buildTrayMenuTemplate(defaultState({ updateState: 'idle' })).find((i) => i.id === 'restart-to-install'),
    ).toBeUndefined();
    expect(
      buildTrayMenuTemplate(defaultState({ updateState: 'downloading' })).find((i) => i.id === 'restart-to-install'),
    ).toBeUndefined();
    const downloadedItem = buildTrayMenuTemplate(defaultState({ updateState: 'downloaded' }))
      .find((i) => i.id === 'restart-to-install');
    expect(downloadedItem).toBeDefined();
    expect(downloadedItem!.label).toBe('Restart to Install Update');
    expect(downloadedItem!.enabled).toBe(true);
  });
});

describe('buildAppMenuTemplate', () => {
  it('returns top-level menu with App, Edit, Window submenus', () => {
    const template = buildAppMenuTemplate('Backspace', defaultState());
    const [appMenu, editMenu, windowMenu] = template;
    expect(template.length).toBeGreaterThanOrEqual(3);
    expect(appMenu!.label).toBe('Backspace');
    expect(editMenu!.label).toBe('Edit');
    expect(windowMenu!.label).toBe('Window');
  });

  it('App submenu includes About and Change Instance', () => {
    const template = buildAppMenuTemplate('Backspace', defaultState());
    const [appMenu] = template;
    const appSub = appMenu!.submenu as MenuItemConstructorOptions[];
    const labels = appSub.map((i) => i.label).filter(Boolean);
    expect(appSub.find((i) => i.role === 'about')).toBeDefined();
    expect(labels).toContain('Change Instance');
    expect(appSub.find((i) => i.role === 'quit')).toBeDefined();
  });

  it('App submenu includes Check for Updates with state-correct label', () => {
    const template = buildAppMenuTemplate('Backspace', defaultState({ updateState: 'idle' }));
    const [appMenu] = template;
    const appSub = appMenu!.submenu as MenuItemConstructorOptions[];
    const item = appSub.find((i) => i.id === 'check-for-updates');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Check for Updates…');
  });

  it('App submenu inserts Restart to Install Update only when downloaded', () => {
    const [idleAppMenu] = buildAppMenuTemplate('Backspace', defaultState({ updateState: 'idle' }));
    const idleSub = idleAppMenu!.submenu as MenuItemConstructorOptions[];
    expect(idleSub.find((i) => i.id === 'restart-to-install')).toBeUndefined();

    const [dlAppMenu] = buildAppMenuTemplate('Backspace', defaultState({ updateState: 'downloaded' }));
    const dlSub = dlAppMenu!.submenu as MenuItemConstructorOptions[];
    const restartItem = dlSub.find((i) => i.id === 'restart-to-install');
    expect(restartItem).toBeDefined();
    expect(restartItem!.label).toBe('Restart to Install Update');
  });
});

interface FakeWebContents { getURL: () => string }
interface FakeWindow { webContents: FakeWebContents; isDestroyed: () => boolean }

function fakeWin(url: string): FakeWindow {
  return { webContents: { getURL: () => url }, isDestroyed: () => false };
}

describe('armBootTimer / clearBootTimer', () => {
  beforeEach(() => {
    // Reset all module-level boot-timer state including pingReceivedThisNav so
    // tests that call handleRendererReady() don't pollute subsequent tests.
    resetBootTimerStateForTest();
  });

  it('arms when URL is http://', () => {
    armBootTimer(fakeWin('http://localhost:3005/') as never);
    expect(isBootArmed()).toBe(true);
    clearBootTimer();
  });

  it('arms when URL is https://', () => {
    armBootTimer(fakeWin('https://example.com/') as never);
    expect(isBootArmed()).toBe(true);
    clearBootTimer();
  });

  it('skips file:// URLs', () => {
    armBootTimer(fakeWin('file:///path/to/recovery.html') as never);
    expect(isBootArmed()).toBe(false);
  });

  it('skips empty URLs', () => {
    armBootTimer(fakeWin('') as never);
    expect(isBootArmed()).toBe(false);
  });

  it('clearBootTimer disarms', () => {
    armBootTimer(fakeWin('http://localhost/') as never);
    expect(isBootArmed()).toBe(true);
    clearBootTimer();
    expect(isBootArmed()).toBe(false);
  });

  it('does NOT arm if rendererReady arrived before armBootTimer (early-ping case)', () => {
    // Simulate SPA timing: useEffect fires (microtask) before did-finish-load.
    // The ping arrives when bootArmed=false, then armBootTimer is called by
    // did-finish-load. Without the pingReceivedThisNav flag this would arm a
    // 20s timer that nothing clears → false renderer-stalled recovery.
    handleRendererReady();
    armBootTimer(fakeWin('http://localhost:3005/') as never);
    expect(isBootArmed()).toBe(false);
  });

  it('clears existing timer if rendererReady arrives after armBootTimer (late-ping case)', () => {
    // Simulate the less-common ordering: did-finish-load fires first (arms timer),
    // then the ping arrives. Preserved existing behavior — ping clears the timer.
    armBootTimer(fakeWin('http://localhost:3005/') as never);
    expect(isBootArmed()).toBe(true);
    handleRendererReady();
    expect(isBootArmed()).toBe(false);
  });

  it('flag is per-navigation: after clearBootTimer reset, a subsequent arm should still be blocked by the set flag', () => {
    // Verify that pingReceivedThisNav persists across clearBootTimer calls until
    // a real did-navigate resets it. The module-level flag is only reset by
    // did-navigate (wired in attachRecoveryHandlers). Here we confirm the flag
    // behaviour in isolation: ping → arm (blocked) → clear → arm again (still blocked).
    // The per-nav reset is integration-tested by smoke scenario 4 + 13 together.
    handleRendererReady();
    armBootTimer(fakeWin('http://localhost:3005/') as never);
    expect(isBootArmed()).toBe(false);
    // clearBootTimer resets bootArmed but NOT pingReceivedThisNav
    clearBootTimer();
    armBootTimer(fakeWin('http://localhost:3005/') as never);
    expect(isBootArmed()).toBe(false);
  });
});
