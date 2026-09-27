import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ApprovalRequest } from '@backspace/shared';

const { OUTBOUND } = vi.hoisted((): { OUTBOUND: ApprovalRequest } => ({ OUTBOUND: {
  id: 'req-1',
  origin: 'https://orbit.example',
  instanceName: null,
  requestedAt: Date.now() - 60_000,
  expiresAt: Date.now() + 86_400_000,
  direction: 'outbound',
  subscribers: [
    { userId: 'u1', username: 'erin', triggerReason: 'friend_add', triggerTarget: 'bob@orbit.example' },
    { userId: 'u2', username: 'frank', triggerReason: 'instance_connect', triggerTarget: 'https://orbit.example' },
  ],
} }));

vi.mock('../../../api/client', () => ({
  api: {
    federation: {
      peers: vi.fn().mockResolvedValue({ peers: [] }),
      approvalRequests: vi.fn().mockResolvedValue({ requests: [OUTBOUND] }),
    },
  },
}));

vi.mock('../../../stores/uiStore', () => ({
  useUIStore: (sel: (s: { addToast: () => void }) => unknown) => sel({ addToast: () => {} }),
}));

vi.mock('../../../hooks/useWebSocket', () => ({
  onFederationPeersChanged: () => () => {},
  onFederationPeerResetDetected: () => () => {},
}));

import { FederationPanel } from './FederationPanel';

describe('FederationPanel — who is waiting on an outbound request, and why', () => {
  it('names a connection as a connection, with the host rather than the origin URL', async () => {
    render(<FederationPanel />);

    expect(await screen.findByText(/connected an account on orbit\.example/)).toBeInTheDocument();
    expect(screen.queryByText(/friend-add to https:\/\/orbit\.example/)).not.toBeInTheDocument();
  });

  it('still names a friend add as a friend add', async () => {
    render(<FederationPanel />);

    expect(await screen.findByText(/friend-add to bob@orbit\.example/)).toBeInTheDocument();
  });
});
