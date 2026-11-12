/**
 * Pure helpers behind the sound-effect trimmer: selection rules, the waveform
 * summary and silence detection. They touch no Web Audio or DOM API, so the
 * rules that keep a clip inside the soundboard limit are unit-tested directly.
 */

/** Longest clip a person can keep. The server accepts up to 5.2 s; this stays under it. */
export const MAX_CLIP_SECONDS = 5;
/** Shortest selectable clip, so a handle can never collapse onto the other one. */
export const MIN_CLIP_SECONDS = 0.1;
/** Edge fade applied when "fade edges" is on; removes the click of a hard cut. */
export const EDGE_FADE_SECONDS = 0.02;

export interface ClipSelection {
  /** Seconds from the start of the source. */
  start: number;
  /** Seconds from the start of the source; always after `start`. */
  end: number;
}

function minLength(duration: number): number {
  return Math.min(MIN_CLIP_SECONDS, duration);
}

/** The cut a fresh file starts with: its beginning, at most `MAX_CLIP_SECONDS`. */
export function defaultSelection(duration: number): ClipSelection {
  return { start: 0, end: Math.min(duration, MAX_CLIP_SECONDS) };
}

/** Move the start handle. It cannot cross the end or make the clip longer than the limit. */
export function moveStart(selection: ClipSelection, seconds: number, duration: number): ClipSelection {
  const lowest = Math.max(0, selection.end - MAX_CLIP_SECONDS);
  const highest = Math.max(lowest, selection.end - minLength(duration));
  return { start: Math.min(highest, Math.max(lowest, seconds)), end: selection.end };
}

/** Move the end handle. It cannot cross the start, pass the source's end or exceed the limit. */
export function moveEnd(selection: ClipSelection, seconds: number, duration: number): ClipSelection {
  const lowest = Math.min(duration, selection.start + minLength(duration));
  const highest = Math.min(duration, selection.start + MAX_CLIP_SECONDS);
  return { start: selection.start, end: Math.max(lowest, Math.min(highest, seconds)) };
}

/** Slide the whole window by `delta` seconds, keeping its length and staying inside the source. */
export function slideSelection(selection: ClipSelection, delta: number, duration: number): ClipSelection {
  const length = selection.end - selection.start;
  const start = Math.min(Math.max(0, duration - length), Math.max(0, selection.start + delta));
  return { start, end: start + length };
}

/** Centre a window of the current length on `centre`, clamped to the source. */
export function centreSelection(selection: ClipSelection, centre: number, duration: number): ClipSelection {
  const length = selection.end - selection.start;
  return slideSelection(selection, centre - length / 2 - selection.start, duration);
}

/** Whether a selection is a valid, in-limit cut of a source of `duration` seconds. */
export function isValidSelection(selection: ClipSelection, duration: number): boolean {
  const length = selection.end - selection.start;
  return selection.start >= 0
    && selection.end <= duration + 1e-6
    && length >= minLength(duration) - 1e-6
    && length <= MAX_CLIP_SECONDS + 1e-6;
}

/**
 * Peak amplitude (0..1) per bucket across every channel, for drawing the waveform.
 * Silence returns zeros; an empty source returns `buckets` zeros.
 */
export function computePeaks(channels: readonly Float32Array[], buckets: number): number[] {
  const count = Math.max(1, Math.floor(buckets));
  const peaks = new Array<number>(count).fill(0);
  const length = channels[0]?.length ?? 0;
  if (length === 0) return peaks;
  for (let bucket = 0; bucket < count; bucket++) {
    const from = Math.floor((bucket * length) / count);
    const to = Math.max(from + 1, Math.floor(((bucket + 1) * length) / count));
    let peak = 0;
    for (const channel of channels) {
      for (let i = from; i < to && i < channel.length; i++) {
        const value = Math.abs(channel[i]!);
        if (value > peak) peak = value;
      }
    }
    peaks[bucket] = Math.min(1, peak);
  }
  return peaks;
}

/**
 * First and last audible moments: where the signal first and last rises above
 * `threshold`. Used by "trim silence". Returns null when nothing is audible.
 */
export function findAudibleRange(
  channels: readonly Float32Array[],
  sampleRate: number,
  threshold = 0.01,
): ClipSelection | null {
  const length = channels[0]?.length ?? 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < length; i++) {
    let loud = false;
    for (const channel of channels) {
      if (Math.abs(channel[i] ?? 0) > threshold) { loud = true; break; }
    }
    if (loud) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  return { start: first / sampleRate, end: (last + 1) / sampleRate };
}

/**
 * Selection that frames the audible part of a source, widened to a readable
 * minimum and trimmed to the limit (the beginning of the audible part wins).
 */
export function selectAudible(
  channels: readonly Float32Array[],
  sampleRate: number,
  duration: number,
  padding = 0.03,
): ClipSelection {
  const range = findAudibleRange(channels, sampleRate);
  if (!range) return defaultSelection(duration);
  const start = Math.max(0, range.start - padding);
  const end = Math.min(duration, range.end + padding);
  const limited: ClipSelection = { start, end: Math.min(end, start + MAX_CLIP_SECONDS) };
  return limited.end - limited.start >= minLength(duration) ? limited : defaultSelection(duration);
}
