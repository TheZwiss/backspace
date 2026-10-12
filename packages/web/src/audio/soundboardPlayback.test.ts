import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useVoiceStore } from '../stores/voiceStore';
import { useSpaceStore } from '../stores/spaceStore';
import { useSoundboardPreferences } from '../stores/soundboardStore';
import { receiveSoundboardPlay, stopSoundboardPlayback, updateSoundboardVolume } from './soundboardPlayback';

const audio = vi.hoisted(() => ({
  source: { start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), buffer: null, onended: null },
  gain: { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() },
  decode: vi.fn(), resume: vi.fn(),
}));
vi.mock('./AudioManager', () => ({ AudioManager: { getInstance: () => ({
  resumeContext: audio.resume,
  ensureContext: () => ({ decodeAudioData: audio.decode, createBufferSource: () => audio.source, createGain: () => audio.gain }),
  getMasterOutput: () => 'master-bus',
}) } }));
const sound = { id: '1', spaceId: 'space', uploaderId: 'me', name: 'Clip', emoji: '🔊', filename: '1.wav', durationSeconds: 1, createdAt: 1 };
beforeEach(() => {
  stopSoundboardPlayback(); vi.clearAllMocks();
  useVoiceStore.setState({ currentVoiceChannelId: 'voice', isLiveKitConnected: true, isDeafened: false, spaceDeafenedUserIds: new Set(), outputVolume: 50 });
  useSpaceStore.setState({ channelOriginMap: new Map([['voice', 'https://remote.test']]) });
  useSoundboardPreferences.setState({ volume: 70 });
  audio.resume.mockResolvedValue(undefined); audio.decode.mockResolvedValue({ duration: 1 });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]))));
});
afterEach(() => { stopSoundboardPlayback(); vi.unstubAllGlobals(); });

describe('voice-scoped soundboard playback', () => {
  it('uses the host asset and shared output bus with independent and master volume', async () => {
    await receiveSoundboardPlay('https://remote.test', 'voice', 'space', sound);
    expect(fetch).toHaveBeenCalledWith('https://remote.test/api/uploads/1.wav', expect.anything());
    expect(audio.gain.connect).toHaveBeenCalledWith('master-bus');
    expect(audio.gain.gain.value).toBeCloseTo(0.35);
    expect(audio.source.start).toHaveBeenCalledOnce();
    useSoundboardPreferences.setState({ volume: 40 }); updateSoundboardVolume();
    expect(audio.gain.gain.value).toBeCloseTo(0.2);
  });
  it('ignores other rooms/origins, disconnected and deafened sessions', async () => {
    await receiveSoundboardPlay('', 'voice', 'space', sound);
    await receiveSoundboardPlay('https://remote.test', 'other', 'space', sound);
    useVoiceStore.setState({ isDeafened: true });
    await receiveSoundboardPlay('https://remote.test', 'voice', 'space', sound);
    useVoiceStore.setState({ isDeafened: false, isLiveKitConnected: false });
    await receiveSoundboardPlay('https://remote.test', 'voice', 'space', sound);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cannot start a pending decode after Stop, a channel switch or deafen', async () => {
    let finish!: (value: { duration: number }) => void;
    audio.decode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const play = receiveSoundboardPlay('https://remote.test', 'voice', 'space', sound);
    await vi.waitFor(() => expect(audio.decode).toHaveBeenCalledOnce());
    stopSoundboardPlayback(); useVoiceStore.setState({ currentVoiceChannelId: 'other' });
    finish({ duration: 1 }); await play;
    expect(audio.source.start).not.toHaveBeenCalled();
  });
  it('rejects filenames outside the canonical asset form', async () => {
    await receiveSoundboardPlay('https://remote.test', 'voice', 'space', { ...sound, filename: '../../private' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
