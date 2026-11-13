import type { Mock } from 'vitest';

/** The slice of the mocked Electron BrowserWindow that the overlay tests read back. */
export interface MockOverlayWindow {
  options: unknown;
  destroyed: boolean;
  webContents: { executeJavaScript: Mock };
  setIgnoreMouseEvents: Mock;
  setAlwaysOnTop: Mock;
  setFullScreen: Mock;
  setOpacity: Mock;
  setBounds: Mock;
  moveTop: Mock;
  showInactive: Mock;
  loadURL: Mock;
}
