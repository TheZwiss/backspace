/**
 * The bands that decide whether a voice or stream connection is healthy.
 *
 * Two surfaces answer that question: the numbers in `ConnectionInfoPopover`,
 * which colour themselves, and the warning icon on a `StreamTile`. They used to
 * carry their own copies of these figures, which is how a tile ends up warning
 * about a stream while the popover open next to it reads every value green.
 * Both read from here instead, so retuning a band moves both at once.
 */
export const VOICE_HEALTH = {
  /** Round-trip time to the voice server, milliseconds. */
  pingWarnMs: 80,
  pingBadMs: 200,
  /** Packet loss on a single track, percent. */
  lossWarnPct: 1,
  lossBadPct: 5,
  /** Jitter on a single track, milliseconds. */
  jitterWarnMs: 30,
  jitterBadMs: 80,
  /**
   * Freezes counted within one stats sample (the poll runs at 1 Hz). A single
   * freeze is ordinary: a simulcast layer switch produces one, and so does a
   * tab that was briefly throttled. Sustained freezing is what a viewer notices.
   */
  freezesBadPerSample: 2,
} as const;

export type HealthBand = 'good' | 'warn' | 'bad';

/** Place a measurement in its band. Both thresholds are inclusive of the lower band. */
export function healthBand(value: number, warnAbove: number, badAbove: number): HealthBand {
  if (value <= warnAbove) return 'good';
  if (value <= badAbove) return 'warn';
  return 'bad';
}
