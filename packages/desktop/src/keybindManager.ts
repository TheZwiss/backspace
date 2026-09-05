import type { UiohookKeyboardEvent, UiohookMouseEvent } from 'uiohook-napi';
import { BrowserWindow, systemPreferences } from 'electron';
import { GlobalShortcutsPortal } from './globalShortcutsPortal';
import { isWayland, PortalKeybindStatus } from './portalShortcut';

// ---------------------------------------------------------------------------
// Uiohook keycode → DOM event.code mapping
// ---------------------------------------------------------------------------
// The web UI records keybinds as djb2 hashes of DOM KeyboardEvent.code strings.
// Uiohook fires native keycodes (hardware scan codes). This table bridges the
// two so the main process can match keybinds against native events.

const UIOHOOK_TO_DOM_CODE: Record<number, string> = {
  // Letters
  30: 'KeyA', 48: 'KeyB', 46: 'KeyC', 32: 'KeyD', 18: 'KeyE',
  33: 'KeyF', 34: 'KeyG', 35: 'KeyH', 23: 'KeyI', 36: 'KeyJ',
  37: 'KeyK', 38: 'KeyL', 50: 'KeyM', 49: 'KeyN', 24: 'KeyO',
  25: 'KeyP', 16: 'KeyQ', 19: 'KeyR', 31: 'KeyS', 20: 'KeyT',
  22: 'KeyU', 47: 'KeyV', 17: 'KeyW', 45: 'KeyX', 21: 'KeyY',
  44: 'KeyZ',
  // Digits
  11: 'Digit0', 2: 'Digit1', 3: 'Digit2', 4: 'Digit3', 5: 'Digit4',
  6: 'Digit5', 7: 'Digit6', 8: 'Digit7', 9: 'Digit8', 10: 'Digit9',
  // Function keys
  59: 'F1', 60: 'F2', 61: 'F3', 62: 'F4', 63: 'F5', 64: 'F6',
  65: 'F7', 66: 'F8', 67: 'F9', 68: 'F10', 87: 'F11', 88: 'F12',
  91: 'F13', 92: 'F14', 93: 'F15', 99: 'F16', 100: 'F17', 101: 'F18',
  102: 'F19', 103: 'F20', 104: 'F21', 105: 'F22', 106: 'F23', 107: 'F24',
  // Modifiers
  29: 'ControlLeft', 3613: 'ControlRight',
  56: 'AltLeft', 3640: 'AltRight',
  42: 'ShiftLeft', 54: 'ShiftRight',
  3675: 'MetaLeft', 3676: 'MetaRight',
  // Special keys
  14: 'Backspace', 15: 'Tab', 28: 'Enter', 58: 'CapsLock', 1: 'Escape', 57: 'Space',
  // Navigation
  3657: 'PageUp', 3665: 'PageDown', 3663: 'End', 3655: 'Home',
  57419: 'ArrowLeft', 57416: 'ArrowUp', 57421: 'ArrowRight', 57424: 'ArrowDown',
  3666: 'Insert', 3667: 'Delete',
  // Punctuation
  39: 'Semicolon', 13: 'Equal', 51: 'Comma', 12: 'Minus', 52: 'Period',
  53: 'Slash', 41: 'Backquote', 26: 'BracketLeft', 43: 'Backslash',
  27: 'BracketRight', 40: 'Quote',
  // Numpad
  82: 'Numpad0', 79: 'Numpad1', 80: 'Numpad2', 81: 'Numpad3',
  75: 'Numpad4', 76: 'Numpad5', 77: 'Numpad6', 71: 'Numpad7',
  72: 'Numpad8', 73: 'Numpad9', 55: 'NumpadMultiply', 78: 'NumpadAdd',
  74: 'NumpadSubtract', 83: 'NumpadDecimal', 3637: 'NumpadDivide',
  // Locks
  69: 'NumLock', 70: 'ScrollLock', 3639: 'PrintScreen',
};

/** djb2 hash — must match codeToNumeric() in KeybindsPanel.tsx */
function djb2(code: string): number {
  let hash = 5381;
  for (let i = 0; i < code.length; i++) {
    hash = ((hash << 5) + hash + code.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

// Pre-compute: uiohook keycode → djb2 hash (same values the web UI stores)
const UIOHOOK_TO_HASH = new Map<number, number>();
for (const [keycode, domCode] of Object.entries(UIOHOOK_TO_DOM_CODE)) {
  UIOHOOK_TO_HASH.set(Number(keycode), djb2(domCode));
}

interface KeybindConfig {
  actionId: string;
  keys: number[];
  mouseButton?: number;
}

export class KeybindManager {
  private keybinds: KeybindConfig[] = [];
  private pressedKeys = new Set<number>();
  private activeActions = new Set<string>();
  private window: BrowserWindow | null = null;
  private started = false;
  private hook?: typeof import('uiohook-napi').uIOhook;
  private portal?: GlobalShortcutsPortal;
  private portalStatus: PortalKeybindStatus | null = isWayland() ? { state: 'idle', shortcuts: {} } : null;

  getPortalStatus(): PortalKeybindStatus | null { return this.portalStatus; }

  retryPortal(): void {
    if (this.portalStatus && ['idle', 'unavailable'].includes(this.portalStatus.state)) this.startPortal(true);
  }

  refreshPortal(): void { void this.portal?.refresh(); }

  private sendPortalStatus = (status: PortalKeybindStatus): void => {
    this.portalStatus = status;
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('keybind-portal-status', status);
  };

  private startPortal(interactive = false): void {
    this.portal?.stop();
    this.portal = undefined;
    this.sendPortalStatus({ state: 'pending', shortcuts: {} });
    this.portal = new GlobalShortcutsPortal((id, pressed) => this.sendAction(id, pressed), this.sendPortalStatus);
    void this.portal.start(interactive);
  }

  constructor() {
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
  }

  setWindow(win: BrowserWindow): void {
    this.window = win;
    if (this.portalStatus) {
      if (!this.portal) this.startPortal();
      win.on('focus', () => this.refreshPortal());
    }
  }

  updateKeybinds(keybinds: KeybindConfig[]): void {
    if (this.portalStatus) {
      // Local settings belong to the browser/X11 backend, never to the portal.
      // In particular renderer unmount or clearing local storage must not close
      // a Wayland session or pretend to delete persistent system assignments.
      this.sendPortalStatus(this.portalStatus);
      return;
    }
    this.keybinds = keybinds;
    for (const actionId of this.activeActions) {
      if (!keybinds.some((kb) => kb.actionId === actionId)) {
        this.sendAction(actionId, false);
        this.activeActions.delete(actionId);
      }
    }
    if (keybinds.length > 0 && !this.started) {
      this.start();
    }
    if (keybinds.length === 0 && this.started) {
      this.stop();
    }
  }

  private start(): void {
    if (this.started) return;
    if (process.platform === 'darwin') {
      const trusted = systemPreferences.isTrustedAccessibilityClient(true);
      this.sendAccessibilityStatus(trusted);
      if (!trusted) return;
    }
    try {
      // Do not load the X11 native library at all on the Wayland portal path.
      const { uIOhook } = require('uiohook-napi') as typeof import('uiohook-napi');
      this.hook = uIOhook;
      uIOhook.on('keydown', this.onKeyDown);
      uIOhook.on('keyup', this.onKeyUp);
      uIOhook.on('mousedown', this.onMouseDown);
      uIOhook.on('mouseup', this.onMouseUp);
      uIOhook.start();
      this.started = true;
    } catch (err) {
      this.removeHookListeners();
      console.error('[KeybindManager] Failed to start uiohook:', err);
      this.window?.webContents.send('keybind-hook-error', { message: String(err) });
    }
  }

  stop(): void {
    this.portal?.stop();
    this.portal = undefined;
    this.keybinds = [];
    if (this.portalStatus) this.sendPortalStatus({ state: 'idle', shortcuts: {} });
    if (!this.started) return;
    for (const actionId of this.activeActions) {
      this.sendAction(actionId, false);
    }
    this.activeActions.clear();
    this.pressedKeys.clear();
    this.removeHookListeners();
    try { this.hook?.stop(); } catch { /* ignore */ }
    this.started = false;
  }

  private removeHookListeners(): void {
    this.hook?.removeListener('keydown', this.onKeyDown);
    this.hook?.removeListener('keyup', this.onKeyUp);
    this.hook?.removeListener('mousedown', this.onMouseDown);
    this.hook?.removeListener('mouseup', this.onMouseUp);
  }

  checkAccessibility(): boolean {
    if (process.platform !== 'darwin') return true;
    return systemPreferences.isTrustedAccessibilityClient(false);
  }

  private onKeyDown(e: UiohookKeyboardEvent): void {
    const hash = UIOHOOK_TO_HASH.get(e.keycode);
    if (hash === undefined) return; // unmapped key — ignore
    this.pressedKeys.add(hash);
    this.evaluateKeybinds();
  }

  private onKeyUp(e: UiohookKeyboardEvent): void {
    const hash = UIOHOOK_TO_HASH.get(e.keycode);
    if (hash === undefined) return;
    this.pressedKeys.delete(hash);
    this.checkReleases();
  }

  private onMouseDown(e: UiohookMouseEvent): void {
    const button = e.button as number;
    if (button <= 2) return;
    this.evaluateKeybindsWithMouse(button);
  }

  private onMouseUp(e: UiohookMouseEvent): void {
    const button = e.button as number;
    if (button <= 2) return;
    this.checkMouseReleases(button);
  }

  private evaluateKeybinds(): void {
    for (const kb of this.keybinds) {
      if (this.activeActions.has(kb.actionId)) continue;
      if (kb.mouseButton) continue;
      if (kb.keys.length === 0) continue;
      if (kb.keys.every((k) => this.pressedKeys.has(k))) {
        this.activeActions.add(kb.actionId);
        this.sendAction(kb.actionId, true);
      }
    }
  }

  private evaluateKeybindsWithMouse(mouseButton: number): void {
    for (const kb of this.keybinds) {
      if (this.activeActions.has(kb.actionId)) continue;
      if (kb.mouseButton !== mouseButton) continue;
      if (kb.keys.every((k) => this.pressedKeys.has(k))) {
        this.activeActions.add(kb.actionId);
        this.sendAction(kb.actionId, true);
      }
    }
  }

  private checkReleases(): void {
    for (const actionId of this.activeActions) {
      const kb = this.keybinds.find((k) => k.actionId === actionId);
      if (!kb) continue;
      if (kb.mouseButton) continue;
      if (!kb.keys.every((k) => this.pressedKeys.has(k))) {
        this.activeActions.delete(actionId);
        this.sendAction(actionId, false);
      }
    }
  }

  private checkMouseReleases(mouseButton: number): void {
    for (const actionId of this.activeActions) {
      const kb = this.keybinds.find((k) => k.actionId === actionId);
      if (!kb || kb.mouseButton !== mouseButton) continue;
      this.activeActions.delete(actionId);
      this.sendAction(actionId, false);
    }
  }

  private sendAction(actionId: string, pressed: boolean): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send('keybind-action', { actionId, pressed });
  }

  private sendAccessibilityStatus(trusted: boolean): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send('accessibility-status', { trusted });
  }
}
