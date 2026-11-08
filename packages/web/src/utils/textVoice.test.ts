import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state: Record<string, unknown> = {};
  const update = (changes: Record<string, unknown>) => { Object.assign(state, changes); for (const listener of listeners) listener(); };
  return { state, listeners, update, speech: vi.fn(), source: null as unknown, hold: false, starts: vi.fn(), destination: {}, master: {}, connections: [] as unknown[], gains: [] as Array<{ gain: { value: number } }>,
    room: { state: 'connected', localParticipant: { getTrackPublication: () => ({ track: {}, isMuted: false }) } } as { state: string; localParticipant: unknown },
  };
});
vi.mock('../platform/textVoice', () => ({ supportsLocalTextVoice: () => true, synthesizeLocalTextVoice: (...args: unknown[]) => mocks.speech(...args) }));
vi.mock('../hooks/useLiveKit', () => ({ getActiveRoom: () => mocks.room }));
vi.mock('./dmCall', () => ({ voiceSessionOrigin: () => '' }));
vi.mock('../stores/voiceStore', () => ({ useVoiceStore: {
  getState: () => mocks.state, setState: mocks.update,
  subscribe: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
} }));
vi.mock('../stores/spaceStore', () => ({
  getApiForOrigin: () => ({ tts: { speech: mocks.speech } }), getChannelOrigin: () => '', getMyUserIdForOrigin: () => 'me',
  useSpaceStore: { getState: () => ({ channelToSpaceMap: new Map([['voice', 'space']]) }) },
}));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({
  resumeContext: async () => {}, getSpeechInput: () => mocks.destination, getMasterOutput: () => mocks.master, getAnalyserNode: () => ({}),
  ensureContext: () => ({
    decodeAudioData: async () => ({ duration: 0.1 }),
    createGain: () => { const gain = { gain: { value: 1 }, connect: (node: unknown) => mocks.connections.push(node), disconnect: () => {} }; mocks.gains.push(gain); return gain; },
    createBufferSource: () => {
      const source: { onended: (() => void) | null; connect: () => void; disconnect: () => void; start: () => void; stop: () => void } = { connect: () => {}, disconnect: () => {}, onended: null, start: () => { mocks.starts(); if (!mocks.hold) setTimeout(() => source.onended?.(), 0); }, stop: () => source.onended?.() };
      mocks.source = source; return source;
    },
  }),
}) } }));
import { canUseTextVoice, speakText, splitSpeech, stopTextVoice } from './textVoice';
beforeEach(() => {
  stopTextVoice(); vi.clearAllMocks(); mocks.listeners.clear(); mocks.connections.length = 0; mocks.gains.length = 0;
  mocks.hold = false;
  mocks.room.state = 'connected';
  mocks.update({ textVoiceEnabled: true, isLiveKitConnected: true, isMuted: false, isDeafened: false, currentVoiceChannelId: 'voice',
    activeDmCall: null, spaceMutedUserIds: new Set(), spaceDeafenedUserIds: new Set(), permissionMutedUserIds: new Set(), textVoice: 'pf_dora', textVoiceSpeed: 1, outputVolume: 100, textVoiceMonitor: false });
  mocks.speech.mockResolvedValue(new ArrayBuffer(100));
});
it('bounds phrases without dropping Portuguese words', () => {
  const text = 'Olá, tudo bem? Eu estou usando uma voz sintetizada para conversar com vocês hoje. '.repeat(3).trim();
  const chunks = splitSpeech(text);
  expect(chunks.every((chunk) => chunk.length <= 120)).toBe(true);
  expect(chunks.join(' ')).toBe(text);
  expect(splitSpeech('x'.repeat(260)).map((x) => x.length)).toEqual([120, 120, 20]);
});
it('sends synthesized audio to the microphone graph, not the local speakers', async () => {
  await speakText('Olá, pessoal!');
  expect(mocks.speech).toHaveBeenCalledWith('Olá, pessoal!', 'pf_dora', 1, expect.any(AbortSignal));
  expect(mocks.connections).toContain(mocks.destination); expect(mocks.gains[1]!.gain.value).toBe(0);
  expect(mocks.starts).toHaveBeenCalledOnce(); expect(mocks.state.textVoiceBusy).toBe(false);
});
it('discards pending synthesis immediately when muted', async () => {
  let finish!: (value: ArrayBuffer) => void;
  mocks.speech.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const pending = speakText('Não transmita esta frase.');
  await vi.waitFor(() => expect(mocks.speech).toHaveBeenCalledOnce());
  const signal = mocks.speech.mock.calls[0]![3] as AbortSignal;
  mocks.update({ isMuted: true }); expect(signal.aborted).toBe(true);
  finish(new ArrayBuffer(100)); await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  expect(mocks.starts).not.toHaveBeenCalled();
});
it('enforces server mute and deafening, but also works in active private calls', () => {
  mocks.update({ permissionMutedUserIds: new Set(['space:me']) }); expect(canUseTextVoice()).toBe(false);
  mocks.update({ permissionMutedUserIds: new Set(), isDeafened: true }); expect(canUseTextVoice()).toBe(false);
  mocks.update({ currentVoiceChannelId: null, isDeafened: false, activeDmCall: {} }); expect(canUseTextVoice()).toBe(true);
  mocks.update({ activeDmCall: null }); expect(canUseTextVoice()).toBe(false);
});
it('local preview never injects audio into the microphone', async () => {
  mocks.update({ textVoiceEnabled: false, isLiveKitConnected: false });
  await speakText('Prévia da minha voz.', true);
  expect(mocks.connections).toContain(mocks.master); expect(mocks.connections).not.toContain(mocks.destination);
});
it('stopping the last phrase reports cancellation instead of consuming the draft as successful', async () => {
  mocks.hold = true;
  const pending = speakText('Ainda estou falando.');
  await vi.waitFor(() => expect(mocks.starts).toHaveBeenCalledOnce());
  stopTextVoice();
  await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  expect(mocks.state.textVoiceBusy).toBe(false);
});

it('monitors only synthesized voice and changes monitoring immediately', async () => {
  mocks.hold = true; mocks.update({ textVoiceMonitor: true, outputVolume: 75 });
  const pending = speakText('Minha voz sintetizada.');
  await vi.waitFor(() => expect(mocks.starts).toHaveBeenCalledOnce());
  expect(mocks.connections).toContain(mocks.destination); expect(mocks.connections).toContain(mocks.master);
  expect(mocks.gains[1]!.gain.value).toBe(0.75);
  mocks.update({ textVoiceMonitor: false }); expect(mocks.gains[1]!.gain.value).toBe(0);
  mocks.update({ textVoiceMonitor: true, outputVolume: 50 }); expect(mocks.gains[1]!.gain.value).toBe(0.5);
  stopTextVoice(); await expect(pending).rejects.toHaveProperty('name', 'AbortError');
});
