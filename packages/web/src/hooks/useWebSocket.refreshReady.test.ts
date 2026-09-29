import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageWithUser, ServerEvent, User } from '@backspace/shared';

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

/**
 * A socket the real handler talks to. `connectInstance` opens one per origin;
 * the test plays the server by feeding events through `onmessage` and reads
 * what the client sent from `sent`.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWebSocket.all.push(this); }
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void { this.readyState = FakeWebSocket.CLOSED; }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  deliver(event: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(event) }); }
  statusSends(): unknown[] {
    return this.sent.filter((e) => e.type === 'presence_update').map((e) => e.status);
  }
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
const { useAuthStore } = await import('../stores/authStore');
const { useChatStore } = await import('../stores/chatStore');

function user(fields: Partial<User> & Pick<User, 'id'>): User {
  return {
    username: fields.id,
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
    ...fields,
  } as User;
}

function ready(readyUser: User): Record<string, unknown> {
  return {
    type: 'ready',
    user: readyUser,
    spaces: [],
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

const jannis = user({ id: 'jannis' });
const DM = 'dm-1';
const cached = [{ id: '41', channelId: '', userId: 'u-bob', content: 'hello' }] as unknown as MessageWithUser[];
const loadMessages = vi.fn(() => Promise.resolve(true));

function homeSocket(): FakeWebSocket {
  connectInstance('', 'token-home');
  const ws = FakeWebSocket.all.at(-1)!;
  ws.open();
  return ws;
}

function dmCacheKept(): boolean {
  return useChatStore.getState().messages.get(DM) === cached;
}

beforeEach(() => {
  FakeWebSocket.all = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useAuthStore.setState({ user: jannis, trueHomeStatus: null });
  loadMessages.mockClear();
  useChatStore.setState({
    currentChannelId: DM,
    messages: new Map([[DM, cached]]),
    hasMore: new Map([[DM, false]]),
    loadMessages,
  });
});

afterEach(() => {
  disconnectInstance('');
  useAuthStore.setState({ user: null, trueHomeStatus: null });
  useChatStore.getState().clearAllMessages();
  vi.restoreAllMocks();
});

describe('ready on a socket (issue #374)', () => {
  it('refetches the message cache on the first ready of a connection, which may have missed messages', () => {
    const home = homeSocket();
    home.deliver(ready(jannis));

    expect(dmCacheKept()).toBe(false);
    expect(loadMessages).toHaveBeenCalledWith(DM, true);
  });

  it('keeps the message cache on a later ready of the same connection', () => {
    const home = homeSocket();
    home.deliver(ready(jannis));
    useChatStore.setState({ messages: new Map([[DM, cached]]), hasMore: new Map([[DM, false]]) });
    loadMessages.mockClear();

    // An instance still on 1.7.0 sends a full ready as a permission refresh.
    home.deliver(ready(jannis));

    expect(dmCacheKept()).toBe(true);
    expect(loadMessages).not.toHaveBeenCalled();
  });

  it('refetches again after a reconnect', () => {
    const first = homeSocket();
    first.deliver(ready(jannis));
    disconnectInstance('');
    useChatStore.setState({ messages: new Map([[DM, cached]]), hasMore: new Map([[DM, false]]) });
    loadMessages.mockClear();

    const second = homeSocket();
    second.deliver(ready(jannis));

    expect(dmCacheKept()).toBe(false);
    expect(loadMessages).toHaveBeenCalledWith(DM, true);
  });
});
