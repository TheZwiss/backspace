import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { peers, resetEvents, resetPeer, initiatePeering, deleteUser, addToast } = vi.hoisted(() => ({
  peers: vi.fn(),
  resetEvents: vi.fn(),
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

function resetEvent(accounts: ReturnType<typeof orphanedAccount>[]) {
  return {
    origin: 'https://peer.example',
    deadEpoch: 'epoch-old',
    newEpoch: 'epoch-new',
    detectedAt: Date.now(),
    resolvedAt: null,
    stubCount: 3,
    orphanedAccountCount: accounts.length,
    orphanedAccounts: accounts,
  };
}

describe('FederationPanel — Reset cleanup', () => {
  beforeEach(() => {
    peers.mockReset();
    resetEvents.mockReset();
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
});
