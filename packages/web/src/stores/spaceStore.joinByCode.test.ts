import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// Stub instanceStore to avoid initialization ordering issues. `instances`
// is read on each call, so a test can add a connected remote.
const { instanceState } = vi.hoisted(() => ({
  instanceState: { instances: [] as Array<{ origin: string; status: string }>, _autoConnectDone: true },
}));
vi.mock('./instanceStore', () => ({
  useInstanceStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(instanceState),
    {
      getState: () => instanceState,
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

// Stub the api client; use vi.fn() inline (hoisting constraint). HttpError
// stays real: joinByCode reads the refusal's code from it.
vi.mock('../api/client', async (importOriginal) => ({
  HttpError: (await importOriginal<typeof import('../api/client')>()).HttpError,
  api: {
    spaces: { joinByCode: vi.fn(), invitePreview: vi.fn() },
  },
  BackspaceApiClient: vi.fn(),
}));

// Stub crossStoreResolvers — use vi.fn() inline
vi.mock('../utils/crossStoreResolvers', () => ({
  getApiForOrigin: vi.fn(),
  resolveOriginFromHostname: vi.fn(),
}));

// Import after mocks so we get the mocked versions
import { useSpaceStore } from './spaceStore';
import { api, HttpError } from '../api/client';
import { getApiForOrigin } from '../utils/crossStoreResolvers';
import { JoinRequestRequiredError } from '../utils/joinErrors';
import { NotConnectedError } from './spaceStore';

const FAKE_SPACE = {
  id: 'S1',
  name: 'Aether',
  icon: null,
  banner: null,
  _instanceOrigin: '',
  description: null,
  isPublic: false,
  isDiscoverable: false,
  ownerId: 'U1',
  createdAt: 1000,
  memberCount: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  instanceState.instances = [];
  useSpaceStore.getState().reset();
  (api.spaces.joinByCode as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_SPACE);
});

describe('spaceStore.joinByCode — origin normalization', () => {
  it('treats explicit home origin as local (does NOT call getApiForOrigin)', async () => {
    const homeOrigin = window.location.origin;
    await useSpaceStore.getState().joinByCode('abc', homeOrigin);
    expect(api.spaces.joinByCode).toHaveBeenCalledTimes(1);
    expect(getApiForOrigin).not.toHaveBeenCalled();
  });

  it('treats undefined origin as local (existing behavior preserved)', async () => {
    await useSpaceStore.getState().joinByCode('abc');
    expect(api.spaces.joinByCode).toHaveBeenCalledTimes(1);
    expect(getApiForOrigin).not.toHaveBeenCalled();
  });
});

describe('spaceStore.joinByCode: a code of a space joined by request', () => {
  const REMOTE = 'https://orbit.example';

  function refusal(details?: Record<string, string>): HttpError {
    return new HttpError(403, 'This space takes join requests', undefined, 'join_request_required', details);
  }

  it('throws JoinRequestRequiredError with the space id the server names', async () => {
    (api.spaces.joinByCode as ReturnType<typeof vi.fn>).mockRejectedValue(refusal({ spaceId: 'S-REQ' }));

    const err = await useSpaceStore.getState().joinByCode('abc').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(JoinRequestRequiredError);
    expect(err).toMatchObject({ spaceId: 'S-REQ', origin: '', code: 'join_request_required' });
    expect(api.spaces.invitePreview).not.toHaveBeenCalled();
    expect(useSpaceStore.getState().spaces).toHaveLength(0);
  });

  it('asks the invite preview for the id when an older instance names none', async () => {
    (api.spaces.joinByCode as ReturnType<typeof vi.fn>).mockRejectedValue(refusal());
    (api.spaces.invitePreview as ReturnType<typeof vi.fn>).mockResolvedValue({ spaceId: 'S-OLD' });

    const err = await useSpaceStore.getState().joinByCode('abc').catch((e: unknown) => e);

    expect(api.spaces.invitePreview).toHaveBeenCalledWith('abc');
    expect(err).toMatchObject({ spaceId: 'S-OLD', origin: '' });
  });

  it('keeps the original refusal when neither names the space', async () => {
    const original = refusal();
    (api.spaces.joinByCode as ReturnType<typeof vi.fn>).mockRejectedValue(original);
    (api.spaces.invitePreview as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));

    const err = await useSpaceStore.getState().joinByCode('abc').catch((e: unknown) => e);

    expect(err).toBe(original);
  });

  it('tags the refusal with the remote origin the code belongs to', async () => {
    instanceState.instances = [{ origin: REMOTE, status: 'connected' }];
    const remoteJoin = vi.fn().mockRejectedValue(refusal({ spaceId: 'R-REQ' }));
    (getApiForOrigin as ReturnType<typeof vi.fn>).mockReturnValue({ spaces: { joinByCode: remoteJoin } });

    const err = await useSpaceStore.getState().joinByCode('abc', REMOTE).catch((e: unknown) => e);

    expect(getApiForOrigin).toHaveBeenCalledWith(REMOTE);
    expect(err).toMatchObject({ spaceId: 'R-REQ', origin: REMOTE });
  });

  it('throws NotConnectedError for a remote origin without a session', async () => {
    const err = await useSpaceStore.getState().joinByCode('abc', REMOTE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotConnectedError);
    expect(api.spaces.joinByCode).not.toHaveBeenCalled();
  });

  it('passes any other refusal through unchanged', async () => {
    const banned = new HttpError(403, 'banned', undefined, 'user_banned');
    (api.spaces.joinByCode as ReturnType<typeof vi.fn>).mockRejectedValue(banned);

    const err = await useSpaceStore.getState().joinByCode('abc').catch((e: unknown) => e);

    expect(err).toBe(banned);
  });
});
