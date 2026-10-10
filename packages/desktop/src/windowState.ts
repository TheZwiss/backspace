import { app, BrowserWindow, screen } from 'electron';
import fs from 'fs';
import path from 'path';

// ─── Window State Persistence ───────────────────────────────────────────────

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1280,
  height: 800,
  isMaximized: false,
};

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

export function loadWindowState(): WindowState {
  try {
    const raw = fs.readFileSync(getWindowStatePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    return {
      width: typeof parsed.width === 'number' ? parsed.width : DEFAULT_WINDOW_STATE.width,
      height: typeof parsed.height === 'number' ? parsed.height : DEFAULT_WINDOW_STATE.height,
      x: typeof parsed.x === 'number' ? parsed.x : undefined,
      y: typeof parsed.y === 'number' ? parsed.y : undefined,
      isMaximized: typeof parsed.isMaximized === 'boolean' ? parsed.isMaximized : false,
    };
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

export function validateWindowBounds(state: WindowState): WindowState {
  if (state.x === undefined || state.y === undefined) return state;

  const bounds = { x: state.x, y: state.y, width: state.width, height: state.height };
  const display = screen.getDisplayMatching(bounds);
  const { x, y, width, height } = display.workArea;

  // Check if window is at least partially visible on the display
  const visible =
    bounds.x + bounds.width > x &&
    bounds.x < x + width &&
    bounds.y + bounds.height > y &&
    bounds.y < y + height;

  if (!visible) {
    // Strip position — let Electron auto-center
    return { width: state.width, height: state.height, isMaximized: state.isMaximized };
  }

  return state;
}

export function saveWindowState(win: BrowserWindow): void {
  try {
    const isMaximized = win.isMaximized();
    // Use the bounds from before maximize, to restore the un-maximized size
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized,
    };
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state));
  } catch {
    // Non-critical — silently ignore write failures
  }
}
