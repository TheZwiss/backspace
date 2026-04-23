import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../hooks/useWebSocket', async () => {
  const actual = await vi.importActual<any>('../hooks/useWebSocket');
  return actual;
});

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// Stub instanceStore to avoid initialization ordering issues
vi.mock('../stores/instanceStore', () => ({
  useInstanceStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ instances: [], _autoConnectDone: true }),
    {
      getState: () => ({ instances: [], _autoConnectDone: true }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    }
  ),
}));

// Stub authStore to avoid localStorage access during module init
vi.mock('../stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: null, token: null }),
    {
      getState: () => ({ user: null, token: null }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    }
  ),
}));

import { useSpaceStore, resolveDmChannelId } from '../stores/spaceStore';
import type { DmChannel } from '@backspace/shared';

function dm(id: string, federatedId: string | null, members: any[] = []): DmChannel {
  return { id, federatedId, createdAt: 1000, members };
}

beforeEach(() => { useSpaceStore.getState().reset(); });

describe('resolveDmChannelId (contract for dm_message_created fallback)', () => {
  it('resolves alternate-origin group-DM id to primary (closes pre-existing phantom-entry bug)', () => {
    // Group DM: primary pinned to home (home-gdm), alternate on remote (remote-gdm).
    useSpaceStore.setState({
      dmChannels: [dm('home-gdm', 'fed-group', [{ id: 'u1' } as any, { id: 'u2' } as any, { id: 'u3' } as any])],
      channelOriginMap: new Map([['home-gdm', '']]),
      dmAlternatives: new Map([
        ['fed-group', new Map([
          ['', 'home-gdm'],
          ['https://remote.example', 'remote-gdm'],
        ])],
      ]),
    });

    // A dm_message_created event from remote.example carries dmChannelId = 'remote-gdm'.
    // The handler's first lookup (dmChannels.find(id === 'remote-gdm')) returns undefined.
    // The new dmAlternatives fallback must resolve this to 'home-gdm'.
    expect(resolveDmChannelId('remote-gdm')).toBe('home-gdm');
  });
});
