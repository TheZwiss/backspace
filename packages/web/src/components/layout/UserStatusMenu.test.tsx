import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Reached transitively through the stores; jsdom has no AudioWorkletNode.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { UserStatusMenu } from './UserStatusMenu';

function makeUser(fields: Partial<User> = {}): User {
  return {
    id: 'me',
    username: 'me',
    displayName: 'Me',
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
    ...fields,
  } as User;
}

beforeEach(() => {
  useAuthStore.setState({ user: makeUser(), trueHomeStatus: null, updateProfile: vi.fn() });
  useUIStore.setState({ activeModal: null, modalData: {} });
});

afterEach(() => {
  useAuthStore.setState({ user: null, trueHomeStatus: null });
});

describe('UserStatusMenu', () => {
  it('writes the chosen status through updateProfile', async () => {
    const updateProfile = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ updateProfile });
    const onClose = vi.fn();

    render(<UserStatusMenu onClose={onClose} />);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Do Not Disturb' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ status: 'dnd' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the true-home refusal instead of pretending the status changed', async () => {
    const message = 'Your status is kept on nova.example. Connect to nova.example to change it.';
    useAuthStore.setState({ updateProfile: vi.fn().mockRejectedValue(new Error(message)) });

    render(<UserStatusMenu onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Idle' }));

    expect(await screen.findByText(message)).toBeTruthy();
  });

  it('saves and clears the custom status', async () => {
    const updateProfile = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ updateProfile });

    const { rerender } = render(<UserStatusMenu onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('What are you up to?');
    fireEvent.change(input, { target: { value: '  shipping  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ customStatus: 'shipping' }));

    useAuthStore.setState({ user: makeUser({ customStatus: 'shipping' }) });
    rerender(<UserStatusMenu onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ customStatus: '' }));
  });

  it('opens the account settings from the edit-profile row', () => {
    render(<UserStatusMenu onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));

    expect(useUIStore.getState().activeModal).toBe('userSettings');
    expect(useUIStore.getState().modalData).toMatchObject({ tab: 'account' });
  });
});
