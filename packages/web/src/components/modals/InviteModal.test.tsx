import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

import { InviteModal } from './InviteModal';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';

// Mock the stores by spying on their getState
beforeEach(() => {
  // Reset stores to default state
  useUIStore.setState({
    activeModal: null,
    modalData: {},
  });
  useSpaceStore.setState({
    currentSpaceId: null,
    spaces: [],
  });
});

describe('InviteModal', () => {
  it('does not render when activeModal is not "invite"', () => {
    useUIStore.setState({ activeModal: null });
    render(<InviteModal />);
    expect(screen.queryByText('Invite Friends')).not.toBeInTheDocument();
  });

  it('calls generateInvite and displays the invite URL when opened', async () => {
    const mockGenerateInvite = vi.fn().mockResolvedValue('test-invite-code');
    useUIStore.setState({ activeModal: 'invite' });
    useSpaceStore.setState({
      currentSpaceId: 'server-123',
      generateInvite: mockGenerateInvite,
    });

    render(<InviteModal />);

    // Modal title should be visible
    expect(screen.getByText('Invite Friends')).toBeInTheDocument();

    // Should show "Generating..." initially
    expect(screen.getByDisplayValue('Generating...')).toBeInTheDocument();

    // Wait for the invite code to load
    await waitFor(() => {
      const input = screen.getByDisplayValue(/\/join\/test-invite-code/);
      expect(input).toBeInTheDocument();
    });

    // generateInvite should have been called with the server ID
    expect(mockGenerateInvite).toHaveBeenCalledWith('server-123');
  });

  it('displays an error when generateInvite fails', async () => {
    const mockGenerateInvite = vi.fn().mockRejectedValue(new Error('Not authorized'));
    useUIStore.setState({ activeModal: 'invite' });
    useSpaceStore.setState({
      currentSpaceId: 'server-123',
      generateInvite: mockGenerateInvite,
    });

    render(<InviteModal />);

    await waitFor(() => {
      expect(screen.getByText('Not authorized')).toBeInTheDocument();
    });
  });

  it('Copy button is disabled while loading', () => {
    const mockGenerateInvite = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    useUIStore.setState({ activeModal: 'invite' });
    useSpaceStore.setState({
      currentSpaceId: 'server-123',
      generateInvite: mockGenerateInvite,
    });

    render(<InviteModal />);

    const copyButton = screen.getByText('Copy');
    expect(copyButton).toBeDisabled();
  });

  it('Copy button calls clipboard.writeText with the invite URL', async () => {
    const user = userEvent.setup();
    const mockGenerateInvite = vi.fn().mockResolvedValue('abc123');
    const mockClipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockClipboard },
      writable: true,
      configurable: true,
    });

    useUIStore.setState({ activeModal: 'invite' });
    useSpaceStore.setState({
      currentSpaceId: 'server-123',
      generateInvite: mockGenerateInvite,
    });

    render(<InviteModal />);

    // Wait for invite to load
    await waitFor(() => {
      expect(screen.getByDisplayValue(/\/join\/abc123/)).toBeInTheDocument();
    });

    // Click copy
    const copyButton = screen.getByText('Copy');
    await user.click(copyButton);

    expect(mockClipboard).toHaveBeenCalledWith(expect.stringContaining('/join/abc123'));

    // Button text should change to "Copied!"
    expect(screen.getByText('Copied!')).toBeInTheDocument();
  });
});
