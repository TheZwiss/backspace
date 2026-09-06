import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { touchUserActivity, parseClientKind } from './activity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
beforeEach(() => {
  sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  db = drizzle(sqlite, { schema });
  db.insert(schema.users).values({ id: 'u1', username: 'u1', passwordHash: 'x', createdAt: 1 }).run();
});

function row() {
  return db.select({ day: schema.users.lastActiveDay, client: schema.users.lastClient })
    .from(schema.users).where(eq(schema.users.id, 'u1')).get()!;
}

describe('touchUserActivity', () => {
  it('writes day and client on the first touch of a day', () => {
    expect(touchUserActivity(db, 'u1', '2026-09-06', 'desktop')).toBe(true);
    expect(row()).toEqual({ day: '2026-09-06', client: 'desktop' });
  });
  it('skips the write when the day is already recorded', () => {
    touchUserActivity(db, 'u1', '2026-09-06', 'desktop');
    expect(touchUserActivity(db, 'u1', '2026-09-06', 'mobile')).toBe(false);
    expect(row()).toEqual({ day: '2026-09-06', client: 'desktop' });
  });
  it('writes again on a new day and keeps the client when none is given', () => {
    touchUserActivity(db, 'u1', '2026-09-06', 'desktop');
    expect(touchUserActivity(db, 'u1', '2026-09-07')).toBe(true);
    expect(row()).toEqual({ day: '2026-09-07', client: 'desktop' });
  });
});

describe('parseClientKind', () => {
  it('accepts the three kinds and falls back to web', () => {
    expect(parseClientKind('desktop')).toBe('desktop');
    expect(parseClientKind('mobile')).toBe('mobile');
    expect(parseClientKind('web')).toBe('web');
    expect(parseClientKind('tv')).toBe('web');
    expect(parseClientKind(undefined)).toBe('web');
  });
});
