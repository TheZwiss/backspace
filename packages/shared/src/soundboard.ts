/** Soundboard clips are canonical PCM WAV: mono, 48 kHz, signed 16-bit. */
export const SOUNDBOARD_SAMPLE_RATE = 48_000;
export const MAX_SOUNDBOARD_BYTES = 20 * 1024 * 1024;
export const MAX_SOUNDBOARD_SOUNDS = 100;

export interface SoundboardSettings {
  enabled: boolean;
  allowMemberUploads: boolean;
  maxDurationSeconds: number | null;
  maxSounds: number;
}

export const DEFAULT_SOUNDBOARD_SETTINGS: SoundboardSettings = {
  enabled: true, allowMemberUploads: true, maxDurationSeconds: 10, maxSounds: 50,
};

export interface SoundboardSound {
  id: string;
  spaceId: string;
  uploaderId: string;
  name: string;
  emoji: string;
  filename: string;
  durationSeconds: number;
  createdAt: number;
}

export interface SoundboardDocument {
  settings: SoundboardSettings;
  sounds: SoundboardSound[];
}

/** Validate every header and the exact payload length, never trust client duration/MIME. */
export function soundboardWavDuration(bytes: Uint8Array): number | null {
  if (bytes.length < 46 || bytes.length > MAX_SOUNDBOARD_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, value: string) => [...value].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (!tag(0, 'RIFF') || !tag(8, 'WAVE') || !tag(12, 'fmt ') || !tag(36, 'data')
    || view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16
    || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1
    || view.getUint32(24, true) !== SOUNDBOARD_SAMPLE_RATE
    || view.getUint32(28, true) !== SOUNDBOARD_SAMPLE_RATE * 2
    || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16
    || view.getUint32(40, true) !== bytes.length - 44 || (bytes.length - 44) % 2 !== 0) return null;
  return (bytes.length - 44) / (SOUNDBOARD_SAMPLE_RATE * 2);
}
