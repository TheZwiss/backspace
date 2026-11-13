import type { Room } from 'livekit-client';
import { Track } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import { getPublisherPC, getMediaStreamTrack } from './livekitInternals';
import {
  initialRecoveryState,
  isScreenShareShrunk,
  RECOVERY_SAMPLE_MS,
  stepRecovery,
  type RecoveryState,
  type ScreenShareStallSample,
} from './screenShareStall';

/**
 * Detects a screen share the encoder shrank and never grew back. WebRTC scales
 * the picture down when the uplink estimate dips and climbs back slowly, and
 * with `maintain-framerate` it can stay tiny (268x146) long after the network
 * recovered. Stopping and sharing again fixed it, because that restarts the
 * encoder; this does the same without the user noticing.
 */

interface OutboundVideoEntry {
  type?: string;
  kind?: string;
  mediaType?: string;
  active?: boolean;
  frameHeight?: number;
  framesEncoded?: number;
  qualityLimitationReason?: string;
}

interface CandidatePairEntry {
  type?: string;
  state?: string;
  nominated?: boolean;
  selected?: boolean;
  availableOutgoingBitrate?: number;
}

export interface RecoveryActions {
  reapply: () => void;
  republish: () => Promise<void>;
  /** The bitrate ceiling currently allowed for the share. */
  targetBitrate: () => number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let state: RecoveryState = initialRecoveryState();
let lastFramesEncoded = new Map<string, number>();
let busy = false;

export function stopScreenShareRecovery(): void {
  if (timer) clearInterval(timer);
  timer = null;
  lastFramesEncoded = new Map();
  busy = false;
}

async function readSample(room: Room, targetBitrate: number): Promise<ScreenShareStallSample | null> {
  const pc = getPublisherPC(room);
  if (!pc) return null;
  const pub = room.localParticipant.getTrackPublications().find((p) => p.source === Track.Source.ScreenShare);
  const mediaTrack = pub?.track ? getMediaStreamTrack(pub.track) : null;
  if (!mediaTrack) return null;
  const sender = pc.getSenders().find((s) => s.track?.id === mediaTrack.id);
  if (!sender) return null;
  const captureHeight = mediaTrack.getSettings().height ?? 0;

  const senderStats = await sender.getStats();
  const streams: Array<OutboundVideoEntry & { id: string }> = [];
  senderStats.forEach((report) => {
    const entry = report as OutboundVideoEntry & { id: string };
    if (entry.type !== 'outbound-rtp' || (entry.kind !== 'video' && entry.mediaType !== 'video')) return;
    if (entry.active === false) return;
    streams.push(entry);
  });
  // The VP9 share's VP8 backup is a second outbound stream; judge the one
  // producing the largest picture, which is the primary.
  const outbound = streams.reduce<(OutboundVideoEntry & { id: string }) | null>(
    (best, entry) => (!best || (entry.frameHeight ?? 0) > (best.frameHeight ?? 0) ? entry : best),
    null,
  );
  if (!outbound) return null;

  // A stream nobody pulls (dynacast pauses it) stops encoding: its last
  // frameHeight is stale and says nothing about the network.
  const encoded = outbound.framesEncoded ?? 0;
  const previous = lastFramesEncoded.get(outbound.id);
  lastFramesEncoded.set(outbound.id, encoded);
  if (previous === undefined || encoded <= previous) return null;

  let availableBitrate: number | null = null;
  const pcStats = await pc.getStats();
  pcStats.forEach((report) => {
    const pair = report as CandidatePairEntry;
    if (pair.type !== 'candidate-pair') return;
    if (!(pair.selected || pair.nominated) || pair.state !== 'succeeded') return;
    if (typeof pair.availableOutgoingBitrate === 'number') availableBitrate = pair.availableOutgoingBitrate;
  });

  return {
    encodedHeight: outbound.frameHeight ?? 0,
    captureHeight,
    limitation: outbound.qualityLimitationReason ?? null,
    availableBitrate,
    targetBitrate,
  };
}

/**
 * Watch the live screen share and recover it when the encoder is stuck small.
 * Safe to call again after a republish: the running monitor keeps its counters,
 * so the republish limit holds across the swaps it causes. It stops itself when
 * the share ends.
 */
export function startScreenShareRecovery(room: Room, actions: RecoveryActions): void {
  if (timer) {
    // Same share, new publication: keep the republish budget, drop the stale
    // frame counters of the old sender.
    lastFramesEncoded = new Map();
    state.shrunkSamples = 0;
    state.sinceAction = 0;
  } else {
    state = initialRecoveryState();
  }
  if (timer) clearInterval(timer);

  timer = setInterval(() => {
    if (busy) return;
    if (!useVoiceStore.getState().isScreenSharing) {
      stopScreenShareRecovery();
      return;
    }
    busy = true;
    void (async () => {
      try {
        const sample = await readSample(room, actions.targetBitrate());
        if (!sample) {
          state.shrunkSamples = 0;
          return;
        }
        const action = stepRecovery(state, isScreenShareShrunk(sample));
        if (action === 'reapply') {
          console.warn('[ScreenShare] Picture stuck small; reasserting the sender parameters', sample);
          actions.reapply();
        } else if (action === 'republish') {
          console.warn('[ScreenShare] Picture still small; republishing the share', sample);
          await actions.republish();
        }
      } catch {
        // Stats are best effort; the next tick tries again.
      } finally {
        busy = false;
      }
    })();
  }, RECOVERY_SAMPLE_MS);
}
