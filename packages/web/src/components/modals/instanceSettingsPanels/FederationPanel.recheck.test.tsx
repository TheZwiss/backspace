import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { recheckPeer, addToast } = vi.hoisted(() => ({
  recheckPeer: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('../../../api/client', () => ({
  api: {
    federation: {
      peers: vi.fn().mockResolvedValue({ peers: [{
        id: 'p1', origin: 'https://peer.example', instanceName: 'Peer',
        status: 'unreachable', consecutiveFailures: 10, lastSeenAt: Date.now(),
        autoRotateIntervalDays: 90, rotationInProgress: false,
      }] }),
      approvalRequests: vi.fn().mockResolvedValue({ requests: [] }),
      recheckPeer,
    },
  },
}));

vi.mock('../../../stores/uiStore', () => ({
  useUIStore: (sel: (s: { addToast: typeof addToast }) => unknown) => sel({ addToast }),
}));

vi.mock('../../../hooks/useWebSocket', () => ({
  onFederationPeersChanged: () => () => {},
}));

import { FederationPanel } from './FederationPanel';

describe('FederationPanel — Check now', () => {
  beforeEach(() => { recheckPeer.mockReset(); addToast.mockReset(); });

  it('shows Check now for an unreachable peer and recovers it on click', async () => {
    recheckPeer.mockResolvedValue({ recovered: true, status: 'active' });
    render(<FederationPanel />);
    // PeerRow collapses its action buttons; expand the card by clicking its header first.
    const header = await screen.findByText('Peer');
    fireEvent.click(header);
    const btn = await screen.findByText('Check now');
    fireEvent.click(btn);
    await waitFor(() => expect(recheckPeer).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining('back online'), 'success', 3000));
  });
});
