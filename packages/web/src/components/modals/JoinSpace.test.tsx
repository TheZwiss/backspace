import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via spaceStore → chatStore → useWebSocket → voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { JoinSpaceModal } from './JoinSpace';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

beforeEach(() => {
  mockNavigate.mockClear();
  useUIStore.setState({ activeModal: null });
  useSpaceStore.setState({
    spaces: [],
    currentSpaceId: null,
  });
});

function renderModal() {
  return render(
    <MemoryRouter>
      <JoinSpaceModal />
    </MemoryRouter>
  );
}

describe('JoinSpaceModal', () => {
  it('does not render when activeModal is not "joinSpace"', () => {
    useUIStore.setState({ activeModal: null });
    renderModal();
    expect(screen.queryByText('Join a Space')).not.toBeInTheDocument();
  });

  it('renders the form when opened', () => {
    useUIStore.setState({ activeModal: 'joinSpace' });
    renderModal();
    expect(screen.getByText('Join a Space')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('e.g. abc123 or https://instance.com/join/abc123')
    ).toBeInTheDocument();
    expect(screen.getByText('Join Space')).toBeInTheDocument();
  });

  it('disables the Join Space button while the input is empty', () => {
    useUIStore.setState({ activeModal: 'joinSpace' });
    renderModal();

    // The submit button is the validation gate in this UI — there is no
    // click-to-show-error path. parseInviteInput's 'Invite code is required'
    // branch is defensive only and unreachable from the rendered form.
    expect(screen.getByText('Join Space')).toBeDisabled();
  });

  it('calls joinByCode with the entered invite code and navigates on success', async () => {
    const user = userEvent.setup();
    const mockJoinByCode = vi.fn().mockResolvedValue({ id: 'new-space-id', name: 'Test Space' });
    useUIStore.setState({ activeModal: 'joinSpace' });
    useSpaceStore.setState({ joinByCode: mockJoinByCode });

    renderModal();

    // Type invite code
    const input = screen.getByPlaceholderText('e.g. abc123 or https://instance.com/join/abc123');
    await user.type(input, 'my-invite-code');

    // Click join
    const submitButton = screen.getByText('Join Space');
    await user.click(submitButton);

    // joinByCode(code, origin) — bare code has no origin, so second arg is
    // undefined (parseInviteInput returns { code, origin: undefined }).
    await waitFor(() => {
      expect(mockJoinByCode).toHaveBeenCalledWith('my-invite-code', undefined);
    });

    // Should navigate to the new space
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/channels/new-space-id');
    });

    // Modal should close (activeModal becomes null)
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('shows error message when joinByCode fails', async () => {
    const user = userEvent.setup();
    const mockJoinByCode = vi.fn().mockRejectedValue(new Error('Invalid invite code'));
    useUIStore.setState({ activeModal: 'joinSpace' });
    useSpaceStore.setState({ joinByCode: mockJoinByCode });

    renderModal();

    const input = screen.getByPlaceholderText('e.g. abc123 or https://instance.com/join/abc123');
    await user.type(input, 'bad-code');

    const submitButton = screen.getByText('Join Space');
    await user.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Invalid invite code')).toBeInTheDocument();
    });
  });
});
