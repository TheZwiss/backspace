import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FederationRelayEvent, SpaceInviteSystemPayload } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Relayed system content is validated (dm-system.md, "System messages"): the
 * only system message a peer relays is a space invite, so a relayed create of
 * type 'system' is stored only when it is a well-formed `space_invite`, and a
 * relayed update never changes a system message, since system messages
 * cannot be edited.
 */

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let db: TestDb;

const HOME_ORIGIN = 'https://home.test';
const ORBIT_ORIGIN = 'https://orbit.test';

vi.mock('../db/index.js', () => ({
  getDb: () => db,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => ORBIT_ORIGIN };
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

const INVITE: SpaceInviteSystemPayload = {
  event: 'space_invite',
  spaceId: 'space-1',
  spaceInstanceOrigin: HOME_ORIGIN,
  inviteCode: 'abc123',
  snapshot: {
    spaceName: 'Lounge',
    icon: null,
    avatarColor: 'mint',
    memberCount: 4,
    description: null,
    instanceName: 'Home',
  },
};

function createEvent(messageId: string, content: string): FederationRelayEvent {
  return {
    eventType: 'create',
    dmChannelId: 'ch-on-home',
    messageId,
    encryptionVersion: 0,
    timestamp: 100,
    participants: [
      { homeUserId: 'alice', homeInstance: HOME_ORIGIN },
      { homeUserId: 'bob', homeInstance: ORBIT_ORIGIN },
    ],
    message: {
      userId: 'alice',
      homeUserId: 'alice',
      homeInstance: HOME_ORIGIN,
      type: 'system',
      content,
      replyToId: null,
      editedAt: null,
      createdAt: 100,
    },
  };
}

async function relay(events: FederationRelayEvent[]) {
  const { processRelayEvents } = await import('./federation.js');
  return processRelayEvents(events, HOME_ORIGIN, HOME_ORIGIN, db);
}

function storedContent(messageId: string): string | null | undefined {
  return db.select({ content: schema.dmMessages.content })
    .from(schema.dmMessages)
    .where(eq(schema.dmMessages.sourceMessageId, messageId))
    .get()?.content;
}

describe('relayed system messages', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    db.insert(schema.instanceSettings).values({ id: 1, federationRelayEnabled: 1, updatedAt: Date.now() }).run();
    db.insert(schema.federationPeers).values({
      id: 'peer-home', origin: HOME_ORIGIN, hmacSecret: 'c'.repeat(64), status: 'active', createdAt: Date.now(),
    }).run();
    db.insert(schema.users).values({ id: 'bob', username: 'bob', passwordHash: 'real-hash', createdAt: 1 }).run();
    db.insert(schema.users).values({
      id: 'alice-on-orbit', username: 'alice@home.test', passwordHash: '!federation-replicated',
      homeInstance: 'home.test', homeUserId: 'alice', createdAt: 1,
    }).run();
  });

  it('stores a well-formed space invite, with only the fields the event defines', async () => {
    const result = await relay([createEvent('inv-1', JSON.stringify({ ...INVITE, extra: 'dropped' }))]);
    expect(result.rejected).toEqual([]);
    expect(JSON.parse(storedContent('inv-1') ?? 'null')).toEqual(INVITE);
  });

  it('refuses a relayed system message of any other event', async () => {
    const content = JSON.stringify({ event: 'owner_changed', newOwnerId: 'alice', newOwnerDisplayName: 'Alice' });
    const result = await relay([createEvent('own-1', content)]);
    expect(result.rejected).toEqual([{ messageId: 'own-1', reason: 'invalid_system_message' }]);
    expect(storedContent('own-1')).toBeUndefined();
    // Refused before anything is written: no copy of the conversation appears.
    expect(db.select().from(schema.dmChannels).all()).toEqual([]);
  });

  it('refuses a space invite that is missing a field', async () => {
    const partial: Partial<SpaceInviteSystemPayload> = { ...INVITE };
    delete partial.inviteCode;
    const result = await relay([createEvent('inv-2', JSON.stringify(partial))]);
    expect(result.rejected).toEqual([{ messageId: 'inv-2', reason: 'invalid_system_message' }]);
    expect(storedContent('inv-2')).toBeUndefined();
  });

  it('refuses a space invite whose origin is not an http(s) origin', async () => {
    const result = await relay([createEvent('inv-3', JSON.stringify({ ...INVITE, spaceInstanceOrigin: 'javascript:alert(1)' }))]);
    expect(result.rejected).toEqual([{ messageId: 'inv-3', reason: 'invalid_system_message' }]);
  });

  it('refuses system content that is not JSON', async () => {
    const result = await relay([createEvent('txt-1', 'plain words')]);
    expect(result.rejected).toEqual([{ messageId: 'txt-1', reason: 'invalid_system_message' }]);
  });

  it('refuses an update of a stored system message and keeps its content', async () => {
    await relay([createEvent('inv-4', JSON.stringify(INVITE))]);
    const update: FederationRelayEvent = {
      ...createEvent('inv-4', 'rewritten'),
      eventType: 'update',
    };
    const result = await relay([update]);
    expect(result.rejected).toEqual([{ messageId: 'inv-4', reason: 'system_message_immutable' }]);
    expect(JSON.parse(storedContent('inv-4') ?? 'null')).toEqual(INVITE);
  });
});
