import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

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

import { useSpaceStore } from '../stores/spaceStore';
import { renderHook } from '@testing-library/react';
import { getCanonicalUserView, useCanonicalUserView } from './userViewLookup';
import type { User } from '@backspace/shared';

function makeUser(extras: Partial<User> & Pick<User, 'id' | 'username'>): User {
  return {
    displayName: extras.username,
    avatar: '',
    avatarColor: 'mint',
    homeUserId: null,
    homeInstance: null,
    status: 'online',
    customStatus: null,
    bio: null,
    banner: null,
    isAdmin: false,
    isDeleted: false,
    discoverable: true,
    showActivity: true,
    createdAt: 0,
    ...extras,
  } as User;
}

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    value: { host: 'nova.example' },
    writable: true,
  });
  useSpaceStore.getState().reset();
});

describe('getCanonicalUserView', () => {
  it('returns the input unchanged on cache miss', () => {
    const stub = makeUser({
      id: 'orbit-frank-stub',
      username: 'frank@nova.example',
      homeUserId: 'nova-frank-id',
      homeInstance: 'nova.example',
      avatarColor: 'lavender',
    });
    expect(getCanonicalUserView(stub, 'https://orbit.example')).toBe(stub);
  });

  it('returns the cached entry when one exists for the same canonical key', () => {
    const stub = makeUser({
      id: 'orbit-frank-stub',
      username: 'frank@nova.example',
      homeUserId: 'nova-frank-id',
      homeInstance: 'nova.example',
      avatarColor: 'lavender',
    });
    const homeFromNova = makeUser({
      id: 'nova-local-id',
      username: 'frank@nova.example',
      homeUserId: 'nova-frank-id',
      homeInstance: 'nova.example',
      avatarColor: 'teal',
    });
    useSpaceStore.getState().upsertUserView(homeFromNova, 'https://nova.example');

    const resolved = getCanonicalUserView(stub, 'https://orbit.example');
    expect(resolved.avatarColor).toBe('teal');
    // The row's own identity stays: its id belongs to the instance that issued it.
    expect(resolved.id).toBe('orbit-frank-stub');
    expect(resolved.homeUserId).toBe('nova-frank-id');
  });

  it('returns the input on miss even after cache holds different users', () => {
    const someOther = makeUser({
      id: 'unrelated',
      username: 'unrelated',
      avatarColor: 'sky',
    });
    useSpaceStore.getState().upsertUserView(someOther, '');

    const stub = makeUser({
      id: 'orbit-frank-stub',
      username: 'frank@nova.example',
      homeUserId: 'nova-frank-id',
      homeInstance: 'nova.example',
    });
    expect(getCanonicalUserView(stub, 'https://orbit.example')).toBe(stub);
  });
});

describe('user views across instances (#353)', () => {
  it('keeps natives of two instances with the same id apart', () => {
    const alice = makeUser({ id: '42', username: 'alice', displayName: 'Alice (nova)' });
    const bob = makeUser({ id: '42', username: 'bob', displayName: 'Bob (orbit)' });
    useSpaceStore.getState().upsertUserView(alice, '');
    useSpaceStore.getState().upsertUserView(bob, 'https://orbit.example');
    expect(getCanonicalUserView(alice, '').displayName).toBe('Alice (nova)');
    expect(getCanonicalUserView(bob, 'https://orbit.example').displayName).toBe('Bob (orbit)');
  });

  it("finds a page-native user's own view from another instance's copy of them", () => {
    const frankHome = makeUser({ id: 'f1', username: 'frank', displayName: 'Frank Home' });
    const frankOnOrbit = makeUser({ id: 'f-orbit', username: 'frank@nova.example', displayName: null, homeUserId: 'f1', homeInstance: 'nova.example' });
    useSpaceStore.getState().upsertUserView(frankHome, '');
    const resolved = getCanonicalUserView(frankOnOrbit, 'https://orbit.example');
    expect(resolved.displayName).toBe('Frank Home');
    expect(resolved.id).toBe('f-orbit');
  });
});

describe('the same view for the same inputs', () => {
  const stub = makeUser({
    id: 'orbit-frank-stub',
    username: 'frank@nova.example',
    homeUserId: 'nova-frank-id',
    homeInstance: 'nova.example',
    avatarColor: 'lavender',
  });
  const homeFromNova = makeUser({
    id: 'nova-local-id',
    username: 'frank@nova.example',
    homeUserId: 'nova-frank-id',
    homeInstance: 'nova.example',
    avatarColor: 'teal',
  });

  it('gives the same object for the same row and cache entry', () => {
    useSpaceStore.getState().upsertUserView(homeFromNova, 'https://nova.example');
    const first = getCanonicalUserView(stub, 'https://orbit.example');
    const second = getCanonicalUserView(stub, 'https://orbit.example');
    expect(first).not.toBe(stub);
    expect(second).toBe(first);
  });

  it('keeps the same object across re-renders until the entry changes', () => {
    useSpaceStore.getState().upsertUserView(homeFromNova, 'https://nova.example');
    const { result, rerender } = renderHook(() => useCanonicalUserView(stub, 'https://orbit.example'));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);

    useSpaceStore.getState().upsertUserView({ ...homeFromNova, avatarColor: 'rose' }, 'https://nova.example');
    rerender();
    expect(result.current).not.toBe(first);
    expect(result.current.avatarColor).toBe('rose');
    expect(result.current.id).toBe('orbit-frank-stub');
  });

  it('builds a separate view for another row of the same person', () => {
    useSpaceStore.getState().upsertUserView(homeFromNova, 'https://nova.example');
    const otherStub = { ...stub, id: 'sky-frank-stub' };
    const forStub = getCanonicalUserView(stub, 'https://orbit.example');
    const forOther = getCanonicalUserView(otherStub, 'https://sky.example');
    expect(forOther).not.toBe(forStub);
    expect(forOther.id).toBe('sky-frank-stub');
  });
});
