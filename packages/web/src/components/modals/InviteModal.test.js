import { jsx as _jsx } from "react/jsx-runtime";
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InviteModal } from './InviteModal';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
// Mock the stores by spying on their getState
beforeEach(() => {
    // Reset stores to default state
    useUIStore.setState({
        activeModal: null,
        modalData: {},
    });
    useServerStore.setState({
        currentServerId: null,
        servers: [],
    });
});
describe('InviteModal', () => {
    it('does not render when activeModal is not "invite"', () => {
        useUIStore.setState({ activeModal: null });
        render(_jsx(InviteModal, {}));
        expect(screen.queryByText('Invite Friends')).not.toBeInTheDocument();
    });
    it('calls generateInvite and displays the invite URL when opened', async () => {
        const mockGenerateInvite = vi.fn().mockResolvedValue('test-invite-code');
        useUIStore.setState({ activeModal: 'invite' });
        useServerStore.setState({
            currentServerId: 'server-123',
            generateInvite: mockGenerateInvite,
        });
        render(_jsx(InviteModal, {}));
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
        useServerStore.setState({
            currentServerId: 'server-123',
            generateInvite: mockGenerateInvite,
        });
        render(_jsx(InviteModal, {}));
        await waitFor(() => {
            expect(screen.getByText('Not authorized')).toBeInTheDocument();
        });
    });
    it('Copy button is disabled while loading', () => {
        const mockGenerateInvite = vi.fn().mockReturnValue(new Promise(() => { })); // never resolves
        useUIStore.setState({ activeModal: 'invite' });
        useServerStore.setState({
            currentServerId: 'server-123',
            generateInvite: mockGenerateInvite,
        });
        render(_jsx(InviteModal, {}));
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
        useServerStore.setState({
            currentServerId: 'server-123',
            generateInvite: mockGenerateInvite,
        });
        render(_jsx(InviteModal, {}));
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
