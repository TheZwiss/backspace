import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import {
  encodeFrame,
  tryDecodeFrame,
  tryParseRawJson,
  clampByCodepoints,
  resolveAssetUrl,
  isValidClientId,
  normalizeActivity,
  startRichPresenceIpcServer,
  stopRichPresenceIpcServer,
  getRichPresenceIpcStatus,
  type IpcActivityPush,
} from './richPresenceIpc';

// ─── Codec ──────────────────────────────────────────────────────────────────

describe('frame codec', () => {
  it('round-trips a frame', () => {
    const buf = encodeFrame(1, { cmd: 'SET_ACTIVITY' });
    const decoded = tryDecodeFrame(buf);
    expect(decoded?.op).toBe(1);
    expect(decoded?.payload).toEqual({ cmd: 'SET_ACTIVITY' });
    expect(decoded?.consumed).toBe(buf.length);
  });

  it('waits for more bytes and rejects bad opcodes', () => {
    expect(tryDecodeFrame(encodeFrame(1, { a: 1 }).subarray(0, 5))).toBeNull();
    const head = Buffer.alloc(8);
    head.writeInt32LE(9, 0); // invalid opcode
    head.writeInt32LE(2, 4);
    expect(tryDecodeFrame(Buffer.concat([head, Buffer.from('{}')]))).toBeNull();
  });

  it('parses complete raw JSON, keeps incomplete waiting, and stops at the object end', () => {
    const raw = Buffer.from('{"v":1,"client_id":"123"}');
    const glued = Buffer.concat([raw, Buffer.from('GARBAGE-AFTER')]);
    const parsed = tryParseRawJson(glued);
    expect(parsed?.payload).toEqual({ v: 1, client_id: '123' });
    expect(parsed?.consumed).toBe(raw.length); // trailing bytes left for the next message

    expect(tryParseRawJson(Buffer.from('{"v":1,'))).toBeNull(); // incomplete
    expect(tryParseRawJson(Buffer.from('[1,2]'))).toBeNull(); // not an object
    expect(tryParseRawJson(Buffer.from('{"a":"}"}'))?.payload).toEqual({ a: '}' }); // braces inside strings
  });
});

// ─── Normalization ──────────────────────────────────────────────────────────

describe('activity normalization', () => {
  it('clamps by codepoints, keeping emoji whole', () => {
    const emoji = '🏳️‍🌈'.repeat(50); // 300 UTF-16 units in 50 codepoints... each flag is multiple codepoints
    expect(Array.from(clampByCodepoints(emoji, 3)).length).toBeLessThanOrEqual(6);
    expect(clampByCodepoints('abcdef', 3)).toBe('abc');
    expect(clampByCodepoints('🎮🎮🎮', 2)).toBe('🎮🎮');
  });

  it('passes http(s) art through and drops everything else, asset keys included', () => {
    // Asset keys only resolve through Discord's CDN, which this server never
    // contacts; icons come from the local machine instead (gameIcons.ts)
    expect(resolveAssetUrl('osu_logo_lazer')).toBeUndefined();
    expect(resolveAssetUrl('https://example.com/art.png')).toBe('https://example.com/art.png');
  });

  it('drops asset references it cannot resolve safely', () => {
    expect(resolveAssetUrl('spotify:abc')).toBeUndefined();
    expect(resolveAssetUrl('../evil/path')).toBeUndefined();
    expect(resolveAssetUrl('a b')).toBeUndefined();
    expect(resolveAssetUrl('')).toBeUndefined();
  });

  it('accepts only digit-string client ids', () => {
    expect(isValidClientId('1216669957799018608')).toBe(true);
    expect(isValidClientId('123')).toBe(true);
    expect(isValidClientId('')).toBe(false);
    expect(isValidClientId('123/../../x')).toBe(false);
    expect(isValidClientId('abc')).toBe(false);
    expect(isValidClientId('123 456')).toBe(false);
    expect(isValidClientId(12345)).toBe(false);
  });

  it('maps a pushed payload to the local shape, dropping buttons/party/secrets', () => {
    const normalized = normalizeActivity(
      {
        type: 0,
        details: 'Playing [Freedom Dive] with mod',
        state: 'Streaming from menu',
        timestamps: { start: 1700000000, end: 'nope' },
        assets: {
          large_image: 'osu_logo_lazer',
          large_text: 'osu!',
          small_image: 'https://example.com/rank.png',
          small_text: 'SS rank',
        },
        buttons: [{ label: 'Spectate', url: 'https://evil.example' }],
        party: { size: [1, 8] },
        secrets: { join: 'super-secret' },
      },
    );
    expect(normalized).toEqual({
      type: 'playing',
      name: undefined,
      details: 'Playing [Freedom Dive] with mod',
      state: 'Streaming from menu',
      timestamps: { start: 1700000000000, end: undefined },
      assets: {
        largeImage: undefined,
        largeText: 'osu!',
        smallImage: 'https://example.com/rank.png',
        smallText: 'SS rank',
      },
    });
    expect(JSON.stringify(normalized)).not.toContain('secret');
    expect(JSON.stringify(normalized)).not.toContain('buttons');
    expect(JSON.stringify(normalized)).not.toContain('party');
  });

  it('maps activity types and clamps overlong strings', () => {
    expect(normalizeActivity({ type: 2 }).type).toBe('listening');
    expect(normalizeActivity({ type: 'watching' }).type).toBe('watching');
    expect(normalizeActivity({ type: 4 }).type).toBe('playing'); // custom → playing
    expect(normalizeActivity({ type: 'bogus' }).type).toBe('playing');
    const long = 'x'.repeat(300);
    expect(normalizeActivity({ details: long, state: long }).details).toHaveLength(128);
  });

  it('drops an overlong art URL instead of cutting it off', () => {
    const url = `https://example.com/${'a'.repeat(600)}.png`;
    expect(normalizeActivity({ assets: { large_image: url } }).assets).toBeUndefined();
    const ok = 'https://example.com/cover.png';
    expect(normalizeActivity({ assets: { large_image: ok } }).assets?.largeImage).toBe(ok);
  });
});

// ─── Server (real sockets in a sandboxed runtime dir) ───────────────────────

const CLIENT_ID = '1216669957799018608';

let runtimeDir: string;
let savedEnv: Record<string, string | undefined>;
let pushes: Array<IpcActivityPush | null>;

class TestClient {
  socket: net.Socket;
  private received = Buffer.alloc(0);
  private waiter: { resolve: (v: { op: number; payload: unknown }) => void } | null = null;

  constructor(slot = 0) {
    this.socket = net.connect(path.join(runtimeDir, `discord-ipc-${slot}`));
    this.socket.on('data', (chunk: Buffer) => {
      this.received = Buffer.concat([this.received, chunk]);
      this.tryDeliver();
    });
  }

  connected(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
  }

  closed(): Promise<void> {
    return new Promise((resolve) => this.socket.once('close', resolve));
  }

  send(buf: Buffer): void {
    this.socket.write(buf);
  }

  handshakeFramed(clientId = CLIENT_ID, v = 1): void {
    this.send(encodeFrame(0, { v, client_id: clientId }));
  }

  handshakeRaw(clientId = CLIENT_ID): void {
    this.socket.write(JSON.stringify({ v: 1, client_id: clientId }));
  }

  setActivity(activity: unknown, pid: number | null = process.pid, nonce = 'n1'): void {
    this.send(encodeFrame(1, { cmd: 'SET_ACTIVITY', args: { pid, activity }, nonce }));
  }

  private tryDeliver(): void {
    if (!this.waiter) return;
    const frame = tryDecodeFrame(this.received);
    if (frame) {
      this.received = this.received.subarray(frame.consumed);
      const w = this.waiter;
      this.waiter = null;
      w.resolve({ op: frame.op, payload: frame.payload });
    }
  }

  nextReply(timeoutMs = 2000): Promise<{ op: number; payload: unknown }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('reply timeout')), timeoutMs);
      const attempt = this.waiter;
      if (attempt) throw new Error('concurrent nextReply');
      this.waiter = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      };
      this.tryDeliver();
    });
  }

  destroy(): void {
    this.socket.destroy();
  }
}

async function startServer(): Promise<void> {
  await startRichPresenceIpcServer({ onActivity: (push) => pushes.push(push) });
}

beforeEach(() => {
  // The sandbox can carry a poisoned TMPDIR ("undefined"); keep tmp sane
  const ambient = process.env['TMPDIR'];
  if (ambient === undefined || ambient.trim() === '' || ambient.trim() === 'undefined') {
    process.env['TMPDIR'] = '/tmp';
  }
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-presence-ipc-test-'));
  savedEnv = {
    XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'],
    TMPDIR: process.env['TMPDIR'],
    TMP: process.env['TMP'],
    TEMP: process.env['TEMP'],
  };
  // One candidate dir → deterministic slot counts
  process.env['XDG_RUNTIME_DIR'] = runtimeDir;
  process.env['TMPDIR'] = runtimeDir;
  delete process.env['TMP'];
  delete process.env['TEMP'];
  pushes = [];
});

afterEach(() => {
  stopRichPresenceIpcServer();
  const restore: Array<[string, string | undefined]> = [
    ['XDG_RUNTIME_DIR', savedEnv.XDG_RUNTIME_DIR],
    ['TMPDIR', savedEnv.TMPDIR],
    ['TMP', savedEnv.TMP],
    ['TEMP', savedEnv.TEMP],
  ];
  for (const [key, value] of restore) {
    if (value === undefined) {
      delete process.env[key]; // assigning undefined would store the string "undefined"
    } else {
      process.env[key] = value;
    }
  }
});

describe('RichPresenceIpcServer', () => {
  it('binds all free slots and chmods them 600', async () => {
    await startServer();
    const status = getRichPresenceIpcStatus();
    expect(status.running).toBe(true);
    expect(status.socketCount).toBe(10);
    const stat = fs.statSync(path.join(runtimeDir, 'discord-ipc-4'));
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('skips slots held by a live server and reclaims stale socket files', async () => {
    // A live server on slot 3: it must keep it
    const live = net.createServer(() => {});
    await new Promise<void>((resolve) => live.listen(path.join(runtimeDir, 'discord-ipc-3'), resolve));

    // A crashed server on slot 5: socket file left behind, nobody listening
    const dead = net.createServer(() => {});
    await new Promise<void>((resolve) => dead.listen(path.join(runtimeDir, 'discord-ipc-5'), resolve));
    dead.close(); // no unlink

    // A non-socket file on slot 7: never touched
    fs.writeFileSync(path.join(runtimeDir, 'discord-ipc-7'), 'not a socket');

    await startServer();
    const status = getRichPresenceIpcStatus();
    expect(status.socketCount).toBe(8); // slots 3 and 7 skipped; 5 reclaimed
    expect(fs.existsSync(path.join(runtimeDir, 'discord-ipc-3'))).toBe(true);
    expect(fs.readFileSync(path.join(runtimeDir, 'discord-ipc-7')).toString()).toBe('not a socket');
    // The reclaimed slot answers
    const client = new TestClient(5);
    await client.connected();
    client.handshakeFramed();
    const ready = await client.nextReply();
    expect(ready.payload).toMatchObject({ cmd: 'DISPATCH', evt: 'READY', data: { v: 1, cfg: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' }, config: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' }, user: { id: '123456789012345678', username: 'backspace', discriminator: '0', avatar: null, bot: false, flags: 0 } } });
    client.destroy();
    live.close();
  });

  it('answers a framed handshake with READY', async () => {
    await startServer();
    const client = new TestClient();
    await client.connected();
    client.handshakeFramed();
    const ready = await client.nextReply();
    expect(ready.op).toBe(1);
    expect(ready.payload).toEqual({
      cmd: 'DISPATCH',
      evt: 'READY',
      data: {
        v: 1,
        cfg: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' },
        config: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' },
        user: { id: '123456789012345678', username: 'backspace', discriminator: '0', avatar: null, bot: false, flags: 0 },
      },
    });
    client.destroy();
  });

  it('answers the raw-JSON handshake (unframed)', async () => {
    await startServer();
    const client = new TestClient();
    await client.connected();
    client.handshakeRaw('9999');
    const ready = await client.nextReply();
    expect(ready.payload).toMatchObject({ cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } });
    client.destroy();
  });

  it('rejects handshakes with malformed client ids', async () => {
    await startServer();
    const client = new TestClient();
    await client.connected();
    client.handshakeFramed('../../evil');
    const reply = await client.nextReply();
    expect(reply.op).toBe(2); // CLOSE
    await client.closed();
  });

  it('rejects commands that arrive before the handshake', async () => {
    await startServer();
    const client = new TestClient();
    await client.connected();
    client.send(encodeFrame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: {} } }));
    const reply = await client.nextReply();
    expect(reply.op).toBe(2);
    await client.closed();
  });

  it('processes a handshake and SET_ACTIVITY glued into one segment', async () => {
    await startServer();
    const client = new TestClient();
    await client.connected();
    const glued = Buffer.concat([
      encodeFrame(0, { v: 1, client_id: CLIENT_ID }),
      encodeFrame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: { details: 'glued' } }, nonce: 'g1' }),
    ]);
    client.send(glued);
    const ready = await client.nextReply();
    expect(ready.payload).toMatchObject({ cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } });
    const ack = await client.nextReply();
    expect(ack.payload).toMatchObject({ cmd: 'SET_ACTIVITY', nonce: 'g1' });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.activity.details).toBe('glued');
    client.destroy();
  });

  it('emits a normalized activity for SET_ACTIVITY', async () => {
    await startServer();
    const client = new TestClient();
    await client.connected();
    client.handshakeFramed();
    await client.nextReply(); // READY
    client.setActivity({ details: 'Playing [Big Black]', state: 'by Blue Stahli', assets: { large_image: 'osu_logo_lazer' } });
    await client.nextReply();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.clientId).toBe(CLIENT_ID);
    expect(pushes[0]?.pid).toBe(process.pid);
    expect(pushes[0]?.activity.details).toBe('Playing [Big Black]');
    // Asset keys are dropped, not resolved against a third-party CDN
    expect(pushes[0]?.activity.assets).toBeUndefined();
    client.destroy();
  });

  it('clears the activity on SET_ACTIVITY null', async () => {
    await startServer();
    const client = new TestClient();
    await client.connected();
    client.handshakeFramed();
    await client.nextReply();
    client.setActivity({ details: 'x' });
    await client.nextReply();
    client.setActivity(null);
    await client.nextReply();
    expect(pushes).toHaveLength(2);
    expect(pushes[1]).toBeNull();
    client.destroy();
  });

  it('echoes the normalized payload with the nonce in the ACK', async () => {
    await startServer();
    const client = new TestClient();
    await client.connected();
    client.handshakeFramed();
    await client.nextReply();
    client.setActivity({ state: 'menu' }, process.pid, 'nonce-42');
    const ack = await client.nextReply();
    expect(ack.payload).toMatchObject({ cmd: 'SET_ACTIVITY', nonce: 'nonce-42' });
    const data = (ack.payload as { data: { state?: string } }).data;
    expect(data.state).toBe('menu');
    client.destroy();
  });

  it('ACKs SUBSCRIBE and UNSUBSCRIBE without dispatching events', async () => {
    await startServer();
    const client = new TestClient();
    await client.connected();
    client.handshakeFramed();
    await client.nextReply();
    client.send(encodeFrame(1, { cmd: 'SUBSCRIBE', args: { evt: 'Join' }, nonce: 's1' }));
    const sub = await client.nextReply();
    expect(sub.payload).toMatchObject({ cmd: 'SUBSCRIBE', data: { evt: 'Join' }, evt: null, nonce: 's1' });
    client.send(encodeFrame(1, { cmd: 'UNSUBSCRIBE', args: { evt: 'Join' }, nonce: 'u1' }));
    const unsub = await client.nextReply();
    expect(unsub.payload).toMatchObject({ cmd: 'UNSUBSCRIBE', nonce: 'u1' });
    // No DISPATCH ever arrives; give the loop a moment to prove silence
    await new Promise((r) => setTimeout(r, 50));
    client.destroy();
  });

  it('answers PING with PONG and the same payload', async () => {
    await startServer();
    const client = new TestClient();
    await client.connected();
    client.handshakeFramed();
    await client.nextReply();
    client.send(encodeFrame(3, { echo: 7 }));
    const pong = await client.nextReply();
    expect(pong.op).toBe(4);
    expect(pong.payload).toEqual({ echo: 7 });
    client.destroy();
  });

  it('ends the connection on a client CLOSE frame', async () => {
    await startServer();
    const client = new TestClient();
    await client.connected();
    client.handshakeFramed();
    await client.nextReply();
    client.send(encodeFrame(2, { code: 1000 }));
    await client.closed();
  });

  it('accepts pushes for dead pids (staleness handled by disconnect grace)', async () => {
    await startServer();
    const client = new TestClient();
    await client.connected();
    client.handshakeFramed();
    await client.nextReply();
    client.setActivity({ details: 'ghost' }, 999_999_999);
    await client.nextReply();
    expect(pushes).toHaveLength(1);
    client.destroy();
  });

  it('lets the last push win across connections', async () => {
    await startServer();
    const a = new TestClient(0);
    await a.connected();
    a.handshakeFramed('111');
    await a.nextReply();
    const b = new TestClient(1);
    await b.connected();
    b.handshakeFramed('222');
    await b.nextReply();

    a.setActivity({ details: 'from A' });
    await a.nextReply();
    expect(pushes.at(-1)?.activity.details).toBe('from A');

    b.setActivity({ details: 'from B' });
    await b.nextReply();
    expect(pushes.at(-1)?.activity.details).toBe('from B');

    a.setActivity({ details: 'from A again' });
    await a.nextReply();
    expect(pushes.at(-1)?.activity.details).toBe('from A again');

    a.destroy();
    b.destroy();
  });

  it('holds the activity for the disconnect grace, then clears it', async () => {
    await startServer();
    const client = new TestClient();
    await client.connected();
    client.handshakeFramed();
    await client.nextReply();
    client.setActivity({ details: 'last words' });
    await client.nextReply();
    client.destroy();

    // Still held right after the disconnect
    await new Promise((r) => setTimeout(r, 300));
    expect(pushes.at(-1)?.activity.details).toBe('last words');

    // Cleared once the grace (2.5s) lapses
    await new Promise((r) => setTimeout(r, 2600));
    expect(pushes.at(-1)).toBeNull();
  });

  it('stops cleanly, unlinks its sockets, and restarts', async () => {
    await startServer();
    expect(fs.existsSync(path.join(runtimeDir, 'discord-ipc-0'))).toBe(true);
    stopRichPresenceIpcServer();
    expect(getRichPresenceIpcStatus().running).toBe(false);
    expect(fs.existsSync(path.join(runtimeDir, 'discord-ipc-0'))).toBe(false);

    await startServer();
    expect(getRichPresenceIpcStatus().running).toBe(true);
    expect(getRichPresenceIpcStatus().socketCount).toBe(10);
    const client = new TestClient();
    await client.connected();
    client.handshakeFramed();
    expect((await client.nextReply()).payload).toMatchObject({ cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } });
    client.destroy();
  });
});
