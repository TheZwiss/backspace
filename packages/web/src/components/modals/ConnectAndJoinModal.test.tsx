import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { DirectoryEntry, User } from '@backspace/shared';
import { HttpError } from '../../api/client';

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

// The resume path is a module export, not a store action, so it is replaced
// at the module boundary; the store itself stays real.
const { connectToInstance } = vi.hoisted(() => ({ connectToInstance: vi.fn() }));
vi.mock('../../stores/instanceStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/instanceStore')>();
  return { ...actual, connectToInstance };
});

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
    directoryAvailable: true,
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
  connectToInstance.mockReset();
  connectToInstance.mockResolvedValue({ kind: 'needs-password' });
  probeInstance.mockReset();
  connectAndJoin.mockReset();
  loginAndJoin.mockReset();
  setCurrentSpace.mockReset();
  useUIStore.setState({ activeModal: null, modalData: {}, toasts: [], isMobile: false });
  useInstanceStore.setState({ instances: [], registry: new Map(), probeInstance });
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
    expect(screen.getByPlaceholderText('The one you sign in with')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect and join' })).toBeInTheDocument();
  });

  it('asks for the password once: the field label and the hint, not the intro or the placeholder', async () => {
    probeOk();
    open(entry());
    const { container } = renderModal();
    const field = await screen.findByLabelText(/Enter your password/);

    const intro = screen.getByText(/This space lives on/);
    expect(intro.textContent).not.toMatch(/password/i);
    expect(field).toHaveAttribute('placeholder');
    const placeholder = field.getAttribute('placeholder') ?? '';
    expect(placeholder).not.toMatch(/password/i);
    expect(placeholder).not.toBe('Enter your password to connect to retro.example');

    const words = (container.textContent ?? '').match(/password/gi) ?? [];
    expect(words.length).toBeLessThanOrEqual(2);
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
    expect(screen.queryByPlaceholderText('The one you sign in with')).not.toBeInTheDocument();
  });

  it('shows the probe error and a close button when the probe fails', async () => {
    const user = userEvent.setup();
    probeInstance.mockRejectedValue(new Error('This instance is already connected'));
    open(entry());
    renderModal();

    expect(await screen.findByText('This instance is already connected')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('The one you sign in with')).not.toBeInTheDocument();
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

    await user.type(await screen.findByPlaceholderText('The one you sign in with'), 'hunter2');
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

    await user.type(await screen.findByPlaceholderText('The one you sign in with'), 'hunter2');
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

    await user.type(await screen.findByPlaceholderText('The one you sign in with'), 'hunter2');
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

    await user.type(await screen.findByPlaceholderText('The one you sign in with'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Connect and join' }));

    expect(await screen.findByText('Invalid password')).toBeInTheDocument();
    expect(useUIStore.getState().activeModal).toBe('connectAndJoin');
    expect(screen.getByPlaceholderText('The one you sign in with')).toBeInTheDocument();
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
    expect(screen.queryByPlaceholderText('The one you sign in with')).not.toBeInTheDocument();
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

// ── Disconnected: the cached session gets its chance first ───────────────────

describe('ConnectAndJoinModal on an origin the session disconnected', () => {
  const RETRO = 'https://retro.example';

  it('a public entry whose cached token still works joins with no password step at all', async () => {
    const e = entry();
    useInstanceStore.setState({ instances: [connectedInstance(RETRO, 'disconnected')] });
    connectToInstance.mockResolvedValue({ kind: 'connected', how: 'resumed' });
    connectAndJoin.mockResolvedValue({ kind: 'joined', spaceId: 'space-1', origin: RETRO });
    open(e);
    renderModal();

    await waitFor(() => expect(connectAndJoin).toHaveBeenCalledWith(e, '', undefined));
    expect(connectToInstance).toHaveBeenCalledWith(RETRO, '');
    expect(probeInstance).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('The one you sign in with')).not.toBeInTheDocument();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/channels/space-1'));
    expect(setCurrentSpace).toHaveBeenCalledWith('space-1');
  });

  it('a request entry whose cached token still works goes straight to the message box', async () => {
    const user = userEvent.setup();
    const e = entry({ visibility: 'request' });
    useInstanceStore.setState({ instances: [connectedInstance(RETRO, 'disconnected')] });
    connectToInstance.mockResolvedValue({ kind: 'connected', how: 'resumed' });
    connectAndJoin.mockResolvedValue({ kind: 'requested' });
    open(e);
    renderModal();

    const box = await screen.findByPlaceholderText('Why do you want to join? (optional)');
    expect(screen.queryByPlaceholderText('The one you sign in with')).not.toBeInTheDocument();
    expect(connectAndJoin).not.toHaveBeenCalled();

    await user.type(box, 'hello there');
    await user.click(screen.getByRole('button', { name: 'Send Request' }));

    await waitFor(() => expect(connectAndJoin).toHaveBeenCalledWith(e, '', 'hello there'));
  });

  it('an expired cached token falls through to the probe and the password step', async () => {
    const user = userEvent.setup();
    probeOk();
    const e = entry();
    useInstanceStore.setState({ instances: [connectedInstance(RETRO, 'disconnected')] });
    connectToInstance.mockResolvedValue({ kind: 'needs-password' });
    connectAndJoin.mockResolvedValue({ kind: 'joined', spaceId: 'space-1', origin: RETRO });
    open(e);
    renderModal();

    await user.type(await screen.findByPlaceholderText('The one you sign in with'), 'hunter2');
    expect(connectToInstance).toHaveBeenCalledWith(RETRO, '');
    expect(probeInstance).toHaveBeenCalledWith('retro.example');
    await user.click(screen.getByRole('button', { name: 'Connect and join' }));

    await waitFor(() => expect(connectAndJoin).toHaveBeenCalledWith(e, 'hunter2', undefined));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/channels/space-1'));
  });

  it('an instance that turns out unreachable shows that error instead of a password step', async () => {
    const e = entry();
    useInstanceStore.setState({ instances: [connectedInstance(RETRO, 'disconnected')] });
    connectToInstance.mockRejectedValue(
      new HttpError(503, 'peer_unreachable', { error: 'peer_unreachable', code: 'peer_unreachable', statusCode: 503 }, 'peer_unreachable'),
    );
    open(e);
    renderModal();

    expect(await screen.findByText('The other instance cannot be reached right now.')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('The one you sign in with')).not.toBeInTheDocument();
    expect(probeInstance).not.toHaveBeenCalled();
    expect(connectAndJoin).not.toHaveBeenCalled();
  });

  it('an origin the session never knew is probed as before, with no resume attempt', async () => {
    probeOk();
    open(entry());
    renderModal();

    expect(await screen.findByPlaceholderText('The one you sign in with')).toBeInTheDocument();
    expect(connectToInstance).not.toHaveBeenCalled();
  });
});
