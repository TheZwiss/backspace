import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { peers, resetEvents, acknowledgeResetEvent, resetPeer, initiatePeering, deleteUser, addToast } = vi.hoisted(() => ({
  peers: vi.fn(),
  resetEvents: vi.fn(),
  acknowledgeResetEvent: vi.fn(),
  resetPeer: vi.fn(),
  initiatePeering: vi.fn(),
  deleteUser: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('../../../api/client', async () => {
  // Re-export the REAL HttpError so the component's `err instanceof HttpError`
  // classifier and the test's constructed rejection share one class identity.
  const actual = await vi.importActual<typeof import('../../../api/client')>('../../../api/client');
  return {
    ...actual,
    api: {
      federation: {
        peers,
        approvalRequests: vi.fn().mockResolvedValue({ requests: [] }),
        resetEvents,
        acknowledgeResetEvent,
        resetPeer,
        initiatePeering,
      },
      admin: {
        deleteUser,
      },
    },
  };
});

vi.mock('../../../stores/uiStore', () => ({
  useUIStore: (sel: (s: { addToast: typeof addToast }) => unknown) => sel({ addToast }),
}));

vi.mock('../../../hooks/useWebSocket', () => ({
  onFederationPeersChanged: () => () => {},
  onFederationPeerResetDetected: () => () => {},
}));

import { FederationPanel } from './FederationPanel';
import { HttpError } from '../../../api/client';

const resetPeerFixture = {
  id: 'p1',
  origin: 'https://peer.example',
  instanceName: 'Peer',
  status: 'needs_attention' as const,
  needsAttentionReason: 'peer_reset_detected' as const,
  lastSeenAt: Date.now(),
  lastFailureAt: null,
  consecutiveFailures: 0,
  consecutiveAuthFailures: 0,
  lastSyncedAt: Date.now(),
  autoRotateIntervalDays: 90,
  secretRotatedAt: null,
  rotationInProgress: false,
  createdAt: Date.now(),
};

function orphanedAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acc1',
    username: 'ghost',
    displayName: 'Ghost',
    avatarColor: null,
    ownedSpaces: [],
    spaceMemberCount: 2,
    messageCount: 5,
    ...overrides,
  };
}

function resetEvent(
  accounts: ReturnType<typeof orphanedAccount>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    origin: 'https://peer.example',
    deadEpoch: 'epoch-old',
    newEpoch: 'epoch-new',
    detectedAt: Date.now(),
    resolvedAt: null,
    acknowledgedAt: null,
    stubCount: 3,
    orphanedAccountCount: accounts.length,
    orphanedAccounts: accounts,
    ...overrides,
  };
}

describe('FederationPanel — Reset cleanup', () => {
  beforeEach(() => {
    peers.mockReset();
    resetEvents.mockReset();
    acknowledgeResetEvent.mockReset();
    resetPeer.mockReset();
    initiatePeering.mockReset();
    deleteUser.mockReset();
    addToast.mockReset();
  });

  it('shows a Re-peer banner for a peer_reset_detected peer and re-peers on click', async () => {
    peers.mockResolvedValue({ peers: [resetPeerFixture] });
    resetEvents.mockResolvedValue({ events: [] });
    resetPeer.mockResolvedValue({ success: true });
    initiatePeering.mockResolvedValue({ peer: resetPeerFixture });

    render(<FederationPanel />);

    // The banner is a persistent surface — its "Re-peer" button is directly visible.
    const repeerBtn = await screen.findByRole('button', { name: 'Re-peer' });
    fireEvent.click(repeerBtn);

    // Confirm the warning dialog.
    const confirmBtn = await screen.findByRole('button', { name: 'Re-peer & heal' });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(resetPeer).toHaveBeenCalledWith('p1'));
    await waitFor(() =>
      expect(initiatePeering).toHaveBeenCalledWith({ remoteOrigin: 'https://peer.example' }),
    );
    // Order matters: reset BEFORE initiate.
    expect(resetPeer.mock.invocationCallOrder[0]).toBeLessThan(
      initiatePeering.mock.invocationCallOrder[0],
    );
  });

  it('warns when Re-peer completes but the handshake is unverified (verified:false)', async () => {
    peers.mockResolvedValue({ peers: [resetPeerFixture] });
    resetEvents.mockResolvedValue({ events: [] });
    resetPeer.mockResolvedValue({ success: true });
    initiatePeering.mockResolvedValue({
      peer: { ...resetPeerFixture, status: 'needs_attention' },
      verified: false,
    });

    render(<FederationPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Re-peer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Re-peer & heal' }));

    await waitFor(() => expect(initiatePeering).toHaveBeenCalled());
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        'Re-peer incomplete — Peer still holds stale peering for you. Its admin must reset their side, then Re-peer again.',
        'warning',
      ),
    );
    expect(addToast).not.toHaveBeenCalledWith(
      expect.stringContaining('Re-peering initiated'),
      'success',
      expect.anything(),
    );
  });

  it('warns when the remote rejects with 409 PEER_EXISTS_RESET_REQUIRED', async () => {
    peers.mockResolvedValue({ peers: [resetPeerFixture] });
    resetEvents.mockResolvedValue({ events: [] });
    resetPeer.mockResolvedValue({ success: true });
    initiatePeering.mockRejectedValue(
      new HttpError(409, 'Peer exists — reset required', {
        error: 'Peer exists — reset required',
        statusCode: 409,
        code: 'PEER_EXISTS_RESET_REQUIRED',
      }),
    );

    render(<FederationPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Re-peer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Re-peer & heal' }));

    await waitFor(() => expect(initiatePeering).toHaveBeenCalled());
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        'The remote instance still holds stale peering for you. Ask its admin to reset their side, then Re-peer again.',
        'warning',
      ),
    );
  });

  it('shows the success toast when the handshake is verified (verified:true)', async () => {
    peers.mockResolvedValue({ peers: [resetPeerFixture] });
    resetEvents.mockResolvedValue({ events: [] });
    resetPeer.mockResolvedValue({ success: true });
    initiatePeering.mockResolvedValue({
      peer: { ...resetPeerFixture, status: 'active' },
      verified: true,
    });

    render(<FederationPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Re-peer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Re-peer & heal' }));

    await waitFor(() => expect(initiatePeering).toHaveBeenCalled());
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith('Re-peering initiated with Peer', 'success', 3000),
    );
    expect(addToast).not.toHaveBeenCalledWith(
      expect.stringContaining('still holds stale peering'),
      'warning',
    );
  });

  it('removes an orphaned account via the existing admin delete', async () => {
    peers.mockResolvedValue({ peers: [] });
    resetEvents.mockResolvedValue({ events: [resetEvent([orphanedAccount()])] });
    deleteUser.mockResolvedValue({ success: true });

    render(<FederationPanel />);

    const removeBtn = await screen.findByRole('button', { name: 'Remove' });
    fireEvent.click(removeBtn);

    const confirmBtn = await screen.findByRole('button', { name: 'Delete permanently' });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(deleteUser).toHaveBeenCalledWith('acc1'));
  });

  it('surfaces "transfer ownership first" only when the 400 carries an ownedSpaces payload', async () => {
    peers.mockResolvedValue({ peers: [] });
    // Isolate the classifier: the fixture account does NOT own spaces locally
    // (default ownedSpaces: []), so the transfer-first message can only come
    // from the error's `ownedSpaces` payload — the real server 400 shape.
    resetEvents.mockResolvedValue({ events: [resetEvent([orphanedAccount()])] });
    deleteUser.mockRejectedValue(
      new HttpError(400, 'User owns spaces — transfer ownership first', {
        error: 'User owns spaces — transfer ownership first',
        statusCode: 400,
        ownedSpaces: [{ id: 's1', name: 'My Space' }],
      }),
    );

    render(<FederationPanel />);

    const removeBtn = await screen.findByRole('button', { name: 'Remove' });
    fireEvent.click(removeBtn);

    const confirmBtn = await screen.findByRole('button', { name: 'Delete permanently' });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(deleteUser).toHaveBeenCalledWith('acc1'));
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        expect.stringContaining('transfer ownership first'),
        'warning',
      ),
    );
  });

  it('shows the generic failure toast for a rejection WITHOUT an ownedSpaces payload', async () => {
    peers.mockResolvedValue({ peers: [] });
    resetEvents.mockResolvedValue({ events: [resetEvent([orphanedAccount()])] });
    deleteUser.mockRejectedValue(
      new HttpError(400, 'Internal server error', { error: 'Internal server error', statusCode: 400 }),
    );

    render(<FederationPanel />);

    const removeBtn = await screen.findByRole('button', { name: 'Remove' });
    fireEvent.click(removeBtn);

    const confirmBtn = await screen.findByRole('button', { name: 'Delete permanently' });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(deleteUser).toHaveBeenCalledWith('acc1'));
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith('Internal server error', 'warning'),
    );
    // The classifier must NOT mislabel a generic 400 as an ownership problem.
    expect(addToast).not.toHaveBeenCalledWith(
      expect.stringContaining('transfer ownership first'),
      'warning',
    );
  });

  it('renders the detached-accounts card with Dismiss + Remove and informational copy, no Keep/frozen', async () => {
    peers.mockResolvedValue({ peers: [] });
    resetEvents.mockResolvedValue({ events: [resetEvent([orphanedAccount()])] });

    render(<FederationPanel />);

    // Both real actions are present.
    await screen.findByRole('button', { name: /Dismiss/ });
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();

    // Informational detach copy — not urgent-cleanup language.
    expect(screen.getAllByText(/detached/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/existing password/i)).toBeInTheDocument();

    // The fake client-only Keep/frozen affordance is fully gone.
    expect(screen.queryByRole('button', { name: 'Keep' })).not.toBeInTheDocument();
    expect(screen.queryByText(/frozen/i)).not.toBeInTheDocument();
    // No "orphaned" urgency wording in the detached-accounts copy.
    expect(screen.queryByText(/with local content orphaned/i)).not.toBeInTheDocument();
  });

  it('does not render an acknowledged event and excludes it from the badge count', async () => {
    peers.mockResolvedValue({ peers: [] });
    resetEvents.mockResolvedValue({
      events: [resetEvent([orphanedAccount()], { acknowledgedAt: 1234 })],
    });

    render(<FederationPanel />);

    // Give effects a chance to run, then assert the whole section stays absent.
    await waitFor(() => expect(resetEvents).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText('Reset Cleanup')).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument();
  });

  it('dismisses an event via the acknowledge API and re-fetches', async () => {
    peers.mockResolvedValue({ peers: [] });
    // First load: unacknowledged. After acknowledge, re-fetch returns it acknowledged.
    resetEvents
      .mockResolvedValueOnce({ events: [resetEvent([orphanedAccount()])] })
      .mockResolvedValue({ events: [resetEvent([orphanedAccount()], { acknowledgedAt: 1234 })] });
    acknowledgeResetEvent.mockResolvedValue({ success: true });

    render(<FederationPanel />);

    const dismissBtn = await screen.findByRole('button', { name: /Dismiss/ });
    fireEvent.click(dismissBtn);

    await waitFor(() =>
      expect(acknowledgeResetEvent).toHaveBeenCalledWith('https://peer.example'),
    );
    // fetchAll re-runs after acknowledge (peers + resetEvents both hit twice).
    await waitFor(() => expect(resetEvents).toHaveBeenCalledTimes(2));
    // The card disappears once the re-fetch marks the event acknowledged.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument(),
    );
  });

  it('surfaces an error toast when dismiss fails', async () => {
    peers.mockResolvedValue({ peers: [] });
    resetEvents.mockResolvedValue({ events: [resetEvent([orphanedAccount()])] });
    acknowledgeResetEvent.mockRejectedValue(new Error('Network down'));

    render(<FederationPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /Dismiss/ }));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith('Network down', 'warning'),
    );
  });
});
