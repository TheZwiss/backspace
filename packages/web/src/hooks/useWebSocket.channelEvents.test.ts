import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, ChannelCategory, ServerEvent, User } from '@backspace/shared';

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

/** A socket the real handler talks to; the test plays the server through `deliver`. */
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
  deliver(event: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(event) }); }
}

/** The heartbeat runs in a Worker (jsdom has none); an inert one keeps it quiet. */
class InertWorker {
  onmessage: (() => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

vi.stubGlobal('WebSocket', FakeWebSocket);
vi.stubGlobal('Worker', InertWorker);
vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:heartbeat', revokeObjectURL: () => {} }));

const { connectInstance, disconnectInstance } = await import('./useWebSocket');
const { useSpaceStore, getChannelOrigin } = await import('../stores/spaceStore');
const { useAuthStore } = await import('../stores/authStore');

const NOVA = 'https://nova.example';
const SPACE = 'space-nova';
const OPEN_SPACE = 'space-home';
const opened: string[] = [];

function channel(id: string, fields: Partial<Channel> = {}): Channel {
  return {
    id,
    spaceId: SPACE,
    name: id,
    type: 'text',
    topic: null,
    position: 0,
    categoryId: null,
    createdAt: 1,
    myPermissions: '1',
    ...fields,
  };
}

function category(id: string): ChannelCategory {
  return { id, spaceId: SPACE, name: id, position: 0, createdAt: 1 };
}

function me(id: string): User {
  return {
    id,
    username: id,
    displayName: null,
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: 1,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
  } as User;
}

function ready(channels: Channel[], categories: ChannelCategory[] = []): Record<string, unknown> {
  return {
    type: 'ready',
    user: me('me-on-nova'),
    spaces: [{
      id: SPACE,
      name: 'Nova space',
      icon: null,
      ownerId: 'owner',
      inviteCode: 'x',
      visibility: 'private',
      createdAt: 1,
      channels,
      categories,
      members: [],
      myPermissions: '1',
    }],
    dmChannels: [],
    folders: [],
    spaceLayout: null,
    layoutUpdatedAt: null,
    voiceStates: {},
    voiceChannelElapsedSeconds: {},
    voiceUserStates: {},
    spaceVoiceStates: {},
    readStates: [],
    activeCalls: [],
    userActivities: {},
    rejectedPeerOrigins: [],
    awaitingApprovalPeerOrigins: [],
    activePeerOrigins: [],
    pendingApprovalCount: 0,
  } satisfies Partial<Record<keyof Extract<ServerEvent, { type: 'ready' }> | 'type', unknown>>;
}

function socketFor(origin: string): FakeWebSocket {
  connectInstance(origin, `token-${origin || 'home'}`);
  opened.push(origin);
  const ws = FakeWebSocket.all.at(-1)!;
  ws.open();
  return ws;
}

beforeEach(() => {
  FakeWebSocket.all = [];
  useSpaceStore.getState().reset();
  useAuthStore.setState({ user: me('me'), trueHomeStatus: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const origin of opened.splice(0)) disconnectInstance(origin);
  useAuthStore.setState({ user: null, trueHomeStatus: null });
  vi.restoreAllMocks();
});

/** Nova's space is known from its ready; the user has another space open. */
function novaWithOtherSpaceOpen(channels: Channel[], categories: ChannelCategory[] = []): FakeWebSocket {
  const nova = socketFor(NOVA);
  nova.deliver(ready(channels, categories));
  useSpaceStore.setState({ currentSpaceId: OPEN_SPACE });
  return nova;
}

describe('a channel that leaves and re-enters the view of a space that is not open', () => {
  it('routes to its instance again once channel_updated brings it back', () => {
    const nova = novaWithOtherSpaceOpen([channel('c1')]);
    expect(getChannelOrigin('c1')).toBe(NOVA);

    // An override hides it: the server sends this user channel_deleted.
    nova.deliver({ type: 'channel_deleted', channelId: 'c1', spaceId: SPACE });
    expect(useSpaceStore.getState().channelOriginMap.has('c1')).toBe(false);

    // The override is lifted: channel_updated, while another space is open.
    nova.deliver({ type: 'channel_updated', channel: channel('c1', { myPermissions: '3' }), spaceId: SPACE });

    const s = useSpaceStore.getState();
    expect(s.channelOriginMap.get('c1')).toBe(NOVA);
    expect(s.channelToSpaceMap.get('c1')).toBe(SPACE);
    expect(s.channelPermissions.get('c1')).toBe('3');
    expect(getChannelOrigin('c1')).toBe(NOVA);
  });
});

describe('channel events replace the lookup maps', () => {
  it('channel_updated gives every lookup map a new reference', () => {
    const nova = novaWithOtherSpaceOpen([channel('c1')]);
    const before = useSpaceStore.getState();

    nova.deliver({ type: 'channel_updated', channel: channel('c1', { myPermissions: '7' }), spaceId: SPACE });

    const after = useSpaceStore.getState();
    expect(after.channelPermissions).not.toBe(before.channelPermissions);
    expect(after.channelPermissions.get('c1')).toBe('7');
  });

  it('channel_deleted for a space that is not open replaces the maps and forgets the voice channel', () => {
    const nova = novaWithOtherSpaceOpen([channel('v1', { type: 'voice' })]);
    const before = useSpaceStore.getState();
    expect(before.voiceChannelIds.has('v1')).toBe(true);

    nova.deliver({ type: 'channel_deleted', channelId: 'v1', spaceId: SPACE });

    const after = useSpaceStore.getState();
    expect(after.channelToSpaceMap).not.toBe(before.channelToSpaceMap);
    expect(after.channelOriginMap).not.toBe(before.channelOriginMap);
    expect(after.channelPermissions).not.toBe(before.channelPermissions);
    expect(after.voiceChannelIds).not.toBe(before.voiceChannelIds);
    expect(after.channelToSpaceMap.has('v1')).toBe(false);
    expect(after.voiceChannelIds.has('v1')).toBe(false);
    expect(after.channelPermissions.has('v1')).toBe(false);
  });

  it('channel_layout_updated is the full visible set: a channel missing from it leaves the index', () => {
    const nova = socketFor(NOVA);
    nova.deliver(ready([channel('c1'), channel('c2')]));
    useSpaceStore.setState({ currentSpaceId: SPACE });
    const before = useSpaceStore.getState();

    nova.deliver({
      type: 'channel_layout_updated',
      spaceId: SPACE,
      channels: [channel('c1', { position: 1 }), channel('c3', { type: 'voice' })],
      categories: [category('cat1')],
    });

    const after = useSpaceStore.getState();
    expect(after.channelToSpaceMap).not.toBe(before.channelToSpaceMap);
    expect([...after.channelToSpaceMap.keys()].sort()).toEqual(['c1', 'c3']);
    expect(after.channelOriginMap.get('c3')).toBe(NOVA);
    expect(after.voiceChannelIds.has('c3')).toBe(true);
    expect(after.categoryOriginMap.get('cat1')).toBe(NOVA);
    expect(after.channels.map(c => c.id)).toEqual(['c3', 'c1']);
  });

  it('channel_layout_updated for a space that is not open still updates the index', () => {
    const nova = novaWithOtherSpaceOpen([channel('c1')]);

    nova.deliver({
      type: 'channel_layout_updated',
      spaceId: SPACE,
      channels: [channel('c1'), channel('c2')],
      categories: [],
    });

    expect(useSpaceStore.getState().channelOriginMap.get('c2')).toBe(NOVA);
    expect(useSpaceStore.getState().channels).toEqual([]);
  });

  it('category_created and category_deleted replace categoryOriginMap', () => {
    const nova = novaWithOtherSpaceOpen([]);
    const before = useSpaceStore.getState().categoryOriginMap;

    nova.deliver({ type: 'category_created', category: category('cat1'), spaceId: SPACE });
    const created = useSpaceStore.getState().categoryOriginMap;
    expect(created).not.toBe(before);
    expect(created.get('cat1')).toBe(NOVA);

    nova.deliver({ type: 'category_deleted', categoryId: 'cat1', spaceId: SPACE });
    const deleted = useSpaceStore.getState().categoryOriginMap;
    expect(deleted).not.toBe(created);
    expect(deleted.has('cat1')).toBe(false);
  });
});
