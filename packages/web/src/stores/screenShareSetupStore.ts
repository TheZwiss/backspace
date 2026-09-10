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
  open: () => void;
  close: () => void;
}

export const useScreenShareSetupStore = create<ScreenShareSetupState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));

export function openScreenShareSetup(): void {
  useScreenShareSetupStore.getState().open();
}

export function closeScreenShareSetup(): void {
  useScreenShareSetupStore.getState().close();
}
