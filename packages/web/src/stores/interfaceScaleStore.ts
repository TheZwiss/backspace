import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const INTERFACE_SCALES = [75, 100, 125, 150, 175, 200, 225, 250] as const;

export function normalizeInterfaceScale(value: unknown): number {
  return typeof value === 'number' && INTERFACE_SCALES.some(scale => scale === value) ? value : 100;
}

interface InterfaceScaleState {
  scale: number;
  setScale: (scale: number) => void;
}

export const useInterfaceScaleStore = create<InterfaceScaleState>()(persist(
  set => ({ scale: 100, setScale: scale => set({ scale: normalizeInterfaceScale(scale) }) }),
  {
    name: 'backspace-interface-scale',
    partialize: state => ({ scale: state.scale }),
    merge: (stored, current) => ({
      ...current,
      scale: normalizeInterfaceScale((stored as Partial<InterfaceScaleState> | undefined)?.scale),
    }),
  },
));
