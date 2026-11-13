import { describe, expect, it } from 'vitest';
import {
  formatVoiceDuration,
  isVoiceMessageName,
  pickRecorderFormat,
  spectrumBars,
  voiceMessageFileName,
  waveformPeaks,
} from './voiceMessage';

describe('pickRecorderFormat', () => {
  it('prefers Opus in WebM, then Opus in Ogg, then MP4', () => {
    expect(pickRecorderFormat(() => true)).toEqual({ mimeType: 'audio/webm;codecs=opus', extension: 'weba' });
    expect(pickRecorderFormat((m) => m.startsWith('audio/ogg'))).toEqual({ mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' });
    expect(pickRecorderFormat((m) => m === 'audio/mp4')).toEqual({ mimeType: 'audio/mp4', extension: 'm4a' });
  });

  it('is null when nothing can be recorded', () => {
    expect(pickRecorderFormat(() => false)).toBeNull();
  });
});

describe('voice message names', () => {
  it('names a recording by its local date and time, with an extension the server maps to audio', () => {
    expect(voiceMessageFileName(new Date(2026, 10, 7, 9, 5, 3), 'weba')).toBe('voice-message-20261107-090503.weba');
  });

  it('recognises only what the recorder names', () => {
    expect(isVoiceMessageName('voice-message-20261107-090503.weba')).toBe(true);
    expect(isVoiceMessageName('voice-message-20261107-090503.OGG')).toBe(true);
    expect(isVoiceMessageName('voice-message-20261107-090503.m4a')).toBe(true);
    expect(isVoiceMessageName('voice-message.weba')).toBe(false);
    expect(isVoiceMessageName('song.mp3')).toBe(false);
    expect(isVoiceMessageName('voice-message-20261107-090503.mp3')).toBe(false);
  });
});

describe('formatVoiceDuration', () => {
  it('floors to whole seconds as m:ss', () => {
    expect(formatVoiceDuration(0)).toBe('0:00');
    expect(formatVoiceDuration(7999)).toBe('0:07');
    expect(formatVoiceDuration(61_000)).toBe('1:01');
    expect(formatVoiceDuration(10 * 60 * 1000)).toBe('10:00');
    expect(formatVoiceDuration(-5)).toBe('0:00');
  });
});

describe('waveformPeaks', () => {
  it('takes the peak of each slice and scales the loudest to 1', () => {
    const samples = Float32Array.from([0.1, -0.2, 0.05, 0.0, 0.4, -0.1]);
    expect(waveformPeaks(samples, 3)).toEqual([1 * 0.2 / 0.4, 0.05 / 0.4, 1]);
  });

  it('stays flat for silence and for no samples, and never divides by zero', () => {
    expect(waveformPeaks(new Float32Array(10), 4)).toEqual([0, 0, 0, 0]);
    expect(waveformPeaks(new Float32Array(0), 3)).toEqual([0, 0, 0]);
    expect(waveformPeaks(Float32Array.from([1]), 0)).toEqual([]);
  });

  it('gives a bar for every slot even with fewer samples than bars', () => {
    const peaks = waveformPeaks(Float32Array.from([0.5, 1]), 6);
    expect(peaks).toHaveLength(6);
    expect(Math.max(...peaks)).toBe(1);
  });
});

describe('spectrumBars', () => {
  it('returns one value in 0..1 per bar', () => {
    const data = new Uint8Array(32).fill(255);
    const bars = spectrumBars(data, 12);
    expect(bars).toHaveLength(12);
    for (const value of bars) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(bars.every((v) => v === 1)).toBe(true);
  });

  it('is silent for silence, and low frequencies move the left bars first', () => {
    expect(spectrumBars(new Uint8Array(32), 8).every((v) => v === 0)).toBe(true);
    const low = new Uint8Array(32);
    low[0] = low[1] = low[2] = 255;
    const bars = spectrumBars(low, 8);
    expect(bars[0]! + bars[1]! + bars[2]!).toBeGreaterThan(bars[5]! + bars[6]! + bars[7]!);
  });
});
