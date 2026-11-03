import workletUrl from '../audio/worklets/processAudio.worklet.js?url';
import { getElectronAPI } from '../platform/platform';

/** No local playback: the destination is published to LiveKit only. */
export async function openWindowsProcessAudio(onStop: () => void): Promise<MediaStreamTrack> {
  const api = getElectronAPI();
  if (!api?.onProcessAudio) throw new Error('Process audio bridge unavailable');
  const context = new AudioContext({ sampleRate: 48000 });
  let remove: (() => void) | undefined;
  try {
    await context.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(context, 'backspace-process-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const destination = context.createMediaStreamDestination();
    node.connect(destination);
    const track = destination.stream.getAudioTracks()[0]!;
    const originalStop = track.stop.bind(track);
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true; remove?.(); node.disconnect(); originalStop();
      void context.close(); onStop();
    };
    track.stop = stop;
    track.addEventListener('ended', stop, { once: true });
    remove = api.onProcessAudio((bytes) => {
      try { node.port.postMessage(bytes, [bytes.buffer as ArrayBuffer]); }
      catch { node.port.postMessage(bytes); }
    }, () => { stop(); track.dispatchEvent(new Event('ended')); });
    await context.resume();
    return track;
  } catch (error) { remove?.(); await context.close(); throw error; }
}
