import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DirectoryEntry, InstanceInfoResponse } from '@backspace/shared';
import userEvent from '@testing-library/user-event';
import { ExplorePage } from './ExplorePage';
import type { ExploreFetchFailure } from '../../stores/exploreStore';
import { useExploreStore } from '../../stores/exploreStore';
import { useDirectoryStore } from '../../stores/directoryStore';
import { useInstanceStore, type ConnectedInstance } from '../../stores/instanceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { HttpError } from '../../api/client';

// Stub AudioManager: the instance store imports it transitively and jsdom has no AudioWorkletNode.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

// ── Spies shared with the mocked modules ─────────────────────────────────────
const { fetchSpaces, fetchMyRequests, fetchDirectory, loadMore, instanceInfo, openModal } = vi.hoisted(() => ({
  fetchSpaces: vi.fn(async (_query?: string) => {}),
  fetchMyRequests: vi.fn(async () => {}),
  fetchDirectory: vi.fn(async (_query: string) => {}),
  loadMore: vi.fn(async () => {}),
  instanceInfo: vi.fn(async (): Promise<InstanceInfoResponse> => ({
    name: 'Home',
    version: '1.0.0',
    registrationOpen: true,
    federatedRegistrationOpen: true,
    instanceId: 'home',
    sourceCodeUrl: 'https://example.invalid',
    commit: null,
    directoryConfigured: true,
    directoryAvailable: true,
    directoryEnabled: true,
  })),
  openModal: vi.fn(),
}));

// Both stores are real zustand stores so the controlled search input re-renders
// as the query changes; only their network actions are spies.
vi.mock('../../stores/exploreStore', async () => {
  const { create } = await import('zustand');
  const useExploreStore = create<{
    spaces: { id: string; name: string; _instanceOrigin: string; joined: boolean }[];
    myRequests: never[];
    searchQuery: string;
    resultsQuery: string;
    isLoading: boolean;
    discoveryEnabled: boolean;
    totalAll: number;
    error: ExploreFetchFailure | null;
    fetchSpaces: typeof fetchSpaces;
    fetchMyRequests: typeof fetchMyRequests;
    setSearchQuery: (q: string) => void;
  }>((set) => ({
    spaces: [] as { id: string; name: string; _instanceOrigin: string; joined: boolean }[],
    myRequests: [],
    searchQuery: '',
    resultsQuery: '',
    isLoading: false,
    discoveryEnabled: true,
    totalAll: 0,
    error: null,
    fetchSpaces,
    fetchMyRequests,
    setSearchQuery: (q) => set({ searchQuery: q }),
  }));
  return { useExploreStore };
});

vi.mock('../../stores/directoryStore', async () => {
  const { create } = await import('zustand');
  const useDirectoryStore = create<{
    entries: DirectoryEntry[];
    status: 'idle' | 'loading' | 'ok' | 'disabled' | 'unreachable' | 'error';
    query: string;
    offset: number;
    hasMore: boolean;
    loadMoreError: 'disabled' | 'unreachable' | 'error' | null;
    fetch: typeof fetchDirectory;
    loadMore: typeof loadMore;
  }>(() => ({
    entries: [],
    status: 'ok',
    query: '',
    offset: 0,
    hasMore: false,
    loadMoreError: null,
    fetch: fetchDirectory,
    loadMore,
  }));
  return { useDirectoryStore };
});

vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (s: { setCurrentSpace: () => void }) => unknown) => selector({ setCurrentSpace: vi.fn() }),
    { getState: () => ({ removeInstanceSpaces: vi.fn() }) },
  ),
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (s: { memberListOpen: boolean; toggleMemberList: () => void; openModal: typeof openModal }) => unknown) =>
    selector({ memberListOpen: false, toggleMemberList: vi.fn(), openModal }),
}));

vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  api: { instance: { info: instanceInfo } },
}));

vi.mock('../../hooks/useMascotAnimation', () => ({ useMascotAnimation: vi.fn() }));

// The Inner cards' join hook: the page test never drives a join.
vi.mock('../../hooks/useSpaceJoin', () => ({
  useSpaceJoin: () => ({
    isJoined: false, isPublic: true, isPending: false, joining: false, joinError: '',
    showRequestForm: false, requestMessage: '', setRequestMessage: vi.fn(),
    openRequestForm: vi.fn(), cancelRequestForm: vi.fn(),
    join: vi.fn(async () => null), sendRequest: vi.fn(async () => {}),
  }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ExplorePage />
    </MemoryRouter>,
  );
}

describe('ExplorePage search and the Outer Space gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useExploreStore.setState({ searchQuery: '', resultsQuery: '', error: null });
    // The hint under the chips reads this store directly. Its resting state is
    // a member whose settings have not arrived, which is the hint's silent row.
    useSettingsStore.setState({ isAdmin: false, streamingLimits: null });
  });

  it('one debounce drives both stores with the same value', async () => {
    renderPage();
    const input = screen.getByPlaceholderText('Search spaces...');
    fireEvent.change(input, { target: { value: 'neb' } });
    fireEvent.change(input, { target: { value: 'nebula' } });

    // Nothing before the debounce elapses.
    expect(fetchSpaces).not.toHaveBeenCalledWith('neb');
    expect(fetchSpaces).not.toHaveBeenCalledWith('nebula');
    expect(fetchDirectory).not.toHaveBeenCalledWith('neb');
    expect(fetchDirectory).not.toHaveBeenCalledWith('nebula');

    await waitFor(() => expect(fetchSpaces).toHaveBeenCalledWith('nebula'), { timeout: 1500 });
    expect(fetchDirectory).toHaveBeenCalledWith('nebula');
    // The intermediate value was swallowed by the debounce for both.
    expect(fetchSpaces).not.toHaveBeenCalledWith('neb');
    expect(fetchDirectory).not.toHaveBeenCalledWith('neb');
  });

  it('renders the Inner header and, once the instance says so, the Outer header', async () => {
    renderPage();
    expect(screen.getByText('Inner Space')).toBeInTheDocument();
    expect(screen.getByText('Spaces on your instances')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Outer Space')).toBeInTheDocument());
    expect(screen.getByText('Communities across Backspace')).toBeInTheDocument();
    expect(instanceInfo).toHaveBeenCalledTimes(1);
  });

  it('renders the Outer header when the directory is available but the admin has not turned listing on', async () => {
    // Browsing needs only DIRECTORY_ENDPOINT; the listing opt-in is a separate
    // switch. A fresh instance with no peers must still be able to browse.
    instanceInfo.mockResolvedValueOnce({
      name: 'Home',
      version: '1.0.0',
      registrationOpen: true,
      federatedRegistrationOpen: true,
      instanceId: 'home',
      sourceCodeUrl: 'https://example.invalid',
      commit: null,
      directoryConfigured: true,
      directoryAvailable: true,
      directoryEnabled: false,
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Outer Space')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('Search spaces...'), { target: { value: 'nebula' } });
    await waitFor(() => expect(fetchDirectory).toHaveBeenCalledWith('nebula'), { timeout: 1500 });
  });

  it('never renders the Outer header when the directory is unavailable, even with listing on', async () => {
    instanceInfo.mockResolvedValueOnce({
      name: 'Home',
      version: '1.0.0',
      registrationOpen: true,
      federatedRegistrationOpen: true,
      instanceId: 'home',
      sourceCodeUrl: 'https://example.invalid',
      commit: null,
      directoryConfigured: true,
      directoryAvailable: false,
      directoryEnabled: true,
    });
    renderPage();
    expect(instanceInfo).toHaveBeenCalledTimes(1);
    // Let the resolved info promise and its state update settle before asserting the absence.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchMyRequests).toHaveBeenCalled();
    expect(screen.queryByText('Outer Space')).not.toBeInTheDocument();
    expect(fetchDirectory).not.toHaveBeenCalled();
    // Inner Space is untouched by the gate.
    expect(screen.getByText('Inner Space')).toBeInTheDocument();

    // A search still drives Inner Space, and still never touches the directory.
    fireEvent.change(screen.getByPlaceholderText('Search spaces...'), { target: { value: 'nebula' } });
    await waitFor(() => expect(fetchSpaces).toHaveBeenCalledWith('nebula'), { timeout: 1500 });
    expect(fetchDirectory).not.toHaveBeenCalled();
  });

  it('the Inner empty copy follows the query the spaces answer, not the one being typed', async () => {
    renderPage();
    expect(screen.getByText('No discoverable spaces yet.')).toBeInTheDocument();

    // Typing moves the search box at once; the fan-out behind it waits out
    // the debounce, so for that interval the copy would be describing a
    // result set that has not changed.
    fireEvent.change(screen.getByPlaceholderText('Search spaces...'), { target: { value: 'zzz' } });
    expect(screen.getByText('No discoverable spaces yet.')).toBeInTheDocument();
    expect(screen.queryByText('No spaces match your search.')).not.toBeInTheDocument();

    // The fan-out lands: now the empty list is an empty answer for "zzz".
    await waitFor(() => expect(fetchSpaces).toHaveBeenCalledWith('zzz'), { timeout: 1500 });
    act(() => { useExploreStore.setState({ resultsQuery: 'zzz' }); });
    expect(screen.getByText('No spaces match your search.')).toBeInTheDocument();

    // And the other way: the box is cleared while the no-match answer stands.
    fireEvent.change(screen.getByPlaceholderText('Search spaces...'), { target: { value: '' } });
    expect(screen.getByText('No spaces match your search.')).toBeInTheDocument();
  });

  it('says a fan-out nobody answered in the reader\'s language, never in the store\'s', async () => {
    renderPage();
    act(() => { useExploreStore.setState({ error: { kind: 'none_answered' } }); });

    expect(screen.getByText('No instance answered. Inner Space is empty until one does.')).toBeInTheDocument();
    expect(screen.queryByText('Failed to reach any instance for discovery')).not.toBeInTheDocument();
  });

  it('describes a fan-out that could not run through the error catalog', async () => {
    renderPage();
    const cause = new HttpError(503, 'peer_unreachable', { error: 'Instance unreachable', code: 'peer_unreachable', statusCode: 503 }, 'peer_unreachable');
    act(() => { useExploreStore.setState({ error: { kind: 'failed', cause } }); });

    expect(screen.getByText('The other instance cannot be reached right now.')).toBeInTheDocument();
    // The English the error carries for logs and older clients is not what
    // the page shows.
    expect(screen.queryByText('Instance unreachable')).not.toBeInTheDocument();
  });

  it('keeps the Inner empty copy inside the Inner section and Outer below it', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Outer Space')).toBeInTheDocument());
    const innerEmpty = screen.getByText('No discoverable spaces yet.');
    const outerHeader = screen.getByText('Outer Space');
    expect(innerEmpty.compareDocumentPosition(outerHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('ExplorePage connection chips', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useExploreStore.setState({ searchQuery: '', resultsQuery: '', error: null });
    useInstanceStore.setState({ registry: new Map(), instances: [] });
  });

  it('renders no chip row when every connection is healthy', () => {
    useInstanceStore.setState({
      registry: new Map([[
        'https://orbit.example',
        { origin: 'https://orbit.example', label: 'Orbit', username: 'jannis@home.example', remoteUserId: 'r1', status: 'connected', addedAt: 1, lastConnectedAt: 1, disconnectedAt: null, errorMessage: null },
      ]]),
    });
    renderPage();
    expect(screen.queryByRole('list', { name: 'Connections that need attention' })).not.toBeInTheDocument();
  });

  it('shows the expired connection under the Inner subtitle and refetches Inner Space once it is back', async () => {
    const reauthenticateInstance = vi.fn(async (origin: string) => {
      const registry = new Map(useInstanceStore.getState().registry);
      const entry = registry.get(origin);
      if (entry) registry.set(origin, { ...entry, status: 'connected' });
      useInstanceStore.setState({ registry });
    });
    useInstanceStore.setState({
      reauthenticateInstance,
      registry: new Map([[
        'https://zwiss.example',
        { origin: 'https://zwiss.example', label: 'Zwiss', username: 'jannis@home.example', remoteUserId: 'r1', status: 'auth_expired', addedAt: 1, lastConnectedAt: 1, disconnectedAt: null, errorMessage: null },
      ]]),
    });
    useExploreStore.setState({ searchQuery: 'alp' });
    const user = userEvent.setup();
    renderPage();
    expect(fetchSpaces).toHaveBeenCalledTimes(1);
    expect(fetchMyRequests).toHaveBeenCalledTimes(1);

    // The row sits between the Inner subtitle and the cards.
    const subtitle = screen.getByText('Spaces on your instances');
    const row = screen.getByRole('list', { name: 'Connections that need attention' });
    expect(subtitle.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Zwiss')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    await user.type(screen.getByLabelText('Your home account password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(reauthenticateInstance).toHaveBeenCalledWith('https://zwiss.example', 'hunter2');
    await waitFor(() => expect(fetchSpaces).toHaveBeenCalledTimes(2));
    expect(fetchSpaces).toHaveBeenLastCalledWith('alp');
    expect(fetchMyRequests).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('list', { name: 'Connections that need attention' })).not.toBeInTheDocument();
  });
});

describe('ExplorePage keeps an expired origin out of Outer Space through a failed reauth', () => {
  const ZWISS = 'https://zwiss.example';
  const zwissEntry: DirectoryEntry = {
    id: 'alpine',
    name: 'Zwiss Alpine Club',
    description: null,
    icon: null,
    banner: null,
    avatarColor: null,
    visibility: 'public',
    memberCount: 23,
    createdAt: 1,
    origin: ZWISS,
    instanceName: 'Zwiss',
    federatedRegistrationOpen: true,
  };
  const farEntry: DirectoryEntry = { ...zwissEntry, id: 'far', name: 'Far Away', origin: 'https://far.example', instanceName: 'Far' };

  beforeEach(() => {
    vi.clearAllMocks();
    useExploreStore.setState({ searchQuery: '', resultsQuery: '', error: null });
    useDirectoryStore.setState({ entries: [zwissEntry, farEntry], status: 'ok' });
  });

  afterEach(() => {
    useInstanceStore.setState({ connectToRemote: useInstanceStore.getInitialState().connectToRemote });
  });

  it('the error placeholder stays in the list, the cards stay hidden, the chip shows the error', async () => {
    // The real reauthenticateInstance over a connectToRemote that refuses the password.
    const connectToRemote = vi.fn(async () => {
      throw new HttpError(401, 'invalid_credentials', { error: 'x', code: 'invalid_credentials', statusCode: 401 }, 'invalid_credentials');
    });
    const placeholder: ConnectedInstance = {
      origin: ZWISS,
      label: 'Zwiss',
      token: '',
      username: 'jannis@home.example',
      status: 'error',
      user: { id: 'u1' } as ConnectedInstance['user'],
      api: {} as ConnectedInstance['api'],
    };
    useAuthStore.setState({ user: { id: 'u1', username: 'jannis', displayName: 'Jannis' } as ConnectedInstance['user'] });
    useInstanceStore.setState({
      // The store's own reauthenticateInstance (an earlier case replaced it), over the refusing connectToRemote.
      reauthenticateInstance: useInstanceStore.getInitialState().reauthenticateInstance,
      connectToRemote,
      instances: [placeholder],
      registry: new Map([[
        ZWISS,
        { origin: ZWISS, label: 'Zwiss', username: 'jannis@home.example', remoteUserId: 'r1', status: 'auth_expired', addedAt: 1, lastConnectedAt: 1, disconnectedAt: null, errorMessage: null },
      ]]),
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Outer Space')).toBeInTheDocument());

    // Deduped: only the unknown origin's card is in Outer Space.
    expect(screen.queryByText('Zwiss Alpine Club')).not.toBeInTheDocument();
    expect(screen.getByText('Far Away')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Reconnect/ }));
    await user.type(screen.getByLabelText('Your home account password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Wrong username or password.')).toBeInTheDocument();
    expect(connectToRemote).toHaveBeenCalledWith(ZWISS, 'wrong', 'Jannis');
    // The origin never left the instance list (the round-1 store fix). Since
    // round 2 the cards are held back by the registry's auth_expired rather
    // than by this entry, so the list assertion pins the store contract, not
    // what keeps Outer Space right.
    expect(useInstanceStore.getState().instances.map((i) => [i.origin, i.status])).toEqual([[ZWISS, 'error']]);
    expect(screen.queryByText('Zwiss Alpine Club')).not.toBeInTheDocument();
    expect(screen.getByText('session expired')).toBeInTheDocument();
  });
});

// ── A connection change while the page is open ───────────────────────────────

describe('ExplorePage follows a connection change while it is open', () => {
  const ORBIT = 'https://orbit.example';

  /** The space as Inner Space lists it on orbit, and as the directory feed carries it. */
  const innerSpace = { id: 'nebula', name: 'Nebula Nine', _instanceOrigin: ORBIT, joined: false };
  const outerEntry: DirectoryEntry = {
    id: 'nebula',
    name: 'Nebula Nine',
    description: null,
    icon: null,
    banner: null,
    avatarColor: null,
    visibility: 'public',
    memberCount: 4,
    createdAt: 1,
    origin: ORBIT,
    instanceName: 'Orbit',
    federatedRegistrationOpen: true,
  };

  function live(status: ConnectedInstance['status']): ConnectedInstance {
    return {
      origin: ORBIT, label: 'Orbit', token: 'tok', user: { id: 'u1' } as ConnectedInstance['user'],
      username: 'jannis@home.example', status, api: {} as ConnectedInstance['api'],
    };
  }

  function registry(status: 'connected' | 'disconnected') {
    return new Map([[ORBIT, {
      origin: ORBIT, label: 'Orbit', username: 'jannis@home.example', remoteUserId: 'r1',
      status, addedAt: 1, lastConnectedAt: 1, disconnectedAt: null, errorMessage: null,
    }]]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    useExploreStore.setState({ searchQuery: '', spaces: [] });
    useDirectoryStore.setState({ entries: [outerEntry], status: 'ok' });
    useInstanceStore.setState({ instances: [], registry: new Map(), _autoConnectDone: true });
    // The real fan-out reaches connected instances only; the mock follows it.
    fetchSpaces.mockImplementation(async () => {
      const connected = useInstanceStore.getState().instances.some((i) => i.origin === ORBIT && i.status === 'connected');
      useExploreStore.setState({ spaces: connected ? [innerSpace] : [] });
    });
  });

  it('a disconnect leaves exactly one card for the space, the Outer one', async () => {
    useInstanceStore.setState({ instances: [live('connected')], registry: registry('connected') });
    useExploreStore.setState({ spaces: [innerSpace] });
    useExploreStore.setState({ searchQuery: 'neb' });
    renderPage();
    await waitFor(() => expect(screen.getByText('Outer Space')).toBeInTheDocument());

    // Connected: the Inner card, and the dedupe keeps the same space out of Outer.
    expect(screen.getAllByText('Nebula Nine')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Join Space' })).toBeInTheDocument();
    expect(fetchSpaces).toHaveBeenCalledTimes(1);

    // The user disconnects orbit in the Connections panel, with Explore still open.
    act(() => {
      useInstanceStore.setState({ instances: [live('disconnected')], registry: registry('disconnected') });
    });

    await waitFor(() => expect(fetchSpaces).toHaveBeenCalledTimes(2));
    // The refetch uses the query that is in the box, not a blank one.
    expect(fetchSpaces).toHaveBeenLastCalledWith('neb');
    expect(fetchMyRequests).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getAllByText('Nebula Nine')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Connect and join' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join Space' })).not.toBeInTheDocument();
  });

  it('a connection coming back leaves exactly one card for the space, the Inner one', async () => {
    useInstanceStore.setState({ instances: [live('disconnected')], registry: registry('disconnected') });
    renderPage();
    await waitFor(() => expect(screen.getByText('Outer Space')).toBeInTheDocument());

    expect(screen.getAllByText('Nebula Nine')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Connect and join' })).toBeInTheDocument();

    // The connect-and-join flow (or the Connections panel) brings the origin back.
    act(() => {
      useInstanceStore.setState({ instances: [live('connected')], registry: registry('connected') });
    });

    await waitFor(() => expect(fetchSpaces).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText('Nebula Nine')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Join Space' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect and join' })).not.toBeInTheDocument();
  });

  it('does not refetch on mount beyond the one fetch the page already makes, nor on an unrelated status change', async () => {
    useInstanceStore.setState({ instances: [live('connected')], registry: registry('connected') });
    useExploreStore.setState({ spaces: [innerSpace] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Outer Space')).toBeInTheDocument());
    expect(fetchSpaces).toHaveBeenCalledTimes(1);
    expect(fetchMyRequests).toHaveBeenCalledTimes(1);

    // A registry-only change, and a re-set of the same connected list: the
    // key is the sorted connected origins, so neither is a refetch.
    act(() => {
      useInstanceStore.setState({ registry: registry('connected'), instances: [live('connected')] });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fetchSpaces).toHaveBeenCalledTimes(1);
    expect(fetchMyRequests).toHaveBeenCalledTimes(1);
  });

  it('waits for autoconnect: origins arriving one at a time fetch nothing until it is done', async () => {
    // A reload straight onto /explore. Both store actions await
    // waitForAutoConnect anyway, so a fetch per arriving instance would be
    // pure load; the page holds off until the list is whole.
    useInstanceStore.setState({ instances: [], registry: new Map(), _autoConnectDone: false });
    renderPage();
    await waitFor(() => expect(screen.getByText('Outer Space')).toBeInTheDocument());
    expect(fetchSpaces).toHaveBeenCalledTimes(1);

    const second = { ...live('connected'), origin: 'https://nova.example', label: 'Nova' };
    act(() => { useInstanceStore.setState({ instances: [live('connected')] }); });
    act(() => { useInstanceStore.setState({ instances: [live('connected'), second] }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // Still only the mount fetch.
    expect(fetchSpaces).toHaveBeenCalledTimes(1);
    expect(fetchMyRequests).toHaveBeenCalledTimes(1);

    // The flip itself is not a fetch either: the mount fetch awaits
    // waitForAutoConnect, so its fan-out already saw the whole list.
    act(() => { useInstanceStore.setState({ _autoConnectDone: true }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fetchSpaces).toHaveBeenCalledTimes(1);

    // From here the page follows the set again: the first change after the
    // gate opened is the first refetch.
    act(() => { useInstanceStore.setState({ instances: [live('disconnected'), second] }); });
    await waitFor(() => expect(fetchSpaces).toHaveBeenCalledTimes(2));
    expect(fetchMyRequests).toHaveBeenCalledTimes(2);
  });

  /*
   * The browse setting, end to end through the page. `directoryBrowseEnabled`
   * is admin-only, so the page never reads it: it reads the effect the public
   * instance info reports, hands it to the hint as `directoryAvailable`, and
   * re-reads that one document after the admin changes it. Without the row,
   * turning the setting off left Explore with no Outer Space and nothing
   * saying why.
   */
  it('names the absent Outer Space when browsing is off, and brings it back on the admin switch', async () => {
    instanceInfo.mockResolvedValueOnce({
      name: 'Home',
      version: '1.0.0',
      registrationOpen: true,
      federatedRegistrationOpen: true,
      instanceId: 'home',
      sourceCodeUrl: 'https://example.invalid',
      commit: null,
      directoryConfigured: true,
      directoryAvailable: false,
      directoryEnabled: true,
    });
    const updateInstanceSettings = vi.fn(async () => {});
    useSettingsStore.setState({
      isAdmin: true,
      streamingLimits: {
        maxBitrateKbps: 20000,
        minBitrateKbps: 500,
        bitrateStepKbps: 500,
        allowedResolutions: [540, 720, 1080],
        allowedFramerates: [30, 45, 60],
        maxResolution: 1080,
        maxFramerate: 60,
        discoveryEnabled: true,
        directoryEnabled: true,
        directoryConfigured: true,
        bitrateMatrixOverrides: null,
        allowCustomBitrate: true,
      },
      updateInstanceSettings,
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(screen.getByText('Spaces from other instances are not shown on this instance.')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Outer Space')).not.toBeInTheDocument();
    expect(fetchDirectory).not.toHaveBeenCalled();

    // The switch writes the admin setting, then the page re-reads the one
    // public document both facts ride on: the section appears without a reload.
    instanceInfo.mockResolvedValueOnce({
      name: 'Home',
      version: '1.0.0',
      registrationOpen: true,
      federatedRegistrationOpen: true,
      instanceId: 'home',
      sourceCodeUrl: 'https://example.invalid',
      commit: null,
      directoryConfigured: true,
      directoryAvailable: true,
      directoryEnabled: true,
    });
    await user.click(screen.getByRole('button', { name: 'Show global spaces in Explore' }));

    expect(updateInstanceSettings).toHaveBeenCalledWith({ directoryBrowseEnabled: true });
    await waitFor(() => expect(screen.getByText('Outer Space')).toBeInTheDocument());
    expect(instanceInfo).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText('Spaces from other instances are not shown on this instance.'),
    ).not.toBeInTheDocument();
  });
});
