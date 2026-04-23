import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom
// (spaceStore → authStore → voiceStore → AudioManager → AudioWorkletNode)
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// Stub instanceStore to avoid initialization ordering issues
// (spaceStore → authStore → socialStore → instanceStore → setApiForOriginResolver)
vi.mock('./instanceStore', () => ({
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
vi.mock('./authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: null, token: null }),
    {
      getState: () => ({ user: null, token: null }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    }
  ),
}));

import { useSpaceStore } from './spaceStore';
import type { DmChannel } from '@backspace/shared';

function makeDm(id: string, federatedId: string | null, extras: Partial<DmChannel> = {}): DmChannel {
  return {
    id,
    federatedId,
    createdAt: 1000,
    members: [],
    ...extras,
  };
}

beforeEach(() => {
  useSpaceStore.getState().reset();
});

describe('spaceStore.dmAlternatives', () => {
  it('records origin + local channel id for each DM with federatedId on populateFromReady', () => {
    const dmsFromHome: DmChannel[] = [
      makeDm('home-1', 'fed-aaa'),
      makeDm('home-2', 'fed-bbb'),
      makeDm('home-3', null), // no federatedId — not indexed
    ];
    useSpaceStore.getState().populateFromReady('', [], [], dmsFromHome, null, 0);

    const alts = useSpaceStore.getState().dmAlternatives;
    expect(alts.get('fed-aaa')?.get('')).toBe('home-1');
    expect(alts.get('fed-bbb')?.get('')).toBe('home-2');
    expect(alts.has(null as any)).toBe(false);
  });

  it('accumulates entries across multiple origins for the same federatedId', () => {
    useSpaceStore.getState().populateFromReady(
      '',
      [],
      [],
      [makeDm('home-1', 'fed-aaa')],
      null,
      0,
    );
    useSpaceStore.getState().populateFromReady(
      'https://remote.example',
      [],
      [],
      [makeDm('remote-1', 'fed-aaa')],
      null,
      0,
    );

    const byOrigin = useSpaceStore.getState().dmAlternatives.get('fed-aaa');
    expect(byOrigin?.get('')).toBe('home-1');
    expect(byOrigin?.get('https://remote.example')).toBe('remote-1');
  });

  it('updates the local id if the same origin reports a different id for a federatedId', () => {
    useSpaceStore.getState().populateFromReady(
      'https://remote.example',
      [],
      [],
      [makeDm('remote-old', 'fed-aaa')],
      null,
      0,
    );
    useSpaceStore.getState().populateFromReady(
      'https://remote.example',
      [],
      [],
      [makeDm('remote-new', 'fed-aaa')],
      null,
      0,
    );

    const byOrigin = useSpaceStore.getState().dmAlternatives.get('fed-aaa');
    expect(byOrigin?.get('https://remote.example')).toBe('remote-new');
    expect(byOrigin?.size).toBe(1);
  });

  it('removeInstanceSpaces drops the origin from every inner map', () => {
    useSpaceStore.getState().populateFromReady(
      '',
      [],
      [],
      [makeDm('home-1', 'fed-aaa'), makeDm('home-2', 'fed-bbb')],
      null,
      0,
    );
    useSpaceStore.getState().populateFromReady(
      'https://remote.example',
      [],
      [],
      [makeDm('remote-1', 'fed-aaa'), makeDm('remote-2', 'fed-bbb')],
      null,
      0,
    );

    useSpaceStore.getState().removeInstanceSpaces('https://remote.example');

    const alts = useSpaceStore.getState().dmAlternatives;
    expect(alts.get('fed-aaa')?.has('https://remote.example')).toBe(false);
    expect(alts.get('fed-aaa')?.get('')).toBe('home-1');
    expect(alts.get('fed-bbb')?.has('https://remote.example')).toBe(false);
    expect(alts.get('fed-bbb')?.get('')).toBe('home-2');
  });

  it('removeInstanceSpaces deletes federatedId entry if its inner map becomes empty', () => {
    useSpaceStore.getState().populateFromReady(
      'https://remote.example',
      [],
      [],
      [makeDm('remote-only', 'fed-solo')],
      null,
      0,
    );

    useSpaceStore.getState().removeInstanceSpaces('https://remote.example');

    expect(useSpaceStore.getState().dmAlternatives.has('fed-solo')).toBe(false);
  });

  it('resolveDmChannelId returns the id itself if it is already a primary dmChannels entry', async () => {
    const { resolveDmChannelId } = await import('./spaceStore');
    useSpaceStore.getState().populateFromReady(
      '',
      [],
      [],
      [makeDm('home-1', 'fed-aaa')],
      null,
      0,
    );
    expect(resolveDmChannelId('home-1')).toBe('home-1');
  });

  it('resolveDmChannelId resolves an alternative id to the primary via federatedId', async () => {
    const { resolveDmChannelId } = await import('./spaceStore');
    // Home loads first → home-1 becomes the primary in dmChannels.
    useSpaceStore.getState().populateFromReady(
      '',
      [],
      [],
      [makeDm('home-1', 'fed-aaa')],
      null,
      0,
    );
    // Remote ready later → remote-1 recorded in dmAlternatives but deduped out of dmChannels.
    useSpaceStore.getState().populateFromReady(
      'https://remote.example',
      [],
      [],
      [makeDm('remote-1', 'fed-aaa')],
      null,
      0,
    );
    expect(resolveDmChannelId('remote-1')).toBe('home-1');
  });

  it('resolveDmChannelId returns null if the id is unknown everywhere', async () => {
    const { resolveDmChannelId } = await import('./spaceStore');
    expect(resolveDmChannelId('nonexistent')).toBeNull();
  });

  it('resolveDmChannelId returns null if the alternative points to a federatedId no longer in dmChannels', async () => {
    const { resolveDmChannelId } = await import('./spaceStore');
    useSpaceStore.getState().populateFromReady(
      'https://remote.example',
      [],
      [],
      [makeDm('remote-1', 'fed-aaa')],
      null,
      0,
    );
    // Simulate the dmChannels entry getting removed without clearing dmAlternatives —
    // resolveDmChannelId should gracefully return null rather than a stale pointer.
    useSpaceStore.setState({ dmChannels: [] });
    expect(resolveDmChannelId('remote-1')).toBeNull();
  });
});
