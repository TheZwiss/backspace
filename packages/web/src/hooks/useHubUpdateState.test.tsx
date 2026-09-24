import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via authStore -> voiceStore.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));
import { act, renderHook, waitFor } from '@testing-library/react';
import type { InstanceInfoResponse, User } from '@backspace/shared';
import { api } from '../api/client';
import { useAuthStore } from '../stores/authStore';
import { useProjectHubStore, type HubUpdateState } from '../stores/projectHubStore';
import { readHubSeenVersion, writeHubSeenVersion } from '../utils/hubSeenVersion';
import { __resetHomeInstanceInfoForTests } from './useHomeInstanceInfo';
import { useHubUpdateState } from './useHubUpdateState';

function user(id: string): User {
  return {
    id,
    username: id,
    displayName: null,
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: 0,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
  };
}

function info(version: string): InstanceInfoResponse {
  return {
    name: 'Home',
    version,
    registrationOpen: true,
    federatedRegistrationOpen: true,
    instanceId: 'instance-1',
    sourceCodeUrl: 'https://github.com/TheZwiss/backspace',
    commit: null,
    directoryConfigured: false,
    directoryAvailable: false,
    directoryEnabled: false,
    supportCardEnabled: true,
  };
}

const originalMarkSeen = useProjectHubStore.getState().markSeen;

/** Wraps the store's real `markSeen` so calls can be counted without changing what it does. */
function spyOnMarkSeen(): ReturnType<typeof vi.fn<(version: string) => void>> {
  const markSeen = vi.fn<(version: string) => void>((version) => originalMarkSeen(version));
  useProjectHubStore.setState({ markSeen });
  return markSeen;
}

/** Renders the hook and records every state it reports, to prove a dot never flashed. */
function renderRecorded() {
  const seen: HubUpdateState[] = [];
  const hook = renderHook(() => {
    const result = useHubUpdateState();
    seen.push(result.state);
    return result;
  });
  return { ...hook, seen };
}

beforeEach(() => {
  localStorage.clear();
  __resetHomeInstanceInfoForTests();
  useProjectHubStore.setState({ userId: null, seenVersion: null, markSeen: originalMarkSeen });
  useAuthStore.setState({ user: user('alice') });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  __resetHomeInstanceInfoForTests();
  useProjectHubStore.setState({ userId: null, seenVersion: null, markSeen: originalMarkSeen });
  useAuthStore.setState({ user: null });
});

describe('useHubUpdateState', () => {
  it('on first run marks the version seen once and never shows a dot', async () => {
    vi.spyOn(api.instance, 'info').mockResolvedValue(info('1.5.1'));
    const markSeen = spyOnMarkSeen();

    const hook = renderRecorded();
    await waitFor(() => expect(hook.result.current).toEqual({ state: 'current', version: '1.5.1' }));

    expect(markSeen).toHaveBeenCalledTimes(1);
    expect(markSeen).toHaveBeenCalledWith('1.5.1');
    expect(readHubSeenVersion(localStorage, 'alice')).toBe('1.5.1');
    expect(hook.seen).not.toContain('updated');
  });

  it('reports updated when the stored version is older', async () => {
    writeHubSeenVersion(localStorage, 'alice', '1.5.0');
    vi.spyOn(api.instance, 'info').mockResolvedValue(info('1.5.1'));
    const markSeen = spyOnMarkSeen();

    const hook = renderRecorded();
    await waitFor(() => expect(hook.result.current).toEqual({ state: 'updated', version: '1.5.1' }));
    expect(markSeen).not.toHaveBeenCalled();
    expect(readHubSeenVersion(localStorage, 'alice')).toBe('1.5.0');
  });

  it('reports current when the stored version matches', async () => {
    writeHubSeenVersion(localStorage, 'alice', '1.5.1');
    vi.spyOn(api.instance, 'info').mockResolvedValue(info('1.5.1'));

    const hook = renderRecorded();
    await waitFor(() => expect(hook.result.current).toEqual({ state: 'current', version: '1.5.1' }));
    expect(hook.seen).not.toContain('updated');
  });

  it('reports unknown with no version when the info request fails', async () => {
    writeHubSeenVersion(localStorage, 'alice', '1.5.0');
    const spy = vi.spyOn(api.instance, 'info').mockRejectedValue(new Error('offline'));
    const markSeen = spyOnMarkSeen();

    const hook = renderRecorded();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });

    expect(hook.result.current).toEqual({ state: 'unknown', version: null });
    expect(markSeen).not.toHaveBeenCalled();
    expect(hook.seen).not.toContain('updated');
  });

  it('switching accounts reads the second user\'s record and leaves the first user\'s alone', async () => {
    writeHubSeenVersion(localStorage, 'alice', '1.5.1');
    writeHubSeenVersion(localStorage, 'bob', '1.5.0');
    vi.spyOn(api.instance, 'info').mockResolvedValue(info('1.5.1'));
    const markSeen = spyOnMarkSeen();

    const hook = renderRecorded();
    await waitFor(() => expect(hook.result.current.state).toBe('current'));

    const switchedAt = hook.seen.length;
    act(() => { useAuthStore.setState({ user: user('bob') }); });
    await waitFor(() => expect(useProjectHubStore.getState().userId).toBe('bob'));

    expect(hook.result.current).toEqual({ state: 'updated', version: '1.5.1' });
    // Not even the render before the store reloads may show Alice's state for Bob.
    expect(hook.seen.slice(switchedAt).every((state) => state === 'updated')).toBe(true);
    expect(markSeen).not.toHaveBeenCalled();
    expect(readHubSeenVersion(localStorage, 'alice')).toBe('1.5.1');
    expect(readHubSeenVersion(localStorage, 'bob')).toBe('1.5.0');
  });

  it('a new account after another one gets its own first run, without touching the first account', async () => {
    writeHubSeenVersion(localStorage, 'alice', '1.5.0');
    vi.spyOn(api.instance, 'info').mockResolvedValue(info('1.5.1'));

    const hook = renderRecorded();
    await waitFor(() => expect(hook.result.current.state).toBe('updated'));

    const switchedAt = hook.seen.length;
    act(() => { useAuthStore.setState({ user: user('carol') }); });
    await waitFor(() => expect(readHubSeenVersion(localStorage, 'carol')).toBe('1.5.1'));

    expect(hook.result.current).toEqual({ state: 'current', version: '1.5.1' });
    // Alice's dot never shows for Carol, not even for one render.
    expect(hook.seen.slice(switchedAt)).not.toContain('updated');
    expect(readHubSeenVersion(localStorage, 'alice')).toBe('1.5.0');
  });

  it('survives a storage that throws on access and shows no dot', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('denied', 'SecurityError'); },
    });
    try {
      vi.spyOn(api.instance, 'info').mockResolvedValue(info('1.5.1'));
      const hook = renderRecorded();
      await waitFor(() => expect(hook.result.current).toEqual({ state: 'current', version: '1.5.1' }));
      expect(hook.seen).not.toContain('updated');
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });

  it('writes nothing and shows no dot when signed out', async () => {
    useAuthStore.setState({ user: null });
    vi.spyOn(api.instance, 'info').mockResolvedValue(info('1.5.1'));

    const hook = renderRecorded();
    await waitFor(() => expect(hook.result.current.version).toBe('1.5.1'));

    expect(hook.seen).not.toContain('updated');
    expect(localStorage.length).toBe(0);
  });
});
