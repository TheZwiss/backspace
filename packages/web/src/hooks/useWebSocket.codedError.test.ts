import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  deliver(event: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(event) });
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
const { useUIStore } = await import('../stores/uiStore');
const { initI18n } = await import('../i18n');
const i18n = (await import('../i18n')).default;

// #420: a WebSocket refusal of a DM message action carries an error code,
// and `details` where the code's text has placeholders. The client shows it
// as a toast in the user's language with the placeholders filled.

const opened: string[] = [];
function homeSocket(): FakeWebSocket {
  connectInstance('', 'token-home');
  opened.push('');
  const ws = FakeWebSocket.all.at(-1)!;
  ws.open();
  return ws;
}

beforeEach(async () => {
  await initI18n();
  FakeWebSocket.all = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  useUIStore.setState({ toasts: [] });
});

afterEach(() => {
  for (const origin of opened.splice(0)) disconnectInstance(origin);
  vi.restoreAllMocks();
});

describe('a coded WebSocket refusal', () => {
  it('shows the translated text of recipient_deleted', () => {
    const ws = homeSocket();

    ws.deliver({ type: 'error', message: "This user's account was deleted", code: 'recipient_deleted' });

    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe(i18n.t('errors:recipient_deleted'));
  });

  it('fills the placeholders from details', () => {
    const ws = homeSocket();

    ws.deliver({
      type: 'error',
      message: 'Message content must be 4000 characters or less',
      code: 'content_too_long',
      details: { max: 4000 },
    });

    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe(i18n.t('errors:content_too_long', { max: 4000 }));
    expect(toasts[0]!.message).toContain('4000');
  });

  it('only logs an error without a code', () => {
    const ws = homeSocket();

    ws.deliver({ type: 'error', message: 'Unknown event type: nope' });

    expect(useUIStore.getState().toasts).toHaveLength(0);
  });
});
