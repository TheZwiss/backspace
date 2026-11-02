import { create } from 'zustand';

/**
 * Open/closed state of the screen-share setup screen (ScreenShareSetup).
 *
 * The setup screen is the single way a screen share starts: the control-bar
 * button, the keybind, the mobile call screen and "Change stream" all open it.
 * Module-level helpers exist so non-React callers (voiceActions, screenShare)
 * can open it without importing the hook.
 */
interface ScreenShareSetupState {
  isOpen: boolean;
  targetDocument: Document | null;
  mode: 'start' | 'replace';
  openingId: number;
  open: (targetDocument?: Document, mode?: 'start' | 'replace') => void;
  close: () => void;
}

export const useScreenShareSetupStore = create<ScreenShareSetupState>((set) => ({
  isOpen: false,
  targetDocument: null,
  mode: 'start',
  openingId: 0,
  open: (targetDocument, mode = 'start') => set(state => state.isOpen && state.mode === mode && state.targetDocument === (targetDocument ?? null)
    ? state
    : { isOpen: true, targetDocument: targetDocument ?? null, mode, openingId: state.openingId + 1 }),
  close: () => set({ isOpen: false, targetDocument: null }),
}));

export function openScreenShareSetup(targetDocument?: Document, mode: 'start' | 'replace' = 'start'): void {
  useScreenShareSetupStore.getState().open(targetDocument, mode);
}

export function closeScreenShareSetup(): void {
  useScreenShareSetupStore.getState().close();
}
