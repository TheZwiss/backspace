import WebSocket from 'ws';

export type WsEvent = Record<string, unknown> & { type: string };

export interface WsCapture {
  events: WsEvent[];
  waitForEvent(type: string, timeoutMs?: number): Promise<WsEvent>;
  send(event: WsEvent): void;
  close(): void;
}

/**
 * Connect to an instance's WS, authenticate with the given JWT, capture all
 * incoming events into an array. waitForEvent resolves with the first matching
 * event already in the buffer or arriving within `timeoutMs`.
 *
 * Auth handshake: server expects `{ type: 'auth', token }` as the first message
 * (see packages/server/src/ws/handler.ts:1617). On success the server emits
 * `{ type: 'ready', ...readyData }` (handler.ts:1661-1664).
 *
 * Events are flat objects — `{ type, ...fields }` — with no nested payload envelope.
 * E.g. `member_left` arrives as `{ type: 'member_left', spaceId, userId }`
 * (see routes/spaces.ts:977-981, routes/federation.ts:2127-2131).
 */
export async function connectWs(origin: string, token: string): Promise<WsCapture> {
  const wsUrl = origin.replace(/^http/, 'ws') + '/ws';
  const ws = new WebSocket(wsUrl);
  const events: WsEvent[] = [];
  let closed = false;
  const waiters: {
    type: string;
    resolve: (e: WsEvent) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    ws.once('open', () => {
      ws.off('error', onError);
      ws.send(JSON.stringify({ type: 'auth', token }));
      resolve();
    });
    ws.once('error', onError);
  });

  ws.on('message', (raw) => {
    let msg: WsEvent | null = null;
    try {
      msg = JSON.parse(raw.toString()) as WsEvent;
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    events.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === msg.type) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });

  // Wait for `ready` before returning so subsequent test code can be sure auth landed.
  // The 'message' listener above already pushes into `events`, so we just need to
  // observe the same stream here without double-processing.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timed out waiting for ws ready')), 5_000);
    const checkExisting = events.find((e) => e.type === 'ready');
    if (checkExisting) {
      clearTimeout(t);
      resolve();
      return;
    }
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsEvent;
        if (msg?.type === 'ready') {
          clearTimeout(t);
          ws.off('message', onMessage);
          resolve();
        } else if (msg?.type === 'error') {
          clearTimeout(t);
          ws.off('message', onMessage);
          reject(new Error(`WS auth error: ${JSON.stringify(msg)}`));
        }
      } catch {
        /* ignore */
      }
    };
    ws.on('message', onMessage);
  });

  return {
    events,
    waitForEvent(type, timeoutMs = 5_000) {
      if (closed) return Promise.reject(new Error('WS closed'));
      const existing = events.find((e) => e.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.timer === timer);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`Timed out waiting for ws event "${type}" after ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push({ type, resolve, reject, timer });
      });
    },
    send(event) {
      ws.send(JSON.stringify(event));
    },
    close() {
      closed = true;
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(new Error('WS closed'));
      }
      waiters.length = 0;
      ws.close();
    },
  };
}
