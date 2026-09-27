import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));

// Only getOurOrigin is overridden — the rest of federationAuth (notably
// normalizeOriginForCompare) must stay real, since the delegation lookup
// depends on it.
vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://nova.ddns.net' };
});

import { attributionRefusal, extractDomain } from './federation.js';

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
});

/** A native user of this instance (nova) — we are their identity authority. */
function seedNativeUser(id: string, replicatedInstances?: string): void {
  testDb.insert(schema.users).values({
    id,
    username: id,
    passwordHash: 'x',
    isAdmin: 0,
    ...(replicatedInstances !== undefined ? { replicatedInstances } : {}),
    createdAt: Date.now(),
  } as typeof schema.users.$inferInsert).run();
}

function seedRegistryEntry(userId: string, origin: string): void {
  testDb.insert(schema.userFederationRegistry).values({
    userId,
    origin,
    label: 'Orbit',
    username: `${userId}@nova.ddns.net`,
    remoteUserId: 'remote-id',
    status: 'connected',
    addedAt: Date.now(),
  }).run();
}

describe('attributionRefusal — direct case (peer speaks for its own users)', () => {
  it('accepts when the actor is homed on the signing peer', () => {
    const actor = { homeUserId: 'u1', homeInstance: 'orbit.ddns.net' };
    expect(attributionRefusal(actor, 'https://orbit.ddns.net', testDb)).toBeNull();
  });

  it('accepts a full-URL homeInstance for the signing peer', () => {
    const actor = { homeUserId: 'u1', homeInstance: 'https://orbit.ddns.net' };
    expect(attributionRefusal(actor, 'https://orbit.ddns.net', testDb)).toBeNull();
  });

  it('rejects an actor homed on a third instance', () => {
    const actor = { homeUserId: 'u1', homeInstance: 'evil.net' };
    expect(attributionRefusal(actor, 'https://orbit.ddns.net', testDb)).toBe('attribution_mismatch');
  });
});

describe('attributionRefusal — homeward case (peer speaks for one of OUR users)', () => {
  it('accepts when the local user holds a federated account on the signing peer', () => {
    seedNativeUser('erin');
    seedRegistryEntry('erin', 'https://orbit.ddns.net');
    const actor = { homeUserId: 'erin', homeInstance: 'nova.ddns.net' };
    expect(attributionRefusal(actor, 'https://orbit.ddns.net', testDb)).toBeNull();
  });

  it('accepts when the peer is recorded in the user replicatedInstances', () => {
    seedNativeUser('erin', JSON.stringify([{ origin: 'https://orbit.ddns.net', username: 'erin@nova.ddns.net' }]));
    const actor = { homeUserId: 'erin', homeInstance: 'https://nova.ddns.net' };
    expect(attributionRefusal(actor, 'https://orbit.ddns.net', testDb)).toBeNull();
  });

  // The two refusals below cannot tell a forgery from a proof that is still on
  // its way: the registry row is written by the user's client, and a relay the
  // client caused can reach us before the client's registry push does. So they
  // refuse as `attribution_unproven`, which a sender may retry, and never as
  // the terminal `attribution_mismatch`.
  it('refuses as unproven when the local user has no recorded presence on the signing peer yet', () => {
    seedNativeUser('erin');
    const actor = { homeUserId: 'erin', homeInstance: 'nova.ddns.net' };
    expect(attributionRefusal(actor, 'https://orbit.ddns.net', testDb)).toBe('attribution_unproven');
  });

  it('refuses as unproven when the user is so far only known to be connected to a DIFFERENT peer', () => {
    seedNativeUser('erin');
    seedRegistryEntry('erin', 'https://orbit.ddns.net');
    const actor = { homeUserId: 'erin', homeInstance: 'nova.ddns.net' };
    expect(attributionRefusal(actor, 'https://vault.ddns.net', testDb)).toBe('attribution_unproven');
  });

  it('accepts once the proof that was missing has arrived', () => {
    seedNativeUser('erin');
    const actor = { homeUserId: 'erin', homeInstance: 'nova.ddns.net' };
    expect(attributionRefusal(actor, 'https://orbit.ddns.net', testDb)).toBe('attribution_unproven');
    seedRegistryEntry('erin', 'https://orbit.ddns.net');
    expect(attributionRefusal(actor, 'https://orbit.ddns.net', testDb)).toBeNull();
  });

  it('rejects when the claimed local identity does not exist', () => {
    const actor = { homeUserId: 'ghost', homeInstance: 'nova.ddns.net' };
    expect(attributionRefusal(actor, 'https://orbit.ddns.net', testDb)).toBe('attribution_mismatch');
  });

  it('does not accept a replicated stub that merely carries the same homeUserId', () => {
    // A stub homed elsewhere must never satisfy a homeward claim, even when its
    // home_user_id collides with a native id: home_user_id is only unique
    // within one instance.
    testDb.insert(schema.users).values({
      id: 'stub-row',
      username: 'erin@orbit.ddns.net',
      passwordHash: '!federation-replicated',
      isAdmin: 0,
      homeInstance: 'orbit.ddns.net',
      homeUserId: 'erin',
      createdAt: Date.now(),
    } as typeof schema.users.$inferInsert).run();
    seedRegistryEntry('stub-row', 'https://orbit.ddns.net');

    const actor = { homeUserId: 'erin', homeInstance: 'nova.ddns.net' };
    expect(attributionRefusal(actor, 'https://orbit.ddns.net', testDb)).toBe('attribution_mismatch');
  });

  it('rejects a deleted local identity', () => {
    testDb.insert(schema.users).values({
      id: 'erin',
      username: 'erin',
      passwordHash: 'x',
      isAdmin: 0,
      isDeleted: 1,
      createdAt: Date.now(),
    } as typeof schema.users.$inferInsert).run();
    seedRegistryEntry('erin', 'https://orbit.ddns.net');

    const actor = { homeUserId: 'erin', homeInstance: 'nova.ddns.net' };
    expect(attributionRefusal(actor, 'https://orbit.ddns.net', testDb)).toBe('attribution_mismatch');
  });
});

describe('attributionRefusal — malformed actors', () => {
  it('rejects a missing actor', () => {
    expect(attributionRefusal(undefined, 'https://orbit.ddns.net', testDb)).toBe('attribution_mismatch');
  });

  it('rejects an actor with no homeUserId — a homeInstance alone is not an identity', () => {
    expect(attributionRefusal({ homeUserId: '', homeInstance: 'orbit.ddns.net' }, 'https://orbit.ddns.net', testDb)).toBe('attribution_mismatch');
  });

  it('rejects an actor with no homeInstance — a homeUserId alone is not an identity', () => {
    expect(attributionRefusal({ homeUserId: 'u1', homeInstance: '' }, 'https://orbit.ddns.net', testDb)).toBe('attribution_mismatch');
  });
});

describe('extractDomain', () => {
  it('strips https:// prefix', () => {
    expect(extractDomain('https://nova.ddns.net')).toBe('nova.ddns.net');
  });

  it('returns bare domain unchanged', () => {
    expect(extractDomain('nova.ddns.net')).toBe('nova.ddns.net');
  });

  it('strips http:// prefix and port via URL constructor', () => {
    // URL.hostname strips port — extractDomain returns bare hostname
    expect(extractDomain('http://localhost:3000')).toBe('localhost');
  });
});
