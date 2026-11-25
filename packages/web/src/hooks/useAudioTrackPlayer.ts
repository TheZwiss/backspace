import { useRef, useEffect } from 'react';
import { AudioManager } from '../audio/AudioManager';

interface UseAudioTrackPlayerOptions {
  track: MediaStreamTrack | null;
  volume: number;  // final computed value, 0.0 – 4.0+
  muted: boolean;  // deafen, stream mute, etc.
}

/**
 * Hybrid audio pipeline for a single remote audio track.
 *
 * Architecture:
 *   1. A MUTED <audio> element keeps Chrome's WebRTC audio pipeline alive
 *      for the track. Chrome requires an HTML media element consuming a
 *      WebRTC MediaStreamTrack or it stops processing it. The element is
 *      always muted (volume=0, muted=true) — it never produces audible output.
 *
 *   2. A Web Audio pipeline handles ALL actual audio output:
 *      MediaStreamTrack -> MediaStream -> MediaStreamAudioSourceNode -> GainNode -> ctx.destination
 *
 * This gives us:
 *   - Chrome compatibility (muted <audio> keep-alive)
 *   - No ducking (all elements are muted, only Web Audio produces sound)
 *   - Clean mixing (single ctx.destination for all tracks)
 *   - Full volume range (0.0 – 4.0+) via GainNode
 *   - Smooth transitions via setTargetAtTime (no clicks/pops)
 */
export function useAudioTrackPlayer(
  opts: UseAudioTrackPlayerOptions,
): React.RefObject<HTMLAudioElement> {
  const { track, volume, muted } = opts;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  // Keep current volume/muted in refs so Effect 1 can read them
  // for the initial ramp without depending on them
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  volumeRef.current = volume;
  mutedRef.current = muted;

  // Effect 1: Track attachment (keep-alive) + Web Audio pipeline build
  useEffect(() => {
    const audioEl = audioRef.current;

    // Tear down previous Web Audio graph
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (gainRef.current) {
      gainRef.current.disconnect();
      gainRef.current = null;
    }

    if (!track) {
      if (audioEl) audioEl.srcObject = null;
      return;
    }

    // --- Keep-alive: attach track to <audio> element (always muted) ---
    // Chrome / Samsung Internet need a playing HTML media element consuming the
    // WebRTC track or Chromium's audio pipeline outputs silence (zero samples) to
    // MediaStreamAudioSourceNode — breaking both remote playback and SpeakingDetector.
    // Mobile browsers can reject the initial play() if the remote track arrives
    // outside a user gesture, so retry on the next gesture / visibility / resume.
    const audioManager = AudioManager.getInstance();
    let gestureListenersAttached = false;
    let disposed = false;

    const isPlaybackHealthy = () =>
      audioManager.isContextRunning() && (!audioEl || !audioEl.paused);

    const removeGestureListeners = () => {
      if (!gestureListenersAttached) return;
      gestureListenersAttached = false;
      document.removeEventListener('touchstart', onGesture);
      document.removeEventListener('touchend', onGesture);
      document.removeEventListener('pointerdown', onGesture);
      document.removeEventListener('click', onGesture);
      document.removeEventListener('keydown', onGesture);
    };

    const attachGestureListeners = () => {
      if (disposed || gestureListenersAttached) return;
      gestureListenersAttached = true;
      document.addEventListener('touchstart', onGesture, { passive: true });
      document.addEventListener('touchend', onGesture, { passive: true });
      document.addEventListener('pointerdown', onGesture, { passive: true });
      document.addEventListener('click', onGesture, { passive: true });
      document.addEventListener('keydown', onGesture, { passive: true });
    };

    const attemptPlay = () => {
      if (disposed || !audioEl || !audioEl.srcObject) {
        if (!disposed && isPlaybackHealthy()) removeGestureListeners();
        return;
      }
      void audioEl.play().then(() => {
        if (disposed) return;
        // On iOS Safari, muted <audio>.play() resolves without a user gesture
        // even while the Web AudioContext is still 'suspended' or 'interrupted'.
        // Keep gesture listeners attached until the AudioContext is also running.
        if (isPlaybackHealthy()) {
          removeGestureListeners();
        }
      }).catch(() => {
        // Will retry on next user gesture / resume / visibility change
      });
    };

    function onGesture() {
      void audioManager.resumeContext().then(() => {
        if (disposed) return;
        if (isPlaybackHealthy()) removeGestureListeners();
      });
      attemptPlay();
    }

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      attachGestureListeners();
      void audioManager.resumeContext().then(() => {
        if (disposed) return;
        if (isPlaybackHealthy()) removeGestureListeners();
      });
      attemptPlay();
    };

    if (audioEl) {
      audioEl.defaultMuted = true;
      audioEl.muted = true;
      audioEl.volume = 0;
      audioEl.srcObject = new MediaStream([track]);
    }

    const unsubResume = audioManager.onResumed(() => {
      if (audioEl && audioEl.paused) {
        attemptPlay();
      } else if (isPlaybackHealthy()) {
        removeGestureListeners();
      }
    });
    document.addEventListener('visibilitychange', onVisibility);
    attachGestureListeners();

    const cleanupPlayRetry = () => {
      disposed = true;
      unsubResume();
      removeGestureListeners();
      document.removeEventListener('visibilitychange', onVisibility);
    };

    // --- Web Audio pipeline for actual output ---
    const releaseAudioSession = audioManager.acquireAudioSession();
    const ctx = audioManager.ensureContext();
    void audioManager.resumeContext().then(() => {
      if (!disposed && isPlaybackHealthy()) removeGestureListeners();
    });
    attemptPlay();

    const stream = new MediaStream([track]);
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();

    // Start gain at 0 to prevent pop, then ramp to target
    gain.gain.setValueAtTime(0, ctx.currentTime);
    const targetGain = mutedRef.current ? 0 : volumeRef.current;
    gain.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.015);

    source.connect(gain);
    gain.connect(audioManager.getMasterOutput());

    sourceRef.current = source;
    gainRef.current = gain;

    return () => {
      cleanupPlayRetry();
      source.disconnect();
      gain.disconnect();
      sourceRef.current = null;
      gainRef.current = null;
      releaseAudioSession();
    };
  }, [track]);

  // Effect 2: Update gain when volume or muted changes (no graph rebuild)
  useEffect(() => {
    if (!gainRef.current) return;

    const ctx = AudioManager.getInstance().ensureContext();
    const targetGain = muted ? 0 : volume;
    gainRef.current.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.015);
  }, [volume, muted]);

  return audioRef;
}
