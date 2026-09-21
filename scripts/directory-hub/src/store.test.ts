import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  applyDocument,
  deleteOlderThan,
  feed,
  getLastFetchAt,
  readOriginHash,
  touchFetchAttempt,
  touchOriginOk,
} from './store';
import { documentHash } from './hash';
import type { ValidDocument, ValidSpace } from './validate';

const ORIGIN = 'https://chat.example.org';
const OTHER = 'https://other.example.org';
const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

function space(over: Partial<ValidSpace> = {}): ValidSpace {
  return {
    id: 'a',
    name: 'Alpha',
    description: 'first',
    icon: null,
    banner: null,
    avatarColor: 'mint',
    visibility: 'public',
    memberCount: 3,
    createdAt: 1_000,
    ...over,
  };
}

function doc(spaces: ValidSpace[], over: Partial<Omit<ValidDocument, 'spaces'>> = {}): ValidDocument {
  return { instanceName: 'Test', federatedRegistrationOpen: true, version: '1.4.0', spaces, ...over };
}

/** Applies `d` for `origin` at `at`, hashing it the way the ping route will. */
async function apply(origin: string, d: ValidDocument, at: number) {
  return applyDocument(env.DB, origin, d, await documentHash(d), at);
}

interface SpaceRow {
  origin: string;
  id: string;
  row_hash: string;
  name: string;
  description: string | null;
  icon: string | null;
  banner: string | null;
  avatar_color: string | null;
  visibility: string;
  member_count: number;
  created_at: number;
}

interface OriginRow {
  origin: string;
  instance_name: string;
  federated_registration_open: number;
  version: string | null;
  document_hash: string;
  first_seen_at: number;
  last_ok_at: number;
}

async function spaceRows(origin: string): Promise<SpaceRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM spaces WHERE origin = ?1 ORDER BY id').bind(origin).all<SpaceRow>();
  return results;
}

async function originRow(origin: string): Promise<OriginRow | null> {
  return env.DB.prepare('SELECT * FROM origins WHERE origin = ?1').bind(origin).first<OriginRow>();
}

async function block(origin: string, spaceId = '*'): Promise<void> {
  await env.DB.prepare('INSERT INTO blocks (origin, space_id, reason, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(origin, spaceId, 'test', T0)
    .run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM spaces'),
    env.DB.prepare('DELETE FROM origins'),
    env.DB.prepare('DELETE FROM fetch_attempts'),
    env.DB.prepare('DELETE FROM blocks'),
  ]);
});

describe('fetch attempts', () => {
  it('reads null for an origin never pinged', async () => {
    expect(await getLastFetchAt(env.DB, ORIGIN)).toBeNull();
  });

  it('upserts last_fetch_at', async () => {
    await touchFetchAttempt(env.DB, ORIGIN, T0);
    expect(await getLastFetchAt(env.DB, ORIGIN)).toBe(T0);
    await touchFetchAttempt(env.DB, ORIGIN, T0 + 5_000);
    expect(await getLastFetchAt(env.DB, ORIGIN)).toBe(T0 + 5_000);
    const { results } = await env.DB.prepare('SELECT origin FROM fetch_attempts').all();
    expect(results).toHaveLength(1);
  });
});

describe('readOriginHash', () => {
  it('reads null for an unknown origin and the stored hash otherwise', async () => {
    expect(await readOriginHash(env.DB, ORIGIN)).toBeNull();
    await applyDocument(env.DB, ORIGIN, doc([space()]), 'hash-1', T0);
    expect(await readOriginHash(env.DB, ORIGIN)).toBe('hash-1');
  });
});

describe('applyDocument', () => {
  it('inserts every row and the origins row on an empty origin', async () => {
    const d = doc([space({ id: 'a' }), space({ id: 'b', name: 'Beta', memberCount: 7 })]);
    const hash = await documentHash(d);
    const result = await applyDocument(env.DB, ORIGIN, d, hash, T0);
    expect(result).toEqual({ inserted: 2, updated: 0, deleted: 0 });

    const origin = await originRow(ORIGIN);
    expect(origin).toEqual({
      origin: ORIGIN,
      instance_name: 'Test',
      federated_registration_open: 1,
      version: '1.4.0',
      document_hash: hash,
      first_seen_at: T0,
      last_ok_at: T0,
    });

    const rows = await spaceRows(ORIGIN);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[0]).toMatchObject({
      origin: ORIGIN,
      name: 'Alpha',
      description: 'first',
      icon: null,
      banner: null,
      avatar_color: 'mint',
      visibility: 'public',
      member_count: 3,
      created_at: 1_000,
    });
    expect(rows[1]).toMatchObject({ name: 'Beta', member_count: 7 });
    for (const row of rows) expect(row.row_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores a false federatedRegistrationOpen and a null version', async () => {
    await apply(ORIGIN, doc([], { federatedRegistrationOpen: false, version: null }), T0);
    expect(await originRow(ORIGIN)).toMatchObject({ federated_registration_open: 0, version: null });
  });

  it('writes one update, one insert and one delete for a changed, a new and a gone space', async () => {
    const a = space({ id: 'a' });
    const b = space({ id: 'b', name: 'Beta' });
    const c = space({ id: 'c', name: 'Gamma' });
    await apply(ORIGIN, doc([a, b, c]), T0);
    const before = await spaceRows(ORIGIN);

    const bChanged = space({ id: 'b', name: 'Beta', memberCount: 99 });
    const d = space({ id: 'd', name: 'Delta' });
    const next = doc([a, bChanged, d]);
    const nextHash = await documentHash(next);
    const result = await applyDocument(env.DB, ORIGIN, next, nextHash, T0 + DAY);
    expect(result).toEqual({ inserted: 1, updated: 1, deleted: 1 });

    const after = await spaceRows(ORIGIN);
    expect(after.map((r) => r.id)).toEqual(['a', 'b', 'd']);
    const rowA = after.find((r) => r.id === 'a');
    const rowB = after.find((r) => r.id === 'b');
    expect(rowA?.row_hash).toBe(before.find((r) => r.id === 'a')?.row_hash);
    expect(rowB?.row_hash).not.toBe(before.find((r) => r.id === 'b')?.row_hash);
    expect(rowB?.member_count).toBe(99);

    expect(await originRow(ORIGIN)).toMatchObject({ document_hash: nextHash, first_seen_at: T0, last_ok_at: T0 + DAY });
  });

  it('refreshes last_ok_at and document_hash without touching rows when nothing changed', async () => {
    const d = doc([space({ id: 'a' }), space({ id: 'b', name: 'Beta' })]);
    await applyDocument(env.DB, ORIGIN, d, 'hash-1', T0);
    const before = await spaceRows(ORIGIN);

    const result = await applyDocument(env.DB, ORIGIN, d, 'hash-2', T0 + DAY);
    expect(result).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(await spaceRows(ORIGIN)).toEqual(before);
    expect(await originRow(ORIGIN)).toMatchObject({ document_hash: 'hash-2', first_seen_at: T0, last_ok_at: T0 + DAY });
  });

  it('updates the instance fields of the origins row', async () => {
    await apply(ORIGIN, doc([space()]), T0);
    await apply(ORIGIN, doc([space()], { instanceName: 'Renamed', federatedRegistrationOpen: false, version: '1.5.0' }), T0 + 1);
    expect(await originRow(ORIGIN)).toMatchObject({
      instance_name: 'Renamed',
      federated_registration_open: 0,
      version: '1.5.0',
      first_seen_at: T0,
      last_ok_at: T0 + 1,
    });
  });

  it('deletes every row for the origin and keeps the origins row on an empty spaces list', async () => {
    await apply(ORIGIN, doc([space({ id: 'a' }), space({ id: 'b' })]), T0);
    await apply(OTHER, doc([space({ id: 'a' })]), T0);

    const result = await apply(ORIGIN, doc([]), T0 + 1);
    expect(result).toEqual({ inserted: 0, updated: 0, deleted: 2 });
    expect(await spaceRows(ORIGIN)).toEqual([]);
    expect(await originRow(ORIGIN)).toMatchObject({ last_ok_at: T0 + 1 });
    // The other origin is untouched.
    expect(await spaceRows(OTHER)).toHaveLength(1);
  });

  it('applies a 200-space document as 200 rows', async () => {
    const spaces = Array.from({ length: 200 }, (_, i) =>
      space({ id: `s${String(i).padStart(3, '0')}`, name: `Space ${i}`, memberCount: i }),
    );
    const result = await apply(ORIGIN, doc(spaces), T0);
    expect(result).toEqual({ inserted: 200, updated: 0, deleted: 0 });
    expect(await spaceRows(ORIGIN)).toHaveLength(200);

    // And back down to one row in a single batch of 199 deletes plus the origins upsert.
    const shrunk = await apply(ORIGIN, doc([spaces[0]!]), T0 + 1);
    expect(shrunk).toEqual({ inserted: 0, updated: 0, deleted: 199 });
    expect(await spaceRows(ORIGIN)).toHaveLength(1);
  });
});

describe('touchOriginOk', () => {
  it('updates last_ok_at and nothing else', async () => {
    const d = doc([space({ id: 'a' }), space({ id: 'b', name: 'Beta' })]);
    await applyDocument(env.DB, ORIGIN, d, 'hash-1', T0);
    const rowsBefore = await spaceRows(ORIGIN);
    const originBefore = await originRow(ORIGIN);

    await touchOriginOk(env.DB, ORIGIN, T0 + DAY);

    expect(await spaceRows(ORIGIN)).toEqual(rowsBefore);
    expect(await originRow(ORIGIN)).toEqual({ ...originBefore, last_ok_at: T0 + DAY });
  });

  it('does nothing for an unknown origin', async () => {
    await touchOriginOk(env.DB, ORIGIN, T0);
    expect(await originRow(ORIGIN)).toBeNull();
  });
});

describe('feed', () => {
  const NOW = T0 + 10 * DAY;
  const SINCE = NOW - 3 * DAY;

  function q(over: Partial<{ q: string; limit: number; offset: number; since: number }> = {}) {
    return feed(env.DB, { q: '', limit: 50, offset: 0, since: SINCE, ...over });
  }

  it('orders by member_count DESC, created_at DESC and carries every entry field in snake case', async () => {
    await apply(
      ORIGIN,
      doc([
        space({ id: 'small', name: 'Small', memberCount: 1, createdAt: 5 }),
        space({ id: 'big-old', name: 'Big old', memberCount: 10, createdAt: 1 }),
        space({ id: 'big-new', name: 'Big new', memberCount: 10, createdAt: 2 }),
      ]),
      NOW,
    );
    await apply(OTHER, doc([space({ id: 'mid', name: 'Mid', memberCount: 5, createdAt: 3, icon: `${OTHER}/i.png` })], { instanceName: 'Other', federatedRegistrationOpen: false }), NOW);

    const rows = await q();
    expect(rows.map((r) => r.id)).toEqual(['big-new', 'big-old', 'mid', 'small']);
    expect(rows[2]).toEqual({
      origin: OTHER,
      instance_name: 'Other',
      federated_registration_open: 0,
      id: 'mid',
      name: 'Mid',
      description: 'first',
      icon: `${OTHER}/i.png`,
      banner: null,
      avatar_color: 'mint',
      visibility: 'public',
      member_count: 5,
      created_at: 3,
    });
  });

  it('honours limit and offset', async () => {
    await apply(
      ORIGIN,
      doc(Array.from({ length: 5 }, (_, i) => space({ id: `s${i}`, memberCount: 10 - i }))),
      NOW,
    );
    expect((await q({ limit: 2 })).map((r) => r.id)).toEqual(['s0', 's1']);
    expect((await q({ limit: 2, offset: 2 })).map((r) => r.id)).toEqual(['s2', 's3']);
    expect((await q({ limit: 2, offset: 4 })).map((r) => r.id)).toEqual(['s4']);
    expect(await q({ limit: 2, offset: 5 })).toEqual([]);
  });

  it('excludes origins whose last_ok_at is before since', async () => {
    await apply(ORIGIN, doc([space({ id: 'fresh' })]), SINCE);
    await apply(OTHER, doc([space({ id: 'stale' })]), SINCE - 1);
    expect((await q()).map((r) => r.id)).toEqual(['fresh']);
  });

  it('excludes a blocked origin and a blocked single space', async () => {
    await apply(ORIGIN, doc([space({ id: 'kept', memberCount: 2 }), space({ id: 'blocked', memberCount: 9 })]), NOW);
    await apply(OTHER, doc([space({ id: 'gone', memberCount: 20 })]), NOW);
    await block(OTHER);
    await block(ORIGIN, 'blocked');
    expect((await q()).map((r) => `${r.origin} ${r.id}`)).toEqual([`${ORIGIN} kept`]);
  });

  it('matches q against name or description, case-insensitively', async () => {
    await apply(
      ORIGIN,
      doc([
        space({ id: 'by-name', name: 'Gardening Club', description: null, memberCount: 3 }),
        space({ id: 'by-description', name: 'Misc', description: 'we talk about gardens', memberCount: 2 }),
        space({ id: 'neither', name: 'Cooking', description: 'recipes', memberCount: 1 }),
      ]),
      NOW,
    );
    expect((await q({ q: 'GARDEN' })).map((r) => r.id)).toEqual(['by-name', 'by-description']);
    expect((await q({ q: 'cook' })).map((r) => r.id)).toEqual(['neither']);
    expect(await q({ q: 'nothing here' })).toEqual([]);
  });

  it('treats %, _ and backslash in q literally', async () => {
    await apply(
      ORIGIN,
      doc([
        space({ id: 'percent', name: 'Sale', description: '50% off', memberCount: 3 }),
        space({ id: 'words', name: 'Sale', description: '50 percent off', memberCount: 2 }),
        space({ id: 'underscore', name: 'snake_case', description: null, memberCount: 1 }),
        space({ id: 'dash', name: 'snake-case', description: null, memberCount: 0 }),
        space({ id: 'slash', name: 'a\\b', description: null, memberCount: 0 }),
      ]),
      NOW,
    );
    expect((await q({ q: '50%' })).map((r) => r.id)).toEqual(['percent']);
    expect((await q({ q: 'snake_' })).map((r) => r.id)).toEqual(['underscore']);
    expect((await q({ q: 'a\\b' })).map((r) => r.id)).toEqual(['slash']);
    expect(await q({ q: '\\' })).toHaveLength(1);
  });
});

describe('deleteOlderThan', () => {
  it('removes origins with their spaces and fetch_attempts older than the cutoff and nothing newer', async () => {
    const cutoff = T0 + 30 * DAY;
    await apply(ORIGIN, doc([space({ id: 'a' }), space({ id: 'b' })]), cutoff - 1);
    await apply(OTHER, doc([space({ id: 'a' })]), cutoff);
    await touchFetchAttempt(env.DB, ORIGIN, cutoff - 1);
    await touchFetchAttempt(env.DB, OTHER, cutoff);
    await touchFetchAttempt(env.DB, 'https://never-valid.example.org', cutoff - DAY);

    // One origin, its two cascaded spaces, and two fetch attempts. D1 counts
    // the cascaded rows in `meta.changes`, which plain SQLite would not.
    const removed = await deleteOlderThan(env.DB, cutoff);
    expect(removed).toBe(5);

    expect(await originRow(ORIGIN)).toBeNull();
    expect(await spaceRows(ORIGIN)).toEqual([]);
    expect(await originRow(OTHER)).not.toBeNull();
    expect(await spaceRows(OTHER)).toHaveLength(1);
    expect(await getLastFetchAt(env.DB, ORIGIN)).toBeNull();
    expect(await getLastFetchAt(env.DB, 'https://never-valid.example.org')).toBeNull();
    expect(await getLastFetchAt(env.DB, OTHER)).toBe(cutoff);
  });

  it('returns 0 when nothing is old enough', async () => {
    await apply(ORIGIN, doc([space()]), T0);
    expect(await deleteOlderThan(env.DB, T0)).toBe(0);
    expect(await originRow(ORIGIN)).not.toBeNull();
  });
});
