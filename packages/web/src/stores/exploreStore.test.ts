import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExploreSpace } from '@backspace/shared';

// `fetchSpaces` fans out over the home client plus every connected instance's
// client, so the test owns both: `homeApi` is what `../api/client` exports and
// `instanceState` is what the instanceStore mock hands back.
const { homeApi, instanceState } = vi.hoisted(() => ({
  homeApi: {
    explore: {
      list: vi.fn(),
      myJoinRequests: vi.fn(),
      requestJoin: vi.fn(),
      publicJoin: vi.fn(),
    },
  },
  instanceState: {
    instances: [] as Array<{
      origin: string;
      status: 'connected' | 'connecting' | 'disconnected' | 'error';
      api: { explore: { list: ReturnType<typeof vi.fn> } };
    }>,
    _autoConnectDone: true,
  },
}));

vi.mock('../api/client', () => ({
  api: homeApi,
  BackspaceApiClient: vi.fn(),
}));

vi.mock('./instanceStore', () => ({
  useInstanceStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(instanceState),
    { getState: () => instanceState, setState: vi.fn(), subscribe: vi.fn(() => () => {}) },
  ),
  waitForAutoConnect: () => Promise.resolve(),
}));

// spaceStore pulls in AudioManager and the rest of the app; nothing on the
// fan-out path touches it.
vi.mock('./spaceStore', () => ({
  useSpaceStore: {
    getState: () => ({ addSpaceFromReady: vi.fn() }),
  },
}));

import { useExploreStore } from './exploreStore';

function makeSpace(id: string): ExploreSpace {
  return {
    id,
    name: id,
    icon: null,
    banner: null,
    avatarColor: null,
    description: null,
    visibility: 'public',
    memberCount: 1,
    createdAt: 0,
    joined: false,
  };
}

function answer(ids: string[]) {
  const spaces = ids.map(makeSpace);
  return { spaces, total: spaces.length, totalAll: spaces.length, discoveryEnabled: true };
}

function makeInstance(origin: string) {
  return {
    origin,
    status: 'connected' as const,
    api: { explore: { list: vi.fn() } },
  };
}

/**
 * Let a started fan-out reach its clients: `fetchSpaces` awaits
 * `waitForAutoConnect` first, so until the microtask queue drains the mocks
 * have not been entered and the handles that settle them do not exist yet.
 */
const reachedTheClients = () => new Promise((resolve) => { setTimeout(resolve, 0); });

beforeEach(() => {
  vi.clearAllMocks();
  instanceState.instances = [];
  instanceState._autoConnectDone = true;
  useExploreStore.getState().reset();
});

describe('exploreStore.fetchSpaces unanswered instances', () => {
  it('publishes what answered and names what did not', async () => {
    // The defect this covers: with one instance of two down, the page showed
    // the survivor's spaces and said nothing, and a space known to be on the
    // missing instance read as deleted.
    const remote = makeInstance('https://kobold.example.net');
    instanceState.instances = [remote];
    homeApi.explore.list.mockResolvedValue(answer(['home-space']));
    remote.api.explore.list.mockRejectedValue(new Error('down'));

    await useExploreStore.getState().fetchSpaces();

    const { spaces, unansweredOrigins, error } = useExploreStore.getState();
    expect(spaces.map((s) => s.id)).toEqual(['home-space']);
    expect(unansweredOrigins).toEqual(['https://kobold.example.net']);
    expect(error).toBeNull();
  });

  it('names home by the empty origin when home is the one that did not answer', async () => {
    const remote = makeInstance('https://kobold.example.net');
    instanceState.instances = [remote];
    homeApi.explore.list.mockRejectedValue(new Error('down'));
    remote.api.explore.list.mockResolvedValue(answer(['remote-space']));

    await useExploreStore.getState().fetchSpaces();

    const { spaces, unansweredOrigins } = useExploreStore.getState();
    expect(spaces.map((s) => s.id)).toEqual(['remote-space']);
    expect(unansweredOrigins).toEqual(['']);
  });

  it('leaves the list empty when nobody answered, and says that instead', async () => {
    // The all-rejected case is its own state: no list to qualify, so no
    // partial notice either. The two are never on screen together.
    const remote = makeInstance('https://kobold.example.net');
    instanceState.instances = [remote];
    homeApi.explore.list.mockRejectedValue(new Error('down'));
    remote.api.explore.list.mockRejectedValue(new Error('down'));

    await useExploreStore.getState().fetchSpaces();

    const { error, unansweredOrigins, spaces } = useExploreStore.getState();
    expect(error).toEqual({ kind: 'none_answered' });
    expect(unansweredOrigins).toEqual([]);
    expect(spaces).toEqual([]);
  });

  it('records nothing when every instance answered', async () => {
    const remote = makeInstance('https://kobold.example.net');
    instanceState.instances = [remote];
    homeApi.explore.list.mockResolvedValue(answer(['home-space']));
    remote.api.explore.list.mockResolvedValue(answer(['remote-space']));

    await useExploreStore.getState().fetchSpaces();

    const { spaces, unansweredOrigins } = useExploreStore.getState();
    expect(spaces.map((s) => s.id).sort()).toEqual(['home-space', 'remote-space']);
    expect(unansweredOrigins).toEqual([]);
  });

  it('clears a previous fan-out\'s unanswered instances when the next one starts', async () => {
    const remote = makeInstance('https://kobold.example.net');
    instanceState.instances = [remote];
    homeApi.explore.list.mockResolvedValue(answer(['home-space']));
    remote.api.explore.list.mockRejectedValueOnce(new Error('down'));

    await useExploreStore.getState().fetchSpaces();
    expect(useExploreStore.getState().unansweredOrigins).toEqual(['https://kobold.example.net']);

    remote.api.explore.list.mockResolvedValue(answer(['remote-space']));
    const pending = useExploreStore.getState().fetchSpaces();
    // Cleared at the start of the fetch, not when it lands: the notice must
    // not outlive the list it describes.
    expect(useExploreStore.getState().unansweredOrigins).toEqual([]);
    await pending;
    expect(useExploreStore.getState().unansweredOrigins).toEqual([]);
  });

  it('a superseded fan-out writes neither the spaces nor the unanswered instances', async () => {
    // One search box drives this store; a slow instance makes the earlier
    // fan-out land last. Its list is not the current one, so neither is the
    // notice that qualifies it.
    const remote = makeInstance('https://kobold.example.net');
    instanceState.instances = [remote];

    let releaseSlow: () => void = () => {};
    homeApi.explore.list.mockImplementationOnce(
      () => new Promise((resolve) => { releaseSlow = () => resolve(answer(['slow'])); }),
    );
    remote.api.explore.list.mockRejectedValueOnce(new Error('down'));

    const slow = useExploreStore.getState().fetchSpaces('slow');
    await reachedTheClients();

    homeApi.explore.list.mockResolvedValueOnce(answer(['fast']));
    remote.api.explore.list.mockResolvedValueOnce(answer([]));
    const fast = useExploreStore.getState().fetchSpaces('fast');
    await fast;

    expect(useExploreStore.getState().spaces.map((s) => s.id)).toEqual(['fast']);
    expect(useExploreStore.getState().unansweredOrigins).toEqual([]);

    releaseSlow();
    await slow;

    expect(useExploreStore.getState().spaces.map((s) => s.id)).toEqual(['fast']);
    expect(useExploreStore.getState().unansweredOrigins).toEqual([]);
  });

  it('reset clears the unanswered instances', async () => {
    const remote = makeInstance('https://kobold.example.net');
    instanceState.instances = [remote];
    homeApi.explore.list.mockResolvedValue(answer(['home-space']));
    remote.api.explore.list.mockRejectedValue(new Error('down'));

    await useExploreStore.getState().fetchSpaces();
    expect(useExploreStore.getState().unansweredOrigins).toEqual(['https://kobold.example.net']);

    useExploreStore.getState().reset();
    expect(useExploreStore.getState().unansweredOrigins).toEqual([]);
  });
});
