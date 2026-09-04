import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { User } from '@backspace/shared';
import type { BackspaceApiClient } from '../api/client';
import { HttpError } from '../api/client';

// ── Fixtures ────────────────────────────────────────────────────────────────
// Obvious fakes only. HOME_PASSWORD is the value that must never leave the
// user's home instance; ISSUED_SECRET is what the home instance hands out for
// the remote being connected to.
const HOME_PASSWORD = 'fake-home-password-do-not-leak';
const ISSUED_SECRET = 'fake-issued-secret-for-orbit';
const OTHER_SECRET = 'fake-issued-secret-for-zeta';

// ── Home-instance API (`api`) ───────────────────────────────────────────────
const verifyPassword = vi.fn(async (_password: string) => ({ valid: true }));
const federationCredential = vi.fn(
  async (data: { origin: string; markProvisioned?: boolean }) => ({
    origin: data.origin,
    secret: data.origin.includes('zeta') ? OTHER_SECRET : ISSUED_SECRET,
    provisioned: false,
  }),
);
const ensurePeered = vi.fn(async () => ({ peeringStatus: 'active' }));

// ── Target-instance API (built by `createApiClient`) ────────────────────────
const remoteRegister = vi.fn();
const remoteLogin = vi.fn();
const remoteInfo = vi.fn(async () => ({ name: 'Orbit' }));

// Keep the real exports: HttpError is what the store inspects on a failed
// remote registration.
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  api: {
    users: {
      verifyPassword: (password: string) => verifyPassword(password),
      federationCredential: (data: { origin: string; markProvisioned?: boolean }) =>
        federationCredential(data),
      update: vi.fn(async () => ({})),
      getFederationRegistry: vi.fn(async () => ({ registry: [], updatedAt: 0 })),
      putFederationRegistry: vi.fn(async () => ({ ok: true, updatedAt: 1 })),
      me: vi.fn(),
    },
    federation: { ensurePeered: () => ensurePeered() },
  },
  createApiClient: (origin: string) => ({
    auth: {
      register: (data: unknown) => remoteRegister(origin, data),
      login: (data: unknown) => remoteLogin(origin, data),
    },
    instance: { info: () => remoteInfo() },
    users: { reattach: vi.fn(), changePassword: vi.fn() },
    dm: { list: vi.fn(async () => []) },
  }),
}));

vi.mock('../hooks/useWebSocket', () => ({
  connectInstance: vi.fn(),
  disconnectInstance: vi.fn(),
  disconnectAllRemote: vi.fn(),
}));
vi.mock('../utils/dmOriginFailover', () => ({
  failoverDmOriginsFromDisconnected: vi.fn(),
}));
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

// Native (non-federated) primary user: the browsing instance IS the home.
const NATIVE_USER: Partial<User> = {
  id: 'user-1',
  username: 'erin',
  displayName: 'Erin',
  homeInstance: null,
  homeUserId: 'user-1',
  replicatedInstances: [],
};

// Mutable holder so a test can switch the session to a federated identity
// browsing somebody else's instance.
const session: { user: Partial<User> | null } = { user: NATIVE_USER };

vi.mock('./authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: session.user, token: 'tok' }),
    { getState: () => ({ user: session.user, token: 'tok' }), setState: vi.fn(), subscribe: vi.fn() },
  ),
}));

import { useInstanceStore, ensureRemoteCredential, DifferentPasswordError } from './instanceStore';
import type { ConnectedInstance } from './instanceStore';

const REMOTE = 'https://orbit.example';

/** Every password value this test harness saw arrive at a REMOTE instance. */
function passwordsSentToRemote(): string[] {
  const out: string[] = [];
  for (const call of remoteRegister.mock.calls) {
    const body = call[1] as { password?: string };
    if (typeof body?.password === 'string') out.push(body.password);
  }
  for (const call of remoteLogin.mock.calls) {
    const body = call[1] as { password?: string };
    if (typeof body?.password === 'string') out.push(body.password);
  }
  return out;
}

function authResponse(overrides: Partial<User> = {}) {
  return {
    token: 'remote-token-1',
    user: {
      id: 'remote-1',
      username: 'erin@nova.example',
      homeInstance: 'nova.example',
      homeUserId: 'user-1',
      ...overrides,
    } as User,
  };
}

beforeEach(() => {
  verifyPassword.mockClear();
  federationCredential.mockClear();
  ensurePeered.mockClear();
  remoteRegister.mockReset();
  remoteLogin.mockReset();
  remoteInfo.mockClear();
  localStorage.clear();
  session.user = NATIVE_USER;
  useInstanceStore.setState({
    instances: [], registry: new Map(), registryUpdatedAt: 0,
    _autoConnectDone: false, _registrySyncReady: false, isLoading: false, error: null,
  });
  // jsdom's default location is http://localhost:3000 — make it the user's home.
  Object.defineProperty(window, 'location', {
    value: new URL('https://nova.example/'),
    writable: true,
  });
});

describe('connectToRemote never hands the home password to a remote instance', () => {
  it('registers on the remote with the home-issued secret, not the home password', async () => {
    remoteRegister.mockResolvedValue(authResponse());

    await useInstanceStore.getState().connectToRemote(REMOTE, HOME_PASSWORD, 'Erin');

    // Positive control: the harness DOES observe passwords that reach a remote.
    expect(passwordsSentToRemote()).toContain(ISSUED_SECRET);
    // The regression: the home password is not among them.
    expect(passwordsSentToRemote()).not.toContain(HOME_PASSWORD);
    expect(federationCredential).toHaveBeenCalledWith({ origin: REMOTE });
  });

  it('verifies the entered password against the home instance only', async () => {
    remoteRegister.mockResolvedValue(authResponse());
    await useInstanceStore.getState().connectToRemote(REMOTE, HOME_PASSWORD, 'Erin');
    expect(verifyPassword).toHaveBeenCalledWith(HOME_PASSWORD);
  });

  it('falls back to login with the issued secret when the account already exists', async () => {
    remoteRegister.mockRejectedValue(
      new HttpError(409, 'Username is already taken', { error: 'Username is already taken', code: 'username_taken', statusCode: 409 }, 'username_taken'),
    );
    remoteLogin.mockResolvedValue(authResponse());

    await useInstanceStore.getState().connectToRemote(REMOTE, HOME_PASSWORD, 'Erin');

    expect(remoteLogin).toHaveBeenCalledWith(REMOTE, {
      username: 'erin@nova.example',
      password: ISSUED_SECRET,
    });
    expect(passwordsSentToRemote()).not.toContain(HOME_PASSWORD);
  });

  it('never retries a failed remote login with the home password', async () => {
    remoteRegister.mockRejectedValue(
      new HttpError(409, 'Username is already taken', { error: 'Username is already taken', code: 'username_taken', statusCode: 409 }, 'username_taken'),
    );
    remoteLogin.mockRejectedValue(new Error('Invalid username or password'));

    await expect(
      useInstanceStore.getState().connectToRemote(REMOTE, HOME_PASSWORD, 'Erin'),
    ).rejects.toBeInstanceOf(DifferentPasswordError);

    expect(passwordsSentToRemote()).not.toContain(HOME_PASSWORD);
  });

  it('marks the credential provisioned once the remote account uses it', async () => {
    remoteRegister.mockResolvedValue(authResponse());
    await useInstanceStore.getState().connectToRemote(REMOTE, HOME_PASSWORD, 'Erin');
    expect(federationCredential).toHaveBeenCalledWith({ origin: REMOTE, markProvisioned: true });
  });

  it('POSITIVE CONTROL: connecting to the account\'s OWN home still uses the real password', async () => {
    remoteLogin.mockResolvedValue({
      token: 'home-token', user: { id: 'user-1', username: 'erin' } as User,
    });

    await useInstanceStore.getState().connectToRemote('https://nova.example', HOME_PASSWORD);

    expect(remoteLogin).toHaveBeenCalledWith('https://nova.example', {
      username: 'erin', password: HOME_PASSWORD,
    });
    // ...and no per-remote credential is minted for one's own home instance.
    expect(federationCredential).not.toHaveBeenCalled();
  });
});

describe('ensureRemoteCredential (legacy connection migration)', () => {
  function makeInstance(overrides: Partial<ConnectedInstance> = {}): ConnectedInstance {
    const changePassword = vi.fn(async () => ({ token: 'rotated-token' }));
    return {
      origin: REMOTE,
      label: 'Orbit',
      token: 'old-token',
      username: 'erin@nova.example',
      status: 'connected',
      user: {
        id: 'remote-1', username: 'erin@nova.example',
        homeInstance: 'nova.example', homeUserId: 'user-1',
      } as User,
      api: { users: { changePassword } } as unknown as BackspaceApiClient,
      ...overrides,
    };
  }

  it('rotates an unprovisioned remote account onto the home-issued secret', async () => {
    const inst = makeInstance();
    useInstanceStore.setState({ instances: [inst] });

    await ensureRemoteCredential(inst);

    const changePassword = (inst.api as unknown as {
      users: { changePassword: ReturnType<typeof vi.fn> };
    }).users.changePassword;
    expect(changePassword).toHaveBeenCalledWith({ newPassword: ISSUED_SECRET });
    expect(federationCredential).toHaveBeenCalledWith({ origin: REMOTE, markProvisioned: true });
    expect(useInstanceStore.getState().instances[0]!.token).toBe('rotated-token');
  });

  it('does nothing when the home instance already recorded the account as provisioned', async () => {
    federationCredential.mockResolvedValueOnce({
      origin: REMOTE, secret: ISSUED_SECRET, provisioned: true,
    });
    const inst = makeInstance();
    useInstanceStore.setState({ instances: [inst] });

    await ensureRemoteCredential(inst);

    const changePassword = (inst.api as unknown as {
      users: { changePassword: ReturnType<typeof vi.fn> };
    }).users.changePassword;
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('force rotates even a provisioned account (post explicit login)', async () => {
    federationCredential.mockResolvedValueOnce({
      origin: REMOTE, secret: ISSUED_SECRET, provisioned: true,
    });
    const inst = makeInstance();
    useInstanceStore.setState({ instances: [inst] });

    await ensureRemoteCredential(inst, { force: true });

    const changePassword = (inst.api as unknown as {
      users: { changePassword: ReturnType<typeof vi.fn> };
    }).users.changePassword;
    expect(changePassword).toHaveBeenCalledWith({ newPassword: ISSUED_SECRET });
  });

  it('refuses to touch an account on the remote that is not our federated identity', async () => {
    // A native account on the remote (no homeInstance) — rotating its password
    // would hijack somebody else's credential.
    const inst = makeInstance({
      user: { id: 'native-9', username: 'someone-else', homeInstance: null } as User,
    });
    useInstanceStore.setState({ instances: [inst] });

    await ensureRemoteCredential(inst, { force: true });

    const changePassword = (inst.api as unknown as {
      users: { changePassword: ReturnType<typeof vi.fn> };
    }).users.changePassword;
    expect(changePassword).not.toHaveBeenCalled();
    expect(federationCredential).not.toHaveBeenCalled();
  });

  it('refuses when the remote account is homed elsewhere or is a different user', async () => {
    const wrongHome = makeInstance({
      user: {
        id: 'r', username: 'erin@other.example',
        homeInstance: 'other.example', homeUserId: 'user-1',
      } as User,
    });
    const wrongUser = makeInstance({
      user: {
        id: 'r', username: 'erin@nova.example',
        homeInstance: 'nova.example', homeUserId: 'someone-else-id',
      } as User,
    });

    await ensureRemoteCredential(wrongHome, { force: true });
    await ensureRemoteCredential(wrongUser, { force: true });

    expect(federationCredential).not.toHaveBeenCalled();
  });

  it('never rotates the account on the user\'s own home instance', async () => {
    const homeInst = makeInstance({ origin: 'https://nova.example' });
    await ensureRemoteCredential(homeInst, { force: true });
    expect(federationCredential).not.toHaveBeenCalled();
  });
});

describe('credentials are always issued by the account\'s TRUE home instance', () => {
  const FEDERATED_USER: Partial<User> = {
    id: 'orbit-local-9',
    username: 'erin@nova.example',
    displayName: 'Erin',
    homeInstance: 'nova.example',
    homeUserId: 'user-1',
    replicatedInstances: [],
  };

  beforeEach(() => {
    // Browsing orbit as erin@nova.
    session.user = FEDERATED_USER;
    Object.defineProperty(window, 'location', {
      value: new URL('https://orbit.example/'),
      writable: true,
    });
  });

  it('mints the secret on the home connection, never on the instance being browsed', async () => {
    const homeCredential = vi.fn(async (data: { origin: string; markProvisioned?: boolean }) => ({
      origin: data.origin, secret: ISSUED_SECRET, provisioned: false,
    }));
    const homeVerify = vi.fn(async () => ({ valid: true }));
    const homeConnection: ConnectedInstance = {
      origin: 'https://nova.example',
      label: 'Nova',
      token: 'home-token',
      username: 'erin',
      status: 'connected',
      user: { id: 'user-1', username: 'erin' } as User,
      api: {
        users: { verifyPassword: homeVerify, federationCredential: homeCredential },
      } as unknown as BackspaceApiClient,
    };
    useInstanceStore.setState({ instances: [homeConnection] });
    remoteRegister.mockResolvedValue(authResponse());

    await useInstanceStore.getState().connectToRemote('https://zeta.example', HOME_PASSWORD);

    expect(homeVerify).toHaveBeenCalledWith(HOME_PASSWORD);
    expect(homeCredential).toHaveBeenCalledWith({ origin: 'https://zeta.example' });
    // The instance we are browsing is NOT asked for anything.
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(federationCredential).not.toHaveBeenCalled();
    expect(passwordsSentToRemote()).not.toContain(HOME_PASSWORD);
  });

  it('refuses to connect rather than mint a divergent secret when home is offline', async () => {
    await expect(
      useInstanceStore.getState().connectToRemote('https://zeta.example', HOME_PASSWORD),
    ).rejects.toThrow(/home instance/i);

    expect(federationCredential).not.toHaveBeenCalled();
    expect(remoteRegister).not.toHaveBeenCalled();
    expect(remoteLogin).not.toHaveBeenCalled();
  });
});

describe('every path that establishes a remote session reconciles the credential', () => {
  it('reconnectInstance migrates a legacy connection using the still-valid token', async () => {
    const changePassword = vi.fn(async () => ({ token: 'rotated-token' }));
    const legacy: ConnectedInstance = {
      origin: REMOTE,
      label: 'Orbit',
      token: 'still-valid-token',
      username: 'erin@nova.example',
      status: 'error',
      user: {
        id: 'remote-1', username: 'erin@nova.example',
        homeInstance: 'nova.example', homeUserId: 'user-1',
      } as User,
      api: {
        users: {
          me: vi.fn(async () => ({
            id: 'remote-1', username: 'erin@nova.example',
            homeInstance: 'nova.example', homeUserId: 'user-1',
          } as User)),
          changePassword,
        },
        instance: { info: remoteInfo },
      } as unknown as BackspaceApiClient,
    };
    useInstanceStore.setState({ instances: [legacy], _autoConnectDone: true, _registrySyncReady: false });

    await useInstanceStore.getState().reconnectInstance(REMOTE);
    // The reconciliation is fire-and-forget — let its promise chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(changePassword).toHaveBeenCalledWith({ newPassword: ISSUED_SECRET });
    expect(federationCredential).toHaveBeenCalledWith({ origin: REMOTE, markProvisioned: true });
  });
});
