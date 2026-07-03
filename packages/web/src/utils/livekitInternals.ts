import type { Room } from 'livekit-client';

/**
 * Discover all unique RTCPeerConnections from the LiveKit Room engine.
 * Different livekit-client versions expose the PC at different internal paths.
 */
export function discoverPeerConnections(room: Room): RTCPeerConnection[] {
  const engine = (room as any)?.engine;
  if (!engine) return [];

  const pcs: RTCPeerConnection[] = [];
  const seen = new WeakSet<object>();

  const tryAdd = (val: any) => {
    if (val && typeof val.getStats === 'function' && !seen.has(val)) {
      seen.add(val);
      pcs.push(val);
    }
  };

  // Current livekit-client (1.x+): engine.pcManager.{publisher,subscriber}.pc
  tryAdd(engine.pcManager?.publisher?.pc);
  tryAdd(engine.pcManager?.subscriber?.pc);
  // Private backing field fallback
  tryAdd(engine.pcManager?.publisher?._pc);
  tryAdd(engine.pcManager?.subscriber?._pc);
  // Older livekit-client paths
  tryAdd(engine.publisher?.pc);
  tryAdd(engine.subscriber?.pc);
  // Unified-plan single PC
  tryAdd(engine.pc);
  tryAdd((room as any).pc);

  return pcs;
}

/**
 * Get the publisher RTCPeerConnection from a LiveKit Room.
 * Used by overdrive to inject RTP sender parameters.
 */
export function getPublisherPC(room: Room): RTCPeerConnection | null {
  const engine = (room as any)?.engine;
  if (!engine) return null;

  return (
    engine.pcManager?.publisher?.pc ??
    engine.pcManager?.publisher?._pc ??
    engine.publisher?.pc ??
    engine.pc ??
    null
  );
}

/**
 * Safely extract the underlying MediaStreamTrack from a LiveKit track object.
 * Handles both public `.mediaStreamTrack` and private `._mediaStreamTrack`.
 */
export function getMediaStreamTrack(track: unknown): MediaStreamTrack | null {
  if (!track) return null;
  const t = track as any;
  return t.mediaStreamTrack ?? t._mediaStreamTrack ?? null;
}
