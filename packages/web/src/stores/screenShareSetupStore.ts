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
  open: (targetDocument?: Document) => void;
  close: () => void;
}

export const useScreenShareSetupStore = create<ScreenShareSetupState>((set) => ({
  isOpen: false,
  targetDocument: null,
  open: (targetDocument) => set({ isOpen: true, targetDocument: targetDocument ?? null }),
  close: () => set({ isOpen: false, targetDocument: null }),
}));

export function openScreenShareSetup(targetDocument?: Document): void {
  useScreenShareSetupStore.getState().open(targetDocument);
}

export function closeScreenShareSetup(): void {
  useScreenShareSetupStore.getState().close();
}
