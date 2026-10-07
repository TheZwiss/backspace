import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { User } from '@backspace/shared';

// Same shims as instanceStore.tokenResolver.test.ts so importing instanceStore
// doesn't pull in real WS / audio / federation machinery.
vi.mock('../hooks/useWebSocket', () => ({
  connectInstance: vi.fn(),
  disconnectInstance: vi.fn(),
  disconnectAllRemote: vi.fn(),
}));
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

type SessionUser = Pick<User, 'id' | 'username' | 'homeInstance' | 'homeUserId'> & { federationHomeOrphaned?: boolean };
const auth = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock('./authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: auth.user, token: 't' }),
    { getState: () => ({ user: auth.user, token: 't' }), setState: vi.fn(), subscribe: vi.fn() },
  ),
}));

import { useInstanceStore, getFriendsHomeOrigin, type ConnectedInstance } from './instanceStore';

const HOME = 'https://nova.example';

function instance(origin: string, status: ConnectedInstance['status']): ConnectedInstance {
  return {
    origin,
    label: origin,
    token: 'jwt',
    username: 'erin',
    status,
    user: { id: 'erin-home', username: 'erin' } as ConnectedInstance['user'],
    api: {} as ConnectedInstance['api'],
  };
}

beforeEach(() => {
  auth.user = null;
  useInstanceStore.setState({ instances: [] });
});

describe('getFriendsHomeOrigin', () => {
  it("is the page's instance for a native account", () => {
    auth.user = { id: 'erin', username: 'erin', homeInstance: null, homeUserId: null };
    useInstanceStore.setState({ instances: [instance(HOME, 'connected')] });
    expect(getFriendsHomeOrigin()).toBe('');
  });

  it('is the connected true home for a federated account signed in to the page\'s instance', () => {
    auth.user = { id: 'erin-orbit', username: 'erin@nova.example', homeInstance: 'nova.example', homeUserId: 'erin-home' };
    useInstanceStore.setState({ instances: [instance('https://other.example', 'connected'), instance(HOME, 'connected')] });
    expect(getFriendsHomeOrigin()).toBe(HOME);
  });

  it('matches the home by hostname, whatever form the session row stored it in', () => {
    auth.user = { id: 'erin-orbit', username: 'erin@nova.example', homeInstance: 'https://Nova.example', homeUserId: 'erin-home' };
    useInstanceStore.setState({ instances: [instance(HOME, 'connected')] });
    expect(getFriendsHomeOrigin()).toBe(HOME);
  });

  it("falls back to the page's instance while the true home has no live session", () => {
    auth.user = { id: 'erin-orbit', username: 'erin@nova.example', homeInstance: 'nova.example', homeUserId: 'erin-home' };
    useInstanceStore.setState({ instances: [instance(HOME, 'disconnected')] });
    expect(getFriendsHomeOrigin()).toBe('');
    useInstanceStore.setState({ instances: [] });
    expect(getFriendsHomeOrigin()).toBe('');
  });

  it("is the page's instance for a detached account, sovereign here", () => {
    auth.user = {
      id: 'erin-orbit', username: 'erin@nova.example', homeInstance: 'nova.example', homeUserId: 'erin-home',
      federationHomeOrphaned: true,
    };
    useInstanceStore.setState({ instances: [instance(HOME, 'connected')] });
    expect(getFriendsHomeOrigin()).toBe('');
  });

  it("is the page's instance with no session", () => {
    expect(getFriendsHomeOrigin()).toBe('');
  });
});
