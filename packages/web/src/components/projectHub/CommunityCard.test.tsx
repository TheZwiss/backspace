import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DirectoryDocument, DirectoryDocumentSpace, SpaceWithChannelsAndMembers } from '@backspace/shared';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { CommunityCard, communityStatus, parseDirectoryListing } from './CommunityCard';
import type { CommunityTarget } from '../../utils/projectLinks';
import { useExploreStore, type TaggedExploreSpace, type TaggedJoinRequest } from '../../stores/exploreStore';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const REMOTE = 'https://community.example';

function docSpace(overrides: Partial<DirectoryDocumentSpace> = {}): DirectoryDocumentSpace {
  return {
    id: 'space-1',
    name: 'Backspace',
    description: 'Where the project is discussed.',
    icon: null,
    banner: null,
    avatarColor: 'mint',
    visibility: 'public',
    memberCount: 42,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function doc(overrides: Partial<DirectoryDocument> = {}): DirectoryDocument {
  return {
    schema: 1,
    origin: REMOTE,
    instance: { name: 'Backspace Community', federatedRegistrationOpen: true, version: '1.5.1' },
    spaces: [docSpace()],
    ...overrides,
  };
}

function taggedSpace(id: string, origin: string): TaggedSpace {
  return {
    id,
    name: 'Backspace',
    icon: null,
    banner: null,
    avatarColor: null,
    ownerId: 'owner',
    inviteCode: null,
    visibility: 'public',
    directoryListed: true,
    description: null,
    createdAt: 1,
    _instanceOrigin: origin,
  };
}

function request(spaceId: string, origin: string, status: TaggedJoinRequest['status'] = 'pending'): TaggedJoinRequest {
  return {
    id: `req-${spaceId}`,
    spaceId,
    userId: 'u1',
    message: null,
    status,
    decidedBy: null,
    createdAt: 1,
    decidedAt: null,
    _instanceOrigin: origin,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── parseDirectoryListing ────────────────────────────────────────────────────

const INSTANCE = { name: 'Backspace Community', federatedRegistrationOpen: true };

function listed(space: DirectoryDocumentSpace = docSpace()) {
  return { ok: true, instance: INSTANCE, space };
}

const unreachable = { ok: false, reason: 'unreachable' };
const notListed = { ok: false, reason: 'notListed' };

describe('parseDirectoryListing', () => {
  it('finds the space in a well-formed document', () => {
    expect(parseDirectoryListing(doc(), 'space-1')).toEqual(listed());
  });

  it('reads the instance without a version', () => {
    const raw = { ...doc(), instance: { name: 'Backspace Community', federatedRegistrationOpen: true } };
    expect(parseDirectoryListing(raw, 'space-1')).toEqual(listed());
  });

  it('copies known fields only, so nothing unexpected reaches the join entry', () => {
    const raw = {
      ...doc(),
      extra: 'x',
      instance: { ...INSTANCE, version: '1.5.1', injected: true },
      spaces: [{ ...docSpace(), injected: true }],
    };
    const parsed = parseDirectoryListing(raw, 'space-1');
    expect(parsed).toEqual(listed());
    expect(parsed.ok && parsed.space).not.toHaveProperty('injected');
    expect(parsed.ok && parsed.instance).not.toHaveProperty('injected');
  });

  it('reads an unknown avatar colour as null rather than failing the space', () => {
    const raw = { ...doc(), spaces: [{ ...docSpace(), avatarColor: 'chartreuse' }] };
    expect(parseDirectoryListing(raw, 'space-1')).toEqual(listed(docSpace({ avatarColor: null })));
  });

  it('says notListed when the document does not carry the space', () => {
    expect(parseDirectoryListing(doc({ spaces: [docSpace({ id: 'another' })] }), 'space-1')).toEqual(notListed);
    expect(parseDirectoryListing(doc({ spaces: [] }), 'space-1')).toEqual(notListed);
  });

  it('ignores a malformed space that is not the one asked for', () => {
    const raw = {
      ...doc(),
      spaces: [
        { ...docSpace({ id: 'broken' }), memberCount: 'many', visibility: 'private' },
        'not a space',
        null,
        docSpace(),
      ],
    };
    expect(parseDirectoryListing(raw, 'space-1')).toEqual(listed());
  });

  it('says unreachable for a document with another schema', () => {
    expect(parseDirectoryListing({ ...doc(), schema: 2 }, 'space-1')).toEqual(unreachable);
  });

  it('says unreachable for a document without an instance object', () => {
    const rest: Partial<DirectoryDocument> = doc();
    delete rest.instance;
    expect(parseDirectoryListing(rest, 'space-1')).toEqual(unreachable);
    expect(parseDirectoryListing({ ...rest, instance: 'Backspace' }, 'space-1')).toEqual(unreachable);
  });

  it('says unreachable for an instance with a missing name or a non-boolean registration flag', () => {
    expect(parseDirectoryListing({ ...doc(), instance: { federatedRegistrationOpen: true, version: null } }, 'space-1'))
      .toEqual(unreachable);
    expect(parseDirectoryListing({ ...doc(), instance: { name: 'X', federatedRegistrationOpen: 'yes', version: null } }, 'space-1'))
      .toEqual(unreachable);
  });

  it('says unreachable when the matching space has a visibility other than public or request', () => {
    expect(parseDirectoryListing({ ...doc(), spaces: [{ ...docSpace(), visibility: 'private' }] }, 'space-1'))
      .toEqual(unreachable);
  });

  it('says unreachable when the matching space has a wrongly typed field', () => {
    expect(parseDirectoryListing({ ...doc(), spaces: [{ ...docSpace(), memberCount: '42' }] }, 'space-1'))
      .toEqual(unreachable);
    expect(parseDirectoryListing({ ...doc(), spaces: [{ ...docSpace(), name: 7 }] }, 'space-1'))
      .toEqual(unreachable);
  });

  it('says unreachable for a document whose spaces are not an array', () => {
    expect(parseDirectoryListing({ ...doc(), spaces: {} }, 'space-1')).toEqual(unreachable);
  });

  it.each([null, undefined, 'document', 42, [], true])('says unreachable for the non-object %j', (value) => {
    expect(parseDirectoryListing(value, 'space-1')).toEqual(unreachable);
  });
});

// ── communityStatus ──────────────────────────────────────────────────────────

describe('communityStatus', () => {
  const HOME = 'https://home.example';

  it('is member for a home space tagged with the empty origin', () => {
    const target: CommunityTarget = { origin: HOME, spaceId: 'space-1' };
    expect(communityStatus(target, HOME, [taggedSpace('space-1', '')], [])).toBe('member');
  });

  it('is member for a remote space whatever the trailing slash or case of either origin', () => {
    const target: CommunityTarget = { origin: 'https://Community.Example', spaceId: 'space-1' };
    expect(communityStatus(target, HOME, [taggedSpace('space-1', 'https://community.example/')], [])).toBe('member');
    expect(
      communityStatus({ origin: REMOTE, spaceId: 'space-1' }, HOME, [taggedSpace('space-1', 'HTTPS://COMMUNITY.EXAMPLE')], []),
    ).toBe('member');
  });

  it('is pending when a pending request matches on origin and space id', () => {
    const target: CommunityTarget = { origin: REMOTE, spaceId: 'space-1' };
    expect(communityStatus(target, HOME, [], [request('space-1', `${REMOTE}/`)])).toBe('pending');
    const home: CommunityTarget = { origin: HOME, spaceId: 'space-1' };
    expect(communityStatus(home, `${HOME}/`, [], [request('space-1', '')])).toBe('pending');
  });

  it('ignores requests that are no longer pending', () => {
    const target: CommunityTarget = { origin: REMOTE, spaceId: 'space-1' };
    expect(communityStatus(target, HOME, [], [request('space-1', REMOTE, 'declined')])).toBe('not-member');
  });

  it('prefers member over a stale pending request', () => {
    const target: CommunityTarget = { origin: REMOTE, spaceId: 'space-1' };
    expect(communityStatus(target, HOME, [taggedSpace('space-1', REMOTE)], [request('space-1', REMOTE)])).toBe('member');
  });

  it('is not-member with nothing to match', () => {
    expect(communityStatus({ origin: REMOTE, spaceId: 'space-1' }, HOME, [], [])).toBe('not-member');
  });

  it('never matches a same-id space or request on a different origin', () => {
    const target: CommunityTarget = { origin: REMOTE, spaceId: 'space-1' };
    // Space ids are instance-local: `space-1` at home is a different space.
    expect(communityStatus(target, HOME, [taggedSpace('space-1', '')], [request('space-1', '')])).toBe('not-member');
    expect(
      communityStatus(target, HOME, [taggedSpace('space-1', 'https://other.example')], [request('space-1', 'https://other.example')]),
    ).toBe('not-member');
  });

  it('never matches when the target origin does not parse', () => {
    expect(communityStatus({ origin: 'not a url', spaceId: 'space-1' }, HOME, [taggedSpace('space-1', 'not a url')], [])).toBe('not-member');
  });
});

// ── CommunityCard ────────────────────────────────────────────────────────────

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const fetchMyRequests = vi.fn(async () => {});
const publicJoin = vi.fn<(space: TaggedExploreSpace) => Promise<SpaceWithChannelsAndMembers>>();
const requestJoin = vi.fn();
const setCurrentSpace = vi.fn();
const setMobileTab = vi.fn();
const openModal = vi.fn((modal: Parameters<ReturnType<typeof useUIStore.getState>['openModal']>[0], data?: Record<string, unknown>) => {
  useUIStore.setState({ activeModal: modal, modalData: data ?? {} });
});

const remoteTarget: CommunityTarget = { origin: REMOTE, spaceId: 'space-1' };
function homeTarget(): CommunityTarget {
  return { origin: window.location.origin, spaceId: 'space-1' };
}

function joinButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Join' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  useExploreStore.setState({ myRequests: [], fetchMyRequests, publicJoin, requestJoin });
  useSpaceStore.setState({ spaces: [], setCurrentSpace });
  useUIStore.setState({ isMobile: false, activeModal: null, modalData: {}, openModal, setMobileTab });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CommunityCard', () => {
  it('contacts no other instance on mount and asks for pending requests once', () => {
    render(<CommunityCard target={remoteTarget} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchMyRequests).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('article', { name: 'Join the Backspace community' })).toHaveTextContent(
      'Talk to the people who build Backspace, ask questions and share feedback.',
    );
  });

  it('shows Join while idle and disables it while the listing loads', async () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    render(<CommunityCard target={remoteTarget} />);
    expect(joinButton()).toBeEnabled();

    fireEvent.click(joinButton());

    await waitFor(() => expect(joinButton()).toBeDisabled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${REMOTE}/api/directory/spaces`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('says the instance is unreachable on a 500 and loads again from Try again', async () => {
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 500 }));
    render(<CommunityCard target={remoteTarget} />);
    fireEvent.click(joinButton());

    expect(await screen.findByText('The community instance could not be reached.')).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(jsonResponse(doc()));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(openModal).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says the instance is unreachable when the answer is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>proxy error</html>', { status: 200 }));
    render(<CommunityCard target={remoteTarget} />);
    fireEvent.click(joinButton());
    expect(await screen.findByText('The community instance could not be reached.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('says the instance is unreachable when the JSON is not a directory document', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...doc(), schema: 2 }));
    render(<CommunityCard target={remoteTarget} />);
    fireEvent.click(joinButton());
    expect(await screen.findByText('The community instance could not be reached.')).toBeInTheDocument();
  });

  it('says the instance is unreachable on a network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<CommunityCard target={remoteTarget} />);
    fireEvent.click(joinButton());
    expect(await screen.findByText('The community instance could not be reached.')).toBeInTheDocument();
  });

  it('gives up after ten seconds and says the instance is unreachable', async () => {
    // AbortSignal.timeout runs on the runtime's own timers, which fake timers
    // do not reach, so the timeout signal is replaced by one the test fires.
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    fetchMock.mockImplementation((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
    );
    render(<CommunityCard target={remoteTarget} />);
    fireEvent.click(joinButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(timeout.signal);
    expect(joinButton()).toBeDisabled();

    await act(async () => { timeout.abort(new DOMException('The operation timed out.', 'TimeoutError')); });

    expect(await screen.findByText('The community instance could not be reached.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('says the space is not available when a valid document does not list it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(doc({ spaces: [docSpace({ id: 'another' })] })));
    render(<CommunityCard target={remoteTarget} />);
    fireEvent.click(joinButton());
    expect(await screen.findByText('The community space is not available right now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(openModal).not.toHaveBeenCalled();
  });

  it('says the instance is unreachable when the space it lists is malformed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...doc(), spaces: [{ ...docSpace(), memberCount: '42' }] }));
    render(<CommunityCard target={remoteTarget} />);
    fireEvent.click(joinButton());
    expect(await screen.findByText('The community instance could not be reached.')).toBeInTheDocument();
    expect(openModal).not.toHaveBeenCalled();
  });

  it('joins when another space in the document is malformed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...doc(),
      spaces: [{ ...docSpace({ id: 'broken' }), visibility: 'private', memberCount: null }, docSpace()],
    }));
    render(<CommunityCard target={remoteTarget} />);
    fireEvent.click(joinButton());

    await waitFor(() => expect(openModal).toHaveBeenCalledTimes(1));
    expect(openModal).toHaveBeenCalledWith('connectAndJoin', {
      entry: {
        ...docSpace(),
        origin: REMOTE,
        instanceName: 'Backspace Community',
        federatedRegistrationOpen: true,
      },
    });
  });

  it('hands a remote space to the connect-and-join dialog under the configured origin', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(doc({ origin: 'https://impostor.example' })));
    render(<CommunityCard target={remoteTarget} />);
    fireEvent.click(joinButton());

    await waitFor(() => expect(openModal).toHaveBeenCalledTimes(1));
    expect(openModal).toHaveBeenCalledWith('connectAndJoin', {
      entry: {
        ...docSpace(),
        origin: REMOTE,
        instanceName: 'Backspace Community',
        federatedRegistrationOpen: true,
      },
    });
    // The card is back to its resting state under the dialog.
    expect(joinButton()).toBeEnabled();
    expect(publicJoin).not.toHaveBeenCalled();
  });

  it('asks for pending requests again when the dialog closes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(doc({ spaces: [docSpace({ visibility: 'request' })] })));
    render(<CommunityCard target={remoteTarget} />);
    expect(fetchMyRequests).toHaveBeenCalledTimes(1);
    fireEvent.click(joinButton());
    await waitFor(() => expect(useUIStore.getState().activeModal).toBe('connectAndJoin'));
    expect(fetchMyRequests).toHaveBeenCalledTimes(1);

    act(() => { useUIStore.setState({ activeModal: null, modalData: {} }); });

    expect(fetchMyRequests).toHaveBeenCalledTimes(2);
    act(() => { useExploreStore.setState({ myRequests: [request('space-1', REMOTE)] }); });
    expect(screen.getByRole('button', { name: 'Request sent' })).toBeDisabled();
  });

  it('shows a disabled Request sent while a request is pending', () => {
    useExploreStore.setState({ myRequests: [request('space-1', REMOTE)] });
    render(<CommunityCard target={remoteTarget} />);
    expect(screen.getByRole('button', { name: 'Request sent' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
  });

  it('shows Open for a member and lands in the space', () => {
    useSpaceStore.setState({ spaces: [taggedSpace('space-1', REMOTE)] });
    render(<CommunityCard target={remoteTarget} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(setCurrentSpace).toHaveBeenCalledWith('space-1');
    expect(mockNavigate).toHaveBeenCalledWith('/channels/space-1');
    expect(setCurrentSpace.mock.invocationCallOrder[0]).toBeLessThan(mockNavigate.mock.invocationCallOrder[0]);
    expect(setMobileTab).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('switches to the Spaces tab before landing on mobile', () => {
    useUIStore.setState({ isMobile: true });
    useSpaceStore.setState({ spaces: [taggedSpace('space-1', REMOTE)] });
    render(<CommunityCard target={remoteTarget} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(setMobileTab).toHaveBeenCalledWith('spaces');
    expect(setCurrentSpace.mock.invocationCallOrder[0]).toBeLessThan(setMobileTab.mock.invocationCallOrder[0]);
    expect(setMobileTab.mock.invocationCallOrder[0]).toBeLessThan(mockNavigate.mock.invocationCallOrder[0]);
  });

  it('joins a public home space through useSpaceJoin and lands in it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(doc({ origin: window.location.origin })));
    publicJoin.mockResolvedValueOnce({ id: 'space-1' } as SpaceWithChannelsAndMembers);
    render(<CommunityCard target={homeTarget()} />);

    fireEvent.click(joinButton());

    await waitFor(() => expect(publicJoin).toHaveBeenCalledTimes(1));
    expect(publicJoin).toHaveBeenCalledWith({ ...docSpace(), _instanceOrigin: '', joined: false });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/channels/space-1'));
    expect(setCurrentSpace).toHaveBeenCalledWith('space-1');
    expect(openModal).not.toHaveBeenCalled();
  });

  it('shows the join error for a home space and joins again from Try again', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(doc({ origin: window.location.origin })));
    publicJoin.mockRejectedValueOnce(new Error('You are banned from this space'));
    render(<CommunityCard target={homeTarget()} />);

    fireEvent.click(joinButton());

    expect(await screen.findByText('You are banned from this space')).toBeInTheDocument();
    publicJoin.mockResolvedValueOnce({ id: 'space-1' } as SpaceWithChannelsAndMembers);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/channels/space-1'));
    expect(publicJoin).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks for a request message inline for a home request space and then shows Request sent', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(doc({ origin: window.location.origin, spaces: [docSpace({ visibility: 'request' })] })),
    );
    requestJoin.mockResolvedValueOnce(request('space-1', ''));
    render(<CommunityCard target={homeTarget()} />);

    fireEvent.click(joinButton());

    const field = await screen.findByPlaceholderText('Why do you want to join? (optional)');
    fireEvent.change(field, { target: { value: '  I build federation features  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Request' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Request sent' })).toBeDisabled());
    expect(requestJoin).toHaveBeenCalledWith(
      { ...docSpace({ visibility: 'request' }), _instanceOrigin: '', joined: false },
      'I build federation features',
    );
    expect(publicJoin).not.toHaveBeenCalled();
    expect(openModal).not.toHaveBeenCalled();
  });

  it('does not join again when the user later leaves the space it joined', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(doc({ origin: window.location.origin })));
    publicJoin.mockImplementationOnce(async () => {
      useSpaceStore.setState({ spaces: [taggedSpace('space-1', '')] });
      return { id: 'space-1' } as SpaceWithChannelsAndMembers;
    });
    render(<CommunityCard target={homeTarget()} />);

    fireEvent.click(joinButton());
    expect(await screen.findByRole('button', { name: 'Open' })).toBeInTheDocument();

    act(() => { useSpaceStore.setState({ spaces: [] }); });

    expect(joinButton()).toBeEnabled();
    expect(publicJoin).toHaveBeenCalledTimes(1);
  });

  it('returns to Join when the inline request form is cancelled', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(doc({ origin: window.location.origin, spaces: [docSpace({ visibility: 'request' })] })),
    );
    render(<CommunityCard target={homeTarget()} />);
    fireEvent.click(joinButton());
    await screen.findByPlaceholderText('Why do you want to join? (optional)');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(joinButton()).toBeEnabled();
    expect(screen.queryByPlaceholderText('Why do you want to join? (optional)')).not.toBeInTheDocument();
    expect(requestJoin).not.toHaveBeenCalled();
  });
});
