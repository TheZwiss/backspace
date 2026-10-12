import type { SoundboardSound } from '@backspace/shared/src/soundboard';
import { MAX_SOUNDBOARD_BYTES } from '@backspace/shared/src/soundboard';
import { AudioManager } from './AudioManager';
import { useVoiceStore } from '../stores/voiceStore';
import { getChannelOrigin, getMyUserIdForOrigin } from '../stores/spaceStore';
import { useSoundboardPreferences } from '../stores/soundboardStore';
import { useUIStore } from '../stores/uiStore';
import i18n from '../i18n';

let generation = 0;
let source: AudioBufferSourceNode | null = null;
let gain: GainNode | null = null;
let pending: AbortController | null = null;
export function stopSoundboardPlayback(): void {
  generation++;
  pending?.abort(); pending = null;
  try { source?.stop(); } catch { /* It may already have ended. */ }
  source?.disconnect(); gain?.disconnect();
  source = null; gain = null;
}

function canListen(origin: string, channelId: string, spaceId: string): boolean {
  const voice = useVoiceStore.getState();
  const uid = getMyUserIdForOrigin(origin);
  return voice.isLiveKitConnected && voice.currentVoiceChannelId === channelId && getChannelOrigin(channelId) === origin
    && !voice.isDeafened && !voice.spaceDeafenedUserIds.has(`${spaceId}:${uid}`);
}

/** One clip at a time through the existing output bus/device/limiter; never into the microphone. */
export async function receiveSoundboardPlay(origin: string, channelId: string, spaceId: string, sound: SoundboardSound): Promise<void> {
  if (!canListen(origin, channelId, spaceId) || !/^\d+\.wav$/.test(sound.filename)) return;
  stopSoundboardPlayback();
  const run = generation;
  const controller = new AbortController(); pending = controller;
  try {
    const manager = AudioManager.getInstance();
    await manager.resumeContext();
    const response = await fetch(`${origin}/api/uploads/${sound.filename}`, { signal: controller.signal });
    if (!response.ok) throw new Error('Audio unavailable');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Audio unavailable');
    const parts: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_SOUNDBOARD_BYTES) { await reader.cancel(); throw new Error('Audio too large'); }
      parts.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    const context = manager.ensureContext();
    const buffer = await context.decodeAudioData(bytes.buffer);
    if (run !== generation || !canListen(origin, channelId, spaceId)) return;
    source = context.createBufferSource(); gain = context.createGain();
    source.buffer = buffer;
    updateSoundboardVolume();
    source.connect(gain); gain.connect(manager.getMasterOutput());
    source.onended = () => { if (run === generation) stopSoundboardPlayback(); };
    source.start();
  } catch {
    if (run !== generation || controller.signal.aborted) return;
    useUIStore.getState().addToast(i18n.t('voice:soundboard.playFailed'), 'warning');
  } finally { if (run === generation) pending = null; }
}

export function updateSoundboardVolume(): void {
  if (gain) gain.gain.value = useSoundboardPreferences.getState().volume / 100 * useVoiceStore.getState().outputVolume / 100;
}
