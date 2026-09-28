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
      id: 'other-kai-1', username: 'kai~1@friend.example', passwordHash: '!federation-replicated',
      homeInstance: 'friend.example', homeUserId: '998', createdAt: Date.now(),
    }).run();
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const resolved = resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'kai' });
    expect(resolved?.id).toBe('stub-kai');
    expect(row().username).toBe('kai~2@friend.example');
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
      expect(row().username).toBe('kai~1@friend.example');
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

  function userUpdatedTo(uid: string): Array<{ username: string; displayName: string | null }> {
    return vi.mocked(connectionManager.sendToUser).mock.calls
      .filter(([to, event]) => to === uid && (event as { type: string }).type === 'user_updated')
      .map(([, event]) => (event as { user: { username: string; displayName: string | null } }).user);
  }

  it('a rename by hydration is announced once, after the display name is filled', async () => {
    seedRow();
    testDb.insert(schema.friends).values({ userId: 'local-anna', friendId: 'stub-kai', createdAt: Date.now() }).run();
    const { hydrateReplicatedUserProfile } = await import('./federation.js');
    await hydrateReplicatedUserProfile(row(), { username: 'kai', displayName: 'Kai' }, testDb);
    expect(userUpdatedTo('local-anna')).toEqual([
      expect.objectContaining({ username: 'kai@friend.example', displayName: 'Kai' }),
    ]);
  });

  it('a rename by identity resolution followed by hydration ends with the display name announced', async () => {
    seedRow();
    testDb.insert(schema.friends).values({ userId: 'local-anna', friendId: 'stub-kai', createdAt: Date.now() }).run();
    const { resolveOrCreateReplicatedUser, hydrateReplicatedUserProfile } = await import('./federation.js');
    const resolved = resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'kai' });
    await hydrateReplicatedUserProfile(resolved!, { username: 'kai', displayName: 'Kai' }, testDb);
    const events = userUpdatedTo('local-anna');
    expect(events.at(-1)).toEqual(expect.objectContaining({ username: 'kai@friend.example', displayName: 'Kai' }));
  });

  it('hydration that changes nothing announces nothing', async () => {
    seedRow({ username: 'kai@friend.example', displayName: 'Kai', avatarColor: '#7c6cf6' });
    testDb.insert(schema.friends).values({ userId: 'local-anna', friendId: 'stub-kai', createdAt: Date.now() }).run();
    const { hydrateReplicatedUserProfile } = await import('./federation.js');
    await hydrateReplicatedUserProfile(row(), { username: 'kai', displayName: 'Kai', avatarColor: '#7c6cf6' }, testDb);
    expect(userUpdatedTo('local-anna')).toEqual([]);
  });
});

/**
 * A handle that another row already holds gets a suffix a handle cannot
 * contain (`<handle>~<n>@<domain>`), so a suffixed row never takes a name a
 * real user of that instance can have. A suffixed row is re-checked whenever
 * its home reports its handle again, and moves to an earlier free name once
 * the holder is gone. It never renames another row.
 */
describe('suffixed names of remote users', () => {
  const DOMAIN = 'friend.example';
  const X_ID = '1000000000000000001';
  const H1_ID = '1000000000000000002';
  const H2_ID = '1000000000000000003';

  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    vi.mocked(connectionManager.sendToUser).mockClear();
    testDb.insert(schema.users).values({ id: 'local-anna', username: 'anna', passwordHash: 'x', createdAt: Date.now() }).run();
  });

  function seedReplica(id: string, homeUserId: string, username: string): void {
    testDb.insert(schema.users).values({
      id, username, passwordHash: '!federation-replicated',
      homeInstance: DOMAIN, homeUserId, createdAt: Date.now(),
    }).run();
    testDb.insert(schema.friends).values({ userId: 'local-anna', friendId: id, createdAt: Date.now() }).run();
  }

  function nameOf(id: string): string {
    return testDb.select().from(schema.users).where(eq(schema.users.id, id)).get()!.username;
  }

  function tombstone(id: string): void {
    testDb.update(schema.users).set({ username: `!deleted:${id}`, isDeleted: 1 }).where(eq(schema.users.id, id)).run();
  }

  it('a suffixed name never shadows a later real user with that handle', async () => {
    // X: a stale replica of an account deleted on its home, still holding `kai`.
    seedReplica('stub-x', X_ID, `kai@${DOMAIN}`);
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const h1 = resolveOrCreateReplicatedUser(H1_ID, DOMAIN, testDb, { username: 'kai' });
    expect(h1?.username).toBe(`kai~1@${DOMAIN}`);
    const h2 = resolveOrCreateReplicatedUser(H2_ID, DOMAIN, testDb, { username: 'kai_1' });
    expect(h2?.username).toBe(`kai_1@${DOMAIN}`);
  });

  it('a placeholder renamed while its handle is held gets a name no handle can have', async () => {
    seedReplica('stub-x', X_ID, `kai@${DOMAIN}`);
    seedReplica('stub-h1', H1_ID, `${H1_ID}@${DOMAIN}`);
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    resolveOrCreateReplicatedUser(H1_ID, DOMAIN, testDb, { username: 'kai' });
    expect(nameOf('stub-h1')).toBe(`kai~1@${DOMAIN}`);
    const h2 = resolveOrCreateReplicatedUser(H2_ID, DOMAIN, testDb, { username: 'kai_1' });
    expect(h2?.username).toBe(`kai_1@${DOMAIN}`);
  });

  it('once the holder is gone, the next hint moves the suffixed row to its handle and announces it', async () => {
    seedReplica('stub-x', X_ID, `kai@${DOMAIN}`);
    seedReplica('stub-h1', H1_ID, `kai~1@${DOMAIN}`);
    tombstone('stub-x');
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const h1 = resolveOrCreateReplicatedUser(H1_ID, DOMAIN, testDb, { username: 'kai' });
    expect(h1?.username).toBe(`kai@${DOMAIN}`);
    expect(nameOf('stub-h1')).toBe(`kai@${DOMAIN}`);
    expect(userUpdatedRecipients()).toContain('local-anna');
  });

  it('hydration re-checks a suffixed row as identity resolution does', async () => {
    seedReplica('stub-x', X_ID, `kai@${DOMAIN}`);
    seedReplica('stub-h1', H1_ID, `kai~1@${DOMAIN}`);
    tombstone('stub-x');
    const { hydrateReplicatedUserProfile } = await import('./federation.js');
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'stub-h1')).get()!;
    const hydrated = await hydrateReplicatedUserProfile(row, { username: 'kai', displayName: 'Kai' }, testDb);
    expect(hydrated.username).toBe(`kai@${DOMAIN}`);
    expect(nameOf('stub-h1')).toBe(`kai@${DOMAIN}`);
  });

  it('a suffixed row takes no other handle than the one it was named after', async () => {
    seedReplica('stub-h1', H1_ID, `kai~1@${DOMAIN}`);
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    resolveOrCreateReplicatedUser(H1_ID, DOMAIN, testDb, { username: 'bob' });
    expect(nameOf('stub-h1')).toBe(`kai~1@${DOMAIN}`);
    expect(userUpdatedRecipients()).toEqual([]);
  });

  it('a suffixed row is not a placeholder', async () => {
    seedReplica('stub-h1', H1_ID, `kai~1@${DOMAIN}`);
    const { isPlaceholderNamedStub } = await import('./federation/stubName.js');
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'stub-h1')).get()!;
    expect(isPlaceholderNamedStub(row)).toBe(false);
  });

  it('two rows with the same handle never trade names, whatever order the hints come in', async () => {
    seedReplica('stub-x', X_ID, `kai@${DOMAIN}`);
    seedReplica('stub-p', H1_ID, `kai~1@${DOMAIN}`);
    seedReplica('stub-q', H2_ID, `kai~2@${DOMAIN}`);
    const renames = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { resolveOrCreateReplicatedUser } = await import('./federation.js');
      for (let i = 0; i < 4; i++) {
        resolveOrCreateReplicatedUser(H2_ID, DOMAIN, testDb, { username: 'kai' });
        resolveOrCreateReplicatedUser(H1_ID, DOMAIN, testDb, { username: 'kai' });
      }
      expect(nameOf('stub-p')).toBe(`kai~1@${DOMAIN}`);
      expect(nameOf('stub-q')).toBe(`kai~2@${DOMAIN}`);
      expect(userUpdatedRecipients()).toEqual([]);

      // The holder goes. Whichever row hears from its home first takes the
      // handle; the other keeps its place and neither moves again.
      tombstone('stub-x');
      for (let i = 0; i < 4; i++) {
        resolveOrCreateReplicatedUser(H2_ID, DOMAIN, testDb, { username: 'kai' });
        resolveOrCreateReplicatedUser(H1_ID, DOMAIN, testDb, { username: 'kai' });
      }
      expect(nameOf('stub-q')).toBe(`kai@${DOMAIN}`);
      expect(nameOf('stub-p')).toBe(`kai~1@${DOMAIN}`);
      const renameLines = renames.mock.calls.filter(([line]) => String(line).startsWith('[federation] Renamed stub'));
      expect(renameLines).toHaveLength(1);
    } finally {
      renames.mockRestore();
    }
  });

  it('a row that got a random suffix keeps it on later hints', async () => {
    seedReplica('stub-x', X_ID, `kai@${DOMAIN}`);
    for (let n = 1; n <= 10; n++) seedReplica(`stub-n${n}`, `20000000000000000${String(n).padStart(2, '0')}`, `kai~${n}@${DOMAIN}`);
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const h1 = resolveOrCreateReplicatedUser(H1_ID, DOMAIN, testDb, { username: 'kai' });
    expect(h1?.username).toMatch(new RegExp(`^kai~[0-9a-f]{8}@${DOMAIN.replace('.', '\\.')}$`));
    const first = h1!.username;
    vi.mocked(connectionManager.sendToUser).mockClear();
    for (let i = 0; i < 3; i++) resolveOrCreateReplicatedUser(H1_ID, DOMAIN, testDb, { username: 'kai' });
    expect(nameOf(h1!.id)).toBe(first);
    expect(userUpdatedRecipients()).toEqual([]);
  });
});
