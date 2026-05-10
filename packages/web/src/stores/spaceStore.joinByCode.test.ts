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

// Stub instanceStore to avoid initialization ordering issues
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

// Stub the api client — use vi.fn() inline (hoisting constraint)
vi.mock('../api/client', () => ({
  api: {
    spaces: { joinByCode: vi.fn() },
  },
  BackspaceApiClient: vi.fn(),
}));

// Stub crossStoreResolvers — use vi.fn() inline
vi.mock('../utils/crossStoreResolvers', () => ({
  getApiForOrigin: vi.fn(),
  resolveOriginFromHostname: vi.fn(),
  resolveUserIdFromInstances: vi.fn(),
  getCachedUserIdForOrigin: vi.fn(),
  clearMyUserIdCache: vi.fn(),
  setOwnerInstanceForDmResolver: vi.fn(),
}));

// Import after mocks so we get the mocked versions
import { useSpaceStore } from './spaceStore';
import { api } from '../api/client';
import { getApiForOrigin } from '../utils/crossStoreResolvers';

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
