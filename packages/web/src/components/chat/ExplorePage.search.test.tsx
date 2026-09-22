import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DirectoryEntry, InstanceInfoResponse } from '@backspace/shared';
import { ExplorePage } from './ExplorePage';
import { useExploreStore } from '../../stores/exploreStore';

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
    spaces: never[];
    myRequests: never[];
    searchQuery: string;
    isLoading: boolean;
    discoveryEnabled: boolean;
    totalAll: number;
    error: string | null;
    fetchSpaces: typeof fetchSpaces;
    fetchMyRequests: typeof fetchMyRequests;
    setSearchQuery: (q: string) => void;
  }>((set) => ({
    spaces: [],
    myRequests: [],
    searchQuery: '',
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
    fetch: typeof fetchDirectory;
    loadMore: typeof loadMore;
  }>(() => ({
    entries: [],
    status: 'ok',
    query: '',
    offset: 0,
    hasMore: false,
    fetch: fetchDirectory,
    loadMore,
  }));
  return { useDirectoryStore };
});

vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: (selector: (s: { setCurrentSpace: () => void }) => unknown) =>
    selector({ setCurrentSpace: vi.fn() }),
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
    useExploreStore.setState({ searchQuery: '' });
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

  it('keeps the Inner empty copy inside the Inner section and Outer below it', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Outer Space')).toBeInTheDocument());
    const innerEmpty = screen.getByText('No discoverable spaces yet.');
    const outerHeader = screen.getByText('Outer Space');
    expect(innerEmpty.compareDocumentPosition(outerHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
