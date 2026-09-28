import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);

/**
 * A replicated row still named `<homeUserId>@<domain>` is renamed to its real
 * handle the first time identity resolution or profile hydration receives a
 * username for it. The rename happens once (the home username never changes),
 * only on a replicated row that is still attached to its home, and never onto
 * a name another row already holds. Open clients that can see the row are told.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(), sendToDmMembers: vi.fn(), sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [], getRoom: () => undefined, getUserRoom: () => undefined,
  },
}));
vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://test.example' };
});

import { connectionManager } from '../ws/handler.js';

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const KAI_ID = '1234567890123456789';

function seedRow(overrides: Partial<typeof schema.users.$inferInsert> = {}): void {
  testDb.insert(schema.users).values({
    id: 'stub-kai',
    username: `${KAI_ID}@friend.example`,
    displayName: null,
    passwordHash: '!federation-replicated',
    homeInstance: 'friend.example',
    homeUserId: KAI_ID,
    createdAt: Date.now(),
    ...overrides,
  }).run();
}

function row(id = 'stub-kai'): typeof schema.users.$inferSelect {
  return testDb.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
}

function userUpdatedRecipients(): string[] {
  return vi.mocked(connectionManager.sendToUser).mock.calls
    .filter(([, event]) => (event as { type: string }).type === 'user_updated')
    .map(([uid]) => uid);
}

describe('renaming an id-named replicated row to its real handle', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    vi.mocked(connectionManager.sendToUser).mockClear();
    testDb.insert(schema.users).values({ id: 'local-anna', username: 'anna', passwordHash: 'x', createdAt: Date.now() }).run();
  });

  it('identity resolution with a username renames the row and tells the users who can see it', async () => {
    seedRow();
    testDb.insert(schema.friends).values({ userId: 'local-anna', friendId: 'stub-kai', createdAt: Date.now() }).run();
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const resolved = resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'kai' });
    expect(resolved?.id).toBe('stub-kai');
    expect(resolved?.username).toBe('kai@friend.example');
    expect(row().username).toBe('kai@friend.example');
    expect(userUpdatedRecipients()).toContain('local-anna');
  });

  it('identity resolution leaves a row that already has its real name', async () => {
    seedRow({ username: 'kai@friend.example' });
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'someone-else' });
    expect(row().username).toBe('kai@friend.example');
    expect(userUpdatedRecipients()).toEqual([]);
  });

  it('a detached row keeps its name', async () => {
    seedRow({ federationHomeOrphaned: 1 });
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'kai' });
    expect(row().username).toBe(`${KAI_ID}@friend.example`);
  });

  it('a row with its own login credentials keeps its name', async () => {
    seedRow({ passwordHash: '$2b$10$abcdefghijklmnopqrstuv' });
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'kai' });
    expect(row().username).toBe(`${KAI_ID}@friend.example`);
  });

  it('when another row holds the name, the rename takes the first free suffix, as creation does', async () => {
    seedRow();
    testDb.insert(schema.users).values({
      id: 'other-kai', username: 'kai@friend.example', passwordHash: '!federation-replicated',
      homeInstance: 'friend.example', homeUserId: '999', createdAt: Date.now(),
    }).run();
    testDb.insert(schema.users).values({
      id: 'other-kai-1', username: 'kai_1@friend.example', passwordHash: '!federation-replicated',
      homeInstance: 'friend.example', homeUserId: '998', createdAt: Date.now(),
    }).run();
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const resolved = resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'kai' });
    expect(resolved?.id).toBe('stub-kai');
    expect(row().username).toBe('kai_2@friend.example');
    expect(row('other-kai').username).toBe('kai@friend.example');
  });

  it('after a suffixed rename, later hints neither rename nor warn again', async () => {
    seedRow();
    testDb.insert(schema.users).values({
      id: 'other-kai', username: 'kai@friend.example', passwordHash: '!federation-replicated',
      homeInstance: 'friend.example', homeUserId: '999', createdAt: Date.now(),
    }).run();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { resolveOrCreateReplicatedUser } = await import('./federation.js');
      for (let i = 0; i < 3; i++) resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'kai' });
      expect(row().username).toBe('kai_1@friend.example');
      expect(warn).not.toHaveBeenCalled();
      expect(userUpdatedRecipients()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('a row named after a display name (not a handle) is renamed to the handle', async () => {
    seedRow({ username: 'kai smith@friend.example', displayName: 'Kai Smith' });
    testDb.insert(schema.friends).values({ userId: 'local-anna', friendId: 'stub-kai', createdAt: Date.now() }).run();
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const resolved = resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'kai' });
    expect(resolved?.username).toBe('kai@friend.example');
    expect(row().username).toBe('kai@friend.example');
    expect(row().displayName).toBe('Kai Smith');
    expect(userUpdatedRecipients()).toContain('local-anna');
  });

  it.each([
    ['a display name with a dot', 'k.smith@friend.example'],
    ['a display name with a dash', 'kai-smith@friend.example'],
    ['a display name with non-ASCII letters', 'kaï@friend.example'],
    ['a relayed name that kept its own domain', 'kai@friend.example@friend.example'],
  ])('a row named after %s is renamed', async (_label, username) => {
    seedRow({ username });
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'kai' });
    expect(row().username).toBe('kai@friend.example');
  });

  it('a row named after a display name keeps it when it has its own login credentials', async () => {
    seedRow({ username: 'kai smith@friend.example', passwordHash: '$2b$10$abcdefghijklmnopqrstuv' });
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'kai' });
    expect(row().username).toBe('kai smith@friend.example');
  });

  it('a row named after a display name keeps it when it is detached', async () => {
    seedRow({ username: 'kai smith@friend.example', federationHomeOrphaned: 1 });
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'kai' });
    expect(row().username).toBe('kai smith@friend.example');
  });

  it('a hint that is not a handle never renames a row', async () => {
    seedRow();
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'Kai Smith' });
    expect(row().username).toBe(`${KAI_ID}@friend.example`);
    expect(userUpdatedRecipients()).toEqual([]);
  });

  it('a row whose name is shaped like a handle is not renamed, whatever the hint', async () => {
    seedRow({ username: 'kai_dev@friend.example' });
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'kai' });
    expect(row().username).toBe('kai_dev@friend.example');
  });

  it('profile hydration with a username renames the row', async () => {
    seedRow();
    const { hydrateReplicatedUserProfile } = await import('./federation.js');
    const hydrated = await hydrateReplicatedUserProfile(row(), { username: 'kai', displayName: 'Kai' }, testDb);
    expect(hydrated.username).toBe('kai@friend.example');
    expect(hydrated.displayName).toBe('Kai');
    expect(row().username).toBe('kai@friend.example');
    expect(row().displayName).toBe('Kai');
  });

  it('profile hydration leaves a detached row alone', async () => {
    seedRow({ federationHomeOrphaned: 1 });
    const { hydrateReplicatedUserProfile } = await import('./federation.js');
    await hydrateReplicatedUserProfile(row(), { username: 'kai', displayName: 'Kai' }, testDb);
    expect(row().username).toBe(`${KAI_ID}@friend.example`);
    expect(row().displayName).toBeNull();
  });
});
