import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@backspace/shared';
import type { Bookmark } from '@backspace/shared/src/bookmarks';

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
const { bookmarkKey, useBookmarkStore } = await import('../stores/bookmarkStore');

const NOVA = 'https://nova.example';
const opened: string[] = [];

function socketFor(origin: string): FakeWebSocket {
  connectInstance(origin, `token-${origin || 'home'}`);
  opened.push(origin);
  const ws = FakeWebSocket.all.at(-1)!;
  ws.open();
  return ws;
}

function readyFor(id: string): Record<string, unknown> {
  const readyUser = {
    id, username: id, displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: 'home.example', homeUserId: 'me', replicatedInstances: [],
  } as unknown as User;
  return { type: 'ready', user: readyUser, spaces: [], dmChannels: [], readStates: [], activeCalls: [] };
}

const saved: Bookmark = {
  id: 'b-1', kind: 'channel', messageId: 'm-1', channelId: 'ch-1', spaceId: 'sp-1', content: 'hi', authorId: 'u',
  authorName: 'U', spaceName: 'S', channelName: 'c', instanceOrigin: NOVA, messageCreatedAt: 1, createdAt: 2,
  attachments: [], status: 'ok',
};

beforeEach(() => {
  FakeWebSocket.all = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useAuthStore.setState({ user: { id: 'me', status: 'online' } as User });
});

afterEach(() => {
  for (const origin of opened.splice(0)) disconnectInstance(origin);
  useBookmarkStore.getState().reset();
  useAuthStore.setState({ user: null, myRowIds: new Map() });
  vi.restoreAllMocks();
});

describe('bookmarks over the socket', () => {
  it('files a pushed bookmark under the origin of the socket that delivered it', () => {
    const nova = socketFor(NOVA);
    nova.deliver({ type: 'bookmark_added', bookmark: saved });
    const { keys } = useBookmarkStore.getState();
    expect(keys.has(bookmarkKey(NOVA, 'channel', 'm-1'))).toBe(true);
    expect(keys.has(bookmarkKey('', 'channel', 'm-1'))).toBe(false);
  });

  it('removes a mark when the instance says the bookmark is gone', () => {
    const nova = socketFor(NOVA);
    nova.deliver({ type: 'bookmark_added', bookmark: saved });
    nova.deliver({ type: 'bookmark_removed', kind: 'channel', channelId: 'ch-1', messageId: 'm-1' });
    expect(useBookmarkStore.getState().keys.has(bookmarkKey(NOVA, 'channel', 'm-1'))).toBe(false);
  });

  it('forgets what an instance said when its socket reports ready again', () => {
    const nova = socketFor(NOVA);
    nova.deliver({ type: 'bookmark_added', bookmark: saved });
    nova.deliver(readyFor('me-on-nova'));
    expect(useBookmarkStore.getState().keys.has(bookmarkKey(NOVA, 'channel', 'm-1'))).toBe(false);
  });
});
