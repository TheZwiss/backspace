import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FederationRegistryEntry, User } from '@backspace/shared';
import { HttpError } from '../../api/client';
import { ConnectionChips } from './ConnectionChips';
import { useInstanceStore, type ConnectedInstance } from '../../stores/instanceStore';
import { useAuthStore } from '../../stores/authStore';

// Stub AudioManager: the instance store imports it transitively and jsdom has no AudioWorkletNode.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

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
  homeInstance: null,
  homeUserId: null,
  replicatedInstances: [],
};

function registryEntry(origin: string, status: FederationRegistryEntry['status'], label = ''): FederationRegistryEntry {
  return {
    origin,
    label,
    username: 'jannis@home.example',
    remoteUserId: 'r1',
    status,
    addedAt: 1,
    lastConnectedAt: null,
    disconnectedAt: null,
    errorMessage: null,
  };
}

function liveInstance(origin: string, status: ConnectedInstance['status']): ConnectedInstance {
  return {
    origin,
    label: new URL(origin).host,
    token: 'tok',
    user: homeUser,
    username: 'jannis@home.example',
    status,
    api: {} as ConnectedInstance['api'],
  };
}

function seed(entries: FederationRegistryEntry[], instances: ConnectedInstance[] = []) {
  useInstanceStore.setState({
    registry: new Map(entries.map((e) => [e.origin, e])),
    instances,
  });
}

const reconnectInstance = vi.fn(async (_origin: string) => {});
const reauthenticateInstance = vi.fn(async (_origin: string, _password: string) => {});
const onRecovered = vi.fn();

beforeEach(() => {
  reconnectInstance.mockReset();
  reconnectInstance.mockResolvedValue(undefined);
  reauthenticateInstance.mockReset();
  reauthenticateInstance.mockResolvedValue(undefined);
  onRecovered.mockReset();
  useAuthStore.setState({ user: homeUser });
  useInstanceStore.setState({ registry: new Map(), instances: [], reconnectInstance, reauthenticateInstance });
});

describe('ConnectionChips', () => {
  it('renders nothing when every connection is connected', () => {
    seed([registryEntry('https://orbit.example', 'connected')]);
    const { container } = render(<ConnectionChips onRecovered={onRecovered} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing with an empty registry', () => {
    const { container } = render(<ConnectionChips onRecovered={onRecovered} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows one chip per auth_expired and unreachable entry, and none for disconnected', () => {
    seed([
      registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss'),
      registryEntry('https://orbit.example', 'unreachable'),
      registryEntry('https://quiet.example', 'disconnected'),
      registryEntry('https://fine.example', 'connected'),
    ]);
    render(<ConnectionChips onRecovered={onRecovered} />);

    expect(screen.getByText('Zwiss')).toBeInTheDocument();
    expect(screen.getByText('session expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();

    // The label falls back to the host when the registry has none.
    expect(screen.getByText('orbit.example')).toBeInTheDocument();
    expect(screen.getByText('unreachable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    expect(screen.queryByText('quiet.example')).not.toBeInTheDocument();
    expect(screen.queryByText('fine.example')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('carries the state in the dot: rose for auth_expired, amber for unreachable', () => {
    seed([
      registryEntry('https://zwiss.example', 'auth_expired'),
      registryEntry('https://orbit.example', 'unreachable'),
    ]);
    render(<ConnectionChips onRecovered={onRecovered} />);
    const [expired, unreachable] = screen.getAllByRole('listitem');
    expect(expired?.querySelector('.bg-accent-rose')).not.toBeNull();
    expect(unreachable?.querySelector('.bg-accent-amber')).not.toBeNull();
    // The chip itself stays quiet: the pill tier, no warning tint on the whole chip.
    expect(expired).toHaveClass('glass-pill');
  });

  it('hides a chip while its live instance is connecting on its own', () => {
    seed(
      [registryEntry('https://zwiss.example', 'auth_expired')],
      [liveInstance('https://zwiss.example', 'connecting')],
    );
    const { container } = render(<ConnectionChips onRecovered={onRecovered} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('Retry calls reconnectInstance with the origin and shows the connecting word meanwhile', async () => {
    seed(
      [registryEntry('https://orbit.example', 'unreachable')],
      [liveInstance('https://orbit.example', 'disconnected')],
    );
    let finish: () => void = () => {};
    reconnectInstance.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(reconnectInstance).toHaveBeenCalledWith('https://orbit.example');
    const connecting = screen.getByRole('button', { name: 'Connecting…' });
    expect(connecting).toBeDisabled();
    // The store marks the instance connecting; the chip keeps showing while its own retry is in flight.
    useInstanceStore.setState({ instances: [liveInstance('https://orbit.example', 'connecting')] });
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeInTheDocument();

    // Failure: the registry still says unreachable, the chip returns to its resting state.
    useInstanceStore.setState({ instances: [liveInstance('https://orbit.example', 'disconnected')] });
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument());
    expect(screen.getByText('unreachable')).toBeInTheDocument();
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it('Retry that brings the connection back reports recovery and the chip goes away', async () => {
    seed(
      [registryEntry('https://orbit.example', 'unreachable')],
      [liveInstance('https://orbit.example', 'disconnected')],
    );
    reconnectInstance.mockImplementationOnce(async (origin: string) => {
      const registry = new Map(useInstanceStore.getState().registry);
      registry.set(origin, registryEntry(origin, 'connected'));
      useInstanceStore.setState({ registry, instances: [liveInstance(origin, 'connected')] });
    });
    const user = userEvent.setup();
    const { container } = render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(onRecovered).toHaveBeenCalledOnce());
    expect(container).toBeEmptyDOMElement();
  });

  it('Reconnect expands into the password form, submits, collapses on success and reports recovery', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    reauthenticateInstance.mockImplementationOnce(async (origin: string) => {
      const registry = new Map(useInstanceStore.getState().registry);
      registry.set(origin, registryEntry(origin, 'connected', 'Zwiss'));
      useInstanceStore.setState({ registry, instances: [liveInstance(origin, 'connected')] });
    });
    const user = userEvent.setup();
    const { container } = render(<ConnectionChips onRecovered={onRecovered} />);

    expect(screen.queryByPlaceholderText('Your home account password')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));

    const password = screen.getByPlaceholderText('Your home account password');
    expect(password).toHaveFocus();
    // The password manager gets the account's username from a hidden field.
    expect(container.querySelector('input[autocomplete="username"]')).toHaveValue('jannis@home.example');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();

    await user.type(password, 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(reauthenticateInstance).toHaveBeenCalledWith('https://zwiss.example', 'hunter2');
    await waitFor(() => expect(onRecovered).toHaveBeenCalledOnce());
    expect(container).toBeEmptyDOMElement();
  });

  it('Cancel collapses the form and keeps the chip', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    await user.type(screen.getByPlaceholderText('Your home account password'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByPlaceholderText('Your home account password')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(reauthenticateInstance).not.toHaveBeenCalled();
  });

  it('shows the described error inline when the reauth fails, and stays expanded', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    reauthenticateInstance.mockRejectedValueOnce(
      new HttpError(401, 'invalid_credentials', { error: 'x', code: 'invalid_credentials', statusCode: 401 }, 'invalid_credentials'),
    );
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    await user.type(screen.getByPlaceholderText('Your home account password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Wrong username or password.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Your home account password')).toBeInTheDocument();
    expect(onRecovered).not.toHaveBeenCalled();
  });
});
