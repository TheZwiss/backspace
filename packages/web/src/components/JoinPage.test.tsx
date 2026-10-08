import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { InvitePreview, User } from '@backspace/shared';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

const { mockLocalPreview, mockRemotePreview, mockCreateApiClient, mockNavigate } = vi.hoisted(() => {
  const mockRemotePreview = vi.fn();
  return {
    mockLocalPreview: vi.fn(),
    mockRemotePreview,
    mockCreateApiClient: vi.fn(() => ({ spaces: { invitePreview: mockRemotePreview } })),
    mockNavigate: vi.fn(),
  };
});

// Keep the real exports (HttpError is what the page's checks inspect) and
// replace the preview reads.
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  api: { spaces: { invitePreview: mockLocalPreview } },
  createApiClient: mockCreateApiClient,
}));

vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => mockNavigate,
}));

import { JoinPage } from './JoinPage';
import { HttpError } from '../api/client';
import { useAuthStore } from '../stores/authStore';
import { useSpaceStore, NotConnectedError } from '../stores/spaceStore';
import { useExploreStore } from '../stores/exploreStore';
import { useInstanceStore } from '../stores/instanceStore';
import { JoinRequestRequiredError } from '../utils/joinErrors';

const REMOTE = 'https://orbit.example';

const ME = {
  id: 'me',
  username: 'mira',
  displayName: 'Mira',
  avatar: null,
  avatarColor: null,
} as unknown as User;

function preview(overrides: Partial<InvitePreview> = {}): InvitePreview {
  return {
    spaceId: 'S-REQ',
    spaceName: 'Quiet Harbor',
    description: 'A calm place',
    icon: null,
    avatarColor: 'mint',
    memberCount: 4,
    instanceName: 'Nova',
    visibility: 'request',
    ...overrides,
  };
}

let joinByCode: ReturnType<typeof vi.fn>;
let requestJoinSpace: ReturnType<typeof vi.fn>;
let connectToRemote: ReturnType<typeof vi.fn>;

function renderAt(code: string) {
  return render(
    <MemoryRouter initialEntries={[`/join/${code}`]}>
      <Routes>
        <Route path="/join/:inviteCode" element={<JoinPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function joinRequestRequired(spaceId: string, origin: string): JoinRequestRequiredError {
  return new JoinRequestRequiredError(
    new HttpError(403, 'This space takes join requests', undefined, 'join_request_required', { spaceId }),
    spaceId,
    origin,
  );
}

beforeEach(() => {
  mockLocalPreview.mockReset();
  mockRemotePreview.mockReset();
  mockNavigate.mockReset();
  joinByCode = vi.fn().mockResolvedValue({ id: 'S-REQ' });
  requestJoinSpace = vi.fn().mockResolvedValue({ id: 'jr-1', spaceId: 'S-REQ', status: 'pending' });
  connectToRemote = vi.fn().mockResolvedValue(undefined);
  useAuthStore.setState({ token: 'token', user: ME, isLoading: false });
  useSpaceStore.setState({ joinByCode } as never);
  useExploreStore.setState({ requestJoinSpace, myRequests: [] } as never);
  useInstanceStore.setState({ connectToRemote, instances: [] } as never);
});

describe('JoinPage for a space joined by request', () => {
  it('offers a join request instead of a join, and sends it with the note', async () => {
    const user = userEvent.setup();
    mockLocalPreview.mockResolvedValue(preview());
    renderAt('abc123');

    expect(await screen.findByText('Quiet Harbor')).toBeInTheDocument();
    expect(screen.getByText('This space takes join requests. A manager reviews each one before you can enter.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join as Mira' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Note with your request'), 'Hi from the forum');
    await user.click(screen.getByRole('button', { name: 'Ask to join as Mira' }));

    expect(requestJoinSpace).toHaveBeenCalledWith('S-REQ', '', 'Hi from the forum');
    expect(joinByCode).not.toHaveBeenCalled();
    expect(await screen.findByText('Request sent to Quiet Harbor')).toBeInTheDocument();
    expect(screen.getByText('A manager will review it. The space appears in your list once they approve.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to Backspace' }));
    expect(mockNavigate).toHaveBeenCalledWith('/channels/@me');
  });

  it('says a request is already waiting when the server answers join_request_pending', async () => {
    const user = userEvent.setup();
    mockLocalPreview.mockResolvedValue(preview());
    requestJoinSpace.mockRejectedValue(new HttpError(409, 'pending', undefined, 'join_request_pending'));
    renderAt('abc123');

    await user.click(await screen.findByRole('button', { name: 'Ask to join as Mira' }));

    expect(await screen.findByText('Your request to join Quiet Harbor is waiting')).toBeInTheDocument();
  });

  it('shows the ban refusal as every join path does', async () => {
    const user = userEvent.setup();
    mockLocalPreview.mockResolvedValue(preview());
    requestJoinSpace.mockRejectedValue(new HttpError(403, 'banned', undefined, 'user_banned'));
    renderAt('abc123');

    await user.click(await screen.findByRole('button', { name: 'Ask to join as Mira' }));

    expect(await screen.findByText('You are banned from that space.')).toBeInTheDocument();
    expect(screen.queryByText(/Request sent/)).not.toBeInTheDocument();
  });

  it('treats a member as already in the space', async () => {
    const user = userEvent.setup();
    mockLocalPreview.mockResolvedValue(preview());
    requestJoinSpace.mockRejectedValue(new HttpError(409, 'member', undefined, 'already_member'));
    renderAt('abc123');

    await user.click(await screen.findByRole('button', { name: 'Ask to join as Mira' }));

    expect(await screen.findByText("You're already in Quiet Harbor!")).toBeInTheDocument();
  });

  it('switches to the request when an instance without visibility in its preview refuses the join', async () => {
    const user = userEvent.setup();
    mockLocalPreview.mockResolvedValue(preview({ visibility: undefined }));
    joinByCode.mockRejectedValue(joinRequestRequired('S-REQ', ''));
    renderAt('abc123');

    await user.click(await screen.findByRole('button', { name: 'Join as Mira' }));

    expect(await screen.findByRole('button', { name: 'Ask to join as Mira' })).toBeInTheDocument();
    expect(screen.queryByText(/takes join requests\. Send one/)).not.toBeInTheDocument();
    expect(requestJoinSpace).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Ask to join as Mira' }));
    expect(requestJoinSpace).toHaveBeenCalledWith('S-REQ', '', undefined);
    expect(await screen.findByText('Request sent to Quiet Harbor')).toBeInTheDocument();
  });

  it('shows the waiting request when a join is answered with join_request_pending', async () => {
    const user = userEvent.setup();
    mockLocalPreview.mockResolvedValue(preview({ visibility: undefined }));
    joinByCode.mockRejectedValue(new HttpError(409, 'pending', undefined, 'join_request_pending'));
    renderAt('abc123');

    await user.click(await screen.findByRole('button', { name: 'Join as Mira' }));

    expect(await screen.findByText('Your request to join Quiet Harbor is waiting')).toBeInTheDocument();
  });

  it('joins by the code when the space stopped taking requests after the page loaded', async () => {
    const user = userEvent.setup();
    mockLocalPreview.mockResolvedValue(preview());
    requestJoinSpace.mockRejectedValue(new HttpError(403, 'not requestable', undefined, 'space_not_requestable'));
    joinByCode.mockResolvedValue({ id: 'S-REQ' });
    renderAt('abc123');

    await user.click(await screen.findByRole('button', { name: 'Ask to join as Mira' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/channels/S-REQ'));
    expect(joinByCode).toHaveBeenCalledWith('abc123', undefined);
  });

  it('connects to the space\'s instance first, then sends the request there', async () => {
    const user = userEvent.setup();
    mockRemotePreview.mockResolvedValue(preview({ spaceId: 'R-REQ' }));
    requestJoinSpace
      .mockRejectedValueOnce(new NotConnectedError(REMOTE))
      .mockResolvedValueOnce({ id: 'jr-2', spaceId: 'R-REQ', status: 'pending' });
    renderAt('abc123@orbit.example');

    expect(await screen.findByText('Quiet Harbor')).toBeInTheDocument();
    expect(mockCreateApiClient).toHaveBeenCalledWith(REMOTE, expect.any(Function));

    await user.click(screen.getByRole('button', { name: 'Ask to join as Mira' }));
    const submit = await screen.findByRole('button', { name: 'Connect & Ask to Join' });

    await user.type(screen.getByPlaceholderText('Your account password'), 'pw');
    await user.click(submit);

    expect(connectToRemote).toHaveBeenCalledWith(REMOTE, 'pw', 'Mira');
    expect(requestJoinSpace).toHaveBeenLastCalledWith('R-REQ', REMOTE, undefined);
    expect(await screen.findByText('Request sent to Quiet Harbor')).toBeInTheDocument();
  });

  it('asks a signed-out visitor to log in to ask to join', async () => {
    useAuthStore.setState({ token: null, user: null });
    mockLocalPreview.mockResolvedValue(preview());
    renderAt('abc123');

    expect(await screen.findByRole('link', { name: 'Log in to ask to join' })).toHaveAttribute(
      'href',
      '/login?redirect=/join/abc123',
    );
  });
});

describe('JoinPage for spaces not joined by request', () => {
  it.each(['public', 'private'] as const)('joins a %s space directly', async (visibility) => {
    const user = userEvent.setup();
    mockLocalPreview.mockResolvedValue(preview({ visibility, spaceId: 'S-OPEN' }));
    joinByCode.mockResolvedValue({ id: 'S-OPEN' });
    renderAt('open123');

    await user.click(await screen.findByRole('button', { name: 'Join as Mira' }));

    expect(joinByCode).toHaveBeenCalledWith('open123', undefined);
    expect(requestJoinSpace).not.toHaveBeenCalled();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/channels/S-OPEN'));
    expect(screen.queryByText(/takes join requests/)).not.toBeInTheDocument();
  });
});
