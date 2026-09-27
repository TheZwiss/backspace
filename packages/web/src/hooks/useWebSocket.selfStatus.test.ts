import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent, User } from '@backspace/shared';

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
const { alertsAllowed } = await import('../utils/alerts');

/** jsdom serves the page from localhost; the page's instance is "orbit" here. */
const PAGE_HOST = window.location.hostname;
const NOVA = 'https://nova.example';
const opened: string[] = [];

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

function presence(userId: string, status: string): Record<string, unknown> {
  return { type: 'presence_update', userId, status };
}

function socketFor(origin: string): FakeWebSocket {
  connectInstance(origin, `token-${origin || 'home'}`);
  opened.push(origin);
  const ws = FakeWebSocket.all.at(-1)!;
  ws.open();
  return ws;
}

/** jannis, native on the page's instance. */
const jannis = user({ id: 'jannis', status: 'dnd' });
/** erin@nova signed in directly on the page's instance: a replicated row. */
const erinHere = user({ id: 'erin-here', username: 'erin@nova.example', homeInstance: 'nova.example', homeUserId: 'erin-nova' });
/** erin's own row on her true home. */
const erinOnNova = user({ id: 'erin-nova', username: 'erin', status: 'dnd' });

beforeEach(() => {
  FakeWebSocket.all = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const origin of opened.splice(0)) disconnectInstance(origin);
  useAuthStore.setState({ user: null, trueHomeStatus: null });
  vi.restoreAllMocks();
});

describe('status resend to a remote instance on ready', () => {
  it("re-sends a native session's dnd to its own federated identity on the remote", () => {
    useAuthStore.setState({ user: jannis, trueHomeStatus: null });
    const nova = socketFor(NOVA);
    nova.deliver(ready(user({ id: 'jannis-on-nova', homeInstance: PAGE_HOST, homeUserId: 'jannis', status: 'online' })));
    expect(nova.statusSends()).toEqual(['dnd']);
  });

  it('sends nothing to a separate account that merely lives on the remote', () => {
    useAuthStore.setState({ user: jannis, trueHomeStatus: null });
    const nova = socketFor(NOVA);
    nova.deliver(ready(user({ id: 'someone-on-nova', status: 'online' })));
    expect(nova.statusSends()).toEqual([]);
  });

  it("sends nothing from a replicated session, so the true home's dnd survives", () => {
    useAuthStore.setState({ user: erinHere, trueHomeStatus: null });
    const home = socketFor('');
    home.deliver(ready(erinHere));
    const nova = socketFor(NOVA);
    nova.deliver(ready(erinOnNova));
    expect(nova.statusSends()).toEqual([]);
    expect(home.statusSends()).toEqual([]);
  });
});

describe("the user's own status as the alert gate sees it", () => {
  it('ignores a remote instance reporting its view of a native session', () => {
    useAuthStore.setState({ user: jannis, trueHomeStatus: null });
    const nova = socketFor(NOVA);
    nova.deliver(presence('jannis-on-nova', 'online'));
    nova.deliver(presence('jannis', 'online'));
    expect(useAuthStore.getState().user?.status).toBe('dnd');
    expect(alertsAllowed('message')).toBe(false);
  });

  it("follows the true home's dnd for a replicated session, whatever the page instance says", () => {
    useAuthStore.setState({ user: erinHere, trueHomeStatus: null });
    const home = socketFor('');
    home.deliver(ready(erinHere));
    expect(alertsAllowed('message')).toBe(true);

    const nova = socketFor(NOVA);
    nova.deliver(ready(erinOnNova));
    expect(alertsAllowed('message')).toBe(false);

    // The page instance's replicated row falls back to 'online'; it is not the choice.
    home.deliver(presence('erin-here', 'online'));
    expect(alertsAllowed('message')).toBe(false);

    nova.deliver(presence('erin-nova', 'online'));
    expect(alertsAllowed('message')).toBe(true);
    nova.deliver(presence('erin-nova', 'dnd'));
    expect(alertsAllowed('incoming_call')).toBe(false);
  });

  it('takes a change made on another device of a native session from the home socket', () => {
    useAuthStore.setState({ user: user({ id: 'jannis', status: 'online' }), trueHomeStatus: null });
    const home = socketFor('');
    home.deliver(presence('jannis', 'dnd'));
    expect(alertsAllowed('message')).toBe(false);
  });
});
