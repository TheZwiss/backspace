import { useEffect, useState } from 'react';
import { waveformPeaks } from '../utils/voiceMessage';

/** Decoded waveforms by URL: a message that scrolls out and back in is not fetched and decoded again. */
const cache = new Map<string, number[]>();
const MAX_CACHED = 200;

/**
 * Peaks (0..1, `count` of them) of a voice message's audio, for drawing its
 * waveform, or null until they are known or when the file cannot be decoded
 * (the player then draws a neutral waveform). The file is a few kilobytes, so
 * it is fetched and decoded in the browser rather than stored beside the message.
 */
export function useVoicePeaks(url: string, count: number): number[] | null {
  const key = `${count}:${url}`;
  const [peaks, setPeaks] = useState<number[] | null>(() => cache.get(key) ?? null);

  useEffect(() => {
    const cached = cache.get(key);
    if (cached) { setPeaks(cached); return; }
    if (typeof AudioContext === 'undefined') return;
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      let context: AudioContext | null = null;
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return;
        context = new AudioContext();
        const decoded = await context.decodeAudioData(await response.arrayBuffer());
        const computed = waveformPeaks(decoded.getChannelData(0), count);
        if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
        cache.set(key, computed);
        if (!cancelled) setPeaks(computed);
      } catch {
        /* Not decodable, or aborted: the player keeps its neutral waveform. */
      } finally {
        void context?.close().catch(() => { /* already closed */ });
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [key, url, count]);

  return peaks;
}
