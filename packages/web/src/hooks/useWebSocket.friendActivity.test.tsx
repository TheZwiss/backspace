import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Activity, MemberWithUser, ServerEvent, User } from '@backspace/shared';

// jsdom has no AudioWorkletNode; the handler's imports reach the voice stack.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
      playSound: vi.fn(() => Promise.resolve(null)),
    }),
  },
}));
vi.mock('../hooks/useMascotAnimation', () => ({ useMascotAnimation: vi.fn() }));

/**
 * A socket the real handler talks to. The test plays each server by feeding
 * events through `onmessage`.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWebSocket.all.push(this); }
  send(): void {}
  close(): void { this.readyState = FakeWebSocket.CLOSED; }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  deliver(event: Record<string, unknown>): void {
    act(() => { this.onmessage?.({ data: JSON.stringify(event) }); });
  }
}

class InertWorker {
  onmessage: (() => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

vi.stubGlobal('WebSocket', FakeWebSocket);
vi.stubGlobal('Worker', InertWorker);
vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:heartbeat', revokeObjectURL: () => {} }));

const { connectInstance, disconnectInstance } = await import('./useWebSocket');
const { useSocialStore } = await import('../stores/socialStore');
const { useSpaceStore } = await import('../stores/spaceStore');
const { useActivityStore } = await import('../stores/activityStore');
const { useUIStore } = await import('../stores/uiStore');
const { ActivityPanel } = await import('../components/layout/ActivityPanel');
const { MemberSidebar } = await import('../components/layout/MemberSidebar');
const { FriendsPage } = await import('../components/chat/FriendsPage');

type TaggedFriend = import('../stores/socialStore').TaggedFriend;
type TaggedSpace = import('../stores/spaceStore').TaggedSpace;

// #340. The viewer's home is the page's instance. Bob is native on orbit
// (id bob-home). The home keeps a replicated row for him (id stub-a), and that
// row is the friend the home's friend list returns.
const ORBIT = 'https://orbit.test';
const NOVA = 'https://nova.test';
const playing: Activity[] = [{ type: 'playing', name: 'Factorio' }];

const bobStubFriend: TaggedFriend = {
  id: 'stub-a', username: 'bob@orbit.test', displayName: 'Bob', avatar: null, banner: null,
  accentColor: null, avatarColor: null, bio: null, status: 'offline', customStatus: null,
  createdAt: 0, addedAt: 0, homeUserId: 'bob-home', homeInstance: 'orbit.test', _instanceOrigin: '',
};

function user(fields: Partial<User> & Pick<User, 'id'>): User {
  return {
    username: fields.id, displayName: null, avatar: null, banner: null, accentColor: null,
    avatarColor: null, bio: null, status: 'online', customStatus: null, isAdmin: false,
    createdAt: 1, homeInstance: null, homeUserId: null, replicatedInstances: [],
    ...fields,
  } as User;
}

function space(id: string, origin: string): TaggedSpace {
  return {
    id, name: `Space ${id}`, icon: null, banner: null, avatarColor: 'lavender', ownerId: 'someone',
    inviteCode: null, visibility: 'public', directoryListed: false, description: '', createdAt: 1,
    _instanceOrigin: origin,
  };
}

function member(spaceId: string, u: User): MemberWithUser {
  return { spaceId, userId: u.id, nickname: null, joinedAt: 1, user: u, roles: [] };
}

/** Shows one space whose member list holds `u`, delivered by `origin`. */
function showSpace(origin: string, u: User): void {
  useSpaceStore.setState({
    spaces: [space('sp', origin)],
    currentSpaceId: 'sp',
    loadingSpaceId: null,
    members: [member('sp', u)],
  });
}

function ready(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'ready',
    user: user({ id: 'viewer', username: 'viewer' }),
    spaces: [], dmChannels: [], folders: [], spaceLayout: null, layoutUpdatedAt: null,
    voiceStates: {}, voiceChannelElapsedSeconds: {}, voiceUserStates: {}, spaceVoiceStates: {},
    readStates: [], activeCalls: [], userActivities: {},
    rejectedPeerOrigins: [], awaitingApprovalPeerOrigins: [], activePeerOrigins: [], pendingApprovalCount: 0,
    ...extra,
  } satisfies Partial<Record<keyof Extract<ServerEvent, { type: 'ready' }> | 'type', unknown>>;
}

const opened: string[] = [];
function socketFor(origin: string): FakeWebSocket {
  connectInstance(origin, `token-${origin || 'home'}`);
  opened.push(origin);
  const ws = FakeWebSocket.all.at(-1)!;
  ws.open();
  return ws;
}

function panel(): HTMLElement {
  return render(<ActivityPanel />).container;
}

beforeEach(() => {
  FakeWebSocket.all = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  useActivityStore.getState().reset();
  useSocialStore.setState({
    friends: [bobStubFriend], requests: [],
    loadFriends: vi.fn(async () => {}), loadRequests: vi.fn(async () => {}),
  });
  useSpaceStore.setState({ spaces: [], currentSpaceId: null, members: [], loadingSpaceId: null });
  useUIStore.setState({ isMobile: false, memberListOpen: true });
});

afterEach(() => {
  for (const origin of opened.splice(0)) disconnectInstance(origin);
  vi.restoreAllMocks();
});

describe("#340: a federated friend's activity in the friends views", () => {
  it("shows the activity the home delivers under its replicated row's id", () => {
    const home = socketFor('');
    const view = panel();
    home.deliver({
      type: 'presence_update', userId: 'stub-a', status: 'online', activities: playing,
      homeUserId: 'bob-home', homeInstance: 'orbit.test',
    });

    expect(useSocialStore.getState().friends[0]!.status).toBe('online');
    expect(within(view).getByText('Factorio')).toBeTruthy();
  });

  it("shows the activity the friend's own home delivers under their native id", () => {
    const orbit = socketFor(ORBIT);
    const view = panel();
    orbit.deliver({
      type: 'presence_update', userId: 'bob-home', status: 'online', activities: playing,
      homeUserId: null, homeInstance: null,
    });

    expect(useSocialStore.getState().friends[0]!.status).toBe('online');
    expect(within(view).getByText('Factorio')).toBeTruthy();
  });

  it('shows one delivery in the member list and the friends panel alike, and clears both', () => {
    const stubRow = user({ id: 'stub-a', username: 'bob@orbit.test', displayName: 'Bob', homeUserId: 'bob-home', homeInstance: 'orbit.test' });
    showSpace('', stubRow);
    const home = socketFor('');
    const friendsView = panel();
    const membersView = render(<MemoryRouter><MemberSidebar /></MemoryRouter>).container;

    home.deliver({
      type: 'presence_update', userId: 'stub-a', status: 'online', activities: playing,
      homeUserId: 'bob-home', homeInstance: 'orbit.test',
    });
    expect(within(friendsView).getByText('Factorio')).toBeTruthy();
    expect(within(membersView).getByText('Factorio')).toBeTruthy();

    home.deliver({
      type: 'presence_update', userId: 'stub-a', status: 'online', activities: [],
      homeUserId: 'bob-home', homeInstance: 'orbit.test',
    });
    expect(within(friendsView).queryByText('Factorio')).toBeNull();
    expect(within(membersView).queryByText('Factorio')).toBeNull();
  });

  it("keeps a home native's activity apart from a same-id user native elsewhere", () => {
    const carol = user({ id: 'carol', username: 'carol', displayName: 'Carol', status: 'idle' });
    showSpace('', carol);
    useSocialStore.setState({ friends: [{ ...bobStubFriend, ...carol, addedAt: 0, _instanceOrigin: '' }] });
    const nova = socketFor(NOVA);
    const membersView = render(<MemoryRouter><MemberSidebar /></MemoryRouter>).container;
    const friendsView = panel();

    nova.deliver({
      type: 'presence_update', userId: 'carol', status: 'online', activities: playing,
      homeUserId: null, homeInstance: null,
    });
    expect(within(membersView).queryByText('Factorio')).toBeNull();
    expect(within(friendsView).queryByText('Factorio')).toBeNull();
    expect(useSocialStore.getState().friends[0]!.status).toBe('idle');
  });

  it('shows the activity from the ready snapshot of the home', () => {
    const home = socketFor('');
    useSocialStore.setState({ friends: [{ ...bobStubFriend, status: 'online' }] });
    const view = panel();
    home.deliver(ready({
      userActivities: { 'stub-a': playing },
      userActivityIdentities: { 'stub-a': { homeUserId: 'bob-home', homeInstance: 'orbit.test' } },
    }));

    expect(within(view).getByText('Factorio')).toBeTruthy();
  });

  it('shows the activity in the mobile friends page activity tab', async () => {
    useUIStore.setState({ isMobile: true });
    const home = socketFor('');
    render(<MemoryRouter><FriendsPage mobile /></MemoryRouter>);
    home.deliver({
      type: 'presence_update', userId: 'stub-a', status: 'online', activities: playing,
      homeUserId: 'bob-home', homeInstance: 'orbit.test',
    });
    await userEvent.click(screen.getByRole('button', { name: /activity/i }));

    expect(screen.getByText('Factorio')).toBeTruthy();
  });
});

describe('#340: a server that predates the identity fields', () => {
  it("keys a replicated row by the identity the client already holds for it", () => {
    // nova holds its own replicated row for Bob (bob-on-nova) in a space the
    // viewer is in; an older nova sends presence without homeUserId/homeInstance.
    const bobOnNova = user({ id: 'bob-on-nova', username: 'bob@orbit.test', displayName: 'Bob', homeUserId: 'bob-home', homeInstance: 'orbit.test' });
    showSpace(NOVA, bobOnNova);
    const nova = socketFor(NOVA);
    const friendsView = panel();
    const membersView = render(<MemoryRouter><MemberSidebar /></MemoryRouter>).container;

    nova.deliver({ type: 'presence_update', userId: 'bob-on-nova', status: 'online', activities: playing });

    expect(within(friendsView).getByText('Factorio')).toBeTruthy();
    expect(within(membersView).getByText('Factorio')).toBeTruthy();
  });

  it('keys an unknown user as native to the delivering instance', () => {
    const orbit = socketFor(ORBIT);
    const view = panel();
    orbit.deliver({ type: 'presence_update', userId: 'bob-home', status: 'online', activities: playing });

    expect(useSocialStore.getState().friends[0]!.status).toBe('online');
    expect(within(view).getByText('Factorio')).toBeTruthy();
  });

  it('keys ready activities by the members the same ready payload carries', () => {
    const bobOnNova = user({ id: 'bob-on-nova', username: 'bob', displayName: 'Bob', homeUserId: 'bob-home', homeInstance: 'orbit.test' });
    useSocialStore.setState({ friends: [{ ...bobStubFriend, status: 'online' }] });
    const nova = socketFor(NOVA);
    const view = panel();
    nova.deliver(ready({
      spaces: [{ ...space('nova-sp', ''), channels: [], categories: [], roles: [], members: [member('nova-sp', bobOnNova)] }],
      userActivities: { 'bob-on-nova': playing },
    }));

    expect(within(view).getByText('Factorio')).toBeTruthy();
  });
});
