import { RoomEvent, Track, type Room } from 'livekit-client';
import type { NativeScreenCaptureTrack } from './nativeScreenCapture';

const budgets = new WeakMap<MediaStreamTrack, () => void>();

/** Keep a native source warm, at low cadence, only when there is no audience
 * and the local app is not being used. Peer arrival restores the requested rate. */
export function installNativeCaptureBudget(room: Room, track: NativeScreenCaptureTrack, initialFps: number): void {
  budgets.get(track)?.();
  if (!('captureMetrics' in track) || !track.setFrameRate) return;
  const setRate = track.setFrameRate;
  const stopTrack = track.stop;
  let requested = initialFps;
  let applied = Number.NaN;
  let stopped = false;
  let grace = true;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    if (stopped) return;
    const hasLocalPreview = (room.localParticipant?.getTrackPublication(Track.Source.ScreenShare)?.track?.attachedElements.length ?? 0) > 0;
    const idle = !grace && !hasLocalPreview && room.remoteParticipants?.size === 0 && (document.hidden || !document.hasFocus());
    const next = idle ? Math.min(5, requested) : requested;
    if (next !== applied) { applied = next; setRate.call(track, next); }
  };
  const afterActivityChange = () => { clearTimeout(activityTimer); activityTimer = setTimeout(update, 0); };
  const changeRate = (fps: number) => { requested = fps; update(); };
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (budgets.get(track) === cleanup) budgets.delete(track);
    clearTimeout(timer); clearTimeout(activityTimer);
    document.removeEventListener('visibilitychange', afterActivityChange);
    window.removeEventListener('focus', update); window.removeEventListener('blur', afterActivityChange);
    room.off(RoomEvent.ParticipantConnected, update); room.off(RoomEvent.ParticipantDisconnected, update);
    room.off(RoomEvent.Disconnected, cleanup);
    track.removeEventListener('ended', cleanup);
    if (track.setFrameRate === changeRate) track.setFrameRate = setRate;
    if (track.stop === stop) track.stop = stopTrack;
  };
  const stop = () => { cleanup(); stopTrack.call(track); };
  const timer = setTimeout(() => { grace = false; update(); }, 5000);
  budgets.set(track, cleanup);
  track.setFrameRate = changeRate; track.stop = stop;
  document.addEventListener('visibilitychange', afterActivityChange);
  window.addEventListener('focus', update); window.addEventListener('blur', afterActivityChange);
  room.on(RoomEvent.ParticipantConnected, update); room.on(RoomEvent.ParticipantDisconnected, update);
  room.on(RoomEvent.Disconnected, cleanup); track.addEventListener('ended', cleanup);
  update();
}
