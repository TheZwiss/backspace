import { uIOhook, UiohookKeyboardEvent, UiohookMouseEvent } from 'uiohook-napi';
import { BrowserWindow, systemPreferences } from 'electron';

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

  constructor() {
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
  }

  setWindow(win: BrowserWindow): void {
    this.window = win;
  }

  updateKeybinds(keybinds: KeybindConfig[]): void {
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
    uIOhook.on('keydown', this.onKeyDown);
    uIOhook.on('keyup', this.onKeyUp);
    uIOhook.on('mousedown', this.onMouseDown);
    uIOhook.on('mouseup', this.onMouseUp);
    try {
      uIOhook.start();
      this.started = true;
    } catch (err) {
      console.error('[KeybindManager] Failed to start uiohook:', err);
      this.window?.webContents.send('keybind-hook-error', { message: String(err) });
    }
  }

  stop(): void {
    if (!this.started) return;
    for (const actionId of this.activeActions) {
      this.sendAction(actionId, false);
    }
    this.activeActions.clear();
    this.pressedKeys.clear();
    uIOhook.removeAllListeners();
    try { uIOhook.stop(); } catch { /* ignore */ }
    this.started = false;
  }

  checkAccessibility(): boolean {
    if (process.platform !== 'darwin') return true;
    return systemPreferences.isTrustedAccessibilityClient(false);
  }

  private onKeyDown(e: UiohookKeyboardEvent): void {
    this.pressedKeys.add(e.keycode);
    this.evaluateKeybinds();
  }

  private onKeyUp(e: UiohookKeyboardEvent): void {
    this.pressedKeys.delete(e.keycode);
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
