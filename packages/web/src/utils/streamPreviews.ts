import { create } from 'zustand';
import { Room, RoomEvent, Track, type RemoteParticipant, type TrackPublication } from 'livekit-client';

const TOPIC = 'backspace.stream-preview.v1';
export const PREVIEW_INTERVAL = 30_000;
const MAX_PACKET = 14_000;
export type StreamPreviewMode = 'normal' | 'blurred' | 'hidden';
interface Preview { trackSid: string; image: string; mode: StreamPreviewMode; receivedAt: number }
export const useStreamPreviews = create<{ room: Room | null; images: Record<string, Preview>; identities: Record<string, string> }>(() => ({ room: null, images: {}, identities: {} }));

export function parseStreamPreview(payload: Uint8Array): { trackSid: string; image: string | null; mode: StreamPreviewMode } | null {
  if (payload.byteLength > MAX_PACKET) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(payload));
    if (value?.type !== TOPIC || typeof value.trackSid !== 'string' || value.trackSid.length > 128
      || (value.image !== null && (typeof value.image !== 'string' || !/^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/.test(value.image)))
      || !['normal', 'blurred', 'hidden'].includes(value.mode ?? 'normal')
      || (value.mode === 'hidden' && value.image !== null)) return null;
    return { trackSid: value.trackSid, image: value.image, mode: value.mode ?? 'normal' };
  } catch { return null; }
}

/** Small still images over room-scoped data, never a video/audio subscription. */
export function startStreamPreviews(room: Room, options?: { getMode: () => StreamPreviewMode; subscribe: (change: () => void) => () => void }): () => void {
  useStreamPreviews.setState({ room, images: {}, identities: {} });
  let video: HTMLVideoElement | null = null;
  let trackId = '';
  let frameTimeout: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let busy = false;
  let mode = options?.getMode() ?? 'normal';
  let revision = 0;
  const current = () => !stopped && useStreamPreviews.getState().room === room;
  const remove = (identity: string) => {
    if (!current()) return;
    const images = { ...useStreamPreviews.getState().images };
    delete images[identity];
    useStreamPreviews.setState({ images });
  };
  const put = (identity: string, preview: { trackSid: string; image: string | null; mode: StreamPreviewMode }) => {
    if (preview.image === null) { remove(identity); return; }
    const image = preview.image;
    if (current()) useStreamPreviews.setState((state) => ({ images: { ...state.images, [identity]: { ...preview, image, receivedAt: Date.now() } } }));
  };
  const detach = () => { clearTimeout(frameTimeout); frameTimeout = undefined; if (video) { video.onloadeddata = null; video.pause(); video.srcObject = null; video = null; } trackId = ''; };
  const capture = async () => {
    if (!current() || busy) return;
    if (room.remoteParticipants?.size === 0) { detach(); return; }
    const publication = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const track = publication?.track?.mediaStreamTrack;
    if (!track || track.readyState !== 'live' || publication.isMuted) {
      detach(); remove(room.localParticipant.identity); return;
    }
    const capturedRevision = revision;
    if (mode === 'hidden') { detach(); remove(room.localParticipant.identity); return; }
    busy = true;
    try {
      if (!video || trackId !== track.id) {
        detach();
        video = document.createElement('video');
        video.muted = true; video.playsInline = true;
        video.srcObject = new MediaStream([track]); trackId = track.id;
        video.onloadeddata = () => { void capture(); };
        // A broken track must not leave a hidden player running indefinitely.
        frameTimeout = setTimeout(detach, 1500);
        void video.play().catch(() => undefined);
      }
      if (!video.videoWidth || !video.videoHeight) return;
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) return;
      let image = '';
      for (const width of [320, 240, 160]) {
        canvas.width = width; canvas.height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
        // Bound extreme portrait dimensions as well as packet size.
        if (canvas.height > 320) { canvas.width = Math.max(1, Math.round(width * 320 / canvas.height)); canvas.height = 320; }
        context.filter = mode === 'blurred' ? 'blur(16px)' : 'none';
        // Fail closed if a browser cannot blur on the sender's canvas.
        if (mode === 'blurred' && context.filter !== 'blur(16px)') return;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        image = canvas.toDataURL('image/webp', 0.45);
        if (image.length <= 12_000) break;
      }
      if (!current() || capturedRevision !== revision || image.length > 12_000 || room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.trackSid !== publication.trackSid) return;
      // Only sample one frame; never play this full-rate track between samples.
      detach();
      const preview = { trackSid: publication.trackSid, image, mode };
      const payload = new TextEncoder().encode(JSON.stringify({ type: TOPIC, ...preview }));
      if (payload.byteLength > MAX_PACKET) return;
      put(room.localParticipant.identity, preview);
      await room.localParticipant.publishData(payload, { reliable: true, topic: TOPIC });
    } catch { /* A thumbnail must never interrupt the actual share. */ }
    finally { if (video?.videoWidth) detach(); busy = false; if (capturedRevision !== revision) void capture(); }
  };
  const received = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
    if (!current() || !participant || topic !== TOPIC) return;
    const preview = parseStreamPreview(payload);
    const publication = participant.getTrackPublication(Track.Source.ScreenShare);
    if (!preview || !publication || publication.isMuted || publication.trackSid !== preview.trackSid) return;
    const existing = useStreamPreviews.getState().images[participant.identity];
    if (preview.image !== null && existing?.mode === preview.mode && Date.now() - existing.receivedAt < 20_000) return;
    put(participant.identity, preview);
  };
  const unpublished = (publication: TrackPublication, participant: { identity: string }) => {
    if (publication.source === Track.Source.ScreenShare) {
      remove(participant.identity);
      if (participant.identity === room.localParticipant.identity) detach();
    }
  };
  const left = (participant: RemoteParticipant) => { remove(participant.identity); if (room.remoteParticipants?.size === 0) detach(); };
  const peerJoined = (participant: RemoteParticipant) => {
    const preview = useStreamPreviews.getState().images[room.localParticipant.identity];
    if (!current()) return;
    if (!preview || Date.now() - preview.receivedAt > PREVIEW_INTERVAL) { void capture(); return; }
    const payload = new TextEncoder().encode(JSON.stringify({ type: TOPIC, trackSid: preview.trackSid, image: preview.image, mode: preview.mode }));
    void room.localParticipant.publishData(payload, { reliable: true, topic: TOPIC, destinationIdentities: [participant.identity] }).catch(() => undefined);
  };
  const unsubscribeMode = options?.subscribe(() => {
    const next = options.getMode();
    if (!current() || next === mode) return;
    mode = next; revision++;
    remove(room.localParticipant.identity);
    if (mode === 'hidden') detach();
    const publication = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    if (publication) {
      // Withdraw the previous thumbnail immediately, including when capture is busy.
      const payload = new TextEncoder().encode(JSON.stringify({ type: TOPIC, trackSid: publication.trackSid, image: null, mode }));
      void room.localParticipant.publishData(payload, { reliable: true, topic: TOPIC }).catch(() => undefined);
    }
    void capture();
  });
  const timer = setInterval(() => {
    if (!current()) return;
    for (const [identity, preview] of Object.entries(useStreamPreviews.getState().images)) {
      if (Date.now() - preview.receivedAt > 75_000) remove(identity);
    }
    void capture();
  }, PREVIEW_INTERVAL);
  room.on(RoomEvent.DataReceived, received);
  room.on(RoomEvent.LocalTrackPublished, capture);
  room.on(RoomEvent.LocalTrackUnpublished, unpublished);
  room.on(RoomEvent.TrackUnpublished, unpublished);
  room.on(RoomEvent.TrackMuted, unpublished);
  room.on(RoomEvent.ParticipantDisconnected, left);
  room.on(RoomEvent.ParticipantConnected, peerJoined);
  const cleanup = () => {
    stopped = true; unsubscribeMode?.(); clearInterval(timer); detach();
    room.off(RoomEvent.DataReceived, received);
    room.off(RoomEvent.LocalTrackPublished, capture);
    room.off(RoomEvent.LocalTrackUnpublished, unpublished);
    room.off(RoomEvent.TrackUnpublished, unpublished);
    room.off(RoomEvent.TrackMuted, unpublished);
    room.off(RoomEvent.ParticipantDisconnected, left);
    room.off(RoomEvent.ParticipantConnected, peerJoined);
    room.off(RoomEvent.Disconnected, cleanup);
    if (useStreamPreviews.getState().room === room) useStreamPreviews.setState({ room: null, images: {}, identities: {} });
  };
  room.on(RoomEvent.Disconnected, cleanup);
  void capture();
  return cleanup;
}
