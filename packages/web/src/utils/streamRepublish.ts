/**
 * Viewer-side state for a screen share the sharer is republishing (a codec
 * change unpublishes the track and publishes the same capture again).
 *
 * Per sharer, keyed by LiveKit identity:
 *
 * | phase       | entered on                                   | left on |
 * |-------------|----------------------------------------------|---------|
 * | `announced` | `stream_republish` received                  | the old publication's removal (→ `bridging`), a new publication, or the window running out (dropped silently) |
 * | `bridging`  | the old publication removed while announced  | a new publication (resumed), the sharer leaving, or the window running out (`onBridgeExpired`: the share ended) |
 *
 * A further announcement while `bridging` (the codec toggled again before the
 * first republish's new track arrived) keeps the entry `bridging`, restarts
 * the window and is remembered: the new publication then resumes the watch
 * and re-arms the entry as `announced`, so the removal the second republish
 * makes bridges as well.
 *
 * Only a removal that follows an announcement bridges. A removal with no
 * announcement (a sharer that predates the message, or an announcement that
 * arrived late) ends the share at once, exactly as before the message existed.
 */

/**
 * How long a viewer waits for the next publication. livekit-client gives the
 * server 10 s to accept a publication before failing it, so a republish that
 * will succeed shows up well inside this; one that failed leaves the viewer
 * with a stalled tile for at most this long before the share ends.
 */
export const STREAM_REPUBLISH_WINDOW_MS = 15_000;

type Phase = 'announced' | 'bridging';

interface Entry {
  phase: Phase;
  /** While bridging: a further republish was announced before the new track arrived. */
  nextAnnounced: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export class StreamRepublishTracker {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly onBridgeExpired: (identity: string) => void) {}

  /** The sharer announced that its next unpublish is a republish. */
  announce(identity: string): void {
    if (this.entries.get(identity)?.phase === 'bridging') {
      // Still waiting for the previous republish's track: stay bridging, so
      // that track resumes the watch, and remember this one for after it.
      this.arm(identity, 'bridging', true);
      return;
    }
    this.arm(identity, 'announced');
  }

  /**
   * The sharer's screen-share publication was removed. Returns true when the
   * removal was announced: the caller keeps the stream and waits for the next
   * publication. False means the share ended.
   */
  bridgeRemoval(identity: string): boolean {
    if (!this.entries.has(identity)) return false;
    this.arm(identity, 'bridging');
    return true;
  }

  /** Between the announced removal and the next publication. */
  isBridging(identity: string): boolean {
    return this.entries.get(identity)?.phase === 'bridging';
  }

  /**
   * A new screen-share publication arrived. Returns true when it continues a
   * bridged share, i.e. a viewer who was watching should be subscribed to it.
   */
  completeWithPublication(identity: string): boolean {
    const entry = this.entries.get(identity);
    if (entry?.phase === 'bridging' && entry.nextAnnounced) {
      this.arm(identity, 'announced');
      return true;
    }
    return this.drop(identity) === 'bridging';
  }

  /** The sharer left. Returns true when a bridged share ended with it. */
  cancel(identity: string): boolean {
    return this.drop(identity) === 'bridging';
  }

  /** The room went away: forget everything without reporting. */
  clear(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }

  private arm(identity: string, phase: Phase, nextAnnounced = false): void {
    const existing = this.entries.get(identity);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      if (this.entries.get(identity)?.timer !== timer) return;
      this.entries.delete(identity);
      if (phase === 'bridging') this.onBridgeExpired(identity);
    }, STREAM_REPUBLISH_WINDOW_MS);
    this.entries.set(identity, { phase, nextAnnounced, timer });
  }

  private drop(identity: string): Phase | null {
    const entry = this.entries.get(identity);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.entries.delete(identity);
    return entry.phase;
  }
}
