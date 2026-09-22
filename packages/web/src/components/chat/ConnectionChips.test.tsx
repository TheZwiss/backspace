import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FederationRegistryEntry, User } from '@backspace/shared';
import { HttpError } from '../../api/client';
import { ConnectionChips } from './ConnectionChips';
import { useInstanceStore, DifferentPasswordError, type ConnectedInstance } from '../../stores/instanceStore';
import { describeError } from '../../i18n/errors';
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
const loginToRemote = vi.fn(async (_origin: string, _username: string, _password: string) => {});
const onRecovered = vi.fn();

beforeEach(() => {
  reconnectInstance.mockReset();
  reconnectInstance.mockResolvedValue(undefined);
  reauthenticateInstance.mockReset();
  reauthenticateInstance.mockResolvedValue(undefined);
  loginToRemote.mockReset();
  loginToRemote.mockResolvedValue(undefined);
  onRecovered.mockReset();
  useAuthStore.setState({ user: homeUser });
  useInstanceStore.setState({ registry: new Map(), instances: [], reconnectInstance, reauthenticateInstance, loginToRemote });
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
    // The accessible name carries the instance, so two chips never read the same.
    expect(screen.getByRole('button', { name: 'Reconnect Zwiss' })).toBeInTheDocument();

    // The label falls back to the host when the registry has none.
    expect(screen.getByText('orbit.example')).toBeInTheDocument();
    expect(screen.getByText('unreachable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry orbit.example' })).toBeInTheDocument();

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

    await user.click(screen.getByRole('button', { name: /^Retry/ }));

    expect(reconnectInstance).toHaveBeenCalledWith('https://orbit.example');
    const connecting = screen.getByRole('button', { name: /^Connecting…/ });
    expect(connecting).toBeDisabled();
    // The store marks the instance connecting; the chip keeps showing while its own retry is in flight.
    useInstanceStore.setState({ instances: [liveInstance('https://orbit.example', 'connecting')] });
    expect(screen.getByRole('button', { name: /^Connecting…/ })).toBeInTheDocument();

    // Failure: the registry still says unreachable, the chip returns to its resting state.
    useInstanceStore.setState({ instances: [liveInstance('https://orbit.example', 'disconnected')] });
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Retry/ })).toBeInTheDocument());
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

    await user.click(screen.getByRole('button', { name: /^Retry/ }));

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

    expect(screen.queryByLabelText('Your home account password')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));

    const password = screen.getByLabelText('Your home account password');
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

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    await user.type(screen.getByLabelText('Your home account password'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Your home account password')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Reconnect/ })).toBeInTheDocument();
    expect(reauthenticateInstance).not.toHaveBeenCalled();
  });

  it('shows the described error inline when the reauth fails, and stays expanded', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    reauthenticateInstance.mockRejectedValueOnce(
      new HttpError(401, 'invalid_credentials', { error: 'x', code: 'invalid_credentials', statusCode: 401 }, 'invalid_credentials'),
    );
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    await user.type(screen.getByLabelText('Your home account password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Wrong username or password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your home account password')).toBeInTheDocument();
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it('the expanded chip is a panel on its own row, not a stretched pill', async () => {
    seed([
      registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss'),
      registryEntry('https://orbit.example', 'unreachable'),
    ]);
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));

    const [expired, unreachable] = screen.getAllByRole('listitem');
    // The pill tier is gone with the pill: expanded it is a matte panel.
    expect(expired).not.toHaveClass('glass-pill');
    expect(expired).toHaveClass('w-full');
    const panel = expired?.firstElementChild;
    expect(panel).toHaveClass('bg-surface-elevated');
    // Bounded by the form it holds, never by the section it sits in.
    expect(panel).toHaveClass('max-w-[22rem]');
    // The identity line keeps its reading order above the field.
    expect(expired?.textContent?.indexOf('Zwiss')).toBeLessThan(expired?.textContent?.indexOf('session expired') ?? -1);
    // The sibling chip is untouched and still a pill.
    expect(unreachable).toHaveClass('glass-pill');
  });

  it('the error sits inside the field block, under the field it is about', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    reauthenticateInstance.mockRejectedValueOnce(
      new HttpError(401, 'invalid_credentials', { error: 'x', code: 'invalid_credentials', statusCode: 401 }, 'invalid_credentials'),
    );
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    await user.type(screen.getByLabelText('Your home account password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    const message = await screen.findByText('Wrong username or password.');
    const field = screen.getByLabelText('Your home account password');
    expect(field.parentElement).toBe(message.parentElement);
    expect(field.nextElementSibling).toBe(message);
  });

  it('an unreachable instance surfaces its own text rather than a password error', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    reauthenticateInstance.mockRejectedValueOnce(
      new HttpError(503, 'peer_unreachable', { error: 'x', code: 'peer_unreachable', statusCode: 503 }, 'peer_unreachable'),
    );
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    await user.type(screen.getByLabelText('Your home account password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('The other instance cannot be reached right now.')).toBeInTheDocument();
  });

  it('while submitting the action reads the connecting word and Cancel is inert', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    let finish: () => void = () => {};
    reauthenticateInstance.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    const field = screen.getByLabelText('Your home account password');
    await user.type(field, 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('button', { name: 'Connecting…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(field).toBeDisabled();
    // Escape is inert too: the submit it would undo is already running.
    await user.keyboard('{Escape}');
    expect(screen.getByLabelText('Your home account password')).toBeInTheDocument();

    // The chip's own registry entry is untouched by this mock, so the
    // surface simply collapses back to its resting action.
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Reconnect/ })).toBeInTheDocument());
  });

  it('Enter in the field submits the form', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    await user.type(screen.getByLabelText('Your home account password'), 'hunter2{Enter}');

    await waitFor(() => expect(reauthenticateInstance).toHaveBeenCalledWith('https://zwiss.example', 'hunter2'));
  });

  it('Escape collapses the form and hands focus back to the chip action', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    expect(screen.getByLabelText('Your home account password')).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.queryByLabelText('Your home account password')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Reconnect/ })).toHaveFocus());
    expect(reauthenticateInstance).not.toHaveBeenCalled();
  });

  it('Cancel hands focus back to the chip action too', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.getByRole('button', { name: /^Reconnect/ })).toHaveFocus());
  });

  it('a different password on the instance moves to the per-instance login instead of a dead end', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    reauthenticateInstance.mockRejectedValueOnce(new DifferentPasswordError('jannis@home.example'));
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    await user.type(screen.getByLabelText('Your home account password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    // The raw English the error class carries is never what the user reads.
    expect(screen.queryByText('Account exists with a different password on this instance')).not.toBeInTheDocument();
    // The second phase, with the username the error carried already in it.
    expect(await screen.findByPlaceholderText('Password on the remote instance')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Your username on this instance')).toHaveValue('jannis@home.example');
    expect(screen.getByText(/does not accept the credential your home instance issued/)).toBeInTheDocument();
    // The home password the instance did not refuse is no longer asked for.
    expect(screen.queryByLabelText('Your home account password')).not.toBeInTheDocument();
  });

  it('the account being restored is shown but not editable', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    reauthenticateInstance.mockRejectedValueOnce(new DifferentPasswordError('jannis@home.example'));
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    await user.type(screen.getByLabelText('Your home account password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    // Restoring a connection is not choosing an account: typing another name
    // here would silently re-bind the origin to a different identity. The
    // field stays in the DOM so the password manager keys on it.
    const field = await screen.findByPlaceholderText('Your username on this instance');
    expect(field).toHaveAttribute('readonly');
    await user.type(field, 'someone-else');
    expect(field).toHaveValue('jannis@home.example');
  });

  it('the error is announced, not only shown', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    reauthenticateInstance.mockRejectedValueOnce(
      new HttpError(401, 'invalid_credentials', { error: 'x', code: 'invalid_credentials', statusCode: 401 }, 'invalid_credentials'),
    );
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    await user.type(screen.getByLabelText('Your home account password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password.');
  });

  it('a success on the per-instance login restores the connection like any other path', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    reauthenticateInstance.mockRejectedValueOnce(new DifferentPasswordError('jannis@home.example'));
    loginToRemote.mockImplementationOnce(async (origin: string) => {
      const registry = new Map(useInstanceStore.getState().registry);
      registry.set(origin, registryEntry(origin, 'connected', 'Zwiss'));
      useInstanceStore.setState({ registry, instances: [liveInstance(origin, 'connected')] });
    });
    const user = userEvent.setup();
    const { container } = render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    await user.type(screen.getByLabelText('Your home account password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await user.type(await screen.findByPlaceholderText('Password on the remote instance'), 'local-pw');
    await user.click(screen.getByRole('button', { name: 'Login & Connect' }));

    await waitFor(() => expect(loginToRemote).toHaveBeenCalledWith('https://zwiss.example', 'jannis@home.example', 'local-pw'));
    await waitFor(() => expect(onRecovered).toHaveBeenCalledOnce());
    expect(container).toBeEmptyDOMElement();
  });

  it('a refused per-instance login shows its own error and keeps the second phase', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    reauthenticateInstance.mockRejectedValueOnce(new DifferentPasswordError('jannis@home.example'));
    loginToRemote.mockRejectedValueOnce(
      new HttpError(401, 'invalid_credentials', { error: 'x', code: 'invalid_credentials', statusCode: 401 }, 'invalid_credentials'),
    );
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    await user.type(screen.getByLabelText('Your home account password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await user.type(await screen.findByPlaceholderText('Password on the remote instance'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Login & Connect' }));

    expect(await screen.findByText('Wrong username or password.')).toBeInTheDocument();
    // The handback holds in the second phase too: retrying is the only
    // sensible next move, so the keyboard is already in the field.
    expect(screen.getByPlaceholderText('Password on the remote instance')).toHaveFocus();
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it('the surface is named and marked busy while a request runs', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    let finish: () => void = () => {};
    reauthenticateInstance.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    // The surface holds focus for the length of the request, so it has to say
    // what it is and that something is running.
    const surface = screen.getByRole('group', { name: 'Re-authenticate' });
    expect(surface).toHaveAttribute('aria-busy', 'false');

    await user.type(screen.getByLabelText('Your home account password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(surface).toHaveAttribute('aria-busy', 'true'));
    expect(surface).toHaveFocus();

    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Reconnect/ })).toBeInTheDocument());
  });

  it('Escape collapses the second phase too', async () => {
    seed([registryEntry('https://zwiss.example', 'auth_expired', 'Zwiss')]);
    reauthenticateInstance.mockRejectedValueOnce(new DifferentPasswordError('jannis@home.example'));
    const user = userEvent.setup();
    render(<ConnectionChips onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /^Reconnect/ }));
    await user.type(screen.getByLabelText('Your home account password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByPlaceholderText('Password on the remote instance');

    await user.keyboard('{Escape}');

    expect(screen.queryByPlaceholderText('Password on the remote instance')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Reconnect/ })).toHaveFocus());
  });
});

describe('DifferentPasswordError', () => {
  // The class passes its code to super(); a wrong argument there would leave
  // every surface showing the English message with nothing else failing.
  it('describes itself from the catalog rather than from its own message', () => {
    expect(describeError(new DifferentPasswordError('jannis@home.example'))).toBe(
      'Your account on that instance has a password of its own. Sign in with it to reconnect.',
    );
  });
});
