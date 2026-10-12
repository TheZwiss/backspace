import { MAX_SOUNDBOARD_BYTES, SOUNDBOARD_SAMPLE_RATE } from '@backspace/shared/src/soundboard';

/** Validate selections in output samples, not floating-point differences of timestamps. */
export function soundboardSelectionSamples(sourceDuration: number, start: number, end: number): number | null {
  if (!Number.isFinite(sourceDuration) || !Number.isFinite(start) || !Number.isFinite(end)
    || start < 0 || end > sourceDuration) return null;
  const samples = Math.round((end - start) * SOUNDBOARD_SAMPLE_RATE);
  return Number.isSafeInteger(samples) && samples >= SOUNDBOARD_SAMPLE_RATE / 10 ? samples : null;
}

/** Encode only the selection. Mono downmix, resample, and a short fade avoid clicks at cut boundaries. */
export async function encodeSoundboardClip(buffer: AudioBuffer, start: number, end: number): Promise<Uint8Array> {
  const length = soundboardSelectionSamples(buffer.duration, start, end);
  if (length === null) throw new Error('Invalid selection');
  if (length * 2 + 44 > MAX_SOUNDBOARD_BYTES) throw new Error('Selection exceeds file limit');
  const offline = new OfflineAudioContext(1, length, SOUNDBOARD_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0, start, length / SOUNDBOARD_SAMPLE_RATE);
  const rendered = await offline.startRendering();
  return encodePcmWav(rendered.getChannelData(0));
}

export function encodePcmWav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => [...value].forEach((c, i) => { bytes[offset + i] = c.charCodeAt(0); });
  tag(0, 'RIFF'); tag(8, 'WAVE'); tag(12, 'fmt '); tag(36, 'data');
  view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SOUNDBOARD_SAMPLE_RATE, true); view.setUint32(28, SOUNDBOARD_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, samples.length * 2, true);
  const fade = Math.min(240, Math.floor(samples.length / 2));
  for (let i = 0; i < samples.length; i++) {
    const envelope = fade > 0 ? Math.min(1, i / fade, (samples.length - 1 - i) / fade) : 1;
    const sample = Math.max(-1, Math.min(1, (samples[i] ?? 0) * envelope));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export function audioBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(parts.join(''));
}
