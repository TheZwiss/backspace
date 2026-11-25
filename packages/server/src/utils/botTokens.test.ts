import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;
let sqlite: Database.Database;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, schema }));

import {
  BOT_TOKEN_PREFIX,
  countBotTokens,
  isBotTokenString,
  isRetiredLegacyBotJwt,
  issueBotToken,
  listBotTokens,
  revokeAllBotTokens,
  revokeBotToken,
  verifyBotToken,
} from './botTokens.js';

const T0 = 1_800_000_000_000;

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (stmt.trim()) db.exec(stmt.trim());
    }
  }
}

function seedBot(id: string, over: Partial<typeof schema.users.$inferInsert> = {}): void {
  testDb.insert(schema.users).values({
    id, username: `${id}_bot`, passwordHash: '!bot', isBot: 1, botOwnerId: 'owner', createdAt: 1, ...over,
  }).run();
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  testDb.insert(schema.users).values({ id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 }).run();
  seedBot('b1');
});

describe('issueBotToken / verifyBotToken', () => {
  it('issues a bsb_ token that resolves to its bot, and stores only a hash', () => {
    const issued = issueBotToken('b1', 'radio', T0);
    expect(issued.token.startsWith(BOT_TOKEN_PREFIX)).toBe(true);
    expect(isBotTokenString(issued.token)).toBe(true);
    expect(verifyBotToken(issued.token, T0)).toEqual({ tokenId: issued.id, userId: 'b1', username: 'b1_bot', homeInstance: null });

    const secret = issued.token.split('.')[1]!;
    const row = testDb.select().from(schema.botTokens).get()!;
    expect(row.tokenHash).not.toContain(secret);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it('two tokens of one bot are different and both work', () => {
    const a = issueBotToken('b1', null, T0);
    const b = issueBotToken('b1', null, T0);
    expect(a.token).not.toBe(b.token);
    expect(verifyBotToken(a.token, T0)).not.toBe('invalid');
    expect(verifyBotToken(b.token, T0)).not.toBe('invalid');
  });

  it('rejects a wrong secret, an unknown id and malformed strings alike', () => {
    const issued = issueBotToken('b1', null, T0);
    const [head] = issued.token.split('.');
    expect(verifyBotToken(`${head}.${'A'.repeat(43)}`, T0)).toBe('invalid');
    expect(verifyBotToken(`bsb_${'0'.repeat(16)}.${'A'.repeat(43)}`, T0)).toBe('invalid');
    expect(verifyBotToken('bsb_nope', T0)).toBe('invalid');
    expect(verifyBotToken(`${head}.`, T0)).toBe('invalid');
    expect(verifyBotToken('', T0)).toBe('invalid');
  });

  it('a token of a deleted bot is reported as deleted, of a non-bot as invalid', () => {
    const issued = issueBotToken('b1', null, T0);
    testDb.update(schema.users).set({ isDeleted: 1 }).where(eq(schema.users.id, 'b1')).run();
    expect(verifyBotToken(issued.token, T0)).toBe('deleted');

    seedBot('h1', { isBot: 0 });
    const human = issueBotToken('h1', null, T0);
    expect(verifyBotToken(human.token, T0)).toBe('invalid');
  });

  it('writes last_used_at at most once a minute', () => {
    const issued = issueBotToken('b1', null, T0);
    const used = () => listBotTokens('b1')[0]!.lastUsedAt;
    expect(used()).toBeNull();
    verifyBotToken(issued.token, T0);
    expect(used()).toBe(T0);
    verifyBotToken(issued.token, T0 + 30_000);
    expect(used()).toBe(T0);
    verifyBotToken(issued.token, T0 + 60_000);
    expect(used()).toBe(T0 + 60_000);
  });
});

describe('revoking', () => {
  it('one token goes, the other stays; an unknown id or another bot changes nothing', () => {
    seedBot('b2');
    const a = issueBotToken('b1', 'a', T0);
    const b = issueBotToken('b1', 'b', T0);
    expect(revokeBotToken('b2', a.id)).toBe(false);
    expect(revokeBotToken('b1', 'ffffffffffffffff')).toBe(false);
    expect(revokeBotToken('b1', a.id)).toBe(true);
    expect(verifyBotToken(a.token, T0)).toBe('invalid');
    expect(verifyBotToken(b.token, T0)).not.toBe('invalid');
    expect(countBotTokens('b1')).toBe(1);
  });

  it('revokeAll ends every token of that bot only', () => {
    seedBot('b2');
    const a = issueBotToken('b1', null, T0);
    const other = issueBotToken('b2', null, T0);
    revokeAllBotTokens('b1');
    expect(verifyBotToken(a.token, T0)).toBe('invalid');
    expect(verifyBotToken(other.token, T0)).not.toBe('invalid');
  });

  it('deleting the bot row removes its tokens (cascade)', () => {
    issueBotToken('b1', null, T0);
    sqlite.prepare('DELETE FROM users WHERE id = ?').run('b1');
    expect(testDb.select().from(schema.botTokens).all()).toHaveLength(0);
  });
});

describe('isRetiredLegacyBotJwt', () => {
  it('a native bot with a bsb_ token no longer accepts its old JWT', () => {
    const bot = { id: 'b1', isBot: 1, homeInstance: null };
    expect(isRetiredLegacyBotJwt(bot)).toBe(false);
    issueBotToken('b1', null, T0);
    expect(isRetiredLegacyBotJwt(bot)).toBe(true);
  });

  it('never touches a person or a bot account federated from another instance', () => {
    issueBotToken('b1', null, T0);
    expect(isRetiredLegacyBotJwt({ id: 'b1', isBot: 0, homeInstance: null })).toBe(false);
    expect(isRetiredLegacyBotJwt({ id: 'b1', isBot: 1, homeInstance: 'home.test' })).toBe(false);
  });
});
