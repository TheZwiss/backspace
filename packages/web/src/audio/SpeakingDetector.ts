import { useVoiceStore } from '../stores/voiceStore';
import { AudioManager } from './AudioManager';
import type { ParticipantInfo } from '../hooks/useLiveKit';

/**
 * Client-side speaking detection using Web Audio AnalyserNodes.
 *
 * Replaces LiveKit's server-side VAD (which has a conservative, non-configurable
 * threshold that misses conversational speech) with local RMS analysis per
 * participant. Each remote participant gets an AnalyserNode attached to their
 * MediaStreamTrack; the local participant reuses AudioManager's existing analyser.
 *
 * Hysteresis (hold counters) prevents flickering during natural speech pauses.
 */
export class SpeakingDetector {
  private static instance: SpeakingDetector;

  /** Per-participant analysis nodes (keyed by participant identity) */
  private tracks: Map<string, {
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
  }> = new Map();

  /** Identity of the local participant (reads from AudioManager's analyser instead) */
  private localIdentity: string | null = null;

  /** Polling interval handle */
  private intervalId: number | null = null;

  /** Reusable buffer for time-domain data (avoids allocations in poll loop) */
  private analyserBuffer: Uint8Array<ArrayBuffer> | null = null;

  // --- Tuning constants ---
  private readonly POLL_MS = 50;       // 20 checks/sec
  private readonly THRESHOLD = 0.008;  // RMS threshold — conversational speech ~0.01–0.05
  private readonly HOLD_FRAMES = 5;    // Hold speaking state for 5 polls (250ms) after drop

  /** Per-participant hold counters for hysteresis */
  private holdCounters: Map<string, number> = new Map();

  private constructor() {}

  static getInstance(): SpeakingDetector {
    if (!SpeakingDetector.instance) {
      SpeakingDetector.instance = new SpeakingDetector();
    }
    return SpeakingDetector.instance;
  }

  /**
   * Sync tracked participants with the current room state.
   * Called from updateParticipants() in useLiveKit after setParticipants().
   *
   * - Creates AnalyserNodes for new remote participants
   * - Removes nodes for participants that left
   * - Registers localIdentity for AudioManager analyser reads
   * - Starts polling if not already running
   */
  syncTracks(participants: ParticipantInfo[]): void {
    const currentIds = new Set(participants.map(p => p.identity));

    // Identify local participant
    const localP = participants.find(p => p.isLocal);
    this.localIdentity = localP?.identity ?? null;

    // Remove stale entries (participants that left)
    for (const [identity, entry] of this.tracks) {
      if (!currentIds.has(identity)) {
        entry.source.disconnect();
        entry.analyser.disconnect();
        this.tracks.delete(identity);
        this.holdCounters.delete(identity);
      }
    }

    // Add/update remote participants
    for (const p of participants) {
      if (p.isLocal) continue; // Local uses AudioManager's analyser

      if (!p.audioTrack || p.audioTrack.readyState !== 'live') {
        // No live audio track — remove if we were tracking
        const existing = this.tracks.get(p.identity);
        if (existing) {
          existing.source.disconnect();
          existing.analyser.disconnect();
          this.tracks.delete(p.identity);
          this.holdCounters.delete(p.identity);
        }
        continue;
      }

      // Check if we already have an analyser for this exact track
      const existing = this.tracks.get(p.identity);
      if (existing) {
        // Verify the source is still connected to the same track
        // MediaStreamAudioSourceNode doesn't expose its track, so we check
        // if the existing entry's source's mediaStream still has live tracks
        const srcStream = existing.source.mediaStream;
        const srcTrack = srcStream?.getAudioTracks()[0];
        if (srcTrack && srcTrack.id === p.audioTrack.id && srcTrack.readyState === 'live') {
          continue; // Already tracking this exact track
        }
        // Track changed — disconnect old and create new
        existing.source.disconnect();
        existing.analyser.disconnect();
        this.tracks.delete(p.identity);
      }

      // Create analysis-only nodes for this remote participant.
      // This does NOT interfere with useAudioTrackPlayer's playback pipeline —
      // we create a separate MediaStreamAudioSourceNode from the same track
      // (supported by Web Audio spec) and route it to an unconnected AnalyserNode.
      try {
        const ctx = AudioManager.getInstance().ensureContext();
        const stream = new MediaStream([p.audioTrack]);
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        // Connect source → analyser (analyser is NOT connected to destination,
        // so no audio output, purely for level reading)
        source.connect(analyser);

        this.tracks.set(p.identity, { source, analyser });
      } catch (err) {
        console.error(`[SpeakingDetector] Failed to create analyser for ${p.identity}:`, err);
      }
    }

    // Start polling if we have participants and aren't already polling
    if (participants.length > 0 && this.intervalId === null) {
      this.intervalId = window.setInterval(() => this.poll(), this.POLL_MS);
    }

    // Stop polling if no participants
    if (participants.length === 0 && this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Disconnect all nodes, stop polling, clear state.
   * Called on room disconnect / cleanup.
   */
  clear(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    for (const [, entry] of this.tracks) {
      entry.source.disconnect();
      entry.analyser.disconnect();
    }
    this.tracks.clear();
    this.holdCounters.clear();
    this.localIdentity = null;
    this.analyserBuffer = null;
  }

  /**
   * Core polling loop — reads RMS from each participant's AnalyserNode,
   * applies hysteresis, and writes the speaking set to voiceStore if changed.
   */
  private poll(): void {
    const speakingIds = new Set<string>();
    const store = useVoiceStore.getState();

    // --- Local participant ---
    if (this.localIdentity) {
      if (store.isMuted) {
        // Muted → never speaking, reset hold counter
        this.holdCounters.delete(this.localIdentity);
      } else {
        const analyser = AudioManager.getInstance().getAnalyserNode();
        const rms = this.computeRMS(analyser);
        if (this.applyHysteresis(this.localIdentity, rms)) {
          speakingIds.add(this.localIdentity);
        }
      }
    }

    // --- Remote participants ---
    for (const [identity, entry] of this.tracks) {
      const rms = this.computeRMS(entry.analyser);
      if (this.applyHysteresis(identity, rms)) {
        speakingIds.add(identity);
      }
    }

    // Only write to store if the set actually changed
    const current = store.speakingParticipantIds;
    if (!this.setsEqual(current, speakingIds)) {
      store.setSpeakingParticipants(speakingIds);
    }
  }

  /**
   * Apply hysteresis to a single participant's RMS reading.
   * Returns true if the participant should be considered "speaking".
   */
  private applyHysteresis(identity: string, rms: number): boolean {
    if (rms > this.THRESHOLD) {
      // Above threshold — mark speaking, reset hold counter
      this.holdCounters.set(identity, this.HOLD_FRAMES);
      return true;
    }

    // Below threshold — decrement hold counter
    const hold = this.holdCounters.get(identity) ?? 0;
    if (hold > 0) {
      this.holdCounters.set(identity, hold - 1);
      return true; // Still in hold period
    }

    return false; // Truly silent
  }

  /**
   * Compute RMS (root mean square) of an AnalyserNode's time-domain data.
   * Returns a value 0.0–1.0 representing the audio level.
   *
   * getByteTimeDomainData returns unsigned bytes 0–255, where 128 = silence.
   * RMS = sqrt(mean((sample - 128)^2)) / 128
   */
  private computeRMS(analyser: AnalyserNode): number {
    const bufferLength = analyser.fftSize;

    // Reuse or allocate buffer
    if (!this.analyserBuffer || this.analyserBuffer.length !== bufferLength) {
      this.analyserBuffer = new Uint8Array(bufferLength);
    }

    analyser.getByteTimeDomainData(this.analyserBuffer);

    let sumSquares = 0;
    for (let i = 0; i < bufferLength; i++) {
      const normalized = (this.analyserBuffer[i]! - 128) / 128;
      sumSquares += normalized * normalized;
    }

    return Math.sqrt(sumSquares / bufferLength);
  }

  /** Compare two sets for equality */
  private setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const v of a) {
      if (!b.has(v)) return false;
    }
    return true;
  }
}
