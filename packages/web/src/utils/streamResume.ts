/**
 * Viewer-side memory of screen shares that ended while this viewer was
 * watching them, so the watch can come back after a full LiveKit reconnect.
 *
 * A full reconnect (livekit-client 2.22.3, `Room.handleRestarting`) drops
 * every remote participant of the room that reconnects, and the server
 * replaces the reconnecting participant for everyone else. So viewers see a
 * share end both when its sharer fully reconnects and when they do
 * themselves, and nothing could announce it beforehand: the connection is
 * already gone. `stream_republish` cannot cover it.
 *
 * Per sharer, keyed by LiveKit identity (the same before and after a
 * reconnect):
 *
 * | phase                  | entered on | left on |
 * |------------------------|------------|---------|
 * | `awaitingAnnouncement` | a watched share's publication removed, not as a republish | `stream_resume` from the sharer (→ `awaitingPublication`), this viewer's own full reconnect (→ `awaitingPublication`), `stream_stop`, or the window running out |
 * | `awaitingPublication`  | as above   | a screen-share publication of the sharer (`takeOnPublication`: the caller watches again), `stream_stop`, or the window running out |
 * | `stopped`              | `stream_stop` with nothing remembered | the removal that follows (not remembered), or the window running out |
 *
 * A share the sharer stopped is announced (`stream_stop`), so it is not
 * remembered whichever of the stop message and the removal arrives first. A
 * sharer that predates the signals never announces a stop or a resume: its
 * share is remembered for the window and then forgotten, unless this viewer's
 * own full reconnect falls inside it.
 *
 * While this viewer's own room reconnects the windows wait (`hold`): the
 * reconnect itself may take longer than a window.
 */

/** How long a viewer remembers a share it was watching. */
export const STREAM_RESUME_WINDOW_MS = 15_000;

/** The per-stream settings the viewer had, restored when it watches again. */
export interface RememberedStream {
  volume: number | undefined;
  muted: boolean | undefined;
}

type Phase = 'awaitingAnnouncement' | 'awaitingPublication' | 'stopped';

interface Entry {
  phase: Phase;
  stream: RememberedStream | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export class StreamResumeMemory {
  private readonly entries = new Map<string, Entry>();
  private held = false;

  /**
   * A watched share's publication was removed and it was not a republish.
   * Returns whether it is remembered: false when the sharer had announced
   * the stop.
   */
  rememberEnded(identity: string, stream: RememberedStream): boolean {
    if (this.entries.get(identity)?.phase === 'stopped') {
      this.drop(identity);
      return false;
    }
    this.arm(identity, 'awaitingAnnouncement', stream);
    return true;
  }

  /** The sharer announced that its share ended for good. */
  stopAnnounced(identity: string): void {
    this.arm(identity, 'stopped', null);
  }

  /**
   * The sharer announced that its share is back after its full reconnect.
   * Returns true when this viewer remembers watching it; the caller then
   * resumes as soon as the share is published (`takeOnPublication`).
   */
  resumeAnnounced(identity: string): boolean {
    const entry = this.entries.get(identity);
    if (!entry?.stream) return false;
    this.arm(identity, 'awaitingPublication', entry.stream);
    return true;
  }

  /** This viewer's room went into a full reconnect: the windows wait for it. */
  hold(): void {
    this.held = true;
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  /**
   * This viewer's room is back from a full reconnect. Every share it
   * remembers watching resumes once published again, whatever the sharer's
   * version: the share never ended on the sharer's side. Returns their
   * identities, for the caller to resume the ones already published.
   */
  selfReconnected(): string[] {
    this.held = false;
    const awaiting: string[] = [];
    for (const [identity, entry] of [...this.entries]) {
      if (entry.stream) {
        this.arm(identity, 'awaitingPublication', entry.stream);
        awaiting.push(identity);
      } else {
        this.arm(identity, entry.phase, null);
      }
    }
    return awaiting;
  }

  /**
   * The sharer has a screen-share publication. Returns the remembered
   * settings when the watch should resume now, and forgets the share.
   */
  takeOnPublication(identity: string): RememberedStream | null {
    const entry = this.entries.get(identity);
    if (entry?.phase !== 'awaitingPublication' || !entry.stream) return null;
    this.drop(identity);
    return entry.stream;
  }

  /** The room went away: forget everything. */
  clear(): void {
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
    this.entries.clear();
    this.held = false;
  }

  private arm(identity: string, phase: Phase, stream: RememberedStream | null): void {
    const existing = this.entries.get(identity);
    if (existing?.timer) clearTimeout(existing.timer);
    const entry: Entry = { phase, stream, timer: null };
    if (!this.held) {
      entry.timer = setTimeout(() => {
        if (this.entries.get(identity) === entry) this.entries.delete(identity);
      }, STREAM_RESUME_WINDOW_MS);
    }
    this.entries.set(identity, entry);
  }

  private drop(identity: string): void {
    const entry = this.entries.get(identity);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(identity);
  }
}
