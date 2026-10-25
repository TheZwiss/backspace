import fs from 'fs';
import net from 'net';
import path from 'path';

/**
 * Local rich presence IPC server.
 *
 * Games that integrate rich presence speak a local IPC protocol over
 * Unix domain sockets named discord-ipc-0 … discord-ipc-9. By speaking that
 * protocol ourselves we can receive their activity pushes (osu!lazer's
 * "Playing [map] / streaming from menu", elapsed time, cover art) and surface
 * them as Backspace activities.
 *
 * Protocol (verified against public protocol documentation and the open-source
 * client library osu!lazer uses):
 *   - frames are [i32 LE opcode][i32 LE length][JSON payload]
 *   - opcodes: 0 HANDSHAKE, 1 FRAME, 2 CLOSE, 3 PING, 4 PONG
 *   - handshake payload {v, client_id}; some client libraries send it as raw JSON
 *     without the frame header, so both forms are accepted
 *   - commands ride in FRAME payloads: {cmd, args, nonce}
 *
 * Coexistence: slots whose socket answers a probe belong to a live server
 * (usually the first-party desktop client) and are left alone; socket files left
 * behind by crashed servers are reclaimed. With that client already running, a
 * connecting game may land in either server — same as running two
 * copies of it.
 */

// ─── Protocol constants ─────────────────────────────────────────────────────

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_BUFFER_BYTES = 1024 * 1024;
const DISCONNECT_GRACE_MS = 2500;

const CLIENT_ID_RE = /^\d{1,64}$/;

/** Shared activity limits (kept in sync with @backspace/shared ACTIVITY_LIMITS). */
const LIMITS = {
  MAX_NAME_LENGTH: 128,
  MAX_DETAILS_LENGTH: 128,
  MAX_STATE_LENGTH: 128,
  MAX_ASSET_TEXT_LENGTH: 128,
  MAX_URL_LENGTH: 512,
} as const;

// ─── Public types ───────────────────────────────────────────────────────────

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

/** One activity push from one connected game. */
export interface IpcActivityPush {
  clientId: string;
  pid: number | null;
  activity: IpcActivityPayload;
}

export interface RichPresenceIpcServerOptions {
  /**
   * Called with the currently winning push (last push wins), or null when no
   * live connection holds an activity.
   */
  onActivity: (push: IpcActivityPush | null) => void;
}

export interface RichPresenceIpcStatus {
  running: boolean;
  socketCount: number;
  connectionCount: number;
}

// ─── Frame codec (exported for tests) ───────────────────────────────────────

export function encodeFrame(op: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

export interface DecodedFrame {
  op: number;
  /** Parsed JSON payload when parseable, else null */
  payload: unknown;
  /** Raw payload bytes as text */
  raw: string;
  /** Bytes consumed from the front of the buffer */
  consumed: number;
}

/**
 * Decode one frame from the head of buf. Returns null when more bytes are
 * needed or the head is not a valid frame (a raw-JSON handshake, for
 * instance, starts with '{' and fails the opcode check on purpose).
 */
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

/**
 * Parse a complete raw-JSON object (unframed, no frame header) from
 * the head of buf. Uses brace matching so a raw handshake glued to framed
 * commands in one TCP segment still splits correctly; returns null while
 * the object is incomplete.
 */
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
          return null; // Complete but malformed — no point retrying
        }
      }
    }
  }
  return null; // Incomplete
}

// ─── Activity normalization (exported for tests) ────────────────────────────

/** Clamp a string to max codepoints (not UTF-16 units — emoji stay whole). */
export function clampByCodepoints(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join('');
}

/**
 * Accept an art reference from a pushed payload: http(s) URLs pass through
 * (length-clamped), anything else — the Discord protocol's asset keys
 * included — is dropped. Keys only resolve through Discord's CDN, which an
 * independent instance has no business contacting; game icons come from the
 * player's own machine instead (`gameIcons.ts`) and are hosted by the user's
 * own instance.
 */
export function resolveAssetUrl(value: string): string | undefined {
  const v = value.trim();
  if (!v) return undefined;
  if (!/^https?:\/\//i.test(v)) return undefined; // asset keys and external schemas are not resolvable here
  // A cut-off URL points somewhere else (or nowhere): drop it instead
  return v.length <= LIMITS.MAX_URL_LENGTH ? v : undefined;
}

const TYPE_BY_NUMBER: Record<number, IpcActivityType> = {
  0: 'playing',
  1: 'streaming',
  2: 'listening',
  3: 'watching',
};

function mapActivityType(value: unknown): IpcActivityType {
  if (typeof value === 'string') {
    if (value === 'playing' || value === 'listening' || value === 'watching' || value === 'streaming') return value;
  }
  if (typeof value === 'number' && TYPE_BY_NUMBER[value]) return TYPE_BY_NUMBER[value];
  return 'playing'; // Custom/Competing and anything unknown render as playing
}

function clampOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = clampByCodepoints(value, max).trim();
  return s || undefined;
}

// Discord RPC transmits timestamps as unix SECONDS, while the web renders elapsed
// time from Date.now() milliseconds. Values below 1e12 are seconds (millisecond
// epochs crossed 1e12 in 2001; second epochs stay below it until year 33658).
const toEpochMs = (value: number): number => (value > 0 && value < 1e12 ? value * 1000 : value);

function clampTimestamps(value: unknown): { start?: number; end?: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const t = value as Record<string, unknown>;
  const start = typeof t.start === 'number' && Number.isFinite(t.start) ? toEpochMs(t.start) : undefined;
  const end = typeof t.end === 'number' && Number.isFinite(t.end) ? toEpochMs(t.end) : undefined;
  if (start === undefined && end === undefined) return undefined;
  return start !== undefined || end !== undefined ? { start, end } : undefined;
}

/**
 * Normalize a pushed SET_ACTIVITY payload into our clamped local shape.
 * buttons, party and secrets are intentionally never read, let alone relayed.
 */
export function normalizeActivity(raw: Record<string, unknown>): IpcActivityPayload {
  const assetsRaw = (raw.assets && typeof raw.assets === 'object' ? raw.assets : {}) as Record<string, unknown>;

  const largeImage = typeof assetsRaw.large_image === 'string'
    ? resolveAssetUrl(assetsRaw.large_image)
    : typeof assetsRaw.largeImage === 'string' ? resolveAssetUrl(assetsRaw.largeImage) : undefined;
  const smallImage = typeof assetsRaw.small_image === 'string'
    ? resolveAssetUrl(assetsRaw.small_image)
    : typeof assetsRaw.smallImage === 'string' ? resolveAssetUrl(assetsRaw.smallImage) : undefined;
  const largeText = clampOptionalString(assetsRaw.large_text ?? assetsRaw.largeText, LIMITS.MAX_ASSET_TEXT_LENGTH);
  const smallText = clampOptionalString(assetsRaw.small_text ?? assetsRaw.smallText, LIMITS.MAX_ASSET_TEXT_LENGTH);

  const assets: IpcAssets | undefined =
    largeImage || largeText || smallImage || smallText
      ? { largeImage, largeText, smallImage, smallText }
      : undefined;

  return {
    type: mapActivityType(raw.type),
    name: clampOptionalString(raw.name, LIMITS.MAX_NAME_LENGTH),
    details: clampOptionalString(raw.details, LIMITS.MAX_DETAILS_LENGTH),
    state: clampOptionalString(raw.state, LIMITS.MAX_STATE_LENGTH),
    timestamps: clampTimestamps(raw.timestamps),
    assets,
  };
}

/** Validate a handshake client_id: 1..64 digits, nothing else. */
export function isValidClientId(clientId: unknown): clientId is string {
  return typeof clientId === 'string' && CLIENT_ID_RE.test(clientId);
}

// ─── Server state ───────────────────────────────────────────────────────────

interface Connection {
  socket: net.Socket;
  clientId: string;
  pid: number | null;
  /** Latest push from this connection; null while none or cleared */
  push: { seq: number; push: IpcActivityPush } | null;
  graceTimer: NodeJS.Timeout | null;
  handshakeDone: boolean;
  /** Undelivered bytes waiting for a complete message */
  buffer: Buffer;
}

let servers: net.Server[] = [];
let boundPaths: string[] = [];
let connections = new Set<Connection>();
let seqCounter = 0;
let lastPush: IpcActivityPush | null = null;
let onActivityCb: RichPresenceIpcServerOptions['onActivity'] | null = null;
let startPromise: Promise<void> | null = null;

// ─── Socket directory/slot discovery ────────────────────────────────────────

/**
 * Directories clients scan for the sockets: XDG_RUNTIME_DIR first (the
 * documented location), then the TMPDIR/TMP/TEMP//tmp chain.
 */
export function candidateSocketDirs(): string[] {
  const dirs: string[] = [];
  const xdg = process.env['XDG_RUNTIME_DIR'];
  if (xdg && xdg.trim()) dirs.push(xdg);
  const tmp = process.env['TMPDIR'] || process.env['TMP'] || process.env['TEMP'] || '/tmp';
  if (!dirs.includes(tmp)) dirs.push(tmp);
  return dirs;
}

type SlotStatus = 'free' | 'live' | 'stale' | 'occupied';

/** Probe one socket path: live servers answer, crash leftovers are stale. */
function probeSocketPath(socketPath: string, timeoutMs = 400): Promise<'live' | 'stale' | 'free'> {
  return new Promise((resolve) => {
    const client = net.connect(socketPath);
    let settled = false;
    const finish = (result: 'live' | 'stale' | 'free') => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(result);
    };
    client.once('connect', () => finish('live'));
    client.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(code === 'ECONNREFUSED' ? 'stale' : 'free'); // ENOENT/permissions: not ours to take
    });
    setTimeout(() => finish('live'), timeoutMs); // A slow answer still means someone is there
  });
}

async function slotStatus(socketPath: string): Promise<SlotStatus> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch {
    return 'free';
  }
  if (!stat.isSocket()) return 'occupied'; // Never delete a non-socket file
  const probe = await probeSocketPath(socketPath);
  if (probe === 'live') return 'live';
  if (probe === 'stale') return 'stale';
  return 'occupied';
}

// ─── Connection handling ────────────────────────────────────────────────────

function reply(conn: Connection, payload: unknown): void {
  if (conn.socket.destroyed) return;
  conn.socket.write(encodeFrame(OP_FRAME, payload));
}

function handleHandshakePayload(conn: Connection, payload: unknown): boolean {
  const obj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  if (!isValidClientId(obj.client_id)) {
    conn.socket.write(encodeFrame(OP_CLOSE, { code: 4004, message: 'invalid client id' }));
    conn.socket.end();
    return false;
  }
  conn.clientId = obj.client_id;
  conn.handshakeDone = true;
  console.log(`[RichPresenceIpc] Handshake ok (client ${conn.clientId})`);
  reply(conn, {
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

function handleCommandPayload(conn: Connection, payload: unknown): void {
  const obj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const cmd = typeof obj.cmd === 'string' ? obj.cmd : '';
  const nonce = typeof obj.nonce === 'string' || typeof obj.nonce === 'number' ? obj.nonce : null;
  const args = (obj.args && typeof obj.args === 'object' ? obj.args : {}) as Record<string, unknown>;

  if (cmd === 'SET_ACTIVITY') {
    handleSetActivity(conn, args, nonce);
    return;
  }

  if (cmd === 'SUBSCRIBE' || cmd === 'UNSUBSCRIBE') {
    // ACK the subscription; we never dispatch join/spectate events
    reply(conn, { cmd, data: { evt: typeof args.evt === 'string' ? args.evt : null }, evt: null, nonce });
    return;
  }

  if (cmd === 'DISPATCH') {
    return; // Server→client only; ignore
  }

  reply(conn, { cmd: cmd || 'UNKNOWN', data: { code: -1, message: 'unsupported command' }, evt: 'ERROR', nonce });
}

function handleSetActivity(conn: Connection, args: Record<string, unknown>, nonce: unknown): void {
  const pid = typeof args.pid === 'number' && Number.isFinite(args.pid) ? Math.trunc(args.pid) : null;

  const rawActivity = args.activity;
  if (!rawActivity || typeof rawActivity !== 'object') {
    conn.pid = pid;
    conn.push = null; // activity: null clears
    recompute();
    reply(conn, { cmd: 'SET_ACTIVITY', data: null, evt: null, nonce });
    return;
  }

  // The live connection is the source of truth for liveness: a client that
  // just sent a frame is running, even when the pid it reports is dead (an
  // AppImage wrapper's pid, a pid from another namespace) or bogus. Pushes
  // from a game that exits are dropped by the disconnect grace instead.
  const activity = normalizeActivity(rawActivity as Record<string, unknown>);
  console.log(
    `[RichPresenceIpc] Push from client ${conn.clientId}: pid=${pid ?? 'none'}` +
    ` name=${activity.name ?? 'none'} details=${activity.details ? 'yes' : 'no'}` +
    ` state=${activity.state ? 'yes' : 'no'} assets=${activity.assets ? 'yes' : 'no'}`,
  );
  conn.pid = pid;
  conn.push = { seq: ++seqCounter, push: { clientId: conn.clientId, pid, activity } };
  recompute();
  reply(conn, { cmd: 'SET_ACTIVITY', data: activity, evt: null, nonce });
}

/**
 * The winning push is the one with the highest sequence number among live
 * connections (and connections still inside their disconnect grace):
 * "last push wins", so a newer game overrides an older one.
 */
function recompute(): void {
  let best: { seq: number; push: IpcActivityPush } | null = null;
  for (const conn of connections) {
    if (conn.push && (!best || conn.push.seq > best.seq)) best = conn.push;
  }

  const next = best ? best.push : null;
  const changed = JSON.stringify(next) !== JSON.stringify(lastPush);
  if (changed) {
    lastPush = next;
    console.log(`[RichPresenceIpc] Activity ${next ? `update (client ${next.clientId})` : 'cleared'}`);
    onActivityCb?.(next);
  }
}

function feedConnection(conn: Connection, chunk: Buffer): void {
  const socket = conn.socket;
  let buf = Buffer.concat([conn.buffer, chunk]);
  conn.buffer = buf;

  // Parse as many messages as the buffer allows
  for (;;) {
    if (buf.length === 0) break;

    // Raw JSON first (unframed handshake, no frame header)
    const rawJson = tryParseRawJson(buf);
    if (rawJson) {
      if (!conn.handshakeDone) {
        if (!handleHandshakePayload(conn, rawJson.payload)) return;
      } else {
        // Raw JSON after the handshake: an unframed command
        handleCommandPayload(conn, rawJson.payload);
      }
      buf = buf.subarray(rawJson.consumed);
      conn.buffer = buf;
      continue;
    }

    const frame = tryDecodeFrame(buf);
    if (!frame) {
      const looksLikeRawJson = buf[0] === 0x7b; // '{'
      if (looksLikeRawJson) {
        // Incomplete raw JSON — keep buffering, but cap the damage
        if (buf.length > MAX_BUFFER_BYTES) {
          socket.end();
          return;
        }
        break;
      }
      // Not raw JSON, not a decodable frame: if there are enough bytes for a
      // header it is malformed (bad opcode/length); otherwise wait for more.
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
      if (!handleHandshakePayload(conn, frame.payload)) return;
      continue;
    }

    if (!conn.handshakeDone) {
      socket.write(encodeFrame(OP_CLOSE, { code: 4001, message: 'expected handshake' }));
      socket.end();
      return;
    }

    if (frame.op === OP_FRAME) {
      handleCommandPayload(conn, frame.payload);
      continue;
    }

    if (frame.op === OP_PING) {
      socket.write(encodeFrame(OP_PONG, frame.payload ?? {}));
      continue;
    }

    if (frame.op === OP_CLOSE) {
      socket.end();
      return;
    }

    // Unknown opcode inside range cannot happen (tryDecodeFrame gates 0..4)
  }
}

function handleConnection(socket: net.Socket): void {
  const conn: Connection = {
    socket,
    clientId: '',
    pid: null,
    push: null,
    graceTimer: null,
    handshakeDone: false,
    buffer: Buffer.alloc(0),
  };
  connections.add(conn);

  socket.on('data', (chunk: Buffer) => feedConnection(conn, chunk));

  socket.on('error', () => {
    /* handled by close */
  });

  socket.on('close', () => {
    // Disconnect grace: hold the connection's push briefly so a reconnecting
    // client doesn't flicker the activity.
    if (conn.graceTimer) clearTimeout(conn.graceTimer);
    conn.graceTimer = setTimeout(() => {
      conn.graceTimer = null;
      connections.delete(conn);
      recompute();
    }, DISCONNECT_GRACE_MS);
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start listening on every free protocol slot in every candidate
 * directory. Idempotent; concurrent calls share one startup.
 */
export async function startRichPresenceIpcServer(opts: RichPresenceIpcServerOptions): Promise<void> {
  if (servers.length > 0 || startPromise) {
    if (startPromise) await startPromise;
    return;
  }

  onActivityCb = opts.onActivity;

  startPromise = (async () => {
    const bound: string[] = [];
    const spawned: net.Server[] = [];

    for (const dir of candidateSocketDirs()) {
      for (const slot of SLOTS) {
        const socketPath = path.join(dir, `discord-ipc-${slot}`);
        const status = await slotStatus(socketPath);
        if (status === 'live' || status === 'occupied') continue; // Someone else's — leave it alone
        if (status === 'stale') {
          try {
            fs.unlinkSync(socketPath); // Reclaim a crashed server's leftover
          } catch {
            continue;
          }
        }

        // One net.Server per path — a server can only listen once
        const socketServer = net.createServer(handleConnection);
        const listen = new Promise<boolean>((resolve) => {
          socketServer.once('error', () => resolve(false));
          socketServer.listen(socketPath, () => resolve(true));
        });
        if (await listen) {
          try {
            fs.chmodSync(socketPath, 0o600);
          } catch {
            // Permissions are best-effort hardening
          }
          spawned.push(socketServer);
          bound.push(socketPath);
        } else {
          socketServer.close();
        }
      }
    }

    if (bound.length === 0) {
      for (const s of spawned) s.close();
      console.log('[RichPresenceIpc] No free IPC slots — server not started');
      return;
    }

    servers = spawned;
    boundPaths = bound;
    console.log(`[RichPresenceIpc] Listening on ${bound.length} socket(s)`);
  })();

  await startPromise;
  startPromise = null;
}

/** Stop the server, unlink its sockets and drop all state. Restartable. */
export function stopRichPresenceIpcServer(): void {
  for (const conn of connections) {
    if (conn.graceTimer) clearTimeout(conn.graceTimer);
    conn.socket.destroy();
  }
  connections = new Set();

  if (servers.length > 0) {
    for (const s of servers) s.close();
    servers = [];
  }

  for (const p of boundPaths) {
    try {
      fs.unlinkSync(p);
    } catch {
      // Already gone
    }
  }
  boundPaths = [];

  if (lastPush !== null) {
    lastPush = null;
    onActivityCb?.(null);
  }
  onActivityCb = null;
  startPromise = null;
}

export function getRichPresenceIpcStatus(): RichPresenceIpcStatus {
  return {
    running: servers.length > 0,
    socketCount: boundPaths.length,
    connectionCount: connections.size,
  };
}
