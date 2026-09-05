import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeybindManager } from './keybindManager';
import type { PortalKeybindStatus } from './portalShortcut';

const mocks = vi.hoisted(() => ({ clients: [] as Array<{
  start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn>;
  status: (status: PortalKeybindStatus) => void;
}> }));
vi.mock('electron', () => ({ systemPreferences: {} }));
vi.mock('./portalShortcut', async (original) => ({
  ...await original<typeof import('./portalShortcut')>(), isWayland: () => true,
}));
vi.mock('./globalShortcutsPortal', () => ({
  GlobalShortcutsPortal: class {
    start = vi.fn(async () => {});
    stop = vi.fn();
    refresh = vi.fn(async () => {});
    constructor(_action: unknown, public status: (status: PortalKeybindStatus) => void) { mocks.clients.push(this); }
  },
}));
function setup() {
  const manager = new KeybindManager();
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { send: vi.fn() } });
  manager.setWindow(window as unknown as BrowserWindow);
  return { manager, window };
}
beforeEach(() => { mocks.clients.length = 0; });

describe('Wayland keybind manager', () => {
  it('restores the system session at startup independently of local configuration', () => {
    const { manager } = setup();
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.clients[0]!.start).toHaveBeenCalledWith(false);
    manager.updateKeybinds([{ actionId: 'pushToTalk', keys: [123] }]);
    manager.updateKeybinds([]);
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.clients[0]!.stop).not.toHaveBeenCalled();
    manager.stop();
  });
  it('refreshes assignments on window focus without recreating the session', () => {
    const { manager, window } = setup();
    window.emit('focus');
    expect(mocks.clients[0]!.refresh).toHaveBeenCalledOnce();
    expect(mocks.clients).toHaveLength(1);
    manager.stop();
  });
  it('allows initial registration and retries only when no session is active', () => {
    const { manager } = setup();
    manager.retryPortal(); // already pending
    expect(mocks.clients).toHaveLength(1);
    mocks.clients[0]!.status({ state: 'idle', shortcuts: {} });
    manager.retryPortal();
    expect(mocks.clients[0]!.stop).toHaveBeenCalledOnce();
    expect(mocks.clients[1]!.start).toHaveBeenCalledWith(true);
    mocks.clients[1]!.status({ state: 'ready', shortcuts: {} });
    manager.retryPortal();
    expect(mocks.clients).toHaveLength(2);
    mocks.clients[1]!.status({ state: 'unavailable', shortcuts: {} });
    manager.retryPortal();
    expect(mocks.clients).toHaveLength(3);
    manager.stop();
    expect(mocks.clients[2]!.stop).toHaveBeenCalledOnce();
  });
});
