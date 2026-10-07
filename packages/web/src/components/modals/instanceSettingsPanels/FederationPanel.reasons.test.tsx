import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { FederationPeer } from '@backspace/shared';

const { peers } = vi.hoisted(() => ({ peers: vi.fn() }));

vi.mock('../../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../api/client')>('../../../api/client');
  return {
    ...actual,
    api: {
      federation: {
        peers,
        approvalRequests: vi.fn().mockResolvedValue({ requests: [] }),
        resetEvents: vi.fn().mockResolvedValue({ events: [] }),
      },
      admin: {},
    },
  };
});

vi.mock('../../../stores/uiStore', () => ({
  useUIStore: (sel: (s: { addToast: () => void }) => unknown) => sel({ addToast: () => {} }),
}));

vi.mock('../../../hooks/useWebSocket', () => ({
  onFederationPeersChanged: () => () => {},
  onFederationPeerResetDetected: () => () => {},
}));

import { FederationPanel } from './FederationPanel';

function peer(id: string, host: string, status: FederationPeer['status'], statusReason: FederationPeer['statusReason']): FederationPeer {
  return {
    id,
    origin: `https://${host}`,
    instanceName: null,
    status,
    statusReason,
    lastSeenAt: Date.now(),
    lastFailureAt: null,
    consecutiveFailures: 0,
    consecutiveAuthFailures: 5,
    lastSyncedAt: Date.now(),
    autoRotateIntervalDays: 90,
    secretRotatedAt: null,
    rotationInProgress: false,
    createdAt: Date.now(),
  };
}

describe('FederationPanel: why a peer needs attention or was rejected (#324)', () => {
  beforeEach(() => {
    peers.mockReset();
  });

  it('shows the reason on the row of a peer the auth-failure threshold moved to needs_attention', async () => {
    peers.mockResolvedValue({ peers: [peer('p1', 'drift.example', 'needs_attention', 'auth_failures')] });
    render(<FederationPanel />);
    expect(await screen.findByText('Signed deliveries keep failing')).toBeTruthy();
  });

  it('tells each rejected reason apart and explains it when the row is opened', async () => {
    peers.mockResolvedValue({
      peers: [
        peer('p1', 'strict.example', 'rejected', 'denied_by_remote'),
        peer('p2', 'parked.example', 'rejected', 'stale_peering_on_remote'),
      ],
    });
    render(<FederationPanel />);

    expect(await screen.findByText('Declined by their admin')).toBeTruthy();
    fireEvent.click(await screen.findByText('Their side holds an older peering'));
    expect(await screen.findByText(/parked\.example still holds an older peering with this instance/)).toBeTruthy();
  });

  it('shows no reason for a healthy peer', async () => {
    peers.mockResolvedValue({ peers: [peer('p1', 'orbit.example', 'active', null)] });
    render(<FederationPanel />);
    expect(await screen.findByText('orbit.example')).toBeTruthy();
    expect(screen.queryByText('Signed deliveries keep failing')).toBeNull();
  });
});
