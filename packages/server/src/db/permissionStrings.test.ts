import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString, stringToPermissions } from '@backspace/shared/src/permissions.js';
import { normalizeStoredPermissions } from './permissionStrings.js';

// Stored permission values (docs/systems/permissions.md, "Stored form"): the
// override routes used to store whatever BigInt() accepted, so an old
// database can hold "0x10", " 8", "-1" and the like. The boot pass rewrites
// each to the canonical string the routes store now, keeping what every
// permission check reads from it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let db: Database.Database;

function applyMigrations(target: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) target.exec(clean);
    }
  }
}

const now = 1_700_000_000_000;
const SEND = permissionsToString(PermissionBits.SEND_MESSAGES);

beforeEach(() => {
  db = new Database(':memory:');
  applyMigrations(db);
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES ('owner', 'owner', 'x', ?)").run(now);
  db.prepare("INSERT INTO spaces (id, name, owner_id, invite_code, visibility, created_at) VALUES ('s', 'S', 'owner', 'c', 'public', ?)").run(now);
  db.prepare("INSERT INTO channel_categories (id, space_id, name, position, created_at) VALUES ('cat', 's', 'cat', 0, ?)").run(now);
  db.prepare("INSERT INTO channels (id, space_id, name, type, position, category_id, created_at) VALUES ('ch', 's', 'general', 'text', 0, 'cat', ?)").run(now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function role(id: string, permissions: string): void {
  db.prepare('INSERT INTO roles (id, space_id, name, position, permissions, created_at) VALUES (?, ?, ?, 1, ?, ?)').run(id, 's', id, permissions, now);
}
function channelOverride(targetId: string, allow: string, deny: string): void {
  db.prepare("INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES ('ch', 'role', ?, ?, ?)").run(targetId, allow, deny);
}
function categoryOverride(targetId: string, allow: string, deny: string): void {
  db.prepare("INSERT INTO category_overrides (category_id, target_type, target_id, allow, deny) VALUES ('cat', 'role', ?, ?, ?)").run(targetId, allow, deny);
}
function roleValue(id: string): string {
  return (db.prepare('SELECT permissions FROM roles WHERE id = ?').get(id) as { permissions: string }).permissions;
}
function channelRow(targetId: string): { allow: string; deny: string } {
  return db.prepare('SELECT allow, deny FROM channel_overrides WHERE target_id = ?').get(targetId) as { allow: string; deny: string };
}
function categoryRow(targetId: string): { allow: string; deny: string } {
  return db.prepare('SELECT allow, deny FROM category_overrides WHERE target_id = ?').get(targetId) as { allow: string; deny: string };
}

describe('normalizeStoredPermissions', () => {
  it('rewrites readable non-canonical values to the decimal they already meant', () => {
    role('hex', '0x10');
    role('spaced', ' 8 ');
    role('legacy', '["VIEW_CHANNEL","SEND_MESSAGES"]');
    channelOverride('a', '0x400', ' 0');
    categoryOverride('b', '', '0010');

    const changed = normalizeStoredPermissions(db);

    expect(roleValue('hex')).toBe('16');
    expect(roleValue('spaced')).toBe('8');
    expect(roleValue('legacy')).toBe(permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES));
    expect(channelRow('a')).toEqual({ allow: '1024', deny: '0' });
    expect(categoryRow('b')).toEqual({ allow: '0', deny: '10' });
    expect(changed).toBe(7);
  });

  it('masks a negative value to the defined bits, which every check already read it as', () => {
    role('negative', '-1');
    channelOverride('neg', '-1', '0');
    categoryOverride('neg', '0', '-8');

    normalizeStoredPermissions(db);

    expect(roleValue('negative')).toBe(permissionsToString(ALL_PERMISSIONS));
    expect(channelRow('neg')).toEqual({ allow: permissionsToString(ALL_PERMISSIONS), deny: '0' });
    expect(categoryRow('neg').deny).toBe(permissionsToString(-8n & ALL_PERMISSIONS));
    // The same answer for every defined bit, before and after.
    for (const bit of Object.values(PermissionBits)) {
      expect((stringToPermissions('-8') & bit) !== 0n).toBe((stringToPermissions(categoryRow('neg').deny) & bit) !== 0n);
    }
  });

  it('writes an unreadable value as 0, which is how it was read', () => {
    role('garbage', 'not-bits');
    expect(stringToPermissions('not-bits')).toBe(0n);
    normalizeStoredPermissions(db);
    expect(roleValue('garbage')).toBe('0');
  });

  it('leaves canonical rows alone and is a no-op the second time', () => {
    role('fine', SEND);
    channelOverride('fine', '0', SEND);
    role('odd', '0x10');

    expect(normalizeStoredPermissions(db)).toBe(1);
    expect(normalizeStoredPermissions(db)).toBe(0);
    expect(roleValue('fine')).toBe(SEND);
    expect(channelRow('fine')).toEqual({ allow: '0', deny: SEND });
  });
});

describe('normalizeStoredPermissions before it changes anything', () => {
  it('calls beforeChanges once, before the first write, when a value would be rewritten', () => {
    role('hex', '0x10');
    channelOverride('a', '0x400', '0');
    const seen: string[] = [];
    const beforeChanges = vi.fn(() => {
      // The database is still as it was: this is where boot takes its snapshot.
      seen.push(roleValue('hex'), channelRow('a').allow);
    });

    normalizeStoredPermissions(db, { beforeChanges });

    expect(beforeChanges).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['0x10', '0x400']);
    expect(roleValue('hex')).toBe('16');
  });

  it('does not call beforeChanges when every value is already canonical', () => {
    role('fine', SEND);
    channelOverride('fine', '0', SEND);
    categoryOverride('fine', SEND, '0');
    const beforeChanges = vi.fn();

    expect(normalizeStoredPermissions(db, { beforeChanges })).toBe(0);
    expect(beforeChanges).not.toHaveBeenCalled();
  });

  it('does not write when beforeChanges throws (a failed snapshot aborts the pass)', () => {
    role('hex', '0x10');
    expect(() => normalizeStoredPermissions(db, {
      beforeChanges: () => { throw new Error('snapshot failed'); },
    })).toThrow('snapshot failed');
    expect(roleValue('hex')).toBe('0x10');
  });

  it('logs each unreadable value it replaces with its row and old text, and only once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    role('garbage', 'not-bits');
    channelOverride('x', '0', 'zz');
    categoryOverride('y', '["VIEW_CHANNEL","NOT_A_PERMISSION"]', '0');
    role('hex', '0x10');

    normalizeStoredPermissions(db);

    const lines = warn.mock.calls.map((c) => c.join(' '));
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.includes('roles') && l.includes('id=garbage') && l.includes('permissions') && l.includes('"not-bits"'))).toBe(true);
    expect(lines.some((l) => l.includes('channel_overrides') && l.includes('channel_id=ch') && l.includes('target_id=x') && l.includes('deny') && l.includes('"zz"'))).toBe(true);
    expect(lines.some((l) => l.includes('category_overrides') && l.includes('target_id=y') && l.includes('allow') && l.includes('NOT_A_PERMISSION'))).toBe(true);
    // A readable value keeps its meaning and is not logged.
    expect(lines.some((l) => l.includes('0x10'))).toBe(false);

    warn.mockClear();
    normalizeStoredPermissions(db);
    expect(warn).not.toHaveBeenCalled();
  });
});
