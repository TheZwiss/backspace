import { AudioManager } from '../audio/AudioManager';
import { getApiForOrigin } from '../stores/spaceStore';
import { useVoiceStore } from '../stores/voiceStore';
import type { Room } from 'livekit-client';
import { useSoundboardPlaybackStore, type SoundboardSender } from '../stores/soundboardPlaybackStore';
import { EDGE_FADE_SECONDS } from './audioTrim';

/** Longest source file the client will decode. */
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
/** Longest clip the server stores (the trimmer keeps clips under this). */
const MAX_STORED_SECONDS = 5.2;
const OUTPUT_RATE = 48000;

/** Decode an uploaded audio file. Throws `soundboard-invalid` for a file that is too large or not audio. */
export async function decodeSoundboardFile(file: File): Promise<AudioBuffer> {
  if (file.size > MAX_SOURCE_BYTES) throw new Error('soundboard-invalid');
  const decoder = new OfflineAudioContext(1, 1, OUTPUT_RATE);
  const decoded = await decoder.decodeAudioData(await file.arrayBuffer()).catch(() => { throw new Error('soundboard-invalid'); });
  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error('soundboard-invalid');
  return decoded;
}

export interface SoundboardCut {
  /** Seconds into the source where the clip begins. */
  start: number;
  /** Seconds into the source where the clip ends. */
  end: number;
  /** Fade the first and last few milliseconds so a hard cut does not click. */
  fade?: boolean;
}

/**
 * Render a cut of `decoded` to the canonical soundboard WAV (mono, 48 kHz, 16-bit
 * PCM) as base64. The cut must be inside the source and at most 5.2 s: the server
 * checks again, this only fails fast.
 */
export async function encodeSoundboardBuffer(decoded: AudioBuffer, cut: SoundboardCut = { start: 0, end: decoded.duration }): Promise<string> {
  const start = Math.max(0, cut.start);
  const end = Math.min(decoded.duration, cut.end);
  const length = end - start;
  if (!Number.isFinite(length) || length <= 0 || length > MAX_STORED_SECONDS) throw new Error('soundboard-invalid');
  const frames = Math.max(1, Math.ceil(length * OUTPUT_RATE));
  const context = new OfflineAudioContext(1, frames, OUTPUT_RATE);
  const source = context.createBufferSource(); source.buffer = decoded;
  const envelope = context.createGain();
  if (cut.fade) {
    const fade = Math.min(EDGE_FADE_SECONDS, length / 2);
    envelope.gain.setValueAtTime(0, 0);
    envelope.gain.linearRampToValueAtTime(1, fade);
    envelope.gain.setValueAtTime(1, Math.max(fade, length - fade));
    envelope.gain.linearRampToValueAtTime(0, length);
  }
  source.connect(envelope); envelope.connect(context.destination);
  source.start(0, start, length);
  const rendered = await context.startRendering();
  const samples = rendered.getChannelData(0);
  const bytes = new Uint8Array(44 + samples.length * 2); const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, OUTPUT_RATE, true); view.setUint32(28, OUTPUT_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, bytes.length - 44, true);
  for (let i = 0; i < samples.length; i++) { const sample = Math.max(-1, Math.min(1, samples[i]!)); view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true); }
  let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/** Whole-file encode kept for callers that do not trim: the file must already fit. */
export async function encodeSoundboardFile(file: File): Promise<string> {
  const decoded = await decodeSoundboardFile(file);
  if (decoded.duration > MAX_STORED_SECONDS) throw new Error('soundboard-invalid');
  return encodeSoundboardBuffer(decoded);
}

export interface TrimPreview {
  /** Stop playing now. Safe to call twice. */
  stop: () => void;
  /** Seconds into the source the playhead is at. */
  position: () => number;
  /** Resolves when playback ends, by finishing or by `stop`. */
  ended: Promise<void>;
}

/**
 * Play a cut of `buffer` locally through the app's output (same bus as "Listen
 * locally"), for the trimmer's preview. Nothing is sent to a call.
 */
export async function previewSoundboardCut(buffer: AudioBuffer, cut: SoundboardCut): Promise<TrimPreview> {
  const audio = AudioManager.getInstance();
  await audio.resumeContext();
  const context = audio.getContext();
  if (!context) throw new Error('soundboard-invalid');
  const length = Math.max(0, cut.end - cut.start);
  const source = context.createBufferSource(); source.buffer = buffer;
  const envelope = context.createGain();
  const volume = Math.max(0, Math.min(1, useVoiceStore.getState().soundboardVolume / 100));
  const fade = cut.fade ? Math.min(EDGE_FADE_SECONDS, length / 2) : 0;
  const now = context.currentTime;
  envelope.gain.setValueAtTime(fade ? 0 : volume, now);
  if (fade) {
    envelope.gain.linearRampToValueAtTime(volume, now + fade);
    envelope.gain.setValueAtTime(volume, now + Math.max(fade, length - fade));
    envelope.gain.linearRampToValueAtTime(0, now + length);
  }
  source.connect(envelope); envelope.connect(audio.getMasterOutput());
  let done = false;
  let finish: () => void = () => {};
  const ended = new Promise<void>((resolve) => { finish = resolve; });
  source.onended = () => { done = true; envelope.disconnect(); finish(); };
  source.start(now, cut.start, length);
  return {
    stop: () => { if (done) return; try { source.stop(); } catch { /* already stopped */ } },
    position: () => Math.min(cut.end, cut.start + Math.max(0, context.currentTime - now)),
    ended,
  };
}

interface Playback {
  source: AudioBufferSourceNode;
  gain: GainNode;
  sender?: SoundboardSender;
  allowed: () => boolean;
  volume: number;
}

// Reject additional effects at capacity; never cut off an already playing clip.
const MAX_PLAYBACKS = 64;
const active = new Set<Playback>();
const pending = new Set<object>();
const downloads = new Set<object>();
let cancelWatch: (() => void) | null = null;
const buffers = new Map<string, AudioBuffer>();
let seenTickets = new WeakMap<Room, Map<string, number>>();
let generation = 0;

function syncSenders(): void {
  useSoundboardPlaybackStore.getState().setPlaybacks(
    [...active].flatMap((playback) => playback.sender ? [playback.sender] : []),
  );
}

function finish(playback: Playback, stop = false): void {
  if (!active.delete(playback)) return;
  playback.source.onended = null;
  if (stop) { try { playback.source.stop(); } catch {} }
  playback.source.disconnect();
  playback.gain.disconnect();
  if (!active.size) { cancelWatch?.(); cancelWatch = null; }
  syncSenders();
}

export function stopSoundboard(): void {
  generation++;
  for (const playback of active) finish(playback, true);
}

function updatePlaybacks(): void {
  const state = useVoiceStore.getState();
  for (const playback of active) {
    if (state.isDeafened || !playback.allowed()) { finish(playback, true); continue; }
    playback.gain.gain.value = Math.min(1, Math.max(0, playback.volume * state.soundboardVolume / 100 * state.outputVolume / 100));
  }
}

export async function playLocalSoundboard(data: ArrayBuffer, key: string, volume: number, allowed: () => boolean = () => true, sender?: SoundboardSender): Promise<void> {
  if (active.size + pending.size >= MAX_PLAYBACKS) return;
  const reservation = {};
  pending.add(reservation);
  const ownGeneration = generation;
  const startedInCall = useVoiceStore.getState().isLiveKitConnected;
  const stillAllowed = () => allowed() && (!startedInCall || useVoiceStore.getState().isLiveKitConnected);
  try {
    const audio = AudioManager.getInstance();
    await audio.resumeContext();
    const context = audio.getContext();
    if (!context || ownGeneration !== generation || !stillAllowed() || useVoiceStore.getState().isDeafened) return;
    let buffer = buffers.get(key);
    if (!buffer) {
      buffer = await context.decodeAudioData(data.slice(0));
      if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 5.21) return;
      if (buffers.size >= 16) buffers.delete(buffers.keys().next().value!);
      buffers.set(key, buffer);
    }
    if (ownGeneration !== generation || !stillAllowed() || useVoiceStore.getState().isDeafened) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    const playback: Playback = { source, gain, sender, allowed: stillAllowed, volume };
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(audio.getMasterOutput());
    active.add(playback);
    if (!cancelWatch) cancelWatch = useVoiceStore.subscribe(updatePlaybacks);
    updatePlaybacks();
    if (!active.has(playback)) return;
    source.onended = () => finish(playback);
    try { source.start(); } catch (error) { finish(playback); throw error; }
    syncSenders();
  } finally {
    pending.delete(reservation);
  }
}

/** Only server-originated LiveKit packets may invoke this; remote peer packets are ignored. */
export async function receiveSoundboard(payload: Uint8Array, room: Room, origin: string | null, isCurrent: () => boolean): Promise<void> {
  if (payload.byteLength > 2048 || downloads.size >= MAX_PLAYBACKS) return;
  const download = {};
  try {
    const event = JSON.parse(new TextDecoder().decode(payload));
    if (event.type !== 'soundboard_play' || !/^[a-f0-9-]{36}$/.test(event.ticket) || !/^[a-f0-9]{64}$/.test(event.assetId) ||
      !Number.isFinite(event.volume) || event.volume < 0 || event.volume > 1 || !Number.isFinite(event.createdAt) || Math.abs(Date.now() - event.createdAt) > 30_000) return;
    const allowed = () => isCurrent() && room.state === 'connected' && useVoiceStore.getState().isLiveKitConnected && !useVoiceStore.getState().isDeafened;
    if (!allowed()) return;
    let tickets = seenTickets.get(room);
    if (!tickets) { tickets = new Map(); seenTickets.set(room, tickets); }
    for (const [ticket, receivedAt] of tickets) {
      if (Date.now() - receivedAt > 60_000) tickets.delete(ticket);
    }
    if (tickets.has(event.ticket) || tickets.size >= 4096) return;
    tickets.set(event.ticket, Date.now());
    const ownGeneration = generation;
    const cached = buffers.get(event.assetId);
    let assetOrigin = origin;
    if (assetOrigin === null) {
      const parsed = new URL(event.assetOrigin);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
      assetOrigin = parsed.origin;
    }
    downloads.add(download);
    const data = cached ? new ArrayBuffer(0) : await getApiForOrigin(assetOrigin).soundboard.audio(event.ticket, true);
    if (allowed() && ownGeneration === generation) await playLocalSoundboard(data, event.assetId, event.volume, allowed, typeof event.senderIdentity === 'string' && typeof event.senderUserId === 'string' && event.senderIdentity.startsWith(`${event.senderUserId}:`) && event.senderUserId.length > 0 ? { identity: event.senderIdentity, userId: event.senderUserId } : undefined);
  } catch { /* Missing/autoplay-denied effects must not interrupt the call. */ }
  finally { downloads.delete(download); }
}


export function _resetSoundboardForTests(): void { stopSoundboard(); buffers.clear(); seenTickets = new WeakMap(); }
