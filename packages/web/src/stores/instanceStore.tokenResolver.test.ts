import { describe, it, expect, beforeEach, vi } from 'vitest';

// Same shims as instanceStore.failover.test.ts so importing instanceStore
// doesn't pull in real WS / audio / federation machinery.
vi.mock('../utils/dmOriginFailover', () => ({
  failoverDmOriginsFromDisconnected: vi.fn(),
}));
vi.mock('../hooks/useWebSocket', () => ({
  connectInstance: vi.fn(),
  disconnectInstance: vi.fn(),
  disconnectAllRemote: vi.fn(),
}));
vi.mock('../utils/federationOps', () => ({ clearPasswordSyncTimers: vi.fn() }));
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));
// authStore.token is forced to null for every test in this file — that's the
// invariant we're verifying the resolver tolerates (registration window).
vi.mock('./authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: null, token: null }),
    { getState: () => ({ user: null, token: null }), setState: vi.fn(), subscribe: vi.fn() }
  ),
}));

// Importing instanceStore registers the production resolver.
import { useInstanceStore } from './instanceStore';
import { getTokenForOrigin } from '../utils/crossStoreResolvers';

beforeEach(() => {
  localStorage.clear();
  useInstanceStore.setState({ instances: [], registry: new Map(), registryUpdatedAt: 0 });
});

describe('home-origin token resolver', () => {
  // Regression: during the RegisterPage step-2 avatar upload window, the JWT
  // is in localStorage but authStore.token is still null (initSession is
  // intentionally deferred so AuthRedirect doesn't yank the user off /register
  // mid-upload). The home `api` client reads localStorage directly, so the
  // token resolver must too — otherwise transferStore.startUpload throws
  // "not authenticated" and the avatar upload silently fails.
  it('returns localStorage token for empty origin when authStore.token is null', () => {
    localStorage.setItem('backspace_token', 'register-window-jwt');
    expect(getTokenForOrigin('')).toBe('register-window-jwt');
  });

  it('returns null for empty origin when localStorage has no token', () => {
    expect(getTokenForOrigin('')).toBeNull();
  });

  it('returns the per-instance token for a known remote origin', () => {
    useInstanceStore.setState({
      instances: [{
        origin: 'https://remote.example.com',
        label: 'remote',
        token: 'remote-jwt',
        username: 'u',
        status: 'connected',
        user: { id: 'u', username: 'u' } as never,
        api: {} as never,
      }],
    });
    expect(getTokenForOrigin('https://remote.example.com')).toBe('remote-jwt');
  });

  it('returns null for an unknown remote origin', () => {
    expect(getTokenForOrigin('https://unknown.example.com')).toBeNull();
  });
});
