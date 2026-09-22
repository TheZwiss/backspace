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

vi.mock('./instanceStore', () => {
  const subscribe = (listener: (state: { _autoConnectDone: boolean }) => void) => {
    subscribers.push(listener);
    return () => {
      const at = subscribers.indexOf(listener);
      if (at >= 0) subscribers.splice(at, 1);
    };
  };
  return {
    useInstanceStore: Object.assign(
      (selector: (s: unknown) => unknown) => selector(instanceState),
      { getState: () => instanceState, setState: vi.fn(), subscribe },
    ),
    // The real helper's contract against the mocked store: resolve at once
    // when done, otherwise on the flip, and drop the subscription after.
    waitForAutoConnect: () => {
      if (instanceState._autoConnectDone) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const unsub = subscribe((state) => {
          if (state._autoConnectDone) {
            unsub();
            resolve();
          }
        });
      });
    },
  };
});

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

describe('exploreStore origin resolution', () => {
  it('rejects a public join for an origin the session does not hold, without touching home', async () => {
    instanceState.instances = [];

    await expect(
      useExploreStore.getState().publicJoin(makeSpace({ id: 's3', _instanceOrigin: 'https://gone.example' })),
    ).rejects.toThrow('Not connected to gone.example');

    expect(homeApi.explore.publicJoin).not.toHaveBeenCalled();
  });

  it('rejects a join request for an origin the session does not hold, without touching home', async () => {
    instanceState.instances = [];

    await expect(
      useExploreStore.getState().requestJoin(makeSpace({ id: 's3', _instanceOrigin: 'https://gone.example' }), 'hi'),
    ).rejects.toThrow('Not connected to gone.example');

    expect(homeApi.explore.requestJoin).not.toHaveBeenCalled();
    expect(useExploreStore.getState().myRequests).toEqual([]);
  });

  it('still routes the empty origin to home', async () => {
    homeApi.explore.requestJoin.mockResolvedValue(makeRequest({ id: 'home-r', spaceId: 's1' }));

    await useExploreStore.getState().requestJoin(makeSpace({ id: 's1', _instanceOrigin: '' }));

    expect(homeApi.explore.requestJoin).toHaveBeenCalledWith('s1', undefined);
  });
});

describe('exploreStore.fetchSpaces', () => {
  it('records the query the spaces on hand answer, when they arrive', async () => {
    homeApi.explore.list.mockResolvedValue({ spaces: [], total: 0, totalAll: 0, discoveryEnabled: true });

    await useExploreStore.getState().fetchSpaces('nebula');
    expect(useExploreStore.getState().resultsQuery).toBe('nebula');

    // The empty search is the empty string, not the absent one: the copy that
    // reads this distinguishes "nothing matched" from "nothing to show".
    await useExploreStore.getState().fetchSpaces();
    expect(useExploreStore.getState().resultsQuery).toBe('');
  });

  it('leaves the recorded query alone when every instance refuses', async () => {
    homeApi.explore.list.mockResolvedValue({ spaces: [], total: 0, totalAll: 0, discoveryEnabled: true });
    await useExploreStore.getState().fetchSpaces('nebula');

    homeApi.explore.list.mockRejectedValue(new Error('down'));
    await useExploreStore.getState().fetchSpaces('orbit');

    // Nothing arrived, so the spaces on screen still answer the old query.
    expect(useExploreStore.getState().resultsQuery).toBe('nebula');
    expect(useExploreStore.getState().error).not.toBeNull();
  });

  it('records a fan-out nobody answered as a state, not as a sentence', async () => {
    // Once, not for good: a standing rejection outlives `clearAllMocks` and
    // turns the next test's first call into a rejection nobody is waiting on.
    homeApi.explore.list.mockRejectedValueOnce(new Error('down'));

    await useExploreStore.getState().fetchSpaces();

    // The words for this are the Explore page's, in the reader's language.
    expect(useExploreStore.getState().error).toEqual({ kind: 'none_answered' });
    expect(useExploreStore.getState().isLoading).toBe(false);
  });

  it('keeps the cause when the fan-out itself could not run', async () => {
    // Nothing is in flight in this state: the instance list is read before
    // the first client is asked for anything, so the throw leaves the try
    // block with no request to abandon.
    instanceState.instances = undefined as unknown as typeof instanceState.instances;

    await useExploreStore.getState().fetchSpaces();

    const { error, isLoading } = useExploreStore.getState();
    expect(error).toMatchObject({ kind: 'failed' });
    expect((error as { kind: 'failed'; cause: unknown }).cause).toBeInstanceOf(TypeError);
    expect(isLoading).toBe(false);
  });
});

describe('exploreStore.fetchMyRequests sequencing', () => {
  /** See the note in the fetchSpaces sequencing suite. */
  const reachedTheClients = () => new Promise((resolve) => { setTimeout(resolve, 0); });

  it('a slow earlier fan-out does not overwrite a fast later one', async () => {
    // On `main` this was one call to home. The branch made it a fan-out over
    // every connected instance, so it lasts as long as its slowest member,
    // and the page calls it on mount, on every search and on every change to
    // the connected set. An overtaken answer leaves a card reading "Request
    // Pending" that is not, or missing one that is.
    let releaseSlow: () => void = () => {};
    homeApi.explore.myJoinRequests.mockImplementationOnce(
      () => new Promise((resolve) => { releaseSlow = () => resolve({ requests: [makeRequest({ id: 'slow' })] }); }),
    );
    homeApi.explore.myJoinRequests.mockImplementationOnce(async () => ({ requests: [makeRequest({ id: 'fast' })] }));

    const slow = useExploreStore.getState().fetchMyRequests();
    const fast = useExploreStore.getState().fetchMyRequests();
    await reachedTheClients();
    await fast;

    expect(useExploreStore.getState().myRequests.map((r) => r.id)).toEqual(['fast']);

    releaseSlow();
    await slow;

    expect(useExploreStore.getState().myRequests.map((r) => r.id)).toEqual(['fast']);
  });
});

describe('exploreStore.fetchSpaces sequencing', () => {
  function answer(spaces: { id: string }[]) {
    return { spaces, total: spaces.length, totalAll: spaces.length, discoveryEnabled: true };
  }

  /**
   * Let every started fan-out reach its request. `fetchSpaces` awaits
   * `waitForAutoConnect` before it calls a client, so until the microtask
   * queue drains the mocks below have not been entered and the handles that
   * settle them do not exist yet.
   */
  const reachedTheClients = () => new Promise((resolve) => { setTimeout(resolve, 0); });

  it('a slow earlier fan-out does not overwrite a fast later one', async () => {
    // The Explore search box drives this store and `directoryStore` from one
    // debounce. Without the guard the Inner list settles on whichever answer
    // arrives last, which on a slow instance is the query the user already
    // moved on from, and the two halves of the page disagree.
    let releaseSlow: () => void = () => {};
    homeApi.explore.list.mockImplementationOnce(
      () => new Promise((resolve) => { releaseSlow = () => resolve(answer([{ id: 'slow' }])); }),
    );
    homeApi.explore.list.mockImplementationOnce(async () => answer([{ id: 'fast' }]));

    const slow = useExploreStore.getState().fetchSpaces('slow');
    const fast = useExploreStore.getState().fetchSpaces('fast');
    await fast;

    expect(useExploreStore.getState().spaces.map((s) => s.id)).toEqual(['fast']);
    expect(useExploreStore.getState().resultsQuery).toBe('fast');

    releaseSlow();
    await slow;

    expect(useExploreStore.getState().spaces.map((s) => s.id)).toEqual(['fast']);
    expect(useExploreStore.getState().resultsQuery).toBe('fast');
    expect(useExploreStore.getState().isLoading).toBe(false);
  });

  it('a superseded fan-out that fails says nothing and leaves the spinner alone', async () => {
    let refuseSlow: () => void = () => {};
    homeApi.explore.list.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { refuseSlow = () => reject(new Error('down')); }),
    );
    let releaseFast: () => void = () => {};
    homeApi.explore.list.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFast = () => resolve(answer([{ id: 'fast' }])); }),
    );

    const slow = useExploreStore.getState().fetchSpaces('slow');
    const fast = useExploreStore.getState().fetchSpaces('fast');
    await reachedTheClients();

    refuseSlow();
    await slow;

    // The newer fan-out is still running: its spinner is not the old one's to
    // take down, and its list is not the old one's to blame.
    expect(useExploreStore.getState().error).toBeNull();
    expect(useExploreStore.getState().isLoading).toBe(true);

    releaseFast();
    await fast;

    expect(useExploreStore.getState().spaces.map((s) => s.id)).toEqual(['fast']);
    expect(useExploreStore.getState().isLoading).toBe(false);
  });

  it('reset orphans whatever is in flight', async () => {
    let release: () => void = () => {};
    homeApi.explore.list.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve(answer([{ id: 'late' }])); }),
    );

    const pending = useExploreStore.getState().fetchSpaces('late');
    await reachedTheClients();
    useExploreStore.getState().reset();
    release();
    await pending;

    // The answer belongs to the session that ended; nothing from it lands.
    expect(useExploreStore.getState().spaces).toEqual([]);
    expect(useExploreStore.getState().isLoading).toBe(false);
    expect(useExploreStore.getState().resultsQuery).toBe('');
  });
});
