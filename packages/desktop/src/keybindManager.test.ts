import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeybindManager } from './keybindManager';
import { hashCode } from './portalShortcut';

const mocks = vi.hoisted(() => ({ clients: [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> }));
vi.mock('electron', () => ({ systemPreferences: {} }));
vi.mock('./portalShortcut', async (original) => ({
  ...await original<typeof import('./portalShortcut')>(), isWayland: () => true,
}));
vi.mock('./globalShortcutsPortal', () => ({
  GlobalShortcutsPortal: class {
    start = vi.fn(async () => {});
    stop = vi.fn();
    constructor() { mocks.clients.push(this); }
  },
}));

const binding = { actionId: 'pushToTalk', keys: [hashCode('KeyV')] };
beforeEach(() => { vi.useFakeTimers(); mocks.clients.length = 0; });
afterEach(() => vi.useRealTimers());

describe('Wayland keybind manager', () => {
  it('coalesces updates and does not register the same configuration twice', async () => {
    const manager = new KeybindManager();
    manager.updateKeybinds([binding]);
    manager.updateKeybinds([{ ...binding, keys: [hashCode('KeyB')] }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.clients[0]!.start).toHaveBeenCalledWith([{ ...binding, keys: [hashCode('KeyB')] }]);
    manager.updateKeybinds([{ ...binding, keys: [hashCode('KeyB')] }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.clients).toHaveLength(1);
    manager.stop();
  });
  it('unregisters the last binding and cancels pending startup', async () => {
    const manager = new KeybindManager();
    manager.updateKeybinds([binding]);
    manager.updateKeybinds([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.clients).toHaveLength(0);
    manager.updateKeybinds([binding]);
    await vi.advanceTimersByTimeAsync(300);
    manager.updateKeybinds([]);
    expect(mocks.clients[0]!.stop).toHaveBeenCalledOnce();
    expect(manager.getPortalStatus()).toEqual({ state: 'idle', shortcuts: {} });
    manager.stop();
  });
  it('allows explicit retries and restarts after shutdown with the same configuration', async () => {
    const manager = new KeybindManager();
    manager.updateKeybinds([binding]);
    await vi.advanceTimersByTimeAsync(300);
    manager.retryPortal();
    expect(mocks.clients[0]!.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.clients).toHaveLength(2);
    manager.stop();
    manager.updateKeybinds([binding]);
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.clients).toHaveLength(3);
    manager.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
