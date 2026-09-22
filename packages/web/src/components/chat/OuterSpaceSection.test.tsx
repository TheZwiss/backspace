import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import type { DirectoryEntry, FederationRegistryEntry } from '@backspace/shared';
import type { DirectoryStatus } from '../../stores/directoryStore';
import { OuterSpaceSection } from './OuterSpaceSection';
import { useInstanceStore, type ConnectedInstance } from '../../stores/instanceStore';

// Stub AudioManager: the instance store imports it transitively and jsdom has no AudioWorkletNode.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

// ── directoryStore: a plain state object the tests set per case ─────────────
const { directory, fetchDirectory, loadMore } = vi.hoisted(() => {
  const fetchDirectory = vi.fn(async (_query: string) => {});
  const loadMore = vi.fn(async () => {});
  const directory = {
    entries: [] as DirectoryEntry[],
    status: 'ok' as DirectoryStatus,
    query: '',
    offset: 0,
    hasMore: false,
    fetch: fetchDirectory,
    loadMore,
  };
  return { directory, fetchDirectory, loadMore };
});

vi.mock('../../stores/directoryStore', () => ({
  useDirectoryStore: Object.assign(
    (selector: (s: typeof directory) => unknown) => selector(directory),
    {
      getState: () => directory,
      setState: vi.fn(),
      subscribe: () => () => {},
    },
  ),
}));

// The cards' Inner join hook is not exercised by an Outer card.
vi.mock('../../hooks/useSpaceJoin', () => ({
  useSpaceJoin: () => ({
    isJoined: false,
    isPublic: true,
    isPending: false,
    joining: false,
    joinError: '',
    showRequestForm: false,
    requestMessage: '',
    setRequestMessage: vi.fn(),
    openRequestForm: vi.fn(),
    cancelRequestForm: vi.fn(),
    join: vi.fn(async () => null),
    sendRequest: vi.fn(async () => {}),
  }),
}));

vi.mock('../../hooks/useMascotAnimation', () => ({
  useMascotAnimation: vi.fn(),
}));

function entry(id: string, origin = 'https://orbit.example'): DirectoryEntry {
  return {
    id,
    name: `Space ${id}`,
    description: null,
    icon: null,
    banner: null,
    avatarColor: null,
    visibility: 'public',
    memberCount: 3,
    createdAt: 1,
    origin,
    instanceName: origin,
    federatedRegistrationOpen: true,
  };
}

function setDirectory(patch: Partial<typeof directory>) {
  Object.assign(directory, { entries: [], status: 'ok', query: '', offset: 0, hasMore: false }, patch);
}

function renderSection(query = '') {
  const onConnect = vi.fn();
  const view = render(<OuterSpaceSection query={query} onConnect={onConnect} />);
  return { ...view, onConnect };
}

const UNREACHABLE = 'Outer Space is not reachable right now. Inner Space still works.';

function registryEntry(origin: string, status: FederationRegistryEntry['status']): [string, FederationRegistryEntry] {
  return [origin, {
    origin, label: '', username: 'jannis@home.example', remoteUserId: 'r1', status,
    addedAt: 1, lastConnectedAt: null, disconnectedAt: null, errorMessage: null,
  }];
}

function liveInstance(origin: string, status: ConnectedInstance['status']): ConnectedInstance {
  return {
    origin,
    label: new URL(origin).host,
    token: 'tok',
    user: {} as ConnectedInstance['user'],
    username: 'jannis@home.example',
    status,
    api: {} as ConnectedInstance['api'],
  };
}

const originalLocation = window.location;

describe('OuterSpaceSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDirectory({});
    useInstanceStore.setState({ instances: [], registry: new Map() });
  });

  afterEach(() => {
    // One case below points the session at another origin; the rest read jsdom's own.
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
  });

  it('renders the header and fetches the query on mount', () => {
    renderSection('nebula');
    expect(screen.getByText('Outer Space')).toBeInTheDocument();
    expect(screen.getByText('Communities across Backspace')).toBeInTheDocument();
    expect(fetchDirectory).toHaveBeenCalledTimes(1);
    expect(fetchDirectory).toHaveBeenCalledWith('nebula');
  });

  it('loading with no entries: full-height spinner, no cards, no empty copy', () => {
    setDirectory({ status: 'loading' });
    renderSection();
    expect(screen.getByTestId('outer-space-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('outer-space-header-spinner')).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing out there yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
  });

  it('loading with entries: keeps the list and shows an inline spinner in the header', () => {
    setDirectory({ status: 'loading', entries: [entry('a'), entry('b')] });
    renderSection();
    expect(screen.getByRole('heading', { level: 3, name: 'Space a' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Space b' })).toBeInTheDocument();
    const header = screen.getByTestId('outer-space-header');
    expect(within(header).getByTestId('outer-space-header-spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('outer-space-loading')).not.toBeInTheDocument();
  });

  it('unreachable: amber notice with the errors copy', () => {
    setDirectory({ status: 'unreachable' });
    renderSection();
    const notice = screen.getByText(UNREACHABLE);
    expect(notice).toBeInTheDocument();
    expect(notice.className).toContain('accent-amber');
  });

  it('unreachable after a failed load more: the list stays and the notice sits under it', () => {
    setDirectory({ status: 'unreachable', entries: [entry('a')] });
    renderSection();
    const card = screen.getByRole('heading', { level: 3, name: 'Space a' });
    const notice = screen.getByText(UNREACHABLE);
    expect(card.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('error: rose notice', () => {
    setDirectory({ status: 'error' });
    renderSection();
    const notice = screen.getByText('Something went wrong.');
    expect(notice.className).toContain('accent-rose');
  });

  it('ok, zero entries, with a query: the no-matches copy', () => {
    setDirectory({ status: 'ok', query: 'zzz' });
    renderSection('zzz');
    expect(screen.getByText('Nothing in Outer Space matches your search.')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing out there yet/)).not.toBeInTheDocument();
  });

  it('ok, zero entries, no query: the early-days copy with the mascot', () => {
    setDirectory({ status: 'ok' });
    renderSection('');
    expect(
      screen.getByText('Nothing out there yet. Spaces that opt in to the directory appear here.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('outer-space-mascot')).toBeInTheDocument();
  });

  it('ok with entries: a grid of outer cards wired to onConnect', () => {
    setDirectory({ status: 'ok', entries: [entry('a'), entry('b', 'https://nova.example')] });
    const { onConnect } = renderSection();
    expect(screen.getAllByRole('button', { name: 'Connect and join' })).toHaveLength(2);
    expect(screen.getByText('orbit.example')).toBeInTheDocument();
    expect(screen.getByText('nova.example')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect and join' })[1]);
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('show more: rendered when hasMore and calls loadMore', () => {
    setDirectory({ status: 'ok', entries: [entry('a')], hasMore: true });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('dedupes by origin at render: an instance that appears in the session hides its entries without a refetch', () => {
    setDirectory({ status: 'ok', entries: [entry('a'), entry('b', 'https://nova.example'), entry('c')] });
    const { rerender } = renderSection();
    expect(screen.getAllByRole('button', { name: 'Connect and join' })).toHaveLength(3);

    // The user connected orbit.example through the Connections panel.
    act(() => {
      useInstanceStore.setState({ instances: [liveInstance('https://orbit.example', 'connected')] });
    });
    rerender(<OuterSpaceSection query="" onConnect={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: 'Connect and join' })).toHaveLength(1);
    expect(screen.getByText('nova.example')).toBeInTheDocument();
    expect(fetchDirectory).toHaveBeenCalledTimes(1);
  });

  it('keeps an expired or unreachable origin out (its chip explains), lets a disconnected one back in', () => {
    setDirectory({
      status: 'ok',
      entries: [entry('a', 'https://expired.example'), entry('b', 'https://down.example'), entry('c', 'https://quiet.example'), entry('d', 'https://far.example')],
    });
    useInstanceStore.setState({
      registry: new Map([
        registryEntry('https://expired.example', 'auth_expired'),
        registryEntry('https://down.example', 'unreachable'),
        registryEntry('https://quiet.example', 'disconnected'),
      ]),
      instances: [
        liveInstance('https://expired.example', 'error'),
        liveInstance('https://down.example', 'disconnected'),
        liveInstance('https://quiet.example', 'disconnected'),
      ],
    });
    renderSection();
    expect(screen.queryByText('expired.example')).not.toBeInTheDocument();
    expect(screen.queryByText('down.example')).not.toBeInTheDocument();
    // Disconnected by the user's own choice: for Explore it is an outer instance again.
    expect(screen.getByText('quiet.example')).toBeInTheDocument();
    expect(screen.getByText('far.example')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Connect and join' })).toHaveLength(2);
  });

  it('dedupes the session\'s own origin and shows the empty copy when nothing is left', () => {
    Object.defineProperty(window, 'location', { value: new URL('https://nova.example/'), writable: true });
    setDirectory({ status: 'ok', entries: [entry('b', 'https://nova.example/')] });
    renderSection();
    expect(screen.queryByRole('button', { name: 'Connect and join' })).not.toBeInTheDocument();
    expect(screen.getByTestId('outer-space-mascot')).toBeInTheDocument();
  });

  it('disabled: renders nothing at all', () => {
    setDirectory({ status: 'disabled' });
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
  });
});
