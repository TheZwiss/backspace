import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@backspace/shared';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// The shared connect path is a module export, not a store action, so it is
// replaced at the module boundary; the store itself stays real.
const { connectToInstance } = vi.hoisted(() => ({ connectToInstance: vi.fn() }));
vi.mock('../../stores/instanceStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/instanceStore')>();
  return { ...actual, connectToInstance };
});

import { ConnectedInstances } from './ConnectedInstances';
import { useInstanceStore } from '../../stores/instanceStore';
import { useAuthStore } from '../../stores/authStore';
import { useFederationStore } from '../../stores/federationStore';

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

const probeInstance = vi.fn();
const loginToRemote = vi.fn();

beforeEach(() => {
  connectToInstance.mockReset();
  probeInstance.mockReset();
  loginToRemote.mockReset();
  probeInstance.mockResolvedValue({
    name: 'Retro',
    version: '1.0.0',
    registrationOpen: true,
    federatedRegistrationOpen: true,
    instanceId: 'retro',
    sourceCodeUrl: null,
    commit: null,
    directoryEnabled: false,
    origin: 'https://retro.example',
  });
  useInstanceStore.setState({ instances: [], registry: new Map(), probeInstance, loginToRemote });
  useAuthStore.setState({ user: homeUser });
  useFederationStore.setState({
    peeringSubscriptions: [],
    peeringNotifications: [],
    refetchPeeringSubscriptions: vi.fn(async () => {}),
    refetchPeeringNotifications: vi.fn(async () => {}),
  });
});

async function openPasswordStep(user: ReturnType<typeof userEvent.setup>) {
  render(
    <MemoryRouter>
      <ConnectedInstances />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('button', { name: '+ Add Instance' }));
  await user.type(screen.getByPlaceholderText('https://instance.example.com'), 'retro.example');
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  expect(await screen.findByText('Enter your password to connect to retro.example')).toBeInTheDocument();
  expect(probeInstance).toHaveBeenCalledWith('retro.example');
}

describe('AddInstanceFlow', () => {
  it('renders the password step after the probe and connects with the typed password', async () => {
    const user = userEvent.setup();
    connectToInstance.mockResolvedValue({ kind: 'connected', how: 'new' });
    await openPasswordStep(user);

    expect(screen.getByText('Retro')).toBeInTheDocument();
    expect(screen.getByText('https://retro.example')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Your account password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(connectToInstance).toHaveBeenCalledWith('https://retro.example', 'hunter2', 'Jannis'));
    // onDone: the flow closes and the add button is back.
    expect(await screen.findByRole('button', { name: '+ Add Instance' })).toBeInTheDocument();
  });

  it('falls back to the remote login form when the home credential is refused', async () => {
    const user = userEvent.setup();
    connectToInstance.mockResolvedValue({ kind: 'needs-remote-password', remoteUsername: 'jannis-old' });
    loginToRemote.mockResolvedValue(undefined);
    await openPasswordStep(user);

    await user.type(screen.getByPlaceholderText('Your account password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText(/An account already exists on this instance/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('jannis-old')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Password on the remote instance'), 'other-pw');
    await user.click(screen.getByRole('button', { name: 'Login & Connect' }));

    await waitFor(() => expect(loginToRemote).toHaveBeenCalledWith('https://retro.example', 'jannis-old', 'other-pw'));
    expect(await screen.findByRole('button', { name: '+ Add Instance' })).toBeInTheDocument();
  });
});
