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

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('./federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('./federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://local.test' };
});

function applyMigrations(target: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) target.exec(clean);
    }
  }
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
});

describe('subject keys', () => {
  it('match an identity by home user id and home domain, however the instance is spelled', async () => {
    const { memberClockSubject } = await import('./federationSubjectClock.js');
    const full = memberClockSubject('g', { homeUserId: 'u1', homeInstance: 'https://Peer.example/' });
    expect(memberClockSubject('g', { homeUserId: 'u1', homeInstance: 'peer.example' })).toBe(full);
    expect(memberClockSubject('g', { homeUserId: 'u1', homeInstance: 'https://other.example' })).not.toBe(full);
    expect(memberClockSubject('g', { homeUserId: 'u2', homeInstance: 'https://peer.example' })).not.toBe(full);
    expect(memberClockSubject('g2', { homeUserId: 'u1', homeInstance: 'https://peer.example' })).not.toBe(full);
  });

  it('give no subject for an incomplete identity or a missing group', async () => {
    const { memberClockSubject, friendPairClockSubject } = await import('./federationSubjectClock.js');
    expect(memberClockSubject(null, { homeUserId: 'u1', homeInstance: 'https://peer.example' })).toBeNull();
    expect(memberClockSubject('g', { homeUserId: '', homeInstance: 'https://peer.example' })).toBeNull();
    expect(friendPairClockSubject({ homeUserId: 'u1', homeInstance: '' }, { homeUserId: 'u2', homeInstance: 'https://peer.example' })).toBeNull();
  });

  it('name a friend pair the same in either order', async () => {
    const { friendPairClockSubject } = await import('./federationSubjectClock.js');
    const a = { homeUserId: 'alice', homeInstance: 'https://peer.example' };
    const b = { homeUserId: 'bob', homeInstance: 'https://local.test' };
    expect(friendPairClockSubject(a, b)).toBe(friendPairClockSubject(b, a));
    expect(friendPairClockSubject(a, b)).not.toBe(friendPairClockSubject(a, { homeUserId: 'bob', homeInstance: 'https://peer.example' }));
  });
});

describe('the clock', () => {
  it('a change older than the recorded one is stale; the same time is not; the clock never moves back', async () => {
    const { claimSubjectChange, isSubjectChangeStale, recordSubjectChange } = await import('./federationSubjectClock.js');
    expect(isSubjectChangeStale('s', 1_000, testDb)).toBe(false);
    expect(claimSubjectChange('s', 2_000, testDb)).toBe(true);
    expect(claimSubjectChange('s', 1_000, testDb)).toBe(false);
    expect(claimSubjectChange('s', 2_000, testDb)).toBe(true);

    recordSubjectChange('s', 500, testDb);
    expect(testDb.select().from(schema.federationSubjectClocks).all())
      .toEqual([expect.objectContaining({ subjectKey: 's', changedAt: 2_000 })]);
    expect(claimSubjectChange('s', 3_000, testDb)).toBe(true);
    expect(isSubjectChangeStale('s', 2_999, testDb)).toBe(true);
  });

  it('orders a change without a usable timestamp before every recorded one', async () => {
    const { claimSubjectChange } = await import('./federationSubjectClock.js');
    expect(claimSubjectChange('s', Number.NaN, testDb)).toBe(true);
    expect(claimSubjectChange('s', 1, testDb)).toBe(true);
    expect(claimSubjectChange('s', Number.NaN, testDb)).toBe(false);
  });

  it('the sweep removes rows not written within the retention', async () => {
    const { recordSubjectChange, sweepSubjectClocks, SUBJECT_CLOCK_RETENTION_MS } = await import('./federationSubjectClock.js');
    const now = 1_000_000_000_000;
    recordSubjectChange('old', 1, testDb, now - SUBJECT_CLOCK_RETENTION_MS - 1);
    recordSubjectChange('kept', 1, testDb, now - SUBJECT_CLOCK_RETENTION_MS + 1);
    expect(sweepSubjectClocks(now)).toBe(1);
    expect(testDb.select({ key: schema.federationSubjectClocks.subjectKey }).from(schema.federationSubjectClocks).all())
      .toEqual([{ key: 'kept' }]);
  });
});
