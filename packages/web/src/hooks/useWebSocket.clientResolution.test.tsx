import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
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
const { activitiesFor } = await import('../stores/activityStore');

type TaggedFriend = import('../stores/socialStore').TaggedFriend;
type TaggedSpace = import('../stores/spaceStore').TaggedSpace;

// #346. The viewer's home is the page's instance. Bob is native on orbit
// (id bob-home); the home keeps a replicated row for him (id stub-a).
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
  useSpaceStore.setState({ spaces: [], currentSpaceId: null, members: [], loadingSpaceId: null, userViews: new Map() });
  useUIStore.setState({ isMobile: false, memberListOpen: true });
});

afterEach(() => {
  for (const origin of opened.splice(0)) disconnectInstance(origin);
  vi.restoreAllMocks();
});


function statusOf(userId: string): string | undefined {
  return useSpaceStore.getState().members.find(m => m.userId === userId)?.user.status;
}

describe('#346: member_joined / member_left touch only the loaded roster', () => {
  const kai = user({ id: 'kai', displayName: 'Kai' });
  const zed = user({ id: 'zed', displayName: 'Zed' });

  it("adds a member who joined the loaded space", () => {
    showSpace('', kai);
    const home = socketFor('');
    home.deliver({ type: 'member_joined', spaceId: 'sp', member: member('sp', zed) });
    expect(useSpaceStore.getState().members.map(m => m.userId)).toEqual(['kai', 'zed']);
  });

  it('leaves the loaded roster alone when someone joins another space', () => {
    showSpace('', kai);
    const home = socketFor('');
    home.deliver({ type: 'member_joined', spaceId: 'other', member: member('other', zed) });
    expect(useSpaceStore.getState().members.map(m => m.userId)).toEqual(['kai']);
  });

  it('leaves the loaded roster alone when someone leaves another space', () => {
    showSpace('', kai);
    const home = socketFor('');
    home.deliver({ type: 'member_left', spaceId: 'other', userId: 'kai' });
    expect(useSpaceStore.getState().members.map(m => m.userId)).toEqual(['kai']);
  });

  it('removes a member who left the loaded space', () => {
    showSpace('', kai);
    const home = socketFor('');
    home.deliver({ type: 'member_left', spaceId: 'sp', userId: 'kai' });
    expect(useSpaceStore.getState().members).toEqual([]);
  });

  it('ignores an event for a space of the same id on another instance', () => {
    showSpace('', kai);
    const nova = socketFor(NOVA);
    nova.deliver({ type: 'member_joined', spaceId: 'sp', member: member('sp', zed) });
    nova.deliver({ type: 'member_left', spaceId: 'sp', userId: 'kai' });
    expect(useSpaceStore.getState().members.map(m => m.userId)).toEqual(['kai']);
  });
});

describe('#346: member status follows the person, not a raw id', () => {
  it("leaves a member alone when another instance reports a same-id user of its own", () => {
    showSpace('', user({ id: 'carol', displayName: 'Carol', status: 'idle' }));
    const nova = socketFor(NOVA);
    nova.deliver({ type: 'presence_update', userId: 'carol', status: 'online', homeUserId: null, homeInstance: null });
    expect(statusOf('carol')).toBe('idle');
  });

  it("updates a replicated member from their own home's report", () => {
    const stubRow = user({ id: 'stub-a', displayName: 'Bob', status: 'offline', homeUserId: 'bob-home', homeInstance: 'orbit.test' });
    showSpace('', stubRow);
    const orbit = socketFor(ORBIT);
    orbit.deliver({ type: 'presence_update', userId: 'bob-home', status: 'online', homeUserId: null, homeInstance: null });
    expect(statusOf('stub-a')).toBe('online');
  });

  it('updates the member the report names on the space\'s own instance', () => {
    showSpace(NOVA, user({ id: 'dana', displayName: 'Dana', status: 'offline' }));
    const nova = socketFor(NOVA);
    nova.deliver({ type: 'presence_update', userId: 'dana', status: 'dnd', homeUserId: null, homeInstance: null });
    expect(statusOf('dana')).toBe('dnd');
  });

  it("leaves another instance's same-id user's cached view alone", () => {
    const carol = user({ id: 'carol', displayName: 'Carol', status: 'idle' });
    useSpaceStore.getState().upsertUserView(carol, '');
    const nova = socketFor(NOVA);
    nova.deliver({ type: 'presence_update', userId: 'carol', status: 'online', homeUserId: null, homeInstance: null });
    const views = [...useSpaceStore.getState().userViews.values()].map(v => v.user);
    expect(views.find(u => u.id === 'carol')?.status).toBe('idle');
  });
});

describe("#346: an instance's activities are replaced when it reconnects", () => {
  const bobSubject = { id: 'stub-a', homeUserId: 'bob-home', homeInstance: 'orbit.test' };

  it("drops what an instance reported when its next ready no longer lists it", () => {
    const nova = socketFor(NOVA);
    nova.deliver({
      type: 'presence_update', userId: 'bob-on-nova', status: 'online', activities: playing,
      homeUserId: 'bob-home', homeInstance: 'orbit.test',
    });
    expect(activitiesFor(useActivityStore.getState().userActivities, bobSubject, '')).toEqual(playing);

    nova.deliver(ready({ userActivities: {}, userActivityIdentities: {} }));

    expect(activitiesFor(useActivityStore.getState().userActivities, bobSubject, '')).toEqual([]);
  });

  it("keeps what another instance reported last", () => {
    const home = socketFor('');
    const nova = socketFor(NOVA);
    home.deliver({
      type: 'presence_update', userId: 'stub-a', status: 'online', activities: playing,
      homeUserId: 'bob-home', homeInstance: 'orbit.test',
    });

    nova.deliver(ready({ userActivities: {}, userActivityIdentities: {} }));

    expect(activitiesFor(useActivityStore.getState().userActivities, bobSubject, '')).toEqual(playing);
  });

  it("clears a third-instance member's game on an older server even when their space is not open", () => {
    // Carol lives on carol.test. Older nova keeps a replicated row for her in
    // a space the viewer is in but not looking at, and sends no identity fields.
    const carolOnNova = user({ id: 'carol-on-nova', username: 'carol@carol.test', displayName: 'Carol', homeUserId: 'carol-home', homeInstance: 'carol.test' });
    const carolSubject = { id: 'carol-home', homeUserId: 'carol-home', homeInstance: 'carol.test' };
    const nova = socketFor(NOVA);
    nova.deliver(ready({
      spaces: [{ ...space('nova-sp', ''), channels: [], categories: [], roles: [], members: [member('nova-sp', carolOnNova)] }],
      userActivities: { 'carol-on-nova': playing },
    }));
    expect(activitiesFor(useActivityStore.getState().userActivities, carolSubject, '')).toEqual(playing);

    nova.deliver({ type: 'presence_update', userId: 'carol-on-nova', status: 'online', activities: [] });

    expect(activitiesFor(useActivityStore.getState().userActivities, carolSubject, '')).toEqual([]);
  });

  // An older server's ready snapshot covered only space and DM members; a
  // friend it reports on only through live presence is outside it.
  it("keeps a friend's game an older server reported live when its ready does not cover friends", () => {
    const dave = { ...bobStubFriend, id: 'dave', username: 'dave', displayName: 'Dave', homeUserId: null, homeInstance: null, _instanceOrigin: NOVA };
    useSocialStore.setState({ friends: [dave] });
    const daveSubject = { id: 'dave', homeUserId: null, homeInstance: null };
    const nova = socketFor(NOVA);
    nova.deliver({ type: 'presence_update', userId: 'dave', status: 'online', activities: playing });
    expect(activitiesFor(useActivityStore.getState().userActivities, daveSubject, NOVA)).toEqual(playing);

    nova.deliver(ready({ userActivities: {} }));

    expect(activitiesFor(useActivityStore.getState().userActivities, daveSubject, NOVA)).toEqual(playing);
  });

  it("drops a member's game an older server reported when its ready lists the member without one", () => {
    const erin = user({ id: 'erin', displayName: 'Erin' });
    const nova = socketFor(NOVA);
    nova.deliver(ready({
      spaces: [{ ...space('nova-sp', ''), channels: [], categories: [], roles: [], members: [member('nova-sp', erin)] }],
      userActivities: {},
    }));
    nova.deliver({ type: 'presence_update', userId: 'erin', status: 'online', activities: playing });
    expect(activitiesFor(useActivityStore.getState().userActivities, erin, NOVA)).toEqual(playing);

    nova.deliver(ready({
      spaces: [{ ...space('nova-sp', ''), channels: [], categories: [], roles: [], members: [member('nova-sp', erin)] }],
      userActivities: {},
    }));

    expect(activitiesFor(useActivityStore.getState().userActivities, erin, NOVA)).toEqual([]);
  });
});
