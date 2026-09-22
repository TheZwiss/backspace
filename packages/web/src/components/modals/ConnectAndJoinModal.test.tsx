import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { DirectoryEntry, User } from '@backspace/shared';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { ConnectAndJoinModal } from './ConnectAndJoinModal';
import { useUIStore } from '../../stores/uiStore';
import { useDirectoryStore, type ConnectAndJoinResult } from '../../stores/directoryStore';
import { useInstanceStore, type ConnectedInstance } from '../../stores/instanceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSpaceStore } from '../../stores/spaceStore';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function entry(overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    id: 'space-1',
    name: 'Retro Computing',
    description: 'Amigas and Acorns.',
    icon: null,
    banner: null,
    avatarColor: 'coral',
    visibility: 'public',
    memberCount: 12,
    createdAt: 1,
    origin: 'https://retro.example',
    instanceName: 'Retro',
    federatedRegistrationOpen: true,
    ...overrides,
  };
}

const homeUser: User = {
  id: 'u1',
  username: 'jannis',
  displayName: 'Jannis',
  avatar: null,
  banner: null,
  accentColor: null,
  avatarColor: null,
  bio: null,
  status: 'online',
  customStatus: null,
  isAdmin: false,
  createdAt: 1,
  homeInstance: 'home.example',
  homeUserId: null,
  replicatedInstances: [],
};

function connectedInstance(origin: string, status: ConnectedInstance['status']): ConnectedInstance {
  return {
    origin,
    label: 'Retro',
    token: 't',
    user: homeUser,
    username: 'jannis',
    status,
    api: {} as ConnectedInstance['api'],
  };
}

const probeInstance = vi.fn();
const connectAndJoin = vi.fn<(e: DirectoryEntry, p: string, m?: string) => Promise<ConnectAndJoinResult>>();
const loginAndJoin = vi.fn<(e: DirectoryEntry, u: string, p: string, m?: string) => Promise<ConnectAndJoinResult>>();
const setCurrentSpace = vi.fn();

function probeOk(federatedRegistrationOpen = true) {
  probeInstance.mockResolvedValue({
    name: 'Retro',
    version: '1.0.0',
    registrationOpen: true,
    federatedRegistrationOpen,
    instanceId: 'retro',
    sourceCodeUrl: null,
    commit: null,
    directoryEnabled: true,
    origin: 'https://retro.example',
  });
}

function open(e: DirectoryEntry) {
  useUIStore.setState({ activeModal: 'connectAndJoin', modalData: { entry: e } });
}

function renderModal() {
  return render(
    <MemoryRouter>
      <ConnectAndJoinModal />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockNavigate.mockReset();
  probeInstance.mockReset();
  connectAndJoin.mockReset();
  loginAndJoin.mockReset();
  setCurrentSpace.mockReset();
  useUIStore.setState({ activeModal: null, modalData: {}, toasts: [], isMobile: false });
  useInstanceStore.setState({ instances: [], probeInstance });
  useDirectoryStore.setState({ connectAndJoin, loginAndJoin });
  useAuthStore.setState({ user: homeUser });
  useSpaceStore.setState({ setCurrentSpace });
});

// ── Gating ───────────────────────────────────────────────────────────────────

describe('ConnectAndJoinModal gating', () => {
  it('renders nothing when another modal is active', () => {
    useUIStore.setState({ activeModal: 'joinSpace', modalData: { entry: entry() } });
    renderModal();
    expect(screen.queryByText('Join Retro Computing')).not.toBeInTheDocument();
    expect(probeInstance).not.toHaveBeenCalled();
  });

  it('renders nothing when modalData carries no directory entry', () => {
    useUIStore.setState({ activeModal: 'connectAndJoin', modalData: { entry: { id: 'x' } } });
    renderModal();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(probeInstance).not.toHaveBeenCalled();
  });
});

// ── The probe ────────────────────────────────────────────────────────────────

describe('ConnectAndJoinModal probe', () => {
  it('probes the entry host on open and shows the instance, the space and the home host', async () => {
    probeOk();
    open(entry());
    renderModal();

    expect(probeInstance).toHaveBeenCalledWith('retro.example');
    expect(await screen.findByText('Join Retro Computing')).toBeInTheDocument();
    expect(await screen.findByText('Retro')).toBeInTheDocument();
    expect(screen.getByText('https://retro.example')).toBeInTheDocument();
    // The intro names both hosts: where the space lives and whose password is asked for.
    expect(screen.getByText(/This space lives on/)).toBeInTheDocument();
    expect(screen.getByText('retro.example')).toBeInTheDocument();
    expect(screen.getByText('home.example')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Your account password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect and join' })).toBeInTheDocument();
  });

  it('falls back to the page host for the home when the user has no homeInstance', async () => {
    probeOk();
    useAuthStore.setState({ user: { ...homeUser, homeInstance: null } });
    open(entry());
    renderModal();
    expect(await screen.findByText(window.location.host)).toBeInTheDocument();
  });

  it('shows the closed banner when the probe reports closed registrations', async () => {
    probeOk(false);
    open(entry());
    renderModal();
    expect(
      await screen.findByText(/disabled new federated registrations/),
    ).toBeInTheDocument();
  });

  it('shows a spinner until the probe resolves', () => {
    probeInstance.mockReturnValue(new Promise(() => {}));
    open(entry());
    renderModal();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Your account password')).not.toBeInTheDocument();
  });

  it('shows the probe error and a close button when the probe fails', async () => {
    const user = userEvent.setup();
    probeInstance.mockRejectedValue(new Error('This instance is already connected'));
    open(entry());
    renderModal();

    expect(await screen.findByText('This instance is already connected')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Your account password')).not.toBeInTheDocument();
    // The title bar's X is labelled Close as well; the footer button is the last one.
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    await user.click(closeButtons[closeButtons.length - 1]);
    expect(useUIStore.getState().activeModal).toBeNull();
  });
});

// ── Submit paths ─────────────────────────────────────────────────────────────

describe('ConnectAndJoinModal submit', () => {
  it('a public entry: submit calls connectAndJoin with the entry and the password, then navigates and closes', async () => {
    const user = userEvent.setup();
    probeOk();
    const e = entry();
    connectAndJoin.mockResolvedValue({ kind: 'joined', spaceId: 'space-1', origin: 'https://retro.example' });
    open(e);
    renderModal();

    await user.type(await screen.findByPlaceholderText('Your account password'), 'hunter2');
    expect(screen.queryByPlaceholderText('Why do you want to join? (optional)')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect and join' }));

    await waitFor(() => expect(connectAndJoin).toHaveBeenCalledWith(e, 'hunter2', undefined));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/channels/space-1'));
    expect(setCurrentSpace).toHaveBeenCalledWith('space-1');
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('a request entry: the message goes along and the requested result closes with a toast', async () => {
    const user = userEvent.setup();
    probeOk();
    const e = entry({ visibility: 'request' });
    connectAndJoin.mockResolvedValue({ kind: 'requested' });
    open(e);
    renderModal();

    await user.type(await screen.findByPlaceholderText('Your account password'), 'hunter2');
    await user.type(screen.getByPlaceholderText('Why do you want to join? (optional)'), 'let me in');
    await user.click(screen.getByRole('button', { name: 'Connect and request' }));

    await waitFor(() => expect(connectAndJoin).toHaveBeenCalledWith(e, 'hunter2', 'let me in'));
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(useUIStore.getState().toasts.map((t) => t.message)).toContain(
      'Your request to join Retro Computing was sent.',
    );
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('needs-remote-password switches to the fallback form whose submit calls loginAndJoin', async () => {
    const user = userEvent.setup();
    probeOk();
    const e = entry({ visibility: 'request' });
    connectAndJoin.mockResolvedValue({ kind: 'needs-remote-password', remoteUsername: 'jannis-old' });
    loginAndJoin.mockResolvedValue({ kind: 'requested' });
    open(e);
    renderModal();

    await user.type(await screen.findByPlaceholderText('Your account password'), 'hunter2');
    await user.type(screen.getByPlaceholderText('Why do you want to join? (optional)'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Connect and request' }));

    // The fallback form, with the remote username prefilled.
    expect(await screen.findByText(/An account already exists on this instance/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('jannis-old')).toBeInTheDocument();
    expect(screen.queryByText(/This space lives on/)).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Password on the remote instance'), 'other-pw');
    await user.click(screen.getByRole('button', { name: 'Login & Connect' }));

    await waitFor(() => expect(loginAndJoin).toHaveBeenCalledWith(e, 'jannis-old', 'other-pw', 'hello'));
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
  });

  it('a failed connect shows the error inside the step and keeps the modal open', async () => {
    const user = userEvent.setup();
    probeOk();
    connectAndJoin.mockRejectedValue(new Error('Invalid password'));
    open(entry());
    renderModal();

    await user.type(await screen.findByPlaceholderText('Your account password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Connect and join' }));

    expect(await screen.findByText('Invalid password')).toBeInTheDocument();
    expect(useUIStore.getState().activeModal).toBe('connectAndJoin');
    expect(screen.getByPlaceholderText('Your account password')).toBeInTheDocument();
  });
});

// ── Already connected (the stale-card case) ──────────────────────────────────

describe('ConnectAndJoinModal on an origin that is already connected', () => {
  it('a public entry joins immediately without a probe or a password', async () => {
    const e = entry();
    useInstanceStore.setState({ instances: [connectedInstance('https://retro.example', 'connected')] });
    connectAndJoin.mockResolvedValue({ kind: 'joined', spaceId: 'space-1', origin: 'https://retro.example' });
    open(e);
    renderModal();

    await waitFor(() => expect(connectAndJoin).toHaveBeenCalledWith(e, '', undefined));
    expect(probeInstance).not.toHaveBeenCalled();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/channels/space-1'));
    expect(setCurrentSpace).toHaveBeenCalledWith('space-1');
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('a request entry shows only the message box and a Request button', async () => {
    const user = userEvent.setup();
    const e = entry({ visibility: 'request' });
    useInstanceStore.setState({ instances: [connectedInstance('https://retro.example', 'connected')] });
    connectAndJoin.mockResolvedValue({ kind: 'requested' });
    open(e);
    renderModal();

    expect(await screen.findByText('Retro')).toBeInTheDocument();
    expect(probeInstance).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('Your account password')).not.toBeInTheDocument();
    expect(screen.queryByText(/This space lives on/)).not.toBeInTheDocument();
    expect(connectAndJoin).not.toHaveBeenCalled();

    await user.type(screen.getByPlaceholderText('Why do you want to join? (optional)'), 'please');
    await user.click(screen.getByRole('button', { name: 'Send Request' }));

    await waitFor(() => expect(connectAndJoin).toHaveBeenCalledWith(e, '', 'please'));
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(useUIStore.getState().toasts.map((t) => t.message)).toContain(
      'Your request to join Retro Computing was sent.',
    );
  });
});
