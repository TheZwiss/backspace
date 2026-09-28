import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('./federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('./federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://here.test' };
});

const {
  MAX_RELAYED_MENTIONS,
  mentionTokenIds,
  relayMentionsOf,
  replaceMentionTokens,
  rewriteRelayedMentions,
} = await import('./federationMentions.js');

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedUser(row: Partial<typeof schema.users.$inferInsert> & { id: string; username: string }): void {
  testDb.insert(schema.users).values({
    passwordHash: '!federation-replicated',
    createdAt: 1,
    ...row,
  } as typeof schema.users.$inferInsert).run();
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  // Native here.
  seedUser({ id: 'ann', username: 'ann', passwordHash: 'real-hash' });
  // Stub of kai, native on there.test as "kai-home".
  seedUser({ id: 'kai-here', username: 'kai@there.test', homeInstance: 'there.test', homeUserId: 'kai-home' });
  // Stub of a third-instance user.
  seedUser({ id: 'ola-here', username: 'ola@third.test', homeInstance: 'third.test', homeUserId: 'ola-home' });
  // A deleted native.
  seedUser({ id: 'gone', username: 'gone', passwordHash: 'x', isDeleted: 1 });
});

describe('mention tokens', () => {
  it('reads the ids of tokens outside code, once each, in order', () => {
    expect(mentionTokenIds('<@a> x <@b-1> <@a> `<@c>` ```\n<@d>\n``` <@e_2>')).toEqual(['a', 'b-1', 'e_2']);
  });

  it('replaces mapped tokens outside code and leaves everything else as written', () => {
    const map = new Map([['a', 'A'], ['c', 'C']]);
    expect(replaceMentionTokens('<@a> <@b> `<@a>` ```<@c>``` <@c>', map)).toBe('<@A> <@b> `<@a>` ```<@c>``` <@C>');
  });
});

describe('relayMentionsOf (sender)', () => {
  it('names each mentioned local row by its federated identity', () => {
    expect(relayMentionsOf('hi <@ann>, <@kai-here> and <@ola-here>')).toEqual([
      { id: 'ann', homeUserId: 'ann', homeInstance: 'https://here.test' },
      { id: 'kai-here', homeUserId: 'kai-home', homeInstance: 'there.test' },
      { id: 'ola-here', homeUserId: 'ola-home', homeInstance: 'third.test' },
    ]);
  });

  it('leaves out ids that name no live row, and tokens inside code', () => {
    expect(relayMentionsOf('<@nobody> <@gone> `<@ann>`')).toEqual([]);
    expect(relayMentionsOf(null)).toEqual([]);
  });

  it('caps the list', () => {
    const ids = Array.from({ length: MAX_RELAYED_MENTIONS + 5 }, (_, i) => `u${i}`);
    for (const id of ids) seedUser({ id, username: id, passwordHash: 'x' });
    expect(relayMentionsOf(ids.map(id => `<@${id}>`).join(' '))).toHaveLength(MAX_RELAYED_MENTIONS);
  });
});

describe('rewriteRelayedMentions (receiver)', () => {
  it('rewrites each listed id to the row that is that identity here', () => {
    const content = '<@x1> <@x2> <@x3>';
    const mentions = [
      { id: 'x1', homeUserId: 'ann', homeInstance: 'https://here.test' },
      { id: 'x2', homeUserId: 'kai-home', homeInstance: 'https://there.test' },
      { id: 'x3', homeUserId: 'ola-home', homeInstance: 'https://third.test' },
    ];
    expect(rewriteRelayedMentions(content, mentions, testDb)).toBe('<@ann> <@kai-here> <@ola-here>');
  });

  it('matches by identity pair, never by bare id', () => {
    // kai-home on another instance is not the kai stub here; "ann" homed elsewhere is not the native ann.
    const mentions = [
      { id: 'x1', homeUserId: 'kai-home', homeInstance: 'https://elsewhere.test' },
      { id: 'x2', homeUserId: 'ann', homeInstance: 'https://there.test' },
    ];
    expect(rewriteRelayedMentions('<@x1> <@x2>', mentions, testDb)).toBe('<@x1> <@x2>');
  });

  it('keeps a token whose identity is unknown or deleted here, and never creates a row for it', () => {
    const before = testDb.select().from(schema.users).all().length;
    const mentions = [
      { id: 'x1', homeUserId: 'stranger', homeInstance: 'https://there.test' },
      { id: 'x2', homeUserId: 'gone', homeInstance: 'https://here.test' },
    ];
    expect(rewriteRelayedMentions('<@x1> <@x2>', mentions, testDb)).toBe('<@x1> <@x2>');
    expect(testDb.select().from(schema.users).all()).toHaveLength(before);
  });

  it('stores the content as sent without a list (older sender)', () => {
    expect(rewriteRelayedMentions('<@x1>', undefined, testDb)).toBe('<@x1>');
    expect(rewriteRelayedMentions(null, [{ id: 'x1', homeUserId: 'ann', homeInstance: 'https://here.test' }], testDb)).toBeNull();
  });

  it('ignores malformed entries, a non-array list, repeats of an id, and entries past the cap', () => {
    const good = { id: 'x1', homeUserId: 'ann', homeInstance: 'https://here.test' };
    expect(rewriteRelayedMentions('<@x1>', 'nope', testDb)).toBe('<@x1>');
    expect(rewriteRelayedMentions('<@x1> <@x2>', [
      null,
      { id: 'x2', homeUserId: 42, homeInstance: 'https://here.test' },
      { id: 'x 1', homeUserId: 'ann', homeInstance: 'https://here.test' },
      good,
      { id: 'x1', homeUserId: 'kai-home', homeInstance: 'https://there.test' },
    ], testDb)).toBe('<@ann> <@x2>');

    const padding = Array.from({ length: MAX_RELAYED_MENTIONS }, (_, i) => ({ id: `p${i}`, homeUserId: 'nobody', homeInstance: 'https://there.test' }));
    expect(rewriteRelayedMentions('<@x1>', [...padding, good], testDb)).toBe('<@x1>');
  });

  it('leaves tokens inside code alone', () => {
    const mentions = [{ id: 'x1', homeUserId: 'ann', homeInstance: 'https://here.test' }];
    expect(rewriteRelayedMentions('`<@x1>` <@x1>', mentions, testDb)).toBe('`<@x1>` <@ann>');
  });
});
