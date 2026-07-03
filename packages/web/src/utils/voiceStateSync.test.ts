import { describe, it, expect, beforeEach, vi } from 'vitest';

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

beforeEach(() => {
  useVoiceStore.getState().reset();
});

describe('applySpaceVoiceState', () => {
  it('populates voiceUsers, voiceUserStates and scoped restriction sets', () => {
    applySpaceVoiceState({
      spaceId: 'sp1',
      voiceStates: { ch1: ['uA', 'uB'] },
      voiceUserStates: { uA: { isMuted: true, isDeafened: false, isCameraOn: false, isScreenSharing: false } },
      spaceVoiceStates: {
        'sp1:uA': { spaceMuted: true, spaceDeafened: false, permissionMuted: false },
        'sp1:uB': { spaceMuted: false, spaceDeafened: false, permissionMuted: true },
      },
    });

    const s = useVoiceStore.getState();
    expect(s.getVoiceUsers('ch1')).toEqual(['uA', 'uB']);
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
      voiceUserStates: {},
      spaceVoiceStates: { 'sp1:uNew': { spaceMuted: true, spaceDeafened: false, permissionMuted: false } },
    });

    const s = useVoiceStore.getState();
    expect(s.spaceMutedUserIds.has('sp-other:uX')).toBe(true);  // untouched
    expect(s.spaceMutedUserIds.has('sp1:uStale')).toBe(false);  // cleared (authoritative re-sync)
    expect(s.spaceMutedUserIds.has('sp1:uNew')).toBe(true);
  });
});
