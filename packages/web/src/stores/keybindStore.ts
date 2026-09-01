import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Keybind {
  actionId: string;
  keys: number[];          // uIOhook keycodes, sorted ascending
  mouseButton?: number;    // uIOhook mouse button (3=middle, 4=back, 5=forward)
  displayLabel: string;    // human-readable, captured at record time
}

export const BINDABLE_ACTIONS = [
  { id: 'toggleMute', labelKey: 'runtime.manual.toggleMute', type: 'toggle' as const },
  { id: 'toggleDeafen', labelKey: 'runtime.manual.toggleDeafen', type: 'toggle' as const },
  { id: 'pushToTalk', labelKey: 'runtime.manual.pushToTalk', type: 'hold' as const },
  { id: 'toggleCamera', labelKey: 'runtime.manual.toggleCamera', type: 'toggle' as const },
  { id: 'toggleScreenShare', labelKey: 'runtime.manual.toggleScreenShare', type: 'toggle' as const },
  { id: 'disconnect', labelKey: 'runtime.manual.disconnect', type: 'toggle' as const },
] as const;

/** Mouse buttons that must not be bound (would break OS interaction) */
const BLACKLISTED_MOUSE_BUTTONS = new Set([1, 2]); // left, right

interface KeybindState {
  keybinds: Keybind[];
  setKeybind: (keybind: Keybind) => void;
  removeKeybind: (actionId: string) => void;
  findConflict: (keys: number[], mouseButton?: number, excludeActionId?: string) => Keybind | null;
}

function keybindsEqual(a: Keybind, b: { keys: number[]; mouseButton?: number }): boolean {
  if (a.keys.length !== b.keys.length) return false;
  if (a.mouseButton !== b.mouseButton) return false;
  return a.keys.every((k, i) => k === b.keys[i]);
}

export const useKeybindStore = create<KeybindState>()(
  persist(
    (set, get) => ({
      keybinds: [],

      setKeybind: (keybind: Keybind) => {
        if (keybind.mouseButton && BLACKLISTED_MOUSE_BUTTONS.has(keybind.mouseButton)) return;
        const sorted = { ...keybind, keys: [...keybind.keys].sort((a, b) => a - b) };
        set((state) => ({
          keybinds: [
            ...state.keybinds.filter((kb) => kb.actionId !== sorted.actionId),
            sorted,
          ],
        }));
      },

      removeKeybind: (actionId: string) => {
        set((state) => ({
          keybinds: state.keybinds.filter((kb) => kb.actionId !== actionId),
        }));
      },

      findConflict: (keys: number[], mouseButton?: number, excludeActionId?: string) => {
        const sorted = [...keys].sort((a, b) => a - b);
        return get().keybinds.find(
          (kb) => kb.actionId !== excludeActionId && keybindsEqual(kb, { keys: sorted, mouseButton })
        ) ?? null;
      },
    }),
    {
      name: 'backspace-keybinds',
      version: 1,
    }
  )
);
