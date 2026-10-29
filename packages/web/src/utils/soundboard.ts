import { AudioManager } from '../audio/AudioManager';
import { getApiForOrigin } from '../stores/spaceStore';
import { useVoiceStore } from '../stores/voiceStore';
import type { Room } from 'livekit-client';
import { useSoundboardPlaybackStore } from '../stores/soundboardPlaybackStore';

/** Client decoders accept common audio formats; the server only accepts bounded PCM. */
export async function encodeSoundboardFile(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024) throw new Error('soundboard-invalid');
  const decoder = new OfflineAudioContext(1, 1, 48000);
  const decoded = await decoder.decodeAudioData(await file.arrayBuffer()).catch(() => { throw new Error('soundboard-invalid'); });
  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 5.2) throw new Error('soundboard-invalid');
  const context = new OfflineAudioContext(1, Math.ceil(decoded.duration * 48000), 48000);
  const source = context.createBufferSource(); source.buffer = decoded; source.connect(context.destination); source.start();
  const rendered = await context.startRendering();
  const samples = rendered.getChannelData(0);
  const bytes = new Uint8Array(44 + samples.length * 2); const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 48000, true); view.setUint32(28, 96000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, bytes.length - 44, true);
  for (let i = 0; i < samples.length; i++) { const sample = Math.max(-1, Math.min(1, samples[i]!)); view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true); }
  let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

let active: AudioBufferSourceNode | null = null;
let cancelWatch: (() => void) | null = null;
export function stopSoundboard(): void { const source = active; active = null; cancelWatch?.(); cancelWatch = null; useSoundboardPlaybackStore.getState().setPlayback(null, null); try { source?.stop(); } catch {} }
const buffers = new Map<string, AudioBuffer>();
const latest = new WeakMap<Room, string>();
let generation = 0;
export async function playLocalSoundboard(data: ArrayBuffer, key: string, volume: number, allowed: () => boolean = () => true, sender?: { identity: string; userId: string }): Promise<void> {
  const ownGeneration = ++generation;
  const audio = AudioManager.getInstance(); await audio.resumeContext();
  const context = audio.getContext(); if (!context) return;
  let buffer = buffers.get(key);
  if (!buffer) {
    buffer = await context.decodeAudioData(data.slice(0));
    if (buffer.duration > 5.21) return;
    if (buffers.size >= 16) buffers.delete(buffers.keys().next().value!);
    buffers.set(key, buffer);
  }
  if (ownGeneration !== generation || !allowed()) return;
  stopSoundboard();
  const source = context.createBufferSource(); const gain = context.createGain();
  const update = () => {
    const state = useVoiceStore.getState();
    gain.gain.value = Math.min(1, Math.max(0, volume * state.soundboardVolume / 100 * state.outputVolume / 100));
    if (!allowed()) stopSoundboard();
  };
  source.buffer = buffer; source.connect(gain); gain.connect(audio.getMasterOutput()); active = source;
  cancelWatch = useVoiceStore.subscribe(update); update();
  if (active !== source) { source.disconnect(); gain.disconnect(); return; }
  source.onended = () => { source.disconnect(); gain.disconnect(); if (active === source) { active = null; cancelWatch?.(); cancelWatch = null; useSoundboardPlaybackStore.getState().setPlayback(null, null); } };
  source.start();
  if (sender && active === source) useSoundboardPlaybackStore.getState().setPlayback(sender.identity, sender.userId);
}

/** Only server-originated LiveKit packets may invoke this; remote peer packets are ignored. */
export async function receiveSoundboard(payload: Uint8Array, room: Room, origin: string | null, isCurrent: () => boolean): Promise<void> {
  if (payload.byteLength > 2048) return;
  try {
    const event = JSON.parse(new TextDecoder().decode(payload));
    if (event.type !== 'soundboard_play' || !/^[a-f0-9-]{36}$/.test(event.ticket) || !/^[a-f0-9]{64}$/.test(event.assetId) ||
      !Number.isFinite(event.volume) || event.volume < 0 || event.volume > 1 || !Number.isFinite(event.createdAt) || Math.abs(Date.now() - event.createdAt) > 30_000) return;
    const allowed = () => isCurrent() && room.state === 'connected' && useVoiceStore.getState().isLiveKitConnected && !useVoiceStore.getState().isDeafened;
    if (!allowed()) return;
    if (latest.get(room) === event.ticket) return;
    latest.set(room, event.ticket);
    const cached = buffers.get(event.assetId);
    let assetOrigin = origin;
    if (assetOrigin === null) {
      const parsed = new URL(event.assetOrigin);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
      assetOrigin = parsed.origin;
    }
    const data = cached ? new ArrayBuffer(0) : await getApiForOrigin(assetOrigin).soundboard.audio(event.ticket, true);
    if (allowed() && latest.get(room) === event.ticket) await playLocalSoundboard(data, event.assetId, event.volume, allowed, typeof event.senderIdentity === 'string' && typeof event.senderUserId === 'string' && event.senderIdentity.startsWith(`${event.senderUserId}:`) && event.senderUserId.length > 0 ? { identity: event.senderIdentity, userId: event.senderUserId } : undefined);
  } catch { /* Missing/autoplay-denied effects must not interrupt the call. */ }
}


export function _resetSoundboardForTests(): void { stopSoundboard(); buffers.clear(); generation++; }
