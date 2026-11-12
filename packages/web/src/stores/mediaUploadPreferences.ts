import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface MediaUploadPreferences {
  /**
   * Shrink photos and videos on this device before they are uploaded
   * (`utils/mediaCompression.ts`). On by default; "Document" in the attach
   * menu always sends the original, whatever this says.
   */
  compressMedia: boolean;
  setCompressMedia: (compress: boolean) => void;
}

export const useMediaUploadPreferences = create<MediaUploadPreferences>()(persist(
  (set) => ({
    compressMedia: true,
    setCompressMedia: (compressMedia) => set({ compressMedia }),
  }),
  {
    name: 'backspace-media-upload-preferences',
    partialize: (state) => ({ compressMedia: state.compressMedia }),
    merge: (stored, current) => ({
      ...current,
      // Anything but an explicit false keeps the default
      compressMedia: (stored as Partial<MediaUploadPreferences> | undefined)?.compressMedia !== false,
    }),
  },
));
