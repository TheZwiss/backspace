import { AudioManager } from '../audio/AudioManager';
import { Track } from 'livekit-client';
import { getActiveRoom } from '../hooks/useLiveKit';
import { useVoiceStore } from '../stores/voiceStore';
import { getChannelOrigin, getMyUserIdForOrigin, useSpaceStore } from '../stores/spaceStore';
import { supportsLocalTextVoice, synthesizeLocalTextVoice } from '../platform/textVoice';

let current: { controller: AbortController; source: AudioBufferSourceNode | null } | null = null;
export function stopTextVoice(): void {
  const job = current;
  current = null;
  job?.controller.abort();
  if (job) useVoiceStore.setState({ textVoiceBusy: false });
  try { job?.source?.stop(); } catch { /* Already ended. */ }
}

/** Small clauses let the first audio play while the following clause is synthesized. */
export function splitSpeech(text: string, max = 120): string[] {
  const words = text.trim().split(/\s+/u);
  const chunks: string[] = [];
  let chunk = '';
  for (const word of words) {
    if (chunk && chunk.length + word.length + 1 > max) { chunks.push(chunk); chunk = ''; }
    // Bound pathological long words too: the model has a finite phoneme context.
    for (let offset = 0; offset < word.length; offset += max) {
      const part = word.slice(offset, offset + max);
      chunk = chunk ? `${chunk} ${part}` : part;
      if (chunk.length >= max || /[.!?;:]$/u.test(chunk)) { chunks.push(chunk); chunk = ''; }
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.filter(Boolean);
}

export function canUseTextVoice(): boolean {
  const state = useVoiceStore.getState();
  if (!supportsLocalTextVoice() || !state.textVoiceEnabled || !state.isLiveKitConnected || state.isMuted || state.isDeafened) return false;
  const id = state.currentVoiceChannelId;
  if (!id) return !!state.activeDmCall;
  const spaceId = useSpaceStore.getState().channelToSpaceMap.get(id);
  const myId = getMyUserIdForOrigin(getChannelOrigin(id));
  const key = `${spaceId}:${myId}`;
  return !state.spaceMutedUserIds.has(key) && !state.spaceDeafenedUserIds.has(key) && !state.permissionMutedUserIds.has(key);
}

export async function speakText(text: string, preview = false): Promise<void> {
  const value = text.trim();
  if (!value || value.length > 2000) throw new Error('text-voice-invalid');
  stopTextVoice();
  const job = { controller: new AbortController(), source: null as AudioBufferSourceNode | null };
  current = job;
  useVoiceStore.setState({ textVoiceBusy: true });
  const room = getActiveRoom();
  const allowed = () => current === job && !job.controller.signal.aborted && (preview || (canUseTextVoice() && getActiveRoom() === room && room?.state === 'connected'));
  const state = useVoiceStore.getState();
  const audio = AudioManager.getInstance();
  const unsubscribe = useVoiceStore.subscribe(() => { if (!allowed()) stopTextVoice(); });
  const fail = () => new DOMException('Speech stopped', 'AbortError');
  try {
    if (!allowed()) throw fail();
    await audio.resumeContext();
    const context = audio.ensureContext();
    // Wait for the synthetic microphone publication, never fall back to hardware.
    if (!preview) {
      const deadline = Date.now() + 3000;
      while (!room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track || room.localParticipant.getTrackPublication(Track.Source.Microphone)?.isMuted) {
        if (!allowed() || Date.now() > deadline) throw fail();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const chunks = splitSpeech(value);
    const fetchChunk = async (chunk: string) => {
      try { return { data: await synthesizeLocalTextVoice(chunk, state.textVoice, state.textVoiceSpeed, job.controller.signal) }; }
      catch (error) { return { error }; }
    };
    let next = fetchChunk(chunks[0]!);
    for (let i = 0; i < chunks.length; i++) {
      const result = await next;
      if (!allowed()) throw fail();
      if ('error' in result) throw result.error;
      const buffer = await context.decodeAudioData(result.data!);
      if (!allowed()) throw fail();
      if (i + 1 < chunks.length) next = fetchChunk(chunks[i + 1]!);
      const source = context.createBufferSource();
      source.buffer = buffer;
      const gain = context.createGain();
      gain.gain.value = preview ? Math.min(1, state.outputVolume / 100) : 1;
      source.connect(gain);
      gain.connect(preview ? audio.getMasterOutput() : audio.getSpeechInput());
      if (!preview) gain.connect(audio.getAnalyserNode());
      const monitor = !preview ? context.createGain() : null;
      const updateMonitor = () => {
        if (monitor) { const live = useVoiceStore.getState(); monitor.gain.value = live.textVoiceMonitor && !live.isDeafened ? Math.min(1, live.outputVolume / 100) : 0; }
      };
      if (monitor) { updateMonitor(); source.connect(monitor); monitor.connect(audio.getMasterOutput()); }
      const unsubscribeMonitor = monitor ? useVoiceStore.subscribe(updateMonitor) : () => {};
      job.source = source;
      await new Promise<void>((resolve) => {
        source.onended = () => { unsubscribeMonitor(); monitor?.disconnect(); source.disconnect(); gain.disconnect(); if (job.source === source) job.source = null; resolve(); };
        source.start();
      });
      if (!allowed()) throw fail();
    }
  } finally {
    unsubscribe();
    if (current === job) stopTextVoice();
  }
}
