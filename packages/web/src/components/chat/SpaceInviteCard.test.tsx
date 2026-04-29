import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SpaceInviteCard } from './SpaceInviteCard';

const mockJoinByCode = vi.fn();
vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: (selector: any) => selector({ joinByCode: mockJoinByCode }),
}));
vi.mock('../../api/client', () => ({
  createApiClient: vi.fn(),
  getApiForOrigin: vi.fn(() => ({
    spaces: { invitePreview:vi.fn() },
  })),
}));
import { getApiForOrigin } from '../../api/client';

const basePayload = {
  event: 'space_invite' as const,
  spaceId: 'S1',
  spaceInstanceOrigin: 'https://z.example',
  inviteCode: 'abc',
  snapshot: {
    spaceName: 'Aether',
    icon: null,
    avatarColor: 'mint' as const,
    memberCount: 12,
    description: 'A place',
    instanceName: 'Backspace',
  },
};

describe('SpaceInviteCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJoinByCode.mockReset();
    mockJoinByCode.mockResolvedValue({ id: 'S1', name: 'Aether' });
  });

  it('renders snapshot fields immediately on mount (snapshot-only state)', () => {
    (getApiForOrigin as any).mockReturnValue({
      spaces: { invitePreview:() => new Promise(() => {}) }, // never resolves
    });
    render(<MemoryRouter><SpaceInviteCard payload={basePayload} senderName="Alice" /></MemoryRouter>);
    expect(screen.getByText('Aether')).toBeInTheDocument();
    expect(screen.getByText(/12 members/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /join/i })).toBeEnabled();
  });

  it('refreshes member count when live preview resolves (live-confirmed state)', async () => {
    (getApiForOrigin as any).mockReturnValue({
      spaces: { invitePreview:vi.fn().mockResolvedValue({ ...basePayload.snapshot, spaceId: 'S1', memberCount: 99 }) },
    });
    render(<MemoryRouter><SpaceInviteCard payload={basePayload} senderName="Alice" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/99 members/i)).toBeInTheDocument());
  });

  it('shows revoked state when preview rejects (revoked state)', async () => {
    (getApiForOrigin as any).mockReturnValue({
      spaces: { invitePreview:vi.fn().mockRejectedValue(new Error('not found')) },
    });
    render(<MemoryRouter><SpaceInviteCard payload={basePayload} senderName="Alice" /></MemoryRouter>);
    await waitFor(() =>
      expect(screen.getByText(/invite no longer valid/i)).toBeInTheDocument(),
    );
    // Join button replaced with disabled pill
    expect(screen.queryByRole('button', { name: /^join$/i })).not.toBeInTheDocument();
  });

  it('Join click passes payload.spaceInstanceOrigin to joinByCode (three-way federation invariant)', async () => {
    // The space's home instance is what Join must target — NOT the DM transport
    // origin, NOT window.location.origin, NOT the recipient's home. Unit-level
    // proof of the three-way federation correctness rule. Runtime cross-instance
    // verification (Task 19) is bonus.
    const userEvent = (await import('@testing-library/user-event')).default;
    const user = userEvent.setup();

    (getApiForOrigin as any).mockReturnValue({
      spaces: { invitePreview:vi.fn().mockResolvedValue({ ...basePayload.snapshot, spaceId: 'S1' }) },
    });

    render(<MemoryRouter><SpaceInviteCard payload={basePayload} senderName="Alice" /></MemoryRouter>);
    const btn = await screen.findByRole('button', { name: /^join$/i });
    await user.click(btn);

    expect(mockJoinByCode).toHaveBeenCalledTimes(1);
    expect(mockJoinByCode).toHaveBeenCalledWith('abc', 'https://z.example');
    // Specifically NOT called with empty string or undefined
    expect(mockJoinByCode).not.toHaveBeenCalledWith('abc', '');
    expect(mockJoinByCode).not.toHaveBeenCalledWith('abc', undefined);
  });
});
