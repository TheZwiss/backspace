import type net from 'net';
import { normalizeActivity } from './activityNormalizer';
import {
  DISCONNECT_GRACE_MS,
  MAX_BUFFER_BYTES,
  OP_CLOSE,
  OP_FRAME,
  OP_HANDSHAKE,
  OP_PING,
  OP_PONG,
  encodeFrame,
  isValidClientId,
  tryDecodeFrame,
  tryParseRawJson,
  type IpcActivityPush,
} from './protocol';

interface Connection {
  socket: net.Socket;
  clientId: string;
  pid: number | null;
  push: { seq: number; push: IpcActivityPush } | null;
  graceTimer: NodeJS.Timeout | null;
  handshakeDone: boolean;
  buffer: Buffer;
}

export class IpcSessionManager {
  private connections = new Set<Connection>();
  private seqCounter = 0;
  private lastPush: IpcActivityPush | null = null;
  private onActivity: ((push: IpcActivityPush | null) => void) | null = null;

  setOnActivity(callback: ((push: IpcActivityPush | null) => void) | null): void {
    this.onActivity = callback;
  }

  connectionCount(): number {
    return this.connections.size;
  }

  attach = (socket: net.Socket): void => {
    const conn: Connection = {
      socket,
      clientId: '',
      pid: null,
      push: null,
      graceTimer: null,
      handshakeDone: false,
      buffer: Buffer.alloc(0),
    };
    this.connections.add(conn);
    socket.on('data', (chunk: Buffer) => this.feed(conn, chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      if (conn.graceTimer) clearTimeout(conn.graceTimer);
      conn.graceTimer = setTimeout(() => {
        conn.graceTimer = null;
        this.connections.delete(conn);
        this.recompute();
      }, DISCONNECT_GRACE_MS);
    });
  };

  stop(): void {
    for (const conn of this.connections) {
      if (conn.graceTimer) clearTimeout(conn.graceTimer);
      conn.socket.destroy();
    }
    this.connections.clear();
    if (this.lastPush !== null) {
      this.lastPush = null;
      this.onActivity?.(null);
    }
    this.onActivity = null;
  }

  private reply(conn: Connection, payload: unknown): void {
    if (!conn.socket.destroyed) conn.socket.write(encodeFrame(OP_FRAME, payload));
  }

  private handshake(conn: Connection, payload: unknown): boolean {
    const obj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    if (!isValidClientId(obj.client_id)) {
      conn.socket.write(encodeFrame(OP_CLOSE, { code: 4004, message: 'invalid client id' }));
      conn.socket.end();
      return false;
    }
    conn.clientId = obj.client_id;
    conn.handshakeDone = true;
    console.log(`[RichPresenceIpc] Handshake ok (client ${conn.clientId})`);
    this.reply(conn, {
      cmd: 'DISPATCH',
      evt: 'READY',
      data: {
        v: 1,
        cfg: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' },
        config: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' },
        user: { id: '123456789012345678', username: 'backspace', discriminator: '0', avatar: null, bot: false, flags: 0 },
      },
    });
    return true;
  }

  private command(conn: Connection, payload: unknown): void {
    const obj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const cmd = typeof obj.cmd === 'string' ? obj.cmd : '';
    const nonce = typeof obj.nonce === 'string' || typeof obj.nonce === 'number' ? obj.nonce : null;
    const args = (obj.args && typeof obj.args === 'object' ? obj.args : {}) as Record<string, unknown>;

    if (cmd === 'SET_ACTIVITY') {
      this.setActivity(conn, args, nonce);
    } else if (cmd === 'SUBSCRIBE' || cmd === 'UNSUBSCRIBE') {
      this.reply(conn, { cmd, data: { evt: typeof args.evt === 'string' ? args.evt : null }, evt: null, nonce });
    } else if (cmd !== 'DISPATCH') {
      this.reply(conn, { cmd: cmd || 'UNKNOWN', data: { code: -1, message: 'unsupported command' }, evt: 'ERROR', nonce });
    }
  }

  private setActivity(conn: Connection, args: Record<string, unknown>, nonce: unknown): void {
    const pid = typeof args.pid === 'number' && Number.isFinite(args.pid) ? Math.trunc(args.pid) : null;
    const rawActivity = args.activity;
    if (!rawActivity || typeof rawActivity !== 'object') {
      conn.pid = pid;
      conn.push = null;
      this.recompute();
      this.reply(conn, { cmd: 'SET_ACTIVITY', data: null, evt: null, nonce });
      return;
    }

    const activity = normalizeActivity(rawActivity as Record<string, unknown>);
    console.log(
      `[RichPresenceIpc] Push from client ${conn.clientId}: pid=${pid ?? 'none'}` +
      ` name=${activity.name ?? 'none'} details=${activity.details ? 'yes' : 'no'}` +
      ` state=${activity.state ? 'yes' : 'no'} assets=${activity.assets ? 'yes' : 'no'}`,
    );
    conn.pid = pid;
    conn.push = { seq: ++this.seqCounter, push: { clientId: conn.clientId, pid, activity } };
    this.recompute();
    this.reply(conn, { cmd: 'SET_ACTIVITY', data: activity, evt: null, nonce });
  }

  private recompute(): void {
    let best: { seq: number; push: IpcActivityPush } | null = null;
    for (const conn of this.connections) {
      if (conn.push && (!best || conn.push.seq > best.seq)) best = conn.push;
    }
    const next = best ? best.push : null;
    if (JSON.stringify(next) === JSON.stringify(this.lastPush)) return;
    this.lastPush = next;
    console.log(`[RichPresenceIpc] Activity ${next ? `update (client ${next.clientId})` : 'cleared'}`);
    this.onActivity?.(next);
  }

  private feed(conn: Connection, chunk: Buffer): void {
    const socket = conn.socket;
    let buf = Buffer.concat([conn.buffer, chunk]);
    conn.buffer = buf;

    for (;;) {
      if (buf.length === 0) break;
      const rawJson = tryParseRawJson(buf);
      if (rawJson) {
        if (!conn.handshakeDone) {
          if (!this.handshake(conn, rawJson.payload)) return;
        } else {
          this.command(conn, rawJson.payload);
        }
        buf = buf.subarray(rawJson.consumed);
        conn.buffer = buf;
        continue;
      }

      const frame = tryDecodeFrame(buf);
      if (!frame) {
        if (buf[0] === 0x7b) {
          if (buf.length > MAX_BUFFER_BYTES) socket.end();
          break;
        }
        if (buf.length >= 8) {
          socket.write(encodeFrame(OP_CLOSE, { code: 4000, message: 'malformed payload' }));
          socket.end();
          return;
        }
        break;
      }

      buf = buf.subarray(frame.consumed);
      conn.buffer = buf;
      if (frame.op === OP_HANDSHAKE) {
        if (!this.handshake(conn, frame.payload)) return;
      } else if (!conn.handshakeDone) {
        socket.write(encodeFrame(OP_CLOSE, { code: 4001, message: 'expected handshake' }));
        socket.end();
        return;
      } else if (frame.op === OP_FRAME) {
        this.command(conn, frame.payload);
      } else if (frame.op === OP_PING) {
        socket.write(encodeFrame(OP_PONG, frame.payload ?? {}));
      } else if (frame.op === OP_CLOSE) {
        socket.end();
        return;
      }
    }
  }
}
