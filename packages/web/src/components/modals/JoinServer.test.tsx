import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { JoinServerModal } from './JoinServer';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';

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
  useServerStore.setState({
    servers: [],
    currentServerId: null,
  });
});

function renderModal() {
  return render(
    <MemoryRouter>
      <JoinServerModal />
    </MemoryRouter>
  );
}

describe('JoinServerModal', () => {
  it('does not render when activeModal is not "joinServer"', () => {
    useUIStore.setState({ activeModal: null });
    renderModal();
    expect(screen.queryByText('Join a Server')).not.toBeInTheDocument();
  });

  it('renders the form when opened', () => {
    useUIStore.setState({ activeModal: 'joinServer' });
    renderModal();
    expect(screen.getByText('Join a Server')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. abc123')).toBeInTheDocument();
    expect(screen.getByText('Join Server')).toBeInTheDocument();
  });

  it('shows validation error when submitting empty code', async () => {
    const user = userEvent.setup();
    useUIStore.setState({ activeModal: 'joinServer' });
    renderModal();

    const submitButton = screen.getByText('Join Server');
    await user.click(submitButton);

    expect(screen.getByText('Invite code is required')).toBeInTheDocument();
  });

  it('calls joinByCode with the entered invite code and navigates on success', async () => {
    const user = userEvent.setup();
    const mockJoinByCode = vi.fn().mockResolvedValue({ id: 'new-server-id', name: 'Test Server' });
    useUIStore.setState({ activeModal: 'joinServer' });
    useServerStore.setState({ joinByCode: mockJoinByCode });

    renderModal();

    // Type invite code
    const input = screen.getByPlaceholderText('e.g. abc123');
    await user.type(input, 'my-invite-code');

    // Click join
    const submitButton = screen.getByText('Join Server');
    await user.click(submitButton);

    // joinByCode should be called with the code
    await waitFor(() => {
      expect(mockJoinByCode).toHaveBeenCalledWith('my-invite-code');
    });

    // Should navigate to the new server
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/channels/new-server-id');
    });

    // Modal should close (activeModal becomes null)
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('shows error message when joinByCode fails', async () => {
    const user = userEvent.setup();
    const mockJoinByCode = vi.fn().mockRejectedValue(new Error('Invalid invite code'));
    useUIStore.setState({ activeModal: 'joinServer' });
    useServerStore.setState({ joinByCode: mockJoinByCode });

    renderModal();

    const input = screen.getByPlaceholderText('e.g. abc123');
    await user.type(input, 'bad-code');

    const submitButton = screen.getByText('Join Server');
    await user.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Invalid invite code')).toBeInTheDocument();
    });
  });
});
