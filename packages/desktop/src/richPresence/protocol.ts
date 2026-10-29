/** Discord-compatible rich presence wire protocol and public activity types. */

export const OP_HANDSHAKE = 0;
export const OP_FRAME = 1;
export const OP_CLOSE = 2;
export const OP_PING = 3;
export const OP_PONG = 4;

export const IPC_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_BUFFER_BYTES = 1024 * 1024;
export const DISCONNECT_GRACE_MS = 2500;

export interface IpcAssets {
  largeImage?: string;
  largeText?: string;
  smallImage?: string;
  smallText?: string;
}

export type IpcActivityType = 'playing' | 'listening' | 'watching' | 'streaming';

export interface IpcActivityPayload {
  type: IpcActivityType;
  name?: string;
  details?: string;
  state?: string;
  timestamps?: { start?: number; end?: number };
  assets?: IpcAssets;
}

export interface IpcActivityPush {
  clientId: string;
  pid: number | null;
  activity: IpcActivityPayload;
}

export function encodeFrame(op: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

export interface DecodedFrame {
  op: number;
  payload: unknown;
  raw: string;
  consumed: number;
}

export function tryDecodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 8) return null;
  const op = buf.readInt32LE(0);
  const len = buf.readInt32LE(4);
  if (op < OP_HANDSHAKE || op > OP_PONG) return null;
  if (len < 0 || len > MAX_FRAME_BYTES) return null;
  if (buf.length < 8 + len) return null;
  const raw = buf.subarray(8, 8 + len).toString('utf8');
  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
  return { op, payload, raw, consumed: 8 + len };
}

export function tryParseRawJson(buf: Buffer): { payload: unknown; consumed: number } | null {
  if (buf.length === 0 || buf[0] !== 0x7b /* '{' */) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) {
      inString = true;
    } else if (c === 0x7b || c === 0x5b) {
      depth++;
    } else if (c === 0x7d || c === 0x5d) {
      depth--;
      if (depth === 0) {
        const text = buf.subarray(0, i + 1).toString('utf8');
        try {
          return { payload: JSON.parse(text), consumed: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const CLIENT_ID_RE = /^\d{1,64}$/;

export function isValidClientId(clientId: unknown): clientId is string {
  return typeof clientId === 'string' && CLIENT_ID_RE.test(clientId);
}
