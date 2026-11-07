import { useCallback, useEffect, useRef, useState } from 'react';
import { useVoiceStore } from '../stores/voiceStore';
import {
  VOICE_BITS_PER_SECOND,
  VOICE_MAX_DURATION_MS,
  VOICE_MIN_DURATION_MS,
  pickRecorderFormat,
  voiceMessageFileName,
  type RecorderFormat,
} from '../utils/voiceMessage';

export interface VoiceRecording {
  file: File;
  durationMs: number;
}

export type VoiceRecorderError = 'denied' | 'unavailable';

export interface VoiceRecorder {
  /** False where the browser cannot record audio (no MediaRecorder or getUserMedia). */
  supported: boolean;
  state: 'idle' | 'starting' | 'recording';
  elapsedMs: number;
  /** The live analyser of the microphone while recording, for the spectrum. */
  analyser: AnalyserNode | null;
  error: VoiceRecorderError | null;
  start: () => Promise<void>;
  /** Ends the recording and returns it; null when it was too short or nothing was recording. */
  stop: () => Promise<VoiceRecording | null>;
  /** Throws the recording away. */
  cancel: () => void;
}

/** How often the elapsed time is published. The spectrum reads the analyser itself, on every frame. */
const TICK_MS = 100;

function recorderFormat(): RecorderFormat | null {
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
  return pickRecorderFormat((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

interface ActiveRecording {
  stream: MediaStream;
  context: AudioContext;
  recorder: MediaRecorder;
  format: RecorderFormat;
  chunks: Blob[];
  startedAt: number;
  timer: ReturnType<typeof setInterval>;
}

/**
 * Records the microphone as a voice message: mono Opus at `VOICE_BITS_PER_SECOND`,
 * with echo cancellation, noise suppression and gain control on so speech stays
 * clear at that rate. Uses the microphone chosen in the voice settings.
 *
 * `onLimit` receives the recording when `VOICE_MAX_DURATION_MS` runs out, which
 * ends it on its own.
 */
export function useVoiceRecorder(onLimit?: (recording: VoiceRecording | null) => void): VoiceRecorder {
  const [state, setState] = useState<VoiceRecorder['state']>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [error, setError] = useState<VoiceRecorderError | null>(null);
  const active = useRef<ActiveRecording | null>(null);
  const starting = useRef(false);
  const onLimitRef = useRef(onLimit);
  onLimitRef.current = onLimit;
  const supported = recorderFormat() !== null;

  const release = useCallback(() => {
    const current = active.current;
    active.current = null;
    if (!current) return;
    clearInterval(current.timer);
    for (const track of current.stream.getTracks()) track.stop();
    void current.context.close().catch(() => { /* already closed */ });
    setAnalyser(null);
    setState('idle');
    setElapsedMs(0);
  }, []);

  const finish = useCallback((keep: boolean): Promise<VoiceRecording | null> => {
    const current = active.current;
    if (!current) return Promise.resolve(null);
    const durationMs = performance.now() - current.startedAt;
    return new Promise((resolve) => {
      const done = () => {
        const { chunks, format } = current;
        release();
        if (!keep || durationMs < VOICE_MIN_DURATION_MS || chunks.length === 0) {
          resolve(null);
          return;
        }
        const blob = new Blob(chunks, { type: format.mimeType.split(';')[0] });
        const file = new File([blob], voiceMessageFileName(new Date(), format.extension), { type: blob.type });
        resolve({ file, durationMs });
      };
      if (current.recorder.state === 'inactive') {
        done();
        return;
      }
      current.recorder.addEventListener('stop', done, { once: true });
      current.recorder.stop();
    });
  }, [release]);

  const start = useCallback(async () => {
    const format = recorderFormat();
    if (!format || active.current || starting.current) return;
    starting.current = true;
    setError(null);
    setState('starting');
    try {
      const inputDeviceId = useVoiceStore.getState().inputDeviceId;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(inputDeviceId && inputDeviceId !== 'default' ? { deviceId: { ideal: inputDeviceId } } : {}),
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const node = context.createAnalyser();
      node.fftSize = 512; // 256 bins of about 94 Hz: enough resolution for the speech band
      node.smoothingTimeConstant = 0.55;
      source.connect(node); // Not connected to the output: the microphone is never played back.

      const recorder = new MediaRecorder(stream, { mimeType: format.mimeType, audioBitsPerSecond: VOICE_BITS_PER_SECOND });
      const chunks: Blob[] = [];
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size > 0) chunks.push(event.data); });
      const startedAt = performance.now();
      const timer = setInterval(() => {
        const elapsed = performance.now() - startedAt;
        setElapsedMs(elapsed);
        if (elapsed >= VOICE_MAX_DURATION_MS) {
          clearInterval(timer);
          void finish(true).then((recording) => onLimitRef.current?.(recording));
        }
      }, TICK_MS);
      active.current = { stream, context, recorder, format, chunks, startedAt, timer };
      recorder.start(1000);
      setAnalyser(node);
      setState('recording');
    } catch (err) {
      release();
      setError(err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError') ? 'denied' : 'unavailable');
      setState('idle');
    } finally {
      starting.current = false;
    }
  }, [finish, release]);

  const stop = useCallback(() => finish(true), [finish]);
  const cancel = useCallback(() => { void finish(false); }, [finish]);

  // Leaving the screen mid-recording must free the microphone.
  useEffect(() => () => { void finish(false); }, [finish]);

  return { supported, state, elapsedMs, analyser, error, start, stop, cancel };
}
