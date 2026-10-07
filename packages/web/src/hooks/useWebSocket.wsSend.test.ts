import { afterEach, describe, expect, it, vi } from 'vitest';

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

/** A socket that records what the client sent; the test opens it by hand. */
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

const { connectInstance, disconnectInstance, wsSend } = await import('./useWebSocket');

/**
 * `wsSend` says whether the event reached an open socket, so a caller that
 * tracks what it sent (the reaction adds in flight) records only what went
 * out.
 */

const ORBIT = 'https://orbit.example';
const ADD = { type: 'reaction_add', messageId: 'm-1', emoji: '👍' } as const;

afterEach(() => {
  disconnectInstance(ORBIT);
  FakeWebSocket.all = [];
});

describe('wsSend', () => {
  it('returns false and sends nothing for an origin with no connection', () => {
    expect(wsSend(ADD, ORBIT)).toBe(false);
    expect(FakeWebSocket.all).toEqual([]);
  });

  it('returns false while the socket is still connecting, and true once it is open', () => {
    connectInstance(ORBIT, 'token-orbit');
    const ws = FakeWebSocket.all.at(-1)!;

    expect(wsSend(ADD, ORBIT)).toBe(false);
    expect(ws.sent.filter((e) => e.type === 'reaction_add')).toEqual([]);

    ws.open();
    expect(wsSend(ADD, ORBIT)).toBe(true);
    expect(ws.sent.filter((e) => e.type === 'reaction_add')).toEqual([ADD]);
  });
});
