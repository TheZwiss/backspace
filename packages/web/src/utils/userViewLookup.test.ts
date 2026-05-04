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
import { getCanonicalUserView } from './userViewLookup';
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
    value: { host: 'nova.ddns.net' },
    writable: true,
  });
  useSpaceStore.getState().reset();
});

describe('getCanonicalUserView', () => {
  it('returns the input unchanged on cache miss', () => {
    const stub = makeUser({
      id: 'orbit-axel-stub',
      username: 'axel@nova.ddns.net',
      homeUserId: 'nova-axel-id',
      homeInstance: 'nova.ddns.net',
      avatarColor: 'lavender',
    });
    expect(getCanonicalUserView(stub)).toBe(stub);
  });

  it('returns the cached entry when one exists for the same canonical key', () => {
    const stub = makeUser({
      id: 'orbit-axel-stub',
      username: 'axel@nova.ddns.net',
      homeUserId: 'nova-axel-id',
      homeInstance: 'nova.ddns.net',
      avatarColor: 'lavender',
    });
    const homeFromNova = makeUser({
      id: 'nova-local-id',
      username: 'axel@nova.ddns.net',
      homeUserId: 'nova-axel-id',
      homeInstance: 'nova.ddns.net',
      avatarColor: 'teal',
    });
    useSpaceStore.getState().upsertUserView(homeFromNova, 'https://nova.ddns.net');

    const resolved = getCanonicalUserView(stub);
    expect(resolved).toBe(homeFromNova);
    expect(resolved.avatarColor).toBe('teal');
  });

  it('returns the input on miss even after cache holds different users', () => {
    const someOther = makeUser({
      id: 'unrelated',
      username: 'unrelated',
      avatarColor: 'sky',
    });
    useSpaceStore.getState().upsertUserView(someOther, '');

    const stub = makeUser({
      id: 'orbit-axel-stub',
      username: 'axel@nova.ddns.net',
      homeUserId: 'nova-axel-id',
      homeInstance: 'nova.ddns.net',
    });
    expect(getCanonicalUserView(stub)).toBe(stub);
  });
});
