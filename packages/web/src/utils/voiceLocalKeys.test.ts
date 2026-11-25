import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setInputVolume: vi.fn(), setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

import { useVoiceStore } from '../stores/voiceStore';
import { useSpaceStore } from '../stores/spaceStore';
import type { MemberWithUser } from '@backspace/shared';
import { isLocallyMutedIn, localVolumeIn, setLocalMute, setLocalVolume, voiceSeatKey } from './voiceLocalKeys';

const member = (userId: string, isBot: boolean): MemberWithUser =>
  ({ userId, spaceId: 'sp', user: { id: userId, username: userId, isBot } }) as unknown as MemberWithUser;

beforeEach(() => {
  useVoiceStore.getState().reset();
  useSpaceStore.setState({ members: [member('bot', true), member('human', false)] });
});
afterEach(() => useSpaceStore.setState({ members: [] }));

const mutes = () => useVoiceStore.getState().participantMutes;
const volumes = () => useVoiceStore.getState().participantVolumes;

describe('local mute and volume of a voice participant', () => {
  it('a bot muted in one channel is not muted in another', () => {
    setLocalMute('bot', 'chA', true);
    expect(isLocallyMutedIn(mutes(), 'bot', 'chA')).toBe(true);
    expect(isLocallyMutedIn(mutes(), 'bot', 'chB')).toBe(false);
    expect(mutes().has('bot')).toBe(false);
  });

  it('a person muted anywhere stays muted in every channel', () => {
    setLocalMute('human', 'chA', true);
    expect(isLocallyMutedIn(mutes(), 'human', 'chB')).toBe(true);
    expect(mutes().get('human')).toBe(true);
  });

  it('unmuting a bot also lifts a mute stored under the plain id before bots were kept per seat', () => {
    useVoiceStore.getState().setParticipantMute('bot', true);
    expect(isLocallyMutedIn(mutes(), 'bot', 'chB')).toBe(true);
    setLocalMute('bot', 'chB', false);
    expect(isLocallyMutedIn(mutes(), 'bot', 'chA')).toBe(false);
    expect(isLocallyMutedIn(mutes(), 'bot', 'chB')).toBe(false);
  });

  it('a bot volume is per seat, falling back to the plain id and then to 100', () => {
    expect(localVolumeIn(volumes(), 'bot', 'chA')).toBe(100);
    setLocalVolume('bot', 'chA', 30);
    expect(localVolumeIn(volumes(), 'bot', 'chA')).toBe(30);
    expect(localVolumeIn(volumes(), 'bot', 'chB')).toBe(100);
    expect(volumes().has(voiceSeatKey('bot', 'chA'))).toBe(true);
    setLocalVolume('human', 'chA', 150);
    expect(localVolumeIn(volumes(), 'human', 'chB')).toBe(150);
  });
});
