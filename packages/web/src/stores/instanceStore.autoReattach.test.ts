import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { User } from '@backspace/shared';
import type { BackspaceApiClient } from '../api/client';

// ── Module mocks (mirror instanceStore.failover.test.ts) ─────────────────────
// These stub the side-effecting modules instanceStore pulls in at import time so
// the store loads cleanly under jsdom with no network, audio, or WS activity.
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
// Primary user is null: the auto-reattach helper must then locate the home
// session through the instances array (the SECONDARY-connection branch), so
// window.location.host is irrelevant to these tests.
vi.mock('./authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: null, token: null }),
    { getState: () => ({ user: null, token: null }), setState: vi.fn(), subscribe: vi.fn() }
  ),
}));

import { useInstanceStore, maybeAutoReattach } from './instanceStore';
import type { ConnectedInstance } from './instanceStore';

function makeInstance(overrides: Partial<ConnectedInstance> & { origin: string }): ConnectedInstance {
  return {
    label: 'x', token: 't', status: 'connected',
    username: overrides.user?.username ?? 'u',
    api: { auth: { attachProof: vi.fn() }, users: { reattach: vi.fn() } } as unknown as BackspaceApiClient,
    user: { id: 'id', username: 'u' } as User,
    ...overrides,
  };
}

beforeEach(() => {
  useInstanceStore.setState({ instances: [], registry: new Map(), registryUpdatedAt: 0 });
});

describe('maybeAutoReattach', () => {
  it('performs the token exchange when all conditions hold (same base, home session present)', async () => {
    const homeConn = makeInstance({
      origin: 'https://orbit.test',
      username: 'youruser',
      user: { id: 'new-home-1', username: 'youruser' } as User,
    });
    const attachProof = vi.fn().mockResolvedValue({ token: 'a'.repeat(64) });
    (homeConn.api as unknown as { auth: { attachProof: typeof attachProof } }).auth.attachProof = attachProof;

    const updatedUser = { id: 'detached-1', username: 'youruser@orbit.test', federationHomeOrphaned: false, homeInstance: 'orbit.test' } as User;
    const reattach = vi.fn().mockResolvedValue({ success: true, user: updatedUser });
    const detachedConn = makeInstance({
      origin: 'https://nova.test',
      user: { id: 'detached-1', username: 'youruser@orbit.test', federationHomeOrphaned: true, homeInstance: 'orbit.test' } as User,
    });
    (detachedConn.api as unknown as { users: { reattach: typeof reattach } }).users.reattach = reattach;

    useInstanceStore.setState({ instances: [homeConn, detachedConn] });
    await maybeAutoReattach(detachedConn);

    expect(attachProof).toHaveBeenCalledWith('nova.test');
    expect(reattach).toHaveBeenCalledWith({ token: 'a'.repeat(64) });
    const stored = useInstanceStore.getState().instances.find(i => i.origin === 'https://nova.test')!;
    expect(stored.user.federationHomeOrphaned).toBe(false);
  });

  it('skips silently on username-base mismatch (cross-name binds are manual-only)', async () => {
    const homeConn = makeInstance({ origin: 'https://orbit.test', username: 'hans', user: { id: 'h', username: 'hans' } as User });
    const detachedConn = makeInstance({
      origin: 'https://nova.test',
      user: { id: 'd', username: 'youruser@orbit.test', federationHomeOrphaned: true, homeInstance: 'orbit.test' } as User,
    });
    useInstanceStore.setState({ instances: [homeConn, detachedConn] });
    await maybeAutoReattach(detachedConn);
    expect((homeConn.api as unknown as { auth: { attachProof: ReturnType<typeof vi.fn> } }).auth.attachProof).not.toHaveBeenCalled();
    expect((detachedConn.api as unknown as { users: { reattach: ReturnType<typeof vi.fn> } }).users.reattach).not.toHaveBeenCalled();
  });

  it('mints the PORTLESS target host for a ported instance origin (matches server extractDomain)', async () => {
    // Both instances served on a non-443 port. The server binds/verifies the
    // proof against extractDomain(peer.origin) = new URL(origin).hostname, which
    // is portless — so the client must mint the portless host too, or the
    // exchange 401s forever. homeInstance is stored bare (portless hostname).
    const homeConn = makeInstance({
      origin: 'https://orbit.test:8443',
      username: 'youruser',
      user: { id: 'new-home-1', username: 'youruser' } as User,
    });
    const attachProof = vi.fn().mockResolvedValue({ token: 'a'.repeat(64) });
    (homeConn.api as unknown as { auth: { attachProof: typeof attachProof } }).auth.attachProof = attachProof;

    const updatedUser = { id: 'detached-1', username: 'youruser@orbit.test', federationHomeOrphaned: false, homeInstance: 'orbit.test' } as User;
    const reattach = vi.fn().mockResolvedValue({ success: true, user: updatedUser });
    const detachedConn = makeInstance({
      origin: 'https://nova.test:8443',
      user: { id: 'detached-1', username: 'youruser@orbit.test', federationHomeOrphaned: true, homeInstance: 'orbit.test' } as User,
    });
    (detachedConn.api as unknown as { users: { reattach: typeof reattach } }).users.reattach = reattach;

    useInstanceStore.setState({ instances: [homeConn, detachedConn] });
    await maybeAutoReattach(detachedConn);

    // Portless — 'nova.test', NOT 'nova.test:8443'.
    expect(attachProof).toHaveBeenCalledWith('nova.test');
    expect(reattach).toHaveBeenCalledWith({ token: 'a'.repeat(64) });
    const stored = useInstanceStore.getState().instances.find(i => i.origin === 'https://nova.test:8443')!;
    expect(stored.user.federationHomeOrphaned).toBe(false);
  });

  it('skips when the account is not detached', async () => {
    const conn = makeInstance({
      origin: 'https://nova.test',
      user: { id: 'd', username: 'youruser@orbit.test', federationHomeOrphaned: false, homeInstance: 'orbit.test' } as User,
    });
    useInstanceStore.setState({ instances: [conn] });
    await maybeAutoReattach(conn);
    expect((conn.api as unknown as { users: { reattach: ReturnType<typeof vi.fn> } }).users.reattach).not.toHaveBeenCalled();
  });

  it('skips when no home-domain session exists', async () => {
    const detachedConn = makeInstance({
      origin: 'https://nova.test',
      user: { id: 'd', username: 'youruser@orbit.test', federationHomeOrphaned: true, homeInstance: 'orbit.test' } as User,
    });
    useInstanceStore.setState({ instances: [detachedConn] });
    await maybeAutoReattach(detachedConn);
    expect((detachedConn.api as unknown as { users: { reattach: ReturnType<typeof vi.fn> } }).users.reattach).not.toHaveBeenCalled();
  });

  it('a failed exchange never throws and leaves the connection up', async () => {
    const homeConn = makeInstance({ origin: 'https://orbit.test', username: 'youruser', user: { id: 'h', username: 'youruser' } as User });
    (homeConn.api as unknown as { auth: { attachProof: ReturnType<typeof vi.fn> } }).auth.attachProof = vi.fn().mockRejectedValue(new Error('boom'));
    const detachedConn = makeInstance({
      origin: 'https://nova.test',
      user: { id: 'd', username: 'youruser@orbit.test', federationHomeOrphaned: true, homeInstance: 'orbit.test' } as User,
    });
    useInstanceStore.setState({ instances: [homeConn, detachedConn] });
    await expect(maybeAutoReattach(detachedConn)).resolves.toBeUndefined();
    const stored = useInstanceStore.getState().instances.find(i => i.origin === 'https://nova.test')!;
    expect(stored.status).toBe('connected');
    expect(stored.user.federationHomeOrphaned).toBe(true); // unchanged; manual path remains
  });
});
