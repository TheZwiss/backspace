import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  voice: {} as any, asr: {} as any, listeners: new Set<() => void>(),
  getMic: vi.fn(), transcribe: vi.fn(), release: vi.fn(), speak: vi.fn(), prepare: vi.fn(), stopTrack: vi.fn(), connect: vi.fn(),
  room: {} as any, recorder: null as any,
}));
vi.mock('../stores/voiceStore', () => ({ useVoiceStore: { getState: () => mock.voice, subscribe: (callback: () => void) => { mock.listeners.add(callback); return () => mock.listeners.delete(callback); } } }));
vi.mock('../platform/speechRecognition', () => ({ useDictationStore: { getState: () => mock.asr, setState: (changes: any) => Object.assign(mock.asr, changes) }, speechRecognition: { transcribe: mock.transcribe, release: mock.release } }));
vi.mock('../platform/textVoice', () => ({ getLocalTextVoiceProvider: () => ({ prepareTextVoice: mock.prepare }) }));
vi.mock('../hooks/useLiveKit', () => ({ getActiveRoom: () => mock.room }));
vi.mock('./textVoice', () => ({ canUseTextVoice: () => mock.voice.isLiveKitConnected && !mock.voice.isMuted, speakText: mock.speak, stopTextVoice: vi.fn() }));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ resumeContext: async () => {}, ensureContext: () => ({ decodeAudioData: async () => ({ duration: 1 }) }) }) } }));
import { pressDictation, releaseDictation, cancelDictation } from './dictation';
class Recorder {
  state = 'inactive'; mimeType = 'audio/webm'; onstop: (() => void) | null = null; ondataavailable: ((event: any) => void) | null = null;
  constructor() { mock.recorder = this; }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: { size: 100 } }); this.onstop?.(); }
}
beforeEach(() => {
  vi.clearAllMocks(); mock.listeners.clear(); mock.room = {};
  mock.voice = { textVoiceEnabled: true, textVoiceBusy: false, textVoiceDevice: 'cpu', isLiveKitConnected: true, isMuted: false, currentVoiceChannelId: 'voice', activeDmCall: null, inputDeviceId: 'kraken', textVoiceDraft: '', setTextVoiceDraft: (text: string) => { mock.voice.textVoiceDraft = text; } };
  mock.asr = { installed: ['base'], model: 'base', phase: 'idle', recording: false, error: '' };
  mock.getMic.mockResolvedValue({ getTracks: () => [{ stop: mock.stopTrack }] });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: mock.getMic } });
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.stubGlobal('Blob', class { arrayBuffer = async () => new ArrayBuffer(16); });
  vi.stubGlobal('OfflineAudioContext', class {
    destination = {};
    createBufferSource() { return { connect: mock.connect, start: vi.fn() }; }
    async startRendering() { return { getChannelData: () => new Float32Array(16000).fill(0.1) }; }
  });
  mock.transcribe.mockResolvedValue({ text: 'Olá, pessoal!' }); mock.prepare.mockResolvedValue({}); mock.speak.mockResolvedValue(undefined);
});
afterEach(() => { cancelDictation(); vi.unstubAllGlobals(); });
it('records only while held, transcribes after release, then synthesizes to the call', async () => {
  await pressDictation(true);
  expect(mock.getMic).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.objectContaining({ deviceId: { exact: 'kraken' } }) }));
  expect(mock.transcribe).not.toHaveBeenCalled(); expect(mock.speak).not.toHaveBeenCalled(); expect(mock.connect).not.toHaveBeenCalled();
  releaseDictation();
  await vi.waitFor(() => expect(mock.speak).toHaveBeenCalledWith('Olá, pessoal!'));
  expect(mock.transcribe).toHaveBeenCalledOnce(); expect(mock.stopTrack).toHaveBeenCalled(); expect(mock.voice.textVoiceDraft).toBe('');
});
it('discards late microphone permission when the key is already released', async () => {
  let grant!: (value: any) => void;
  mock.getMic.mockReturnValue(new Promise((resolve) => { grant = resolve; }));
  const press = pressDictation();
  await vi.waitFor(() => expect(mock.getMic).toHaveBeenCalledOnce()); releaseDictation();
  grant({ getTracks: () => [{ stop: mock.stopTrack }] }); await press;
  expect(mock.stopTrack).toHaveBeenCalled(); expect(mock.transcribe).not.toHaveBeenCalled(); expect(mock.speak).not.toHaveBeenCalled();
});
it('cancels when changing call, including a late recognition result', async () => {
  let recognize!: (value: any) => void;
  mock.transcribe.mockReturnValue(new Promise((resolve) => { recognize = resolve; }));
  await pressDictation(); releaseDictation(); await vi.waitFor(() => expect(mock.transcribe).toHaveBeenCalledOnce());
  mock.room = {}; mock.voice.currentVoiceChannelId = 'another-call'; for (const callback of mock.listeners) callback();
  recognize({ text: 'Não envie isto.' }); await new Promise((resolve) => setTimeout(resolve, 10));
  expect(mock.speak).not.toHaveBeenCalled(); expect(mock.voice.textVoiceDraft).toBe(''); expect(mock.release).toHaveBeenCalled();
});
it('dictation only appends text without synthesizing or sending the real microphone', async () => {
  mock.voice.isLiveKitConnected = false; mock.voice.textVoiceDraft = 'Já digitado.';
  await pressDictation(false); releaseDictation();
  await vi.waitFor(() => expect(mock.voice.textVoiceDraft).toBe('Já digitado. Olá, pessoal!'));
  expect(mock.speak).not.toHaveBeenCalled(); expect(mock.prepare).not.toHaveBeenCalled();
});
it('never opens the microphone without an installed model or when auto-send is muted', async () => {
  mock.asr.installed = []; await pressDictation(); expect(mock.asr.error).toBe('model-not-installed');
  mock.asr.installed = ['base']; mock.voice.isMuted = true; await pressDictation();
  expect(mock.getMic).not.toHaveBeenCalled();
});
it('preserves recognized text on synthesis failure for retry', async () => {
  mock.speak.mockRejectedValue(new Error('synthesis-failed'));
  await pressDictation(); releaseDictation();
  await vi.waitFor(() => expect(mock.asr.error).toBe('synthesis-failed'));
  expect(mock.voice.textVoiceDraft).toBe('Olá, pessoal!');
});
