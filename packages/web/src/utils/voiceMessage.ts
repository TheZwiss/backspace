/**
 * Voice messages: pure helpers for recording and playing them. The recorder
 * (`hooks/useVoiceRecorder.ts`) and the player (`components/chat/VoiceMessagePlayer.tsx`)
 * share the file naming, so a message is a voice message by its name alone.
 */

/**
 * Opus at 24 kbit/s mono: clear speech at roughly 3 KB per second, about a
 * tenth of what the browser would pick. Music is not the goal.
 */
export const VOICE_BITS_PER_SECOND = 24_000;

/** The longest recording; it stops and keeps what it has when reached. */
export const VOICE_MAX_DURATION_MS = 10 * 60 * 1000;

/** The shortest recording worth sending; anything shorter is a mis-tap and is discarded. */
export const VOICE_MIN_DURATION_MS = 700;

/** What the recorder may produce, best first, with the extension the server maps to its audio type. */
const RECORDER_FORMATS = [
  { mimeType: 'audio/webm;codecs=opus', extension: 'weba' },
  { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' },
  { mimeType: 'audio/mp4', extension: 'm4a' },
] as const;

export interface RecorderFormat {
  mimeType: string;
  extension: string;
}

/** The first format the browser can record, or null when it cannot record audio at all. */
export function pickRecorderFormat(isTypeSupported: (mimeType: string) => boolean): RecorderFormat | null {
  return RECORDER_FORMATS.find((format) => isTypeSupported(format.mimeType)) ?? null;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** `voice-message-20261107-153042.weba`, in local time. */
export function voiceMessageFileName(date: Date, extension: string): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `voice-message-${day}-${time}.${extension}`;
}

const VOICE_MESSAGE_NAME = /^voice-message-\d{8}-\d{6}\.(weba|ogg|m4a)$/i;

/** True for a file the recorder named; the message list draws these as voice messages. */
export function isVoiceMessageName(originalName: string): boolean {
  return VOICE_MESSAGE_NAME.test(originalName);
}

/** `0:07`, `12:30`; floors to whole seconds. Hours are never needed under the length cap. */
export function formatVoiceDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}:${pad(totalSeconds % 60)}`;
}

/**
 * Reduces decoded samples to `count` loudness values in 0..1, one per bar of
 * the waveform: the peak of each slice, scaled so the loudest slice reaches 1
 * (a quiet recording still draws a readable shape).
 */
export function waveformPeaks(samples: Float32Array, count: number): number[] {
  if (count <= 0) return [];
  if (samples.length === 0) return new Array<number>(count).fill(0);
  const peaks = new Array<number>(count).fill(0);
  const slice = samples.length / count;
  for (let bar = 0; bar < count; bar++) {
    const start = Math.floor(bar * slice);
    const end = Math.max(start + 1, Math.floor((bar + 1) * slice));
    let peak = 0;
    for (let i = start; i < end && i < samples.length; i++) {
      const value = Math.abs(samples[i]!);
      if (value > peak) peak = value;
    }
    peaks[bar] = peak;
  }
  const loudest = Math.max(...peaks);
  return loudest > 0 ? peaks.map((peak) => peak / loudest) : peaks;
}

/**
 * Maps an analyser's frequency bins (0..255) to `bars` loudness values in
 * 0..1 across the speech band (up to about 8 kHz of a 48 kHz context). Bins are grouped on a roughly logarithmic
 * scale, because speech energy sits low and a linear split would leave most
 * bars flat; the top of the range (above speech) is ignored.
 */
export function spectrumBars(frequencyData: Uint8Array, bars: number, speechShare = 0.33): number[] {
  const usable = Math.max(bars, Math.floor(frequencyData.length * speechShare));
  const out = new Array<number>(bars).fill(0);
  for (let bar = 0; bar < bars; bar++) {
    const from = Math.floor(Math.pow(usable, bar / bars)) - 1;
    const to = Math.max(from + 1, Math.floor(Math.pow(usable, (bar + 1) / bars)) - 1);
    let sum = 0;
    let n = 0;
    for (let i = Math.max(0, from); i < to && i < frequencyData.length; i++) {
      sum += frequencyData[i]!;
      n++;
    }
    out[bar] = n > 0 ? Math.min(1, sum / n / 255) : 0;
  }
  return out;
}
