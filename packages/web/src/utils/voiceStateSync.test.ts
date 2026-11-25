import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';

// Stub AudioManager — voiceStore imports it and AudioWorkletNode is absent in jsdom.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setInputVolume: vi.fn(),
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { useVoiceStore } from '../stores/voiceStore';
import { applySpaceVoiceState } from './voiceStateSync';
import { isPermissionMutedIn } from './permissionMute';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
  useVoiceStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('applySpaceVoiceState', () => {
  it('populates voiceUsers, voiceUserStates and scoped restriction sets', () => {
    applySpaceVoiceState({
      spaceId: 'sp1',
      voiceStates: { ch1: ['uA', 'uB'] },
      voiceChannelElapsedSeconds: { ch1: 123_456 },
      voiceUserStates: { uA: { isMuted: true, isDeafened: false, isCameraOn: false, isScreenSharing: false } },
      spaceVoiceStates: {
        'sp1:uA': { spaceMuted: true, spaceDeafened: false, permissionMuted: false },
        'sp1:uB': { spaceMuted: false, spaceDeafened: false, permissionMuted: true },
      },
    });

    const s = useVoiceStore.getState();
    expect(s.getVoiceUsers('ch1')).toEqual(['uA', 'uB']);
    expect(s.voiceChannelElapsedSeconds.get('ch1')).toEqual({
      elapsedSeconds: 123_456,
      observedAt: Date.now(),
    });
    expect(s.voiceUserStates.get('uA')).toEqual({ isMuted: true, isDeafened: false, isCameraOn: false, isScreenSharing: false });
    expect(s.spaceMutedUserIds.has('sp1:uA')).toBe(true);
    expect(s.permissionMutedUserIds.has('sp1:uB')).toBe(true);
  });

  it('refreshes only its own space, leaving other spaces untouched', () => {
    useVoiceStore.setState({
      spaceMutedUserIds: new Set(['sp-other:uX', 'sp1:uStale']),
    });

    applySpaceVoiceState({
      spaceId: 'sp1',
      voiceStates: {},
      voiceChannelElapsedSeconds: {},
      voiceUserStates: {},
      spaceVoiceStates: { 'sp1:uNew': { spaceMuted: true, spaceDeafened: false, permissionMuted: false } },
    });

    const s = useVoiceStore.getState();
    expect(s.spaceMutedUserIds.has('sp-other:uX')).toBe(true);  // untouched
    expect(s.spaceMutedUserIds.has('sp1:uStale')).toBe(false);  // cleared (authoritative re-sync)
    expect(s.spaceMutedUserIds.has('sp1:uNew')).toBe(true);
  });
});

describe('permission mute of a bot seat', () => {
  it('keeps the per-channel key apart from the per-space key and re-syncs it', () => {
    const snap = (keys: string[]) => ({
      spaceId: 'sp1',
      voiceStates: { chA: ['bot'], chB: ['bot'] },
      voiceChannelElapsedSeconds: {},
      voiceUserStates: {},
      spaceVoiceStates: Object.fromEntries(keys.map((k) => [k, { spaceMuted: false, spaceDeafened: false, permissionMuted: true }])),
    });
    applySpaceVoiceState(snap(['sp1:bot:chA']));
    const muted = useVoiceStore.getState().permissionMutedUserIds;
    expect(isPermissionMutedIn(muted, 'sp1', 'bot', 'chA')).toBe(true);
    expect(isPermissionMutedIn(muted, 'sp1', 'bot', 'chB')).toBe(false);

    applySpaceVoiceState(snap([]));
    expect(useVoiceStore.getState().permissionMutedUserIds.size).toBe(0);
  });

  it('voice_permission_muted with a channel mutes that channel only, and lifts it the same way', () => {
    const { setPermissionMutedUser } = useVoiceStore.getState();
    setPermissionMutedUser('sp1', 'bot', true, 'chA');
    let muted = useVoiceStore.getState().permissionMutedUserIds;
    expect([...muted]).toEqual(['sp1:bot:chA']);
    setPermissionMutedUser('sp1', 'bot', false, 'chA');
    muted = useVoiceStore.getState().permissionMutedUserIds;
    expect(muted.size).toBe(0);
  });
});

describe('moderator mute of a bot seat', () => {
  it('voice_space_muted with botSeat keys the seat, so the other channel stays clear', () => {
    const { setSpaceMutedUser, setSpaceDeafenedUser } = useVoiceStore.getState();
    setSpaceMutedUser('sp1', 'bot', true, 'chA');
    setSpaceDeafenedUser('sp1', 'bot', true, 'chA');
    const { spaceMutedUserIds, spaceDeafenedUserIds } = useVoiceStore.getState();
    expect([...spaceMutedUserIds]).toEqual(['sp1:bot:chA']);
    expect(isPermissionMutedIn(spaceDeafenedUserIds, 'sp1', 'bot', 'chB')).toBe(false);
    setSpaceMutedUser('sp1', 'bot', false, 'chA');
    expect(useVoiceStore.getState().spaceMutedUserIds.size).toBe(0);
  });
});
