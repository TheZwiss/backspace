import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeybindManager } from './keybindManager';
import type { PortalKeybindStatus } from './portalShortcut';

const mocks = vi.hoisted(() => ({ userData: '', clients: [] as Array<{
  start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn>;
  status: (status: PortalKeybindStatus) => void;
}> }));
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData }, systemPreferences: {} }));
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
function setup(registered = true) {
  if (registered) writeFileSync(join(mocks.userData, 'global-shortcuts.json'), JSON.stringify({ registered: true }));
  const manager = new KeybindManager();
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { send: vi.fn() } });
  manager.setWindow(window as unknown as BrowserWindow);
  return { manager, window };
}
beforeEach(() => {
  mocks.clients.length = 0;
  mocks.userData = mkdtempSync(join(tmpdir(), 'backspace-keybinds-'));
});
afterEach(() => { rmSync(mocks.userData, { recursive: true, force: true }); });

describe('Wayland keybind manager', () => {
  it('waits for settings on first launch, then automatically registers on relaunch', () => {
    const first = setup(false);
    expect(mocks.clients).toHaveLength(0);
    expect(first.manager.getPortalStatus()).toEqual({ state: 'idle', shortcuts: {} });
    first.window.emit('focus');
    first.manager.updateKeybinds([]);
    expect(mocks.clients).toHaveLength(0);
    first.manager.retryPortal();
    expect(mocks.clients[0]!.start).toHaveBeenCalledOnce();
    mocks.clients[0]!.status({ state: 'ready', shortcuts: { pushToTalk: 'Ctrl+V' } });
    first.manager.updateKeybinds([]);
    first.manager.stop();
    expect(JSON.parse(readFileSync(join(mocks.userData, 'global-shortcuts.json'), 'utf8')))
      .toEqual({ registered: true });
    const second = setup(false);
    expect(mocks.clients).toHaveLength(2);
    expect(mocks.clients[1]!.start).toHaveBeenCalledOnce();
    second.manager.stop();
  });
  it('does not prompt on relaunch after initial registration was cancelled', () => {
    const first = setup(false);
    first.manager.retryPortal();
    mocks.clients[0]!.status({ state: 'unavailable', shortcuts: {} });
    first.manager.stop();
    const second = setup(false);
    expect(mocks.clients).toHaveLength(1);
    expect(second.manager.getPortalStatus()?.state).toBe('idle');
    second.manager.stop();
  });
  it.each(['{', 'null', '{"registered":"true"}'])('ignores invalid registration state: %s', (value) => {
    writeFileSync(join(mocks.userData, 'global-shortcuts.json'), value);
    const { manager } = setup(false);
    expect(mocks.clients).toHaveLength(0);
    expect(manager.getPortalStatus()?.state).toBe('idle');
    manager.stop();
  });
  it('restores the system session at startup independently of local configuration', () => {
    const { manager } = setup();
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.clients[0]!.start).toHaveBeenCalledWith();
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
    expect(mocks.clients[1]!.start).toHaveBeenCalledWith();
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
