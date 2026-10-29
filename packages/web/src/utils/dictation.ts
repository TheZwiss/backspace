import { AudioManager } from '../audio/AudioManager';
import { useVoiceStore } from '../stores/voiceStore';
import { speechRecognition, useDictationStore } from '../platform/speechRecognition';
import { getLocalTextVoiceProvider } from '../platform/textVoice';
import { canUseTextVoice, speakText, stopTextVoice } from './textVoice';
import { getActiveRoom } from '../hooks/useLiveKit';

type Recording = { auto: boolean; released: boolean; cancelled: boolean; stream?: MediaStream; recorder?: MediaRecorder; chunks: Blob[]; timer?: ReturnType<typeof setTimeout>; room: ReturnType<typeof getActiveRoom>; channel: string | null; dm: unknown; unsubscribe: () => void; };
let current: Recording | null = null;
export function cancelDictation() {
  const job = current; current = null;
  if (job) {
    job.cancelled = true; clearTimeout(job.timer); job.unsubscribe();
    if (job.recorder?.state === 'recording') job.recorder.stop();
    job.stream?.getTracks().forEach((track) => track.stop());
    speechRecognition.release();
  }
  useDictationStore.setState({ recording: false });
}
const live = (job: Recording) => current === job && !job.cancelled && useVoiceStore.getState().textVoiceEnabled && (!job.auto || (canUseTextVoice() && job.room === getActiveRoom() && job.channel === useVoiceStore.getState().currentVoiceChannelId && job.dm === useVoiceStore.getState().activeDmCall));
const fail = () => new DOMException('Recording cancelled', 'AbortError');

/** Independent recording stream: it is NEVER connected to the call microphone graph. */
export async function pressDictation(auto = true): Promise<void> {
  if (current) return;
  const state = useVoiceStore.getState(); const asr = useDictationStore.getState();
  if (!state.textVoiceEnabled || (auto && !canUseTextVoice()) || state.textVoiceBusy || !['idle', 'ready'].includes(asr.phase)) return;
  if (!asr.installed.includes(asr.model)) { useDictationStore.setState({ error: 'model-not-installed' }); return; }
  const job: Recording = { auto, released: false, cancelled: false, chunks: [], room: getActiveRoom(), channel: state.currentVoiceChannelId, dm: state.activeDmCall, unsubscribe: () => {} };
  current = job; useDictationStore.setState({ recording: true, error: '' });
  job.unsubscribe = useVoiceStore.subscribe(() => { if (!live(job)) cancelDictation(); });
  try {
    // Resume speaker output on the original user gesture, including keyboard holds.
    await AudioManager.getInstance().resumeContext();
    if (!live(job) || job.released) { if (current === job) cancelDictation(); return; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: state.inputDeviceId === 'default' ? undefined : { exact: state.inputDeviceId }, echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false });
    if (!live(job) || job.released) { stream.getTracks().forEach((track) => track.stop()); if (current === job) cancelDictation(); return; }
    job.stream = stream;
    const recorder = new MediaRecorder(stream); job.recorder = recorder;
    recorder.ondataavailable = ({ data }) => { if (data.size) job.chunks.push(data); };
    recorder.onerror = () => { if (current === job) { cancelDictation(); useDictationStore.setState({ error: 'microphone-failed' }); } };
    recorder.onstop = () => { void finish(job); };
    recorder.start(250);
    job.timer = setTimeout(() => { if (current === job) { cancelDictation(); useDictationStore.setState({ error: 'recording-limit' }); } }, 60_000);
  } catch (error) {
    if (current === job) { cancelDictation(); useDictationStore.setState({ error: 'microphone-failed' }); }
  }
}
export function releaseDictation() {
  const job = current; if (!job || job.released) return;
  job.released = true; clearTimeout(job.timer);
  useDictationStore.setState({ recording: false });
  if (job.recorder?.state === 'recording') { useDictationStore.setState({ phase: 'transcribing' }); job.recorder.stop(); }
  else if (!job.recorder) cancelDictation(); // Release before permission resolves: discard late stream.
  job.stream?.getTracks().forEach((track) => track.stop());
}
async function finish(job: Recording) {
  try {
    if (!live(job) || !job.released) return;
    const context = AudioManager.getInstance().ensureContext();
    const decoded = await context.decodeAudioData(await new Blob(job.chunks, { type: job.recorder?.mimeType }).arrayBuffer());
    if (!live(job)) throw fail();
    if (decoded.duration < 0.15 || decoded.duration > 60.5) throw new Error('invalid-audio');
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    const rendered = await offline.startRendering(); const samples = rendered.getChannelData(0);
    let energy = 0; for (const sample of samples) energy += sample * sample;
    if (!live(job)) throw fail();
    if (Math.sqrt(energy / samples.length) < 0.002) throw new Error('no-speech');
    const { text } = await speechRecognition.transcribe(new Float32Array(samples));
    if (!live(job)) throw fail();
    if (!text?.trim()) throw new Error('no-speech');
    if (text.length > 2000) throw new Error('text-too-long');
    if (!job.auto) {
      const draft = useVoiceStore.getState().textVoiceDraft;
      const combined = draft.trim() ? `${draft.trimEnd()} ${text}` : text;
      if (combined.length > 2000) throw new Error('text-too-long');
      useVoiceStore.getState().setTextVoiceDraft(combined);
    } else useVoiceStore.getState().setTextVoiceDraft(text);
    if (job.auto) {
      const provider = getLocalTextVoiceProvider();
      const device = useVoiceStore.getState().textVoiceDevice;
      // Re-load the selected voice after idle unloading. This step happens only AFTER release.
      await provider.prepareTextVoice!(device);
      if (!live(job)) throw fail();
      await speakText(text);
      if (live(job) && useVoiceStore.getState().textVoiceDraft === text) useVoiceStore.getState().setTextVoiceDraft('');
    }
  } catch (error) {
    if (current === job && !(error instanceof DOMException && error.name === 'AbortError')) useDictationStore.setState({ error: error instanceof Error ? error.message : 'recognition-failed' });
  } finally {
    job.stream?.getTracks().forEach((track) => track.stop()); job.unsubscribe(); clearTimeout(job.timer);
    if (current === job) { current = null; useDictationStore.setState({ recording: false, phase: 'idle' }); }
  }
}
export function stopDictationAndVoice() { cancelDictation(); speechRecognition.release(); stopTextVoice(); }
