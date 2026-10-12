import { afterEach, describe, expect, it, vi } from 'vitest';
import { soundboardWavDuration } from '@backspace/shared/src/soundboard';
import { audioBase64, encodePcmWav, encodeSoundboardClip, soundboardSelectionSamples } from './soundboardAudio';

afterEach(() => vi.unstubAllGlobals());

describe('soundboard audio encoding', () => {
  it('produces a canonical mono 48 kHz WAV with sample-derived duration', () => {
    const bytes = encodePcmWav(new Float32Array(48000));
    expect(soundboardWavDuration(bytes)).toBe(1);
    expect(atob(audioBase64(bytes)).length).toBe(bytes.length);
  });
  it('clamps samples and fades both cut boundaries', () => {
    const samples = new Float32Array(1000).fill(2);
    const bytes = encodePcmWav(samples); const view = new DataView(bytes.buffer);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(44 + 500 * 2, true)).toBe(32767);
    expect(view.getInt16(bytes.length - 2, true)).toBe(0);
  });
  it('does not accept truncated, mismatched or non-PCM WAV data', () => {
    const bytes = encodePcmWav(new Float32Array(4800));
    expect(soundboardWavDuration(bytes.slice(0, -2))).toBeNull();
    new DataView(bytes.buffer).setUint16(20, 3, true);
    expect(soundboardWavDuration(bytes)).toBeNull();
  });
  it.each([[6.01, 16.01, 480000], [0.5, 0.6, 4800]])('encodes boundary selection %s → %s in exact output samples', async (start, end, samples) => {
    const startSource = vi.fn();
    const offline = vi.fn();
    vi.stubGlobal('OfflineAudioContext', class {
      destination = {};
      constructor(readonly channels: number, readonly length: number, readonly sampleRate: number) { offline(channels, length, sampleRate); }
      createBufferSource() { return { connect: vi.fn(), start: startSource }; }
      async startRendering() { return { getChannelData: () => new Float32Array(this.length) }; }
    });
    expect(soundboardSelectionSamples(20, start, end)).toBe(samples);
    const bytes = await encodeSoundboardClip({ duration: 20 } as AudioBuffer, start, end);
    expect(offline).toHaveBeenCalledWith(1, samples, 48000);
    expect(startSource).toHaveBeenCalledWith(0, start, samples / 48000);
    expect(soundboardWavDuration(bytes)).toBe(samples / 48000);
  });
  it.each([[0.5, 0.5999], [-0.01, 1], [1, 0.5], [0, 21], [NaN, 1], [0, Infinity]])('rejects invalid selection %s → %s', async (start, end) => {
    expect(soundboardSelectionSamples(20, start, end)).toBeNull();
    await expect(encodeSoundboardClip({ duration: 20 } as AudioBuffer, start, end)).rejects.toThrow('Invalid selection');
  });
});
