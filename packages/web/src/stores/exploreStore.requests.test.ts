import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JoinRequest } from '@backspace/shared';

// exploreStore fans `fetchMyRequests` out over the home client plus every
// connected instance's client, so the test controls both through hoisted
// mocks: `homeApi` is what `../api/client` exports and `instanceState` is
// what the instanceStore mock hands back.
const { homeApi, instanceState, subscribers } = vi.hoisted(() => ({
  homeApi: {
    explore: {
      myJoinRequests: vi.fn<(status?: string) => Promise<{ requests: JoinRequest[] }>>(),
      requestJoin: vi.fn<(spaceId: string, message?: string) => Promise<JoinRequest>>(),
      publicJoin: vi.fn(),
      list: vi.fn(),
    },
  },
  instanceState: {
    instances: [] as Array<{
      origin: string;
      status: 'connected' | 'connecting' | 'disconnected' | 'error';
      api: { explore: { myJoinRequests: ReturnType<typeof vi.fn>; requestJoin: ReturnType<typeof vi.fn> } };
    }>,
    _autoConnectDone: true,
  },
  subscribers: [] as Array<(state: { _autoConnectDone: boolean }) => void>,
}));

vi.mock('../api/client', () => ({
  api: homeApi,
  BackspaceApiClient: vi.fn(),
}));

vi.mock('./instanceStore', () => ({
  useInstanceStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(instanceState),
    {
      getState: () => instanceState,
      setState: vi.fn(),
      subscribe: (listener: (state: { _autoConnectDone: boolean }) => void) => {
        subscribers.push(listener);
        return () => {
          const at = subscribers.indexOf(listener);
          if (at >= 0) subscribers.splice(at, 1);
        };
      },
    },
  ),
}));

// spaceStore pulls in AudioManager and the rest of the app; the requests
// path never touches it, so a stub with the one method publicJoin uses is enough.
vi.mock('./spaceStore', () => ({
  useSpaceStore: {
    getState: () => ({ addSpaceFromReady: vi.fn() }),
  },
}));

import { useExploreStore, type TaggedExploreSpace } from './exploreStore';

function makeRequest(overrides: Partial<JoinRequest> = {}): JoinRequest {
  return {
    id: 'r1',
    spaceId: 's1',
    userId: 'u1',
    message: null,
    status: 'pending',
    decidedBy: null,
    createdAt: 0,
    decidedAt: null,
    ...overrides,
  };
}

function makeInstance(origin: string, status: 'connected' | 'connecting' | 'disconnected' | 'error' = 'connected') {
  return {
    origin,
    status,
    api: {
      explore: {
        myJoinRequests: vi.fn(),
        requestJoin: vi.fn(),
      },
    },
  };
}

function makeSpace(overrides: Partial<TaggedExploreSpace> = {}): TaggedExploreSpace {
  return {
    id: 's1',
    name: 'Test Space',
    icon: null,
    banner: null,
    avatarColor: null,
    description: null,
    visibility: 'request',
    memberCount: 3,
    createdAt: 0,
    joined: false,
    _instanceOrigin: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  instanceState.instances = [];
  instanceState._autoConnectDone = true;
  subscribers.length = 0;
  useExploreStore.getState().reset();
});

describe('exploreStore.fetchMyRequests', () => {
  it('queries home plus every connected instance and tags each result with its origin', async () => {
    const remote = makeInstance('https://chat.example.org');
    const idle = makeInstance('https://idle.example.org', 'disconnected');
    instanceState.instances = [remote, idle];
    homeApi.explore.myJoinRequests.mockResolvedValue({ requests: [makeRequest({ id: 'home-r', spaceId: 's1' })] });
    remote.api.explore.myJoinRequests.mockResolvedValue({ requests: [makeRequest({ id: 'remote-r', spaceId: 's1' })] });

    await useExploreStore.getState().fetchMyRequests();

    expect(homeApi.explore.myJoinRequests).toHaveBeenCalledWith('pending');
    expect(remote.api.explore.myJoinRequests).toHaveBeenCalledWith('pending');
    expect(idle.api.explore.myJoinRequests).not.toHaveBeenCalled();

    const { myRequests } = useExploreStore.getState();
    expect(myRequests).toHaveLength(2);
    expect(myRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'home-r', spaceId: 's1', _instanceOrigin: '' }),
      expect.objectContaining({ id: 'remote-r', spaceId: 's1', _instanceOrigin: 'https://chat.example.org' }),
    ]));
  });

  it('keeps the home results when a remote call rejects', async () => {
    const remote = makeInstance('https://chat.example.org');
    instanceState.instances = [remote];
    homeApi.explore.myJoinRequests.mockResolvedValue({ requests: [makeRequest({ id: 'home-r' })] });
    remote.api.explore.myJoinRequests.mockRejectedValue(new Error('remote down'));

    await expect(useExploreStore.getState().fetchMyRequests()).resolves.toBeUndefined();

    const { myRequests } = useExploreStore.getState();
    expect(myRequests).toHaveLength(1);
    expect(myRequests[0]).toMatchObject({ id: 'home-r', _instanceOrigin: '' });
  });

  it('waits for auto-connect before fanning out, so a reload sees the full instance list', async () => {
    const remote = makeInstance('https://chat.example.org');
    instanceState.instances = [remote];
    instanceState._autoConnectDone = false;
    homeApi.explore.myJoinRequests.mockResolvedValue({ requests: [] });
    remote.api.explore.myJoinRequests.mockResolvedValue({ requests: [makeRequest({ id: 'remote-r' })] });

    const pending = useExploreStore.getState().fetchMyRequests();
    await Promise.resolve();
    expect(homeApi.explore.myJoinRequests).not.toHaveBeenCalled();
    expect(subscribers).toHaveLength(1);

    instanceState._autoConnectDone = true;
    for (const listener of [...subscribers]) listener(instanceState);
    await pending;

    expect(subscribers).toHaveLength(0);
    expect(remote.api.explore.myJoinRequests).toHaveBeenCalledWith('pending');
    expect(useExploreStore.getState().myRequests).toEqual([
      expect.objectContaining({ id: 'remote-r', _instanceOrigin: 'https://chat.example.org' }),
    ]);
  });

  it('leaves the list untouched when every instance rejects', async () => {
    const remote = makeInstance('https://chat.example.org');
    instanceState.instances = [remote];
    useExploreStore.setState({ myRequests: [{ ...makeRequest({ id: 'stale' }), _instanceOrigin: '' }] });
    homeApi.explore.myJoinRequests.mockRejectedValue(new Error('home down'));
    remote.api.explore.myJoinRequests.mockRejectedValue(new Error('remote down'));

    await expect(useExploreStore.getState().fetchMyRequests()).resolves.toBeUndefined();

    expect(useExploreStore.getState().myRequests).toEqual([
      expect.objectContaining({ id: 'stale', _instanceOrigin: '' }),
    ]);
  });
});

describe('exploreStore.requestJoin', () => {
  it('tags the appended request with the space origin', async () => {
    const remote = makeInstance('https://chat.example.org');
    instanceState.instances = [remote];
    remote.api.explore.requestJoin.mockResolvedValue(makeRequest({ id: 'remote-r', spaceId: 's9' }));

    const request = await useExploreStore.getState().requestJoin(
      makeSpace({ id: 's9', _instanceOrigin: 'https://chat.example.org' }),
      'hello',
    );

    expect(remote.api.explore.requestJoin).toHaveBeenCalledWith('s9', 'hello');
    expect(homeApi.explore.requestJoin).not.toHaveBeenCalled();
    expect(request.id).toBe('remote-r');
    expect(useExploreStore.getState().myRequests).toEqual([
      expect.objectContaining({ id: 'remote-r', spaceId: 's9', _instanceOrigin: 'https://chat.example.org' }),
    ]);
  });

  it('tags a home request with the empty origin', async () => {
    homeApi.explore.requestJoin.mockResolvedValue(makeRequest({ id: 'home-r', spaceId: 's1' }));

    await useExploreStore.getState().requestJoin(makeSpace({ id: 's1', _instanceOrigin: '' }));

    expect(homeApi.explore.requestJoin).toHaveBeenCalledWith('s1', undefined);
    expect(useExploreStore.getState().myRequests).toEqual([
      expect.objectContaining({ id: 'home-r', spaceId: 's1', _instanceOrigin: '' }),
    ]);
  });
});
