import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { signJwt } from '../utils/auth.js';
import { config } from '../config.js';

setWorkerId(28);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));

const forceDisconnectUser = vi.hoisted(() => vi.fn());
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    forceDisconnectUser,
    removeUserSpace: vi.fn(),
    addUserSpace: vi.fn(),
  },
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (stmt.trim()) db.exec(stmt.trim());
    }
  }
}

const owner = () => ({ Authorization: `Bearer ${signJwt({ userId: 'owner', username: 'owner' })}` });
const stranger = () => ({ Authorization: `Bearer ${signJwt({ userId: 'stranger', username: 'stranger' })}` });

interface TokenBody { id: string; token: string; name: string | null; createdAt: number; lastUsedAt: number | null }
const create = (name?: unknown, headers = owner()) => app.inject({
  method: 'POST', url: '/api/bots/bot-1/tokens', headers, payload: name === undefined ? {} : { name },
});
const me = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/bots/bot-1/tokens', headers });

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  testDb.insert(schema.users).values([
    { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
    { id: 'stranger', username: 'stranger', passwordHash: 'x', createdAt: 1 },
    { id: 'bot-1', username: 'radio_bot', passwordHash: '!bot', isBot: 1, botOwnerId: 'owner', createdAt: 1 },
  ]).run();
  forceDisconnectUser.mockClear();
  const { botRoutes } = await import('./bots.js');
  app = Fastify({ logger: false });
  await app.register(botRoutes);
  await app.ready();
});

describe('POST /api/bots', () => {
  it('hands out a bsb_ token that authenticates the new bot', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/bots', headers: owner(), payload: { name: 'echo' } });
    expect(res.statusCode).toBe(201);
    const { token, bot } = res.json() as { token: string; bot: { id: string } };
    expect(token.startsWith('bsb_')).toBe(true);
    expect(testDb.select().from(schema.botTokens).all()).toHaveLength(1);
    const asBot = await app.inject({ method: 'GET', url: `/api/bots/${bot.id}/tokens`, headers: { Authorization: `Bot ${token}` } });
    expect(asBot.statusCode).toBe(403); // the token works; a bot just may not manage bots
  });
});

describe('the tokens of a bot', () => {
  it('a bot that only has its old token reports legacy, with an empty list', async () => {
    const res = await me(owner());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tokens: [], legacy: true });
  });

  it('the first new token retires the old JWT and ends the live sockets', async () => {
    const legacy = signJwt({ userId: 'bot-1', username: 'radio_bot' });
    const { verifyAccessToken } = await import('../utils/auth.js');
    await expect(verifyAccessToken(legacy)).resolves.toMatchObject({ userId: 'bot-1' });

    const res = await create('radio');
    expect(res.statusCode).toBe(201);
    expect(forceDisconnectUser).toHaveBeenCalledWith('bot-1');
    await expect(verifyAccessToken(legacy)).rejects.toMatchObject({ statusCode: 401 });
    const fresh = (res.json() as TokenBody).token;
    await expect(verifyAccessToken(fresh)).resolves.toMatchObject({ userId: 'bot-1' });
  });

  it('lists tokens without their secrets, and shows last use', async () => {
    const a = (await create('one')).json() as TokenBody;
    await create();
    const { verifyAccessToken } = await import('../utils/auth.js');
    await verifyAccessToken(a.token);
    const list = (await me(owner())).json() as { tokens: Array<{ id: string; name: string | null; lastUsedAt: number | null }>; legacy: boolean };
    expect(list.legacy).toBe(false);
    expect(list.tokens).toHaveLength(2);
    expect(list.tokens.find(t => t.id === a.id)?.lastUsedAt).not.toBeNull();
    expect(JSON.stringify(list)).not.toContain(a.token.split('.')[1]);
  });

  it('adding a second token does not disconnect the bot', async () => {
    await create('one');
    forceDisconnectUser.mockClear();
    expect((await create('two')).statusCode).toBe(201);
    expect(forceDisconnectUser).not.toHaveBeenCalled();
  });

  it('revoking one token ends it and keeps the other', async () => {
    const a = (await create('one')).json() as TokenBody;
    const b = (await create('two')).json() as TokenBody;
    forceDisconnectUser.mockClear();
    const del = await app.inject({ method: 'DELETE', url: `/api/bots/bot-1/tokens/${a.id}`, headers: owner() });
    expect(del.statusCode).toBe(200);
    expect(forceDisconnectUser).toHaveBeenCalledWith('bot-1');
    const { verifyAccessToken } = await import('../utils/auth.js');
    await expect(verifyAccessToken(a.token)).rejects.toMatchObject({ statusCode: 401 });
    await expect(verifyAccessToken(b.token)).resolves.toMatchObject({ userId: 'bot-1' });

    const again = await app.inject({ method: 'DELETE', url: `/api/bots/bot-1/tokens/${a.id}`, headers: owner() });
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe('bot_token_not_found');
  });

  it('revoking the last token does not bring the old JWT back', async () => {
    const stale = jwt.sign({ userId: 'bot-1', username: 'radio_bot', iat: Math.floor(Date.now() / 1000) - 100 }, config.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: '3650d',
    });
    const { verifyAccessToken } = await import('../utils/auth.js');
    const only = (await create('only')).json() as TokenBody;
    await expect(verifyAccessToken(stale)).rejects.toMatchObject({ statusCode: 401 });

    const del = await app.inject({ method: 'DELETE', url: `/api/bots/bot-1/tokens/${only.id}`, headers: owner() });
    expect(del.statusCode).toBe(200);
    await expect(verifyAccessToken(only.token)).rejects.toMatchObject({ statusCode: 401 });
    await expect(verifyAccessToken(stale)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('allows five tokens and refuses the sixth with the limit', async () => {
    for (let i = 0; i < 5; i++) expect((await create(`t${i}`)).statusCode).toBe(201);
    const sixth = await create('t5');
    expect(sixth.statusCode).toBe(400);
    expect(sixth.json()).toMatchObject({ code: 'bot_token_limit_reached', details: { max: 5 } });
  });

  it('validates the name', async () => {
    for (const bad of ['', '   ', 'x'.repeat(33), 42]) {
      const res = await create(bad);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('bot_token_name_invalid');
    }
    expect(testDb.select().from(schema.botTokens).all()).toHaveLength(0);
  });

  it("another person's bot answers 404 on all three routes", async () => {
    expect((await me(stranger())).statusCode).toBe(404);
    expect((await create('x', stranger())).statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: '/api/bots/bot-1/tokens/abc', headers: stranger() });
    expect(del.statusCode).toBe(404);
  });
});

describe('POST /api/bots/:id/token (full cut-off)', () => {
  it('ends every earlier token and issues exactly one new', async () => {
    const a = (await create('one')).json() as TokenBody;
    const b = (await create('two')).json() as TokenBody;
    const res = await app.inject({ method: 'POST', url: '/api/bots/bot-1/token', headers: owner() });
    expect(res.statusCode).toBe(200);
    const { token } = res.json() as { token: string };
    const { verifyAccessToken } = await import('../utils/auth.js');
    await expect(verifyAccessToken(a.token)).rejects.toMatchObject({ statusCode: 401 });
    await expect(verifyAccessToken(b.token)).rejects.toMatchObject({ statusCode: 401 });
    await expect(verifyAccessToken(token)).resolves.toMatchObject({ userId: 'bot-1' });
    expect(testDb.select().from(schema.botTokens).all()).toHaveLength(1);
  });
});

describe('DELETE /api/bots/:id', () => {
  it('leaves no token behind', async () => {
    await create('one');
    const res = await app.inject({ method: 'DELETE', url: '/api/bots/bot-1', headers: owner() });
    expect(res.statusCode).toBe(200);
    expect(testDb.select().from(schema.botTokens).all()).toHaveLength(0);
  });
});
