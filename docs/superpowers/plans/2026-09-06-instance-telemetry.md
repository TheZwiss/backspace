# Instance Telemetry ("Say hi to Jannis") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in, anonymous daily pings from self-hosted Backspace servers to a receiver at `hello.backspacechat.com`, aggregated by the existing metrics pipeline and published as open data, asked for once through an illustrated admin-panel modal.

**Architecture:** Four independent tracks. A: the server records day-coarse activity, builds a rounded payload and posts it once a day when the admin opted in. B: a Cloudflare Worker with D1 stores one raw row per instance per day for 90 days and exports ranges to the collector. C: the metrics collector aggregates a 7-day snapshot into date-keyed and dimensional series on `metrics-data`, and the bundler carries them to the dashboard. D: the web app sends its client kind, asks admins once with a spaceship-in-the-void scene, and hosts the toggle and live preview under Instance settings. Tracks A, B, C, D run in parallel; the dashboard charts (track F) wait for the insights facelift (track E, separate spec).

**Tech Stack:** Fastify 4, Drizzle + better-sqlite3, Vitest 4; Cloudflare Workers + D1 + wrangler + `@cloudflare/vitest-pool-workers` ≥ 0.13; the zero-dependency `@backspace/metrics` package; React 18, Zustand 5, i18next, inline SVG + Web Animations API; the Electron-based render harness at `packages/web/scripts/render-frames.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-06-instance-telemetry-design.md`

## Global Constraints

- No new runtime dependencies anywhere. The receiver package gets dev dependencies only: `wrangler`, `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers` (0.13 or later, the first line supporting Vitest 4).
- TypeScript strict, no `any`. Every function fully implemented, no placeholders.
- Payload schema is `1`. Adding a field never bumps it; changing a meaning does. Every count is rounded to two significant digits before it leaves the instance and again on arrival.
- Never included in a ping: domain, instance name, user names, e-mail addresses, message content, file names, IP addresses, the federation `instance_id`, timestamps finer than a day.
- The telemetry id is `crypto.randomUUID()`, minted on every off-to-on transition, cleared on every transition to off. `telemetry_last_day` is set to today on every off-to-on transition so the first ping goes out the next day.
- Day means UTC calendar day `YYYY-MM-DD`.
- Endpoint default `https://hello.backspacechat.com`, overridable with `TELEMETRY_ENDPOINT`. Instances treat 2xx as success, 410 as "retired, turn off", anything else as "try again tomorrow".
- Receiver keeps rows 90 days. Dimension values held by fewer than 3 instances fold into `other` before anything is written to the public archive. An instance counts only after reporting on 2 distinct days in the trailing 30.
- Copy is in Jannis's first person, English source, German and Russian catalogs, keys under the `telemetry` namespace. No em dashes anywhere in code comments, copy, docs or commit messages.
- Commit messages: conventional prefix, no attribution trailers of any kind, no session links.
- Both modal buttons identical in size and weight. "No" saves first and animates nothing sad. Any dismissal without an answer snoozes 7 days in that browser and stops for good after the second one.
- GitHub Actions: every action SHA-pinned, fork-guarded, `harden-runner` first step, per `docs/systems/security-scanning.md`.
- Docs listed in spec §13 are updated inside the task that changes the behaviour, not in a separate pass.

---

## File Structure

**Track A, server (`packages/server`)**
- `src/db/schema.ts` (modify): four columns on `instanceSettings`, two on `users`.
- `drizzle/0013_*.sql` (generated): the migration.
- `src/db/migrate.ts` (modify): `installed_at` backfill in `ensureDefaults`.
- `src/telemetry/day.ts` (create): UTC day helpers.
- `src/telemetry/rounding.ts` (create): two-significant-digit rounding.
- `src/telemetry/activity.ts` (create): `touchUserActivity`, `parseClientKind`.
- `src/telemetry/state.ts` (create): read and transition the opt-in state.
- `src/telemetry/payload.ts` (create): `buildTelemetryPayload`.
- `src/telemetry/reporter.ts` (create): the daily job.
- `src/routes/adminTelemetry.ts` (create): the three admin routes.
- `src/ws/handler.ts` (modify): `client` on auth, activity touch on auth and pong.
- `src/config.ts` (modify): `telemetry.endpoint`.
- `src/index.ts` (modify): register the route, start and stop the reporter.
- `packages/shared/src/types.ts` (modify): `ClientKind`, `TelemetryPayload`, `TelemetryStatus`.
- `install.sh` (modify): `TELEMETRY=on|off`, the teaser lines.
- Docs: `docs/systems/database.md`, `api.md`, `websocket.md`, `admin.md`, new `docs/systems/telemetry.md`.

**Track B, receiver (`scripts/telemetry-receiver`)**
- `package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `migrations/0001_pings.sql`
- `src/validate.ts`: body parsing, validation, rounding on arrival.
- `src/page.ts`: the root HTML page.
- `src/index.ts`: fetch and scheduled handlers.
- `src/*.test.ts`, `test/setup.ts`
- `.github/workflows/telemetry-receiver.yml`
- `pnpm-workspace.yaml` (modify), `docs/systems/security-scanning.md` (modify)

**Track C, collector (`scripts/metrics`)**
- `src/telemetry.ts` (create): row type, NDJSON parsing, snapshot aggregation, folding.
- `src/collect.ts` (modify): the telemetry step.
- `src/cli-collect.ts` (modify): the two env variables.
- `src/backfill.ts` (modify): telemetry days write-if-absent.
- `src/bundle.ts`, `src/datapage.ts` (modify): the `telemetry` block and tables.
- `.github/workflows/metrics.yml` (modify): env for the step.
- `docs/systems/metrics.md` (modify).

**Track D, web (`packages/web`)**
- `src/platform/clientKind.ts` (create): `detectClientKind`.
- `src/hooks/useWebSocket.ts` (modify): `client` in the auth message.
- `src/api/client.ts` (modify): `api.admin.telemetry.*`.
- `src/stores/settingsStore.ts` (modify): telemetry slice.
- `src/lib/telemetryAsk.ts` (create): snooze and dismissal logic.
- `src/components/telemetry/scene/{Void,Ship,Pilot,Beam,HelloScene}.tsx` (create, design brief).
- `src/components/telemetry/HelloModal.tsx`, `TelemetryAsk.tsx` (create).
- `src/components/modals/instanceSettingsPanels/TelemetryPanel.tsx` (create), `settingsPanels/InstancePanel.tsx` (modify).
- `src/locales/{en,de,ru}/telemetry.json` (create), `src/locales/*/settings.json` (modify), `src/i18n/resources.ts` (modify).
- `src/App.tsx` (modify).
- `scripts/render-frames.mjs` (already present, untracked): the render harness.
- Docs: `docs/systems/localization.md`, `docs/systems/admin.md`.

---

## Track A: server

### Task A1: Schema columns, migration, `installed_at` backfill

**Files:**
- Modify: `packages/server/src/db/schema.ts:4-29` (users) and `:309-331` (instanceSettings)
- Create: `packages/server/drizzle/0013_<generated>.sql` via `pnpm --filter @backspace/server db:generate`
- Modify: `packages/server/src/db/migrate.ts:8-53` (`ensureDefaults`)
- Test: `packages/server/src/db/migrate.installedAt.test.ts`

**Interfaces:**
- Produces: columns `users.last_active_day TEXT`, `users.last_client TEXT`, `instance_settings.telemetry_enabled INTEGER`, `telemetry_id TEXT`, `telemetry_last_day TEXT`, `telemetry_last_error TEXT`, `installed_at INTEGER`. Drizzle names: `lastActiveDay`, `lastClient`, `telemetryEnabled`, `telemetryId`, `telemetryLastDay`, `telemetryLastError`, `installedAt`.

- [ ] **Step 1: Write the failing test for the backfill**

```ts
// packages/server/src/db/migrate.installedAt.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaults } from './migrate.js';

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

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  applyMigrations(db);
});

describe('ensureDefaults installed_at', () => {
  it('backfills installed_at from the oldest local non-deleted user', () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, home_instance, is_deleted, created_at)
      VALUES ('a', 'a', 'x', NULL, 0, 1000), ('b', 'b', 'x', NULL, 1, 500), ('c', 'c', 'x', 'remote.example', 0, 100)`).run();
    ensureDefaults(db);
    const row = db.prepare('SELECT installed_at FROM instance_settings WHERE id = 1').get() as { installed_at: number };
    expect(row.installed_at).toBe(1000);
  });

  it('uses now when there is no local user, and never overwrites an existing value', () => {
    const before = Date.now();
    ensureDefaults(db);
    const first = (db.prepare('SELECT installed_at FROM instance_settings WHERE id = 1').get() as { installed_at: number }).installed_at;
    expect(first).toBeGreaterThanOrEqual(before);
    db.prepare(`INSERT INTO users (id, username, password_hash, home_instance, is_deleted, created_at) VALUES ('a', 'a', 'x', NULL, 0, 1)`).run();
    ensureDefaults(db);
    const second = (db.prepare('SELECT installed_at FROM instance_settings WHERE id = 1').get() as { installed_at: number }).installed_at;
    expect(second).toBe(first);
  });
});
```

- [ ] **Step 2: Run it, expect failure on the missing column**

Run: `cd packages/server && npx vitest run src/db/migrate.installedAt.test.ts`
Expected: FAIL, `no such column: installed_at`.

- [ ] **Step 3: Add the columns to the schema**

In `users` (after `federationHomeOrphaned`):

```ts
  /** UTC day (YYYY-MM-DD) of the last authenticated WebSocket activity; written at most once per day. */
  lastActiveDay: text('last_active_day'),
  /** 'web' | 'desktop' | 'mobile', from the client's auth message. */
  lastClient: text('last_client'),
```

In `instanceSettings` (before `updatedAt`):

```ts
  /** null = never asked, 0 = off, 1 = on. */
  telemetryEnabled: integer('telemetry_enabled'),
  /** Random UUID, minted on every off-to-on transition, cleared on off. Never the federation instance_id. */
  telemetryId: text('telemetry_id'),
  /** Last UTC day successfully reported. */
  telemetryLastDay: text('telemetry_last_day'),
  /** JSON { day, status } of the last failed attempt, null after a success. */
  telemetryLastError: text('telemetry_last_error'),
  /** First-boot timestamp (ms); backfilled by ensureDefaults, so non-null after boot. */
  installedAt: integer('installed_at'),
```

- [ ] **Step 4: Generate the migration**

Run: `cd packages/server && pnpm db:generate`
Expected: a new `drizzle/0013_*.sql` containing seven `ALTER TABLE ... ADD ...` statements and a new entry in `drizzle/meta/_journal.json`. Open the file and confirm no `NOT NULL` appears.

- [ ] **Step 5: Add the backfill to `ensureDefaults`** (after step 2b, before step 3)

```ts
  // 2c. Ensure installed_at is set. Existing databases get the oldest local
  // account's creation time, a fresh one gets now. Never overwritten.
  const installedRow = db.prepare('SELECT installed_at FROM instance_settings WHERE id = 1').get() as
    { installed_at: number | null } | undefined;
  if (!installedRow || installedRow.installed_at === null) {
    const oldest = db.prepare(
      'SELECT created_at FROM users WHERE home_instance IS NULL AND (is_deleted IS NULL OR is_deleted = 0) ORDER BY created_at ASC LIMIT 1',
    ).get() as { created_at: number } | undefined;
    const installedAt = oldest?.created_at ?? Date.now();
    db.prepare('UPDATE instance_settings SET installed_at = ? WHERE id = 1').run(installedAt);
    console.log('[defaults] Recorded installed_at');
  }
```

- [ ] **Step 6: Run the test and the whole server suite**

Run: `cd packages/server && npx vitest run src/db/migrate.installedAt.test.ts && npx vitest run`
Expected: PASS, and the existing suite still green (it applies every migration file).

- [ ] **Step 7: Document and commit**

Add the seven columns to `docs/systems/database.md` under "Instance Settings (singleton, id=1)" (line 364) and the users table section, one line each with the semantics above.

```bash
git add packages/server/src/db/schema.ts packages/server/drizzle packages/server/src/db/migrate.ts packages/server/src/db/migrate.installedAt.test.ts docs/systems/database.md
git commit -m "feat(server): telemetry and activity columns with installed_at backfill"
```

### Task A2: Day helpers, rounding, activity touch, client kind

**Files:**
- Create: `packages/server/src/telemetry/day.ts`, `rounding.ts`, `activity.ts`
- Create: `packages/shared/src/types.ts` additions
- Test: `packages/server/src/telemetry/day.test.ts`, `rounding.test.ts`, `activity.test.ts`

**Interfaces:**
- Produces:
  - `utcDay(now: Date): string`, `addDays(day: string, delta: number): string`, `isIsoDay(value: unknown): value is string`
  - `roundTwoSignificant(n: number): number`
  - `type ClientKind = 'web' | 'desktop' | 'mobile'` (shared), `parseClientKind(value: unknown): ClientKind`
  - `touchUserActivity(db: DrizzleDb, userId: string, today: string, client?: ClientKind): boolean` (true when a row was written)

- [ ] **Step 1: Shared types**

Append to `packages/shared/src/types.ts` (after `InstanceUpdateStatus`):

```ts
export type ClientKind = 'web' | 'desktop' | 'mobile';

/** Schema 1 of the opt-in daily instance report. See docs/systems/telemetry.md. */
export interface TelemetryPayload {
  schema: 1;
  instance: string;
  day: string;
  build: { version: string; commit: string | null; modified: boolean };
  users: { registered: number; active1d: number; active7d: number; active30d: number };
  clients: { web: number; desktop: number; mobile: number };
  content: { spaces: number; channels: number; messages: number; messages7d: number; storageMiB: number };
  features: { voice: boolean; federation: boolean; peers: number; registrationOpen: boolean };
  runtime: { install: 'prebuilt' | 'source' | null; os: string; arch: string; node: number };
  installedAt: string;
}

export interface TelemetryStatus {
  /** null = never asked. */
  enabled: boolean | null;
  lastDay: string | null;
  lastError: { day: string; status: number } | null;
  /** The random telemetry id, or null while off. */
  id: string | null;
}
```

Run `pnpm --filter @backspace/shared build`.

- [ ] **Step 2: Failing tests**

```ts
// packages/server/src/telemetry/day.test.ts
import { describe, it, expect } from 'vitest';
import { utcDay, addDays, isIsoDay } from './day.js';

describe('day helpers', () => {
  it('formats a UTC calendar day', () => {
    expect(utcDay(new Date('2026-09-06T23:59:59Z'))).toBe('2026-09-06');
    expect(utcDay(new Date('2026-09-06T00:00:00Z'))).toBe('2026-09-06');
  });
  it('adds and subtracts days across month ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('recognises only YYYY-MM-DD', () => {
    expect(isIsoDay('2026-09-06')).toBe(true);
    expect(isIsoDay('2026-9-6')).toBe(false);
    expect(isIsoDay(20260906)).toBe(false);
  });
});
```

```ts
// packages/server/src/telemetry/rounding.test.ts
import { describe, it, expect } from 'vitest';
import { roundTwoSignificant } from './rounding.js';

describe('roundTwoSignificant', () => {
  it('keeps values under 100 exact', () => {
    expect(roundTwoSignificant(0)).toBe(0);
    expect(roundTwoSignificant(7)).toBe(7);
    expect(roundTwoSignificant(99)).toBe(99);
  });
  it('rounds larger values to two significant digits', () => {
    expect(roundTwoSignificant(101)).toBe(100);
    expect(roundTwoSignificant(12345)).toBe(12000);
    expect(roundTwoSignificant(12500)).toBe(13000);
    expect(roundTwoSignificant(999)).toBe(1000);
  });
  it('never returns negatives or fractions', () => {
    expect(roundTwoSignificant(-5)).toBe(0);
    expect(roundTwoSignificant(3.7)).toBe(3);
  });
});
```

```ts
// packages/server/src/telemetry/activity.test.ts
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
```

Run: `cd packages/server && npx vitest run src/telemetry`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

```ts
// packages/server/src/telemetry/day.ts
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function isIsoDay(value: unknown): value is string {
  return typeof value === 'string' && ISO_DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}
```

```ts
// packages/server/src/telemetry/rounding.ts
/**
 * Two significant digits, floored at zero, integers only. Values below 100
 * are already two digits and stay exact; 12345 becomes 12000. The receiver
 * applies the same rule on arrival (scripts/telemetry-receiver/src/validate.ts).
 */
export function roundTwoSignificant(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const whole = Math.floor(n);
  if (whole < 100) return whole;
  const magnitude = 10 ** (Math.floor(Math.log10(whole)) - 1);
  return Math.round(whole / magnitude) * magnitude;
}
```

```ts
// packages/server/src/telemetry/activity.ts
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import type { ClientKind } from '@backspace/shared';

type Db = ReturnType<typeof drizzle<typeof schema>>;

const KINDS: ReadonlySet<string> = new Set(['web', 'desktop', 'mobile']);

export function parseClientKind(value: unknown): ClientKind {
  return typeof value === 'string' && KINDS.has(value) ? (value as ClientKind) : 'web';
}

/**
 * Records that a user was active today. Day precision only: the row is
 * touched once per UTC day and the write is skipped after that, so the
 * server never learns at what time anyone was online. Returns true when a
 * row was written.
 */
export function touchUserActivity(db: Db, userId: string, today: string, client?: ClientKind): boolean {
  const values: { lastActiveDay: string; lastClient?: ClientKind } = { lastActiveDay: today };
  if (client !== undefined) values.lastClient = client;
  const result = db.update(schema.users).set(values).where(and(
    eq(schema.users.id, userId),
    or(isNull(schema.users.lastActiveDay), ne(schema.users.lastActiveDay, today)),
  )).run();
  return result.changes === 1;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd packages/server && npx vitest run src/telemetry && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/server/src/telemetry
git commit -m "feat(server): day-coarse user activity tracking and telemetry helpers"
```

### Task A3: WebSocket wiring for `client` and activity

**Files:**
- Modify: `packages/server/src/ws/handler.ts:1704-1745` (auth branch) and the `ws.on('pong', ...)` line
- Modify: `docs/systems/websocket.md` "Auth Flow" (line 9)
- Test: `packages/server/src/ws/activityTouch.test.ts`

**Interfaces:**
- Consumes: `touchUserActivity`, `parseClientKind`, `utcDay` from A2.
- Produces: the C→S auth message accepts `client?: 'web' | 'desktop' | 'mobile'`.

- [ ] **Step 1: Failing test**

The handler is large and socket-driven; test the seam the way `spaceVoiceState.test.ts` does, by exporting a small pure function from the handler and calling it. Add this test:

```ts
// packages/server/src/ws/activityTouch.test.ts
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
const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;
vi.mock('../db/index.js', () => ({ getDb: () => testDb, schema }));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

beforeEach(() => {
  const sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  testDb.insert(schema.users).values({ id: 'u1', username: 'u1', passwordHash: 'x', createdAt: 1 }).run();
});

describe('recordConnectionActivity', () => {
  it('stores today and the parsed client kind on auth', async () => {
    const { recordConnectionActivity } = await import('./handler.js');
    recordConnectionActivity('u1', { type: 'auth', token: 't', client: 'desktop' }, new Date('2026-09-06T10:00:00Z'));
    const row = testDb.select({ d: schema.users.lastActiveDay, c: schema.users.lastClient }).from(schema.users).where(eq(schema.users.id, 'u1')).get();
    expect(row).toEqual({ d: '2026-09-06', c: 'desktop' });
  });
  it('stores today without touching the client on a pong', async () => {
    const { recordConnectionActivity } = await import('./handler.js');
    recordConnectionActivity('u1', { type: 'auth', token: 't', client: 'mobile' }, new Date('2026-09-06T10:00:00Z'));
    recordConnectionActivity('u1', null, new Date('2026-09-07T10:00:00Z'));
    const row = testDb.select({ d: schema.users.lastActiveDay, c: schema.users.lastClient }).from(schema.users).where(eq(schema.users.id, 'u1')).get();
    expect(row).toEqual({ d: '2026-09-07', c: 'mobile' });
  });
});
```

Run: `cd packages/server && npx vitest run src/ws/activityTouch.test.ts`
Expected: FAIL, `recordConnectionActivity` is not exported.

- [ ] **Step 2: Implement in `handler.ts`**

Add imports near the top:

```ts
import { touchUserActivity, parseClientKind } from '../telemetry/activity.js';
import { utcDay } from '../telemetry/day.js';
```

Add the exported seam (module level, near `connectionManager`):

```ts
/**
 * Day-coarse activity for the opt-in telemetry counts. `authMessage` is the
 * parsed auth message on the auth path (its optional `client` field names the
 * client kind) and null on a heartbeat pong, which touches the day only.
 */
export function recordConnectionActivity(
  userId: string,
  authMessage: { client?: unknown } | null,
  now: Date,
): void {
  const db = getDb();
  if (authMessage) {
    touchUserActivity(db, userId, utcDay(now), parseClientKind(authMessage.client));
  } else {
    touchUserActivity(db, userId, utcDay(now));
  }
}
```

In the auth branch, right after `connectionManager.addConnection(userId, ws);`:

```ts
          recordConnectionActivity(userId, parsed as { client?: unknown }, new Date());
```

Replace the pong line:

```ts
          ws.on('pong', () => {
            wsIsAlive.set(ws, true);
            recordConnectionActivity(userId, null, new Date());
          });
```

- [ ] **Step 3: Run tests**

Run: `cd packages/server && npx vitest run src/ws && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Docs and commit**

In `docs/systems/websocket.md` Auth Flow, document the optional `client` field: `{ type: 'auth', token, client?: 'web' | 'desktop' | 'mobile' }`, that unknown values read as `web`, and that it feeds `users.last_client` and `users.last_active_day` (day precision, written on auth and pong at most once per day).

```bash
git add packages/server/src/ws/handler.ts packages/server/src/ws/activityTouch.test.ts docs/systems/websocket.md
git commit -m "feat(ws): accept the client kind on auth and record day-coarse activity"
```

### Task A4: Opt-in state transitions

**Files:**
- Create: `packages/server/src/telemetry/state.ts`
- Test: `packages/server/src/telemetry/state.test.ts`

**Interfaces:**
- Produces:
  - `readTelemetryState(sqlite: Database.Database): TelemetryStatus`
  - `setTelemetryEnabled(sqlite, enabled: boolean, today: string): TelemetryStatus` (the only place the id is minted or cleared)
  - `recordTelemetrySuccess(sqlite, day: string): void`, `recordTelemetryFailure(sqlite, day: string, status: number): void`

- [ ] **Step 1: Failing test**

```ts
// packages/server/src/telemetry/state.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaults } from '../db/migrate.js';
import { readTelemetryState, setTelemetryEnabled, recordTelemetrySuccess, recordTelemetryFailure } from './state.js';

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
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); applyMigrations(db); ensureDefaults(db); });

describe('telemetry state', () => {
  it('starts as never asked', () => {
    expect(readTelemetryState(db)).toEqual({ enabled: null, id: null, lastDay: null, lastError: null });
  });
  it('mints an id and sets lastDay to today on enable', () => {
    const s = setTelemetryEnabled(db, true, '2026-09-06');
    expect(s.enabled).toBe(true);
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.lastDay).toBe('2026-09-06');
  });
  it('clears the id on disable and mints a new one on re-enable', () => {
    const first = setTelemetryEnabled(db, true, '2026-09-06').id;
    expect(setTelemetryEnabled(db, false, '2026-09-06')).toMatchObject({ enabled: false, id: null });
    const second = setTelemetryEnabled(db, true, '2026-09-07').id;
    expect(second).not.toBe(first);
  });
  it('records success and failure', () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    recordTelemetryFailure(db, '2026-09-07', 503);
    expect(readTelemetryState(db).lastError).toEqual({ day: '2026-09-07', status: 503 });
    recordTelemetrySuccess(db, '2026-09-07');
    expect(readTelemetryState(db)).toMatchObject({ lastDay: '2026-09-07', lastError: null });
  });
});
```

Run: `cd packages/server && npx vitest run src/telemetry/state.test.ts` → FAIL, module not found.

- [ ] **Step 2: Implement**

```ts
// packages/server/src/telemetry/state.ts
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TelemetryStatus } from '@backspace/shared';

interface Row {
  telemetry_enabled: number | null;
  telemetry_id: string | null;
  telemetry_last_day: string | null;
  telemetry_last_error: string | null;
}

function parseError(raw: string | null): TelemetryStatus['lastError'] {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null
      && typeof (parsed as { day?: unknown }).day === 'string'
      && typeof (parsed as { status?: unknown }).status === 'number') {
      return { day: (parsed as { day: string }).day, status: (parsed as { status: number }).status };
    }
  } catch { /* fall through: a corrupt value reads as no error */ }
  return null;
}

export function readTelemetryState(sqlite: Database.Database): TelemetryStatus {
  const row = sqlite.prepare(
    'SELECT telemetry_enabled, telemetry_id, telemetry_last_day, telemetry_last_error FROM instance_settings WHERE id = 1',
  ).get() as Row | undefined;
  if (!row) return { enabled: null, id: null, lastDay: null, lastError: null };
  return {
    enabled: row.telemetry_enabled === null ? null : row.telemetry_enabled === 1,
    id: row.telemetry_id,
    lastDay: row.telemetry_last_day,
    lastError: parseError(row.telemetry_last_error),
  };
}

/**
 * The single on/off transition. Enabling mints a fresh id and stamps today as
 * the last reported day so the first ping goes out tomorrow at the slot, never
 * within the minute. Disabling clears the id: a later re-enable is a new
 * anonymous instance as far as the receiver can tell.
 */
export function setTelemetryEnabled(sqlite: Database.Database, enabled: boolean, today: string): TelemetryStatus {
  if (enabled) {
    sqlite.prepare(
      'UPDATE instance_settings SET telemetry_enabled = 1, telemetry_id = ?, telemetry_last_day = ?, telemetry_last_error = NULL, updated_at = ? WHERE id = 1',
    ).run(crypto.randomUUID(), today, Date.now());
  } else {
    sqlite.prepare(
      'UPDATE instance_settings SET telemetry_enabled = 0, telemetry_id = NULL, telemetry_last_day = NULL, telemetry_last_error = NULL, updated_at = ? WHERE id = 1',
    ).run(Date.now());
  }
  return readTelemetryState(sqlite);
}

export function recordTelemetrySuccess(sqlite: Database.Database, day: string): void {
  sqlite.prepare('UPDATE instance_settings SET telemetry_last_day = ?, telemetry_last_error = NULL WHERE id = 1').run(day);
}

export function recordTelemetryFailure(sqlite: Database.Database, day: string, status: number): void {
  sqlite.prepare('UPDATE instance_settings SET telemetry_last_error = ? WHERE id = 1').run(JSON.stringify({ day, status }));
}
```

- [ ] **Step 3: Run, expect pass; commit**

```bash
cd packages/server && npx vitest run src/telemetry/state.test.ts
git add packages/server/src/telemetry/state.ts packages/server/src/telemetry/state.test.ts
git commit -m "feat(server): telemetry opt-in state transitions"
```

### Task A5: Payload builder

**Files:**
- Create: `packages/server/src/telemetry/payload.ts`
- Test: `packages/server/src/telemetry/payload.test.ts`

**Interfaces:**
- Consumes: `roundTwoSignificant`, `addDays` (A2).
- Produces:
```ts
export interface PayloadContext {
  today: string;
  telemetryId: string;
  version: string;
  commit: string | null;
  modified: boolean;
  voice: boolean;
  domainSet: boolean;
  registrationOpenDefault: boolean;
  installChannel: string | undefined;
  os: string;
  arch: string;
  nodeMajor: number;
}
export function buildTelemetryPayload(sqlite: Database.Database, ctx: PayloadContext): TelemetryPayload
export function payloadContextFromConfig(cfg: typeof config, today: string, telemetryId: string): PayloadContext
```

- [ ] **Step 1: Failing test**

```ts
// packages/server/src/telemetry/payload.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaults } from '../db/migrate.js';
import { buildTelemetryPayload, type PayloadContext } from './payload.js';

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

const ctx: PayloadContext = {
  today: '2026-09-06', telemetryId: 'id-1', version: '1.1.2', commit: 'abc1234', modified: false,
  voice: true, domainSet: true, registrationOpenDefault: true, installChannel: 'prebuilt',
  os: 'linux', arch: 'arm64', nodeMajor: 20,
};

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  applyMigrations(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, home_instance, is_deleted, last_active_day, last_client, created_at) VALUES
    ('a', 'a', 'x', NULL, 0, '2026-09-06', 'desktop', 1000),
    ('b', 'b', 'x', NULL, 0, '2026-09-01', NULL, 1000),
    ('c', 'c', 'x', NULL, 0, '2026-08-10', 'mobile', 1000),
    ('d', 'd', 'x', NULL, 1, '2026-09-06', 'web', 1000),
    ('r', 'r', 'x', 'remote.example', 0, '2026-09-06', 'web', 1000)`).run();
  ensureDefaults(db);
  db.prepare('UPDATE instance_settings SET installed_at = ?, registration_open = 0, federation_relay_enabled = 1 WHERE id = 1')
    .run(Date.parse('2026-07-03T12:00:00Z'));
  db.prepare(`INSERT INTO spaces (id, name, owner_id, created_at) VALUES ('s1', 'S', 'a', 1)`).run();
  db.prepare(`INSERT INTO channels (id, space_id, name, type, created_at) VALUES ('c1', 's1', 'general', 'text', 1), ('c2', 's1', 'voice', 'voice', 1)`).run();
  const insertMsg = db.prepare(`INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, 'c1', 'a', 'hi', ?)`);
  for (let i = 0; i < 150; i++) insertMsg.run(`m${i}`, Date.parse('2026-09-05T00:00:00Z'));
  insertMsg.run('old', Date.parse('2026-08-01T00:00:00Z'));
  db.prepare(`INSERT INTO attachments (id, message_id, filename, original_name, mimetype, size, source_url, created_at) VALUES
    ('f1', 'm1', 'f1', 'f1', 'image/png', ${3 * 1024 * 1024}, NULL, 1),
    ('f2', 'm1', 'f2', 'f2', 'image/png', ${9 * 1024 * 1024}, 'https://remote.example/x', 1)`).run();
  db.prepare(`INSERT INTO federation_peers (domain, status, created_at) VALUES ('p1', 'active', 1), ('p2', 'unreachable', 1)`).run();
});

describe('buildTelemetryPayload', () => {
  it('counts local, non-deleted users and windows by last_active_day', () => {
    const p = buildTelemetryPayload(db, ctx);
    expect(p.users).toEqual({ registered: 3, active1d: 1, active7d: 2, active30d: 3 });
  });
  it('groups active7d users by client with null as web', () => {
    expect(buildTelemetryPayload(db, ctx).clients).toEqual({ web: 1, desktop: 1, mobile: 0 });
  });
  it('counts content with rounding, local attachments only, in MiB', () => {
    const p = buildTelemetryPayload(db, ctx);
    expect(p.content).toEqual({ spaces: 1, channels: 2, messages: 150, messages7d: 150, storageMiB: 3 });
  });
  it('reports features and runtime from the context and the settings row', () => {
    const p = buildTelemetryPayload(db, ctx);
    expect(p.features).toEqual({ voice: true, federation: true, peers: 1, registrationOpen: false });
    expect(p.runtime).toEqual({ install: 'prebuilt', os: 'linux', arch: 'arm64', node: 20 });
    expect(p.build).toEqual({ version: '1.1.2', commit: 'abc1234', modified: false });
    expect(p.installedAt).toBe('2026-07');
    expect(p.schema).toBe(1);
    expect(p.instance).toBe('id-1');
    expect(p.day).toBe('2026-09-06');
  });
  it('rounds large counts to two significant digits', () => {
    const insert = db.prepare(`INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, 'c1', 'a', 'x', 1)`);
    for (let i = 0; i < 12200; i++) insert.run(`big${i}`);
    expect(buildTelemetryPayload(db, ctx).content.messages).toBe(12000);
  });
  it('maps an unknown install channel to null and never counts DM messages', () => {
    expect(buildTelemetryPayload(db, { ...ctx, installChannel: undefined }).runtime.install).toBeNull();
  });
});
```

Adjust the seed INSERT column lists to the real NOT NULL columns of `messages`, `attachments`, `spaces` and `federation_peers` in `schema.ts` if the ones above miss any (read the table definitions; add the required columns with placeholder values). The assertions stay.

Run: `cd packages/server && npx vitest run src/telemetry/payload.test.ts` → FAIL, module not found.

- [ ] **Step 2: Implement**

```ts
// packages/server/src/telemetry/payload.ts
import type Database from 'better-sqlite3';
import type { TelemetryPayload } from '@backspace/shared';
import { addDays } from './day.js';
import { roundTwoSignificant } from './rounding.js';
import type { config as serverConfig } from '../config.js';

export interface PayloadContext {
  today: string;
  telemetryId: string;
  version: string;
  commit: string | null;
  modified: boolean;
  voice: boolean;
  domainSet: boolean;
  registrationOpenDefault: boolean;
  installChannel: string | undefined;
  os: string;
  arch: string;
  nodeMajor: number;
}

const UPSTREAM_SOURCE_URL = 'https://github.com/TheZwiss/backspace';

export function payloadContextFromConfig(cfg: typeof serverConfig, today: string, telemetryId: string): PayloadContext {
  return {
    today,
    telemetryId,
    version: cfg.version,
    commit: cfg.commit,
    modified: cfg.sourceCodeUrl !== UPSTREAM_SOURCE_URL,
    voice: Boolean(cfg.livekit.url && cfg.livekit.apiKey && cfg.livekit.apiSecret),
    domainSet: Boolean(cfg.domain),
    registrationOpenDefault: cfg.registrationOpen,
    installChannel: cfg.updates.installChannel,
    os: process.platform,
    arch: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0]),
  };
}

const LOCAL_USER = "home_instance IS NULL AND (is_deleted IS NULL OR is_deleted = 0)";

function count(sqlite: Database.Database, sql: string, ...params: unknown[]): number {
  const row = sqlite.prepare(sql).get(...params) as { n: number | null } | undefined;
  return row?.n ?? 0;
}

function install(channel: string | undefined): 'prebuilt' | 'source' | null {
  return channel === 'prebuilt' || channel === 'source' ? channel : null;
}

export function buildTelemetryPayload(sqlite: Database.Database, ctx: PayloadContext): TelemetryPayload {
  const { today } = ctx;
  const d7 = addDays(today, -6);
  const d30 = addDays(today, -29);
  const todayStart = Date.parse(`${today}T00:00:00Z`);
  const sevenDaysMs = todayStart - 6 * 86_400_000;

  const settings = sqlite.prepare(
    'SELECT registration_open, federation_relay_enabled, installed_at FROM instance_settings WHERE id = 1',
  ).get() as { registration_open: number | null; federation_relay_enabled: number; installed_at: number | null } | undefined;

  const registered = count(sqlite, `SELECT COUNT(*) AS n FROM users WHERE ${LOCAL_USER}`);
  const active1d = count(sqlite, `SELECT COUNT(*) AS n FROM users WHERE ${LOCAL_USER} AND last_active_day = ?`, today);
  const active7d = count(sqlite, `SELECT COUNT(*) AS n FROM users WHERE ${LOCAL_USER} AND last_active_day >= ?`, d7);
  const active30d = count(sqlite, `SELECT COUNT(*) AS n FROM users WHERE ${LOCAL_USER} AND last_active_day >= ?`, d30);

  const clientRows = sqlite.prepare(
    `SELECT COALESCE(last_client, 'web') AS client, COUNT(*) AS n FROM users WHERE ${LOCAL_USER} AND last_active_day >= ? GROUP BY client`,
  ).all(d7) as Array<{ client: string; n: number }>;
  const clients = { web: 0, desktop: 0, mobile: 0 };
  for (const row of clientRows) {
    if (row.client === 'desktop') clients.desktop += row.n;
    else if (row.client === 'mobile') clients.mobile += row.n;
    else clients.web += row.n;
  }

  const spaces = count(sqlite, 'SELECT COUNT(*) AS n FROM spaces');
  const channels = count(sqlite, 'SELECT COUNT(*) AS n FROM channels');
  const messages = count(sqlite, 'SELECT COUNT(*) AS n FROM messages');
  const messages7d = count(sqlite, 'SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?', sevenDaysMs);
  const storageBytes = count(sqlite, 'SELECT SUM(size) AS n FROM attachments WHERE source_url IS NULL');
  const peers = count(sqlite, "SELECT COUNT(*) AS n FROM federation_peers WHERE status = 'active'");

  const registrationOpen = settings?.registration_open === null || settings?.registration_open === undefined
    ? ctx.registrationOpenDefault
    : settings.registration_open === 1;
  const installedAt = new Date(settings?.installed_at ?? Date.now()).toISOString().slice(0, 7);

  return {
    schema: 1,
    instance: ctx.telemetryId,
    day: today,
    build: { version: ctx.version, commit: ctx.commit, modified: ctx.modified },
    users: {
      registered: roundTwoSignificant(registered),
      active1d: roundTwoSignificant(active1d),
      active7d: roundTwoSignificant(active7d),
      active30d: roundTwoSignificant(active30d),
    },
    clients: {
      web: roundTwoSignificant(clients.web),
      desktop: roundTwoSignificant(clients.desktop),
      mobile: roundTwoSignificant(clients.mobile),
    },
    content: {
      spaces: roundTwoSignificant(spaces),
      channels: roundTwoSignificant(channels),
      messages: roundTwoSignificant(messages),
      messages7d: roundTwoSignificant(messages7d),
      storageMiB: roundTwoSignificant(Math.floor(storageBytes / (1024 * 1024))),
    },
    features: {
      voice: ctx.voice,
      federation: ctx.domainSet && settings?.federation_relay_enabled === 1,
      peers: roundTwoSignificant(peers),
      registrationOpen,
    },
    runtime: { install: install(ctx.installChannel), os: ctx.os, arch: ctx.arch, node: ctx.nodeMajor },
    installedAt,
  };
}
```

- [ ] **Step 3: Run, expect pass; commit**

```bash
cd packages/server && npx vitest run src/telemetry/payload.test.ts && npx tsc --noEmit
git add packages/server/src/telemetry/payload.ts packages/server/src/telemetry/payload.test.ts
git commit -m "feat(server): build the rounded telemetry payload"
```

### Task A6: Reporter job

**Files:**
- Create: `packages/server/src/telemetry/reporter.ts`
- Modify: `packages/server/src/config.ts` (add `telemetry.endpoint`)
- Test: `packages/server/src/telemetry/reporter.test.ts`

**Interfaces:**
- Consumes: A4 state functions, A5 builder.
- Produces:
```ts
export function slotMinute(telemetryId: string): number            // 0..1439, stable per id
export interface ReporterDeps {
  sqlite: Database.Database;
  endpoint: string;
  fetch: typeof fetch;
  now: () => Date;
  context: (today: string, telemetryId: string) => PayloadContext;
  log: { info(msg: string): void; debug(msg: string): void };
}
export async function reporterTick(deps: ReporterDeps): Promise<'sent' | 'skipped' | 'failed' | 'retired'>
export function startTelemetryReporter(): void
export function stopTelemetryReporter(): void
```

- [ ] **Step 1: Add the config key** in `config.ts` inside the `config` object, after `updates`:

```ts
  telemetry: {
    /** Receiver base URL for the opt-in daily ping. Tests and a future move override it. */
    endpoint: envOptional('TELEMETRY_ENDPOINT') ?? 'https://hello.backspacechat.com',
  },
```

- [ ] **Step 2: Failing test**

```ts
// packages/server/src/telemetry/reporter.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaults } from '../db/migrate.js';
import { readTelemetryState, setTelemetryEnabled } from './state.js';
import { reporterTick, slotMinute, type ReporterDeps } from './reporter.js';
import type { PayloadContext } from './payload.js';

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

const context = (today: string, telemetryId: string): PayloadContext => ({
  today, telemetryId, version: '1.1.2', commit: null, modified: false, voice: false, domainSet: true,
  registrationOpenDefault: true, installChannel: undefined, os: 'linux', arch: 'x64', nodeMajor: 20,
});

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;
const log = { info: vi.fn(), debug: vi.fn() };

function deps(nowIso: string, status = 204): ReporterDeps {
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status }));
  return { sqlite: db, endpoint: 'https://hello.test', fetch: fetchMock as unknown as typeof fetch, now: () => new Date(nowIso), context, log };
}

beforeEach(() => { db = new Database(':memory:'); applyMigrations(db); ensureDefaults(db); log.info.mockClear(); });

describe('slotMinute', () => {
  it('is stable per id and inside a day', () => {
    const a = slotMinute('3f6c9e2a-0000-4000-8000-000000000000');
    expect(a).toBe(slotMinute('3f6c9e2a-0000-4000-8000-000000000000'));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1440);
    expect(slotMinute('other')).not.toBe(a);
  });
});

describe('reporterTick', () => {
  it('does nothing while disabled or never asked', async () => {
    expect(await reporterTick(deps('2026-09-07T23:59:00Z'))).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send on the day it was enabled, sends the next day after the slot', async () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    const id = readTelemetryState(db).id!;
    expect(await reporterTick(deps('2026-09-06T23:59:00Z'))).toBe('skipped');
    const slot = slotMinute(id);
    const before = new Date(Date.UTC(2026, 8, 7, 0, Math.max(slot - 1, 0))).toISOString();
    const after = new Date(Date.UTC(2026, 8, 7, 0, slot)).toISOString();
    if (slot > 0) expect(await reporterTick(deps(before))).toBe('skipped');
    expect(await reporterTick(deps(after))).toBe('sent');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hello.test/v1/ping');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ schema: 1, instance: id, day: '2026-09-07' });
    expect(readTelemetryState(db).lastDay).toBe('2026-09-07');
    expect(await reporterTick(deps(after))).toBe('skipped');
  });

  it('records a failure and leaves lastDay alone', async () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    expect(await reporterTick(deps('2026-09-08T23:59:59Z', 503))).toBe('failed');
    expect(readTelemetryState(db)).toMatchObject({ lastDay: '2026-09-06', lastError: { day: '2026-09-08', status: 503 } });
  });

  it('turns itself off on 410', async () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    expect(await reporterTick(deps('2026-09-08T23:59:59Z', 410))).toBe('retired');
    expect(readTelemetryState(db)).toMatchObject({ enabled: false, id: null });
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('treats a thrown fetch as a failure with status 0', async () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    const d = deps('2026-09-08T23:59:59Z');
    (d.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    expect(await reporterTick(d)).toBe('failed');
    expect(readTelemetryState(db).lastError).toEqual({ day: '2026-09-08', status: 0 });
  });
});
```

Run: `cd packages/server && npx vitest run src/telemetry/reporter.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/server/src/telemetry/reporter.ts
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { config } from '../config.js';
import { getRawDb } from '../db/index.js';
import { utcDay } from './day.js';
import { buildTelemetryPayload, payloadContextFromConfig, type PayloadContext } from './payload.js';
import { readTelemetryState, recordTelemetryFailure, recordTelemetrySuccess, setTelemetryEnabled } from './state.js';

export interface ReporterDeps {
  sqlite: Database.Database;
  endpoint: string;
  fetch: typeof fetch;
  now: () => Date;
  context: (today: string, telemetryId: string) => PayloadContext;
  log: { info(msg: string): void; debug(msg: string): void };
}

/** Minute of the UTC day this instance reports at, spread by hashing the id. */
export function slotMinute(telemetryId: string): number {
  const digest = crypto.createHash('sha256').update(telemetryId).digest();
  return digest.readUInt16BE(0) % 1440;
}

const TIMEOUT_MS = 10_000;

export async function reporterTick(deps: ReporterDeps): Promise<'sent' | 'skipped' | 'failed' | 'retired'> {
  const state = readTelemetryState(deps.sqlite);
  if (state.enabled !== true || state.id === null) return 'skipped';

  const now = deps.now();
  const today = utcDay(now);
  if (state.lastDay === today) return 'skipped';
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (minuteOfDay < slotMinute(state.id)) return 'skipped';
  if (state.lastError?.day === today) return 'skipped';

  const payload = buildTelemetryPayload(deps.sqlite, deps.context(today, state.id));
  let status = 0;
  try {
    const response = await deps.fetch(`${deps.endpoint}/v1/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `backspace-server/${payload.build.version}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
  } catch (error) {
    deps.log.debug(`[telemetry] ping failed: ${(error as Error).message}`);
  }

  if (status >= 200 && status < 300) {
    recordTelemetrySuccess(deps.sqlite, today);
    return 'sent';
  }
  if (status === 410) {
    setTelemetryEnabled(deps.sqlite, false, today);
    deps.log.info('[telemetry] the receiver reports the service as retired; reporting switched off');
    return 'retired';
  }
  recordTelemetryFailure(deps.sqlite, today, status);
  deps.log.debug(`[telemetry] ping answered ${status}; retrying tomorrow`);
  return 'failed';
}

let timer: ReturnType<typeof setInterval> | null = null;
const TICK_MS = 60_000;

function productionDeps(): ReporterDeps {
  return {
    sqlite: getRawDb(),
    endpoint: config.telemetry.endpoint,
    fetch: globalThis.fetch,
    now: () => new Date(),
    context: (today, id) => payloadContextFromConfig(config, today, id),
    log: { info: (m) => console.log(m), debug: () => undefined },
  };
}

export function startTelemetryReporter(): void {
  if (timer) return;
  const run = () => { void reporterTick(productionDeps()); };
  run();
  timer = setInterval(run, TICK_MS);
}

export function stopTelemetryReporter(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
```

Note the extra guard `state.lastError?.day === today`: one attempt per day, so a receiver that answers 500 is not hit every minute.

- [ ] **Step 4: Run, expect pass; commit**

```bash
cd packages/server && npx vitest run src/telemetry && npx tsc --noEmit
git add packages/server/src/config.ts packages/server/src/telemetry/reporter.ts packages/server/src/telemetry/reporter.test.ts
git commit -m "feat(server): daily telemetry reporter with per-instance slot"
```

### Task A7: Admin routes, startup wiring, docs

**Files:**
- Create: `packages/server/src/routes/adminTelemetry.ts`
- Modify: `packages/server/src/index.ts:202` (register after `adminUpdateRoutes`) and `:243-256` (start and stop)
- Create: `docs/systems/telemetry.md`
- Modify: `docs/systems/api.md` (new section after line 296), `docs/systems/admin.md`
- Test: `packages/server/src/routes/adminTelemetry.test.ts`

**Interfaces:**
- Produces: `GET /api/admin/telemetry` → `TelemetryStatus`; `PUT /api/admin/telemetry` body `{ enabled: boolean }` → `TelemetryStatus`; `GET /api/admin/telemetry/preview` → `TelemetryPayload` (with `instance` set to the current id or `"preview"` while off).

- [ ] **Step 1: Failing test** (pattern of `instance.test.ts` for the database and `adminUpdates.test.ts` for the auth mock)

```ts
// packages/server/src/routes/adminTelemetry.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { ensureDefaults } from '../db/migrate.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(3);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let callerIsAdmin = true;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../utils/auth.js', () => ({
  authenticate: async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.headers.authorization) return reply.code(401).send({ error: 'unauthenticated', statusCode: 401 });
    (request as FastifyRequest & { userId: string }).userId = 'admin';
  },
  requireAdmin: async (_r: FastifyRequest, reply: FastifyReply) => {
    if (!callerIsAdmin) return reply.code(403).send({ error: 'forbidden', statusCode: 403 });
  },
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

let app: FastifyInstance;
const AUTH = { authorization: 'Bearer t' };

beforeEach(async () => {
  callerIsAdmin = true;
  sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  ensureDefaults(sqlite);
  testDb = drizzle(sqlite, { schema });
  const { adminTelemetryRoutes } = await import('./adminTelemetry.js');
  app = Fastify();
  await app.register(adminTelemetryRoutes);
});

describe('admin telemetry routes', () => {
  it('requires an admin', async () => {
    callerIsAdmin = false;
    const res = await app.inject({ method: 'GET', url: '/api/admin/telemetry', headers: AUTH });
    expect(res.statusCode).toBe(403);
  });
  it('reads never-asked, enables, disables', async () => {
    let res = await app.inject({ method: 'GET', url: '/api/admin/telemetry', headers: AUTH });
    expect(res.json()).toEqual({ enabled: null, id: null, lastDay: null, lastError: null });
    res = await app.inject({ method: 'PUT', url: '/api/admin/telemetry', headers: AUTH, payload: { enabled: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
    expect(res.json().id).toMatch(/-/);
    res = await app.inject({ method: 'PUT', url: '/api/admin/telemetry', headers: AUTH, payload: { enabled: false } });
    expect(res.json()).toMatchObject({ enabled: false, id: null });
  });
  it('rejects a body without a boolean', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/admin/telemetry', headers: AUTH, payload: { enabled: 'yes' } });
    expect(res.statusCode).toBe(400);
  });
  it('previews the payload before and after opting in', async () => {
    let res = await app.inject({ method: 'GET', url: '/api/admin/telemetry/preview', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ schema: 1, instance: 'preview' });
    await app.inject({ method: 'PUT', url: '/api/admin/telemetry', headers: AUTH, payload: { enabled: true } });
    res = await app.inject({ method: 'GET', url: '/api/admin/telemetry/preview', headers: AUTH });
    expect(res.json().instance).toMatch(/-/);
  });
});
```

Run: `cd packages/server && npx vitest run src/routes/adminTelemetry.test.ts` → FAIL.

- [ ] **Step 2: Implement the routes**

```ts
// packages/server/src/routes/adminTelemetry.ts
import type { FastifyInstance } from 'fastify';
import { authenticate, requireAdmin } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { getRawDb } from '../db/index.js';
import { config } from '../config.js';
import { utcDay } from '../telemetry/day.js';
import { readTelemetryState, setTelemetryEnabled } from '../telemetry/state.js';
import { buildTelemetryPayload, payloadContextFromConfig } from '../telemetry/payload.js';
import type { TelemetryStatus, TelemetryPayload } from '@backspace/shared';

/**
 * The opt-in usage report ("Say hi to Jannis"). Its own file so the id
 * lifecycle has exactly one owner; the general settings PATCH never touches
 * these columns. See docs/systems/telemetry.md.
 */
export async function adminTelemetryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/telemetry', { preHandler: [authenticate, requireAdmin] }, async (): Promise<TelemetryStatus> => {
    return readTelemetryState(getRawDb());
  });

  app.put<{ Body: { enabled?: unknown } }>(
    '/api/admin/telemetry',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply): Promise<TelemetryStatus | void> => {
      const enabled = request.body?.enabled;
      if (typeof enabled !== 'boolean') {
        return sendError(reply, 400, 'validation_failed');
      }
      return setTelemetryEnabled(getRawDb(), enabled, utcDay(new Date()));
    },
  );

  app.get('/api/admin/telemetry/preview', { preHandler: [authenticate, requireAdmin] }, async (): Promise<TelemetryPayload> => {
    const sqlite = getRawDb();
    const state = readTelemetryState(sqlite);
    const today = utcDay(new Date());
    return buildTelemetryPayload(sqlite, payloadContextFromConfig(config, today, state.id ?? 'preview'));
  });
}
```

If `sendError`'s `ErrorCode` union rejects `'validation_failed'`, use the existing code the other admin routes use for a bad body (grep `sendError(reply, 400` in `routes/admin.ts`) and keep the 400.

- [ ] **Step 3: Wire it into the server**

In `src/index.ts`: import `adminTelemetryRoutes` and register it after `adminUpdateRoutes`; import `startTelemetryReporter`, `stopTelemetryReporter` from `./telemetry/reporter.js`; call `startTelemetryReporter()` inside the same `else` branch as `startFederationWorkers()` (the `DISABLE_FEDERATION_WORKERS` guard keeps it out of the two-instance harness), and `stopTelemetryReporter()` in `shutdown` after `stopFederationWorkers()`.

- [ ] **Step 4: Run tests and boot**

Run: `cd packages/server && npx vitest run src/routes/adminTelemetry.test.ts && npx vitest run && npx tsc --noEmit`, then from the repo root `pnpm dev` and confirm the server starts, `GET /api/admin/telemetry/preview` with an admin token returns the payload, and the log shows no telemetry errors.

- [ ] **Step 5: Docs**

Create `docs/systems/telemetry.md` with these sections, written from the spec: purpose; the opt-in state model (the four columns and the transition rules); activity tracking (the two user columns, day precision, auth and pong); the payload with the field table from spec §5 and the rounding rule; what is never sent; the Cloudflare note; the reporter (slot, one attempt per day, 2xx/410/other); the admin routes; the receiver contract (routes, row shape, 90-day retention, rate-limit key); the collector's snapshot, two-days rule and folding; the publication threshold; the backup-restore limit; `TELEMETRY_ENDPOINT`.

Add the three routes to `docs/systems/api.md` as a new "Admin: Telemetry (`routes/adminTelemetry.ts`)" section after the Instance Updates section, and a "Telemetry" paragraph to `docs/systems/admin.md` pointing at the new doc.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/adminTelemetry.ts packages/server/src/routes/adminTelemetry.test.ts packages/server/src/index.ts docs/systems/telemetry.md docs/systems/api.md docs/systems/admin.md
git commit -m "feat(server): admin telemetry routes and reporter startup"
```

### Task A8: install.sh

**Files:**
- Modify: `install.sh` after the Phase 7 block (line 764) and in the Phase 8 summary (after line 990)
- Modify: `docs/systems/deployment.md` (env table) and `.env.example`

- [ ] **Step 1: Add Phase 7b after the instance-name block**

```bash
# ── Phase 7b: Optional usage ping (TELEMETRY=on|off for unattended installs) ──
# Interactive installs are never asked here; the admin panel asks once after
# the first login, with the full explanation. Any other value leaves the
# setting untouched. Runs the same transition the admin route runs.
if [[ "$healthy" == true && ( "${TELEMETRY:-}" == "on" || "${TELEMETRY:-}" == "off" ) ]]; then
  $DOCKER exec -e BS_TELEMETRY="$TELEMETRY" -w /app/packages/server backspace node -e '
    const Database = require("better-sqlite3");
    const crypto = require("crypto");
    const db = new Database("/app/data/backspace.db");
    const today = new Date().toISOString().slice(0, 10);
    const on = process.env.BS_TELEMETRY === "on";
    const changes = on
      ? db.prepare("UPDATE instance_settings SET telemetry_enabled = 1, telemetry_id = ?, telemetry_last_day = ?, telemetry_last_error = NULL WHERE id = 1").run(crypto.randomUUID(), today).changes
      : db.prepare("UPDATE instance_settings SET telemetry_enabled = 0, telemetry_id = NULL, telemetry_last_day = NULL, telemetry_last_error = NULL WHERE id = 1").run().changes;
    db.close();
    if (changes === 0) { console.error("No rows updated"); process.exit(1); }
  ' 2>/dev/null && success "Usage ping: ${TELEMETRY}" || warn "Could not set the usage ping (set it in admin settings)"
fi
```

- [ ] **Step 2: The teaser in Phase 8**, after the `Voice:` line:

```bash
if [[ -z "${TELEMETRY:-}" ]]; then
  echo ""
  echo -e "  One more thing waits after your first login: a small, optional usage ping,"
  echo -e "  and a note from me about why. It is off until you say otherwise."
fi
```

- [ ] **Step 3: Verify the script parses and the env is documented**

Run: `bash -n install.sh`. Add `TELEMETRY` to the env list at the top of `install.sh` (the comment block around line 25) and to `.env.example` with a one-line comment, and a row to the env table in `docs/systems/deployment.md`.

- [ ] **Step 4: Commit**

```bash
git add install.sh .env.example docs/systems/deployment.md
git commit -m "feat(install): unattended telemetry choice and the post-install note"
```

---

## Track B: receiver (`scripts/telemetry-receiver`)

Runs in parallel with A. Nothing in B imports from the rest of the monorepo.

### Task B1: Package scaffold, D1 migration, Worker test harness

**Files:**
- Create: `scripts/telemetry-receiver/package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `test/apply-migrations.ts`, `migrations/0001_pings.sql`, `src/env.ts`
- Modify: `pnpm-workspace.yaml` (add `- "scripts/telemetry-receiver"`)
- Test: `scripts/telemetry-receiver/src/harness.test.ts`, `src/no-runtime-deps.test.ts`

**Interfaces:**
- Produces: `Env` type `{ DB: D1Database; RATE_LIMITER?: RateLimit; EXPORT_TOKEN: string; RETIRED?: string }`; a test environment where `env.DB` has the `pings` table.

- [ ] **Step 1: Files**

`package.json`:

```json
{
  "name": "@backspace/telemetry-receiver",
  "version": "0.1.0",
  "private": true,
  "license": "AGPL-3.0-only",
  "author": "Jannis Braun",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.13.0",
    "@cloudflare/workers-types": "^4.20260901.0",
    "typescript": "^5.8.0",
    "vitest": "^4.1.11",
    "wrangler": "^4.36.0"
  }
}
```

Before installing, check the newest published versions of the three Cloudflare packages (`npm view <name> version`) and use those; the floors above are the minimums the plan relies on (Vitest 4 support in the pool, the rate-limit binding in wrangler).

`tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types/2023-07-01", "@cloudflare/vitest-pool-workers"],
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

If `tsconfig.base.json` does not exist at the repo root, copy the `compilerOptions` that `scripts/metrics/tsconfig.json` uses instead of `extends`.

`wrangler.toml`:

```toml
name = "backspace-telemetry-receiver"
main = "src/index.ts"
compatibility_date = "2026-09-01"

routes = [{ pattern = "hello.backspacechat.com", custom_domain = true }]

[vars]
RETIRED = "0"

[[d1_databases]]
binding = "DB"
database_name = "backspace-telemetry"
database_id = "REPLACE-AFTER-wrangler-d1-create"
migrations_dir = "migrations"

[[ratelimits]]
name = "RATE_LIMITER"
namespace_id = "1001"
[ratelimits.simple]
limit = 10
period = 10

[triggers]
crons = ["17 3 * * *"]
```

The `database_id` is filled in once by hand after `wrangler d1 create backspace-telemetry` (rollout, spec §16) and committed.

`migrations/0001_pings.sql`:

```sql
CREATE TABLE pings (
  instance    TEXT NOT NULL,
  day         TEXT NOT NULL,
  received_at TEXT NOT NULL,
  country     TEXT NOT NULL,
  schema      INTEGER NOT NULL,
  body        TEXT NOT NULL,
  PRIMARY KEY (instance, day)
);
CREATE INDEX pings_day ON pings (day);
```

`src/env.ts`:

```ts
export interface Env {
  DB: D1Database;
  /** Absent in tests and in `wrangler dev` without the binding; the handler skips limiting then. */
  RATE_LIMITER?: RateLimit;
  EXPORT_TOKEN: string;
  /** "1" retires the service: every ping answers 410. */
  RETIRED?: string;
  /** Injected by vitest.config.ts only. */
  TEST_MIGRATIONS?: D1Migration[];
}
```

`vitest.config.ts` (the Vitest 4 plugin API; confirm the two import paths against the current Cloudflare docs before running, they moved between 0.12 and 0.13):

```ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, EXPORT_TOKEN: 'test-export-token' } },
      }),
    ],
    test: { setupFiles: ['./test/apply-migrations.ts'] },
  };
});
```

`test/apply-migrations.ts`:

```ts
import { applyD1Migrations, env } from 'cloudflare:test';
import type { Env } from '../src/env';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
```

- [ ] **Step 2: Harness test and the no-runtime-deps test**

```ts
// src/harness.test.ts
import { it, expect } from 'vitest';
import { env } from 'cloudflare:test';

it('has the pings table', async () => {
  const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pings'").first<{ name: string }>();
  expect(row?.name).toBe('pings');
});
```

```ts
// src/no-runtime-deps.test.ts
import { it, expect } from 'vitest';
import pkg from '../package.json';

it('declares no runtime dependencies', () => {
  expect((pkg as { dependencies?: unknown }).dependencies).toBeUndefined();
});
```

Add `"resolveJsonModule": true` to the tsconfig if the import complains.

- [ ] **Step 3: Install and run**

Run from the repo root: `pnpm install` (updates the lockfile), then `cd scripts/telemetry-receiver && pnpm test`.
Expected: both tests PASS in the Workers pool. If the plugin import path differs, fix the config against the docs, not by pinning an older pool.

- [ ] **Step 4: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml scripts/telemetry-receiver
git commit -m "feat(telemetry-receiver): package scaffold with D1 schema and Workers test harness"
```

### Task B2: Ping validation and rounding on arrival

**Files:**
- Create: `scripts/telemetry-receiver/src/validate.ts`
- Test: `scripts/telemetry-receiver/src/validate.test.ts`

**Interfaces:**
- Produces:
```ts
export const MAX_BODY_BYTES = 4096;
export const MAX_COUNT = 1_000_000_000;
export interface ValidPing { instance: string; day: string; schema: number; body: string }  // body re-serialised after rounding
export type ParseResult = { ok: true; ping: ValidPing } | { ok: false; reason: string };
export function parsePing(text: string, receiverToday: string): ParseResult
export function roundTwoSignificant(n: number): number
export function normaliseCountry(value: unknown): string  // 'ZZ' for undefined, null, 'XX', 'T1', non-2-letter
```

- [ ] **Step 1: Failing tests**

```ts
// src/validate.test.ts
import { describe, it, expect } from 'vitest';
import { parsePing, roundTwoSignificant, normaliseCountry, MAX_BODY_BYTES } from './validate';

const good = {
  schema: 1, instance: '3f6c9e2a-1b2c-4d5e-8f90-1234567890ab', day: '2026-09-06',
  users: { registered: 12345, active1d: 7, active7d: 19, active30d: 31 },
  clients: { web: 12, desktop: 6, mobile: 1 },
  content: { spaces: 3, channels: 21, messages: 12345, messages7d: 410, storageMiB: 700 },
  features: { voice: true, federation: true, peers: 2, registrationOpen: false },
  extra: { future: 'field' },
};

describe('parsePing', () => {
  it('accepts a valid ping and rounds counts on arrival', () => {
    const r = parsePing(JSON.stringify(good), '2026-09-06');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ping).toMatchObject({ instance: good.instance, day: '2026-09-06', schema: 1 });
    const body = JSON.parse(r.ping.body) as typeof good;
    expect(body.users.registered).toBe(12000);
    expect(body.content.messages).toBe(12000);
    expect(body.users.active1d).toBe(7);
    expect(body.extra).toEqual({ future: 'field' });
  });
  it('rejects malformed JSON, wrong schema, bad ids, bad days', () => {
    expect(parsePing('{', '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, schema: 0 }), '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, schema: '1' }), '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, instance: 'not-a-uuid' }), '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, day: '2026-9-6' }), '2026-09-06').ok).toBe(false);
  });
  it('rejects days more than two days from the receiver date', () => {
    expect(parsePing(JSON.stringify({ ...good, day: '2026-09-04' }), '2026-09-06').ok).toBe(true);
    expect(parsePing(JSON.stringify({ ...good, day: '2026-09-03' }), '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, day: '2026-09-09' }), '2026-09-06').ok).toBe(false);
  });
  it('rejects negative, fractional, oversized or non-numeric known counts', () => {
    expect(parsePing(JSON.stringify({ ...good, users: { ...good.users, registered: -1 } }), '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, users: { ...good.users, registered: 1.5 } }), '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, users: { ...good.users, registered: 1e12 } }), '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, users: { ...good.users, registered: '5' } }), '2026-09-06').ok).toBe(false);
  });
  it('rejects bodies over the size limit', () => {
    const big = JSON.stringify({ ...good, pad: 'x'.repeat(MAX_BODY_BYTES) });
    expect(parsePing(big, '2026-09-06').ok).toBe(false);
  });
});

describe('roundTwoSignificant', () => {
  it('matches the server rule', () => {
    expect(roundTwoSignificant(99)).toBe(99);
    expect(roundTwoSignificant(12345)).toBe(12000);
    expect(roundTwoSignificant(999)).toBe(1000);
  });
});

describe('normaliseCountry', () => {
  it('maps unknowns to ZZ and keeps ISO codes', () => {
    expect(normaliseCountry('DE')).toBe('DE');
    expect(normaliseCountry('XX')).toBe('ZZ');
    expect(normaliseCountry('T1')).toBe('ZZ');
    expect(normaliseCountry(undefined)).toBe('ZZ');
    expect(normaliseCountry(null)).toBe('ZZ');
    expect(normaliseCountry('Germany')).toBe('ZZ');
  });
});
```

Run: `pnpm test` in the package → FAIL.

- [ ] **Step 2: Implement**

```ts
// src/validate.ts
export const MAX_BODY_BYTES = 4096;
export const MAX_COUNT = 1_000_000_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The numeric fields schema 1 defines. Anything else in the body is opaque. */
const COUNT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['users', 'registered'], ['users', 'active1d'], ['users', 'active7d'], ['users', 'active30d'],
  ['clients', 'web'], ['clients', 'desktop'], ['clients', 'mobile'],
  ['content', 'spaces'], ['content', 'channels'], ['content', 'messages'], ['content', 'messages7d'], ['content', 'storageMiB'],
  ['features', 'peers'],
];

export interface ValidPing { instance: string; day: string; schema: number; body: string }
export type ParseResult = { ok: true; ping: ValidPing } | { ok: false; reason: string };

export function roundTwoSignificant(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const whole = Math.floor(n);
  if (whole < 100) return whole;
  const magnitude = 10 ** (Math.floor(Math.log10(whole)) - 1);
  return Math.round(whole / magnitude) * magnitude;
}

export function normaliseCountry(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value) || value === 'XX' || value === 'T1') return 'ZZ';
  return value;
}

function dayOffset(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parsePing(text: string, receiverToday: string): ParseResult {
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { ok: false, reason: 'too large' };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: 'not json' }; }
  if (!isRecord(parsed)) return { ok: false, reason: 'not an object' };

  const { schema, instance, day } = parsed;
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 1) return { ok: false, reason: 'schema' };
  if (typeof instance !== 'string' || !UUID.test(instance)) return { ok: false, reason: 'instance' };
  if (typeof day !== 'string' || !ISO_DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return { ok: false, reason: 'day' };
  if (Math.abs(dayOffset(day, receiverToday)) > 2) return { ok: false, reason: 'day out of range' };

  for (const [group, field] of COUNT_FIELDS) {
    const g = parsed[group];
    if (!isRecord(g)) continue;
    const v = g[field];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_COUNT) return { ok: false, reason: `${group}.${field}` };
    g[field] = roundTwoSignificant(v);
  }

  return { ok: true, ping: { instance: instance.toLowerCase(), day, schema, body: JSON.stringify(parsed) } };
}
```

- [ ] **Step 3: Run, expect pass; commit**

```bash
cd scripts/telemetry-receiver && pnpm test && pnpm typecheck
git add scripts/telemetry-receiver/src/validate.ts scripts/telemetry-receiver/src/validate.test.ts
git commit -m "feat(telemetry-receiver): validate and round incoming pings"
```

### Task B3: The Worker: ping, export, root page, retirement, retention

**Files:**
- Create: `scripts/telemetry-receiver/src/index.ts`, `src/page.ts`, `src/store.ts`
- Test: `scripts/telemetry-receiver/src/index.test.ts`

**Interfaces:**
- Consumes: B2.
- Produces: the HTTP contract of spec §7; `scheduled` deletes rows older than 90 days.

- [ ] **Step 1: Failing tests**

```ts
// src/index.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from './index';

const ID = '3f6c9e2a-1b2c-4d5e-8f90-1234567890ab';
function today(): string { return new Date().toISOString().slice(0, 10); }
function ping(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: 1, instance: ID, day: today(), users: { registered: 5 }, ...over });
}
async function call(req: Request, e = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
function post(body: string, cf: Record<string, unknown> = { country: 'DE' }): Request {
  return new Request('https://hello.test/v1/ping', { method: 'POST', headers: { 'content-type': 'application/json' }, body, cf } as RequestInit);
}
async function rows(): Promise<Array<{ instance: string; day: string; country: string; body: string }>> {
  return (await env.DB.prepare('SELECT instance, day, country, body FROM pings ORDER BY day').all()).results as never;
}

beforeEach(async () => { await env.DB.prepare('DELETE FROM pings').run(); });

describe('POST /v1/ping', () => {
  it('stores a row with the edge country and answers 204', async () => {
    const res = await call(post(ping()));
    expect(res.status).toBe(204);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ instance: ID, day: today(), country: 'DE' });
  });
  it('upserts on instance and day', async () => {
    await call(post(ping({ users: { registered: 5 } })));
    await call(post(ping({ users: { registered: 6 } })));
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(JSON.parse(all[0]!.body).users.registered).toBe(6);
  });
  it('answers 400 to an invalid body and to an oversized body without a length header', async () => {
    expect((await call(post('{'))).status).toBe(400);
    expect((await call(post(ping({ pad: 'x'.repeat(5000) })))).status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });
  it('stores ZZ when the edge has no country', async () => {
    await call(post(ping(), {}));
    expect((await rows())[0]!.country).toBe('ZZ');
  });
  it('answers 410 when retired', async () => {
    const res = await call(post(ping()), { ...env, RETIRED: '1' });
    expect(res.status).toBe(410);
    expect(await rows()).toHaveLength(0);
  });
  it('answers 429 when the limiter says no', async () => {
    const limiter = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const res = await call(post(ping()), { ...env, RATE_LIMITER: limiter });
    expect(res.status).toBe(429);
  });
});

describe('GET /v1/export', () => {
  it('requires the bearer token and returns NDJSON for a range', async () => {
    await call(post(ping()));
    const d = today();
    let res = await call(new Request(`https://hello.test/v1/export?from=${d}&to=${d}`));
    expect(res.status).toBe(401);
    res = await call(new Request(`https://hello.test/v1/export?from=${d}&to=${d}`, { headers: { authorization: 'Bearer wrong' } }));
    expect(res.status).toBe(401);
    res = await call(new Request(`https://hello.test/v1/export?from=${d}&to=${d}`, { headers: { authorization: 'Bearer test-export-token' } }));
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ instance: ID, day: d, country: 'DE', schema: 1 });
  });
  it('rejects bad or too-long ranges', async () => {
    const h = { headers: { authorization: 'Bearer test-export-token' } };
    expect((await call(new Request('https://hello.test/v1/export?from=x&to=y', h))).status).toBe(400);
    expect((await call(new Request('https://hello.test/v1/export?from=2026-01-01&to=2026-03-01', h))).status).toBe(400);
  });
});

describe('other routes', () => {
  it('serves the root page and 404s elsewhere', async () => {
    const root = await call(new Request('https://hello.test/'));
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(await root.text()).toContain('docs/systems/telemetry.md');
    expect((await call(new Request('https://hello.test/nope'))).status).toBe(404);
    expect((await call(new Request('https://hello.test/v1/ping'))).status).toBe(404);
  });
});

describe('scheduled', () => {
  it('deletes rows older than 90 days', async () => {
    await env.DB.prepare("INSERT INTO pings (instance, day, received_at, country, schema, body) VALUES (?, '2020-01-01', 'x', 'ZZ', 1, '{}')").bind(ID).run();
    await call(post(ping()));
    const ctx = createExecutionContext();
    await worker.scheduled({ scheduledTime: Date.now(), cron: '', noRetry() {} } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await rows()).toHaveLength(1);
  });
});
```

Run: `pnpm test` → FAIL.

- [ ] **Step 2: Implement `store.ts`, `page.ts`, `index.ts`**

```ts
// src/store.ts
export interface StoredPing { instance: string; day: string; receivedAt: string; country: string; schema: number; body: string }

export async function upsertPing(db: D1Database, p: StoredPing): Promise<void> {
  await db.prepare(
    `INSERT INTO pings (instance, day, received_at, country, schema, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(instance, day) DO UPDATE SET received_at = excluded.received_at, country = excluded.country, schema = excluded.schema, body = excluded.body`,
  ).bind(p.instance, p.day, p.receivedAt, p.country, p.schema, p.body).run();
}

export async function exportRange(db: D1Database, from: string, to: string): Promise<StoredPing[]> {
  const { results } = await db.prepare(
    'SELECT instance, day, received_at, country, schema, body FROM pings WHERE day >= ?1 AND day <= ?2 ORDER BY day, instance',
  ).bind(from, to).all<{ instance: string; day: string; received_at: string; country: string; schema: number; body: string }>();
  return results.map((r) => ({ instance: r.instance, day: r.day, receivedAt: r.received_at, country: r.country, schema: r.schema, body: r.body }));
}

export async function deleteOlderThan(db: D1Database, day: string): Promise<number> {
  const res = await db.prepare('DELETE FROM pings WHERE day < ?1').bind(day).run();
  return res.meta.changes;
}
```

```ts
// src/page.ts
export const ROOT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Backspace usage pings</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px/1.5 system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#1a1a23}code{background:#eee;padding:0 .2rem}</style>
</head><body>
<h1>Backspace usage pings</h1>
<p>This is the receiver for the optional daily usage report that a Backspace server admin can switch on. It is off by default on every instance.</p>
<p>A report contains a random instance id, the day, the Backspace version, and rounded counts: users, active users, spaces, channels, messages, storage, whether voice and federation are on, and how many peers. The receiver adds the country of the request as seen by Cloudflare. Nothing else is stored: no addresses, no names, no domains, no message content.</p>
<p>Rows are deleted after 90 days. Aggregates, never single instances, are published as open data on the project's insights page.</p>
<p>Details and the exact schema: <a href="https://github.com/TheZwiss/backspace/blob/main/docs/systems/telemetry.md">docs/systems/telemetry.md</a>. This receiver's source: <a href="https://github.com/TheZwiss/backspace/tree/main/scripts/telemetry-receiver">scripts/telemetry-receiver</a>.</p>
</body></html>`;
```

```ts
// src/index.ts
import type { Env } from './env';
import { parsePing, normaliseCountry, MAX_BODY_BYTES } from './validate';
import { upsertPing, exportRange, deleteOlderThan } from './store';
import { ROOT_PAGE } from './page';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EXPORT_DAYS = 31;
const RETENTION_DAYS = 90;

function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
}

/** Constant-time bearer comparison via hashes, so unequal lengths leak nothing. */
async function bearerMatches(header: string | null, expected: string): Promise<boolean> {
  if (!header?.startsWith('Bearer ') || expected === '') return false;
  const [a, b] = await Promise.all([sha256(header.slice(7)), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function handlePing(request: Request, env: Env): Promise<Response> {
  if (env.RETIRED === '1') return new Response(null, { status: 410 });
  if (env.RATE_LIMITER) {
    // The source address is used here and nowhere else: as the limiter key, never stored.
    const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key });
    if (!success) return new Response(null, { status: 429 });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 400 });
  const receivedAt = new Date().toISOString();
  const result = parsePing(text, receivedAt.slice(0, 10));
  if (!result.ok) return new Response(null, { status: 400 });
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  await upsertPing(env.DB, { ...result.ping, receivedAt, country: normaliseCountry(cf?.country) });
  return new Response(null, { status: 204 });
}

async function handleExport(request: Request, env: Env): Promise<Response> {
  if (!(await bearerMatches(request.headers.get('authorization'), env.EXPORT_TOKEN))) {
    return new Response(null, { status: 401 });
  }
  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) return new Response(null, { status: 400 });
  const span = daysBetween(from, to);
  if (Number.isNaN(span) || span < 0 || span >= MAX_EXPORT_DAYS) return new Response(null, { status: 400 });
  const rows = await exportRange(env.DB, from, to);
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname === '/v1/ping') return handlePing(request, env);
    if (request.method === 'GET' && pathname === '/v1/export') return handleExport(request, env);
    if (request.method === 'GET' && pathname === '/') {
      return new Response(ROOT_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response(null, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const cutoff = utcDay(controller.scheduledTime - RETENTION_DAYS * 86_400_000);
    await deleteOlderThan(env.DB, cutoff);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 3: Run, expect pass**

Run: `cd scripts/telemetry-receiver && pnpm test && pnpm typecheck`. If `cf` on `RequestInit` is rejected by the runtime in tests, construct the request as `new Request(url, init)` and set `Object.defineProperty(req, 'cf', { value: { country: 'DE' } })` in the test helper instead; the handler reads `request.cf` either way.

- [ ] **Step 4: Manual check with wrangler dev**

Run `pnpm dev` in the package, then:

```bash
curl -i -X POST localhost:8787/v1/ping -H 'content-type: application/json' -d '{"schema":1,"instance":"3f6c9e2a-1b2c-4d5e-8f90-1234567890ab","day":"'$(date -u +%F)'","users":{"registered":3}}'
curl -i localhost:8787/
```

Expected: 204 and the HTML page.

- [ ] **Step 5: Commit**

```bash
git add scripts/telemetry-receiver/src
git commit -m "feat(telemetry-receiver): ping intake, export, retirement switch and retention"
```

### Task B4: Deploy workflow and security docs

**Files:**
- Create: `.github/workflows/telemetry-receiver.yml`
- Modify: `docs/systems/security-scanning.md` (pinned-actions inventory), `docs/systems/telemetry.md` (deployment paragraph)

- [ ] **Step 1: Write the workflow**

Copy the exact pinned SHAs for `step-security/harden-runner`, `actions/checkout`, `pnpm/action-setup` and `actions/setup-node` from `.github/workflows/ci.yml`. Look up the current commit SHA of the `cloudflare/wrangler-action` v3 line and pin it with a `# v3.x.y` comment, per the repo policy.

```yaml
name: Telemetry receiver

on:
  push:
    branches: [main]
    paths: ['scripts/telemetry-receiver/**', '.github/workflows/telemetry-receiver.yml']
  pull_request:
    paths: ['scripts/telemetry-receiver/**', '.github/workflows/telemetry-receiver.yml']

permissions:
  contents: read

jobs:
  test:
    name: Test the receiver
    runs-on: ubuntu-latest
    steps:
      - name: Harden the runner
        uses: step-security/harden-runner@<sha> # vX.Y.Z
        with:
          egress-policy: audit
      - uses: actions/checkout@<sha> # vX.Y.Z
      - uses: pnpm/action-setup@<sha> # vX.Y.Z
      - uses: actions/setup-node@<sha> # vX.Y.Z
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile --filter @backspace/telemetry-receiver
      - run: pnpm --filter @backspace/telemetry-receiver typecheck
      - run: pnpm --filter @backspace/telemetry-receiver test

  deploy:
    name: Deploy to Cloudflare
    needs: test
    if: github.event_name == 'push' && github.ref == 'refs/heads/main' && !github.event.repository.fork
    runs-on: ubuntu-latest
    environment: telemetry-receiver
    steps:
      - name: Harden the runner
        uses: step-security/harden-runner@<sha> # vX.Y.Z
        with:
          egress-policy: audit
      - uses: actions/checkout@<sha> # vX.Y.Z
      - uses: pnpm/action-setup@<sha> # vX.Y.Z
      - uses: actions/setup-node@<sha> # vX.Y.Z
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile --filter @backspace/telemetry-receiver
      - name: Apply D1 migrations
        uses: cloudflare/wrangler-action@<sha> # v3.x.y
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: scripts/telemetry-receiver
          command: d1 migrations apply DB --remote
      - name: Deploy
        uses: cloudflare/wrangler-action@<sha> # v3.x.y
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: scripts/telemetry-receiver
          command: deploy
```

If `.nvmrc` does not exist, use the `node-version` value the other workflows use.

- [ ] **Step 2: Lint and document**

Run `actionlint .github/workflows/telemetry-receiver.yml` if available (the CI has an actionlint job; otherwise rely on it). Add the workflow and the wrangler action to the inventory in `docs/systems/security-scanning.md`, and a deployment paragraph to `docs/systems/telemetry.md`: the two repository secrets, the `EXPORT_TOKEN` Worker secret (`wrangler secret put EXPORT_TOKEN`) mirrored as the `TELEMETRY_EXPORT_TOKEN` repository secret for the collector, the `database_id` step, the custom domain, and the `RETIRED` switch.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/telemetry-receiver.yml docs/systems/security-scanning.md docs/systems/telemetry.md
git commit -m "ci: test and deploy the telemetry receiver"
```

---

## Track C: collector and bundle (`scripts/metrics`)

Runs in parallel with A and B. The package has zero runtime dependencies and every module takes the clock, the network and the filesystem as injected values; keep it that way.

### Task C1: Export parsing and the snapshot aggregation

**Files:**
- Create: `scripts/metrics/src/telemetry.ts`
- Modify: `scripts/metrics/src/types.ts` (add `NetworkPoint`)
- Test: `scripts/metrics/src/telemetry.test.ts`

**Interfaces:**
- Produces:
```ts
// types.ts
export interface NetworkPoint {
  date: IsoDate;
  instances_1d: number; instances_7d: number; instances_30d: number;
  users_registered: number; users_active1d: number; users_active7d: number; users_active30d: number;
  messages7d: number; storage_mib: number; voice_instances: number; federation_instances: number;
}
// telemetry.ts
export interface PingRow { instance: string; day: IsoDate; country: string; schema: number; body: PingBody }
export interface PingBody {  // every field optional: old schemas, modified builds
  build?: { version?: unknown }; users?: Record<string, unknown>; clients?: Record<string, unknown>;
  content?: Record<string, unknown>; features?: Record<string, unknown>;
}
export const MIN_INSTANCES_PER_DIMENSION = 3;
export const MAX_ROW_VALUE = 1_000_000_000;
export function parseExportNdjson(text: string): { rows: PingRow[]; skipped: number }
export function aggregateTelemetry(rows: readonly PingRow[], date: IsoDate): TelemetryAggregate
export interface TelemetryAggregate { network: NetworkPoint; versions: DimensionRow[]; countries: DimensionRow[]; clients: DimensionRow[] }
export type TelemetryFetcher = (from: IsoDate, to: IsoDate) => Promise<PingRow[]>
export function createTelemetryFetcher(fetchFn: typeof fetch, endpoint: string, token: string): TelemetryFetcher
```

- [ ] **Step 1: Failing tests**

```ts
// scripts/metrics/src/telemetry.test.ts
import { describe, it, expect } from 'vitest';
import { parseExportNdjson, aggregateTelemetry, createTelemetryFetcher, type PingRow } from './telemetry.ts';

function row(instance: string, day: string, over: Partial<PingRow['body']> = {}, country = 'DE'): PingRow {
  return {
    instance, day, country, schema: 1,
    body: {
      build: { version: '1.1.2' },
      users: { registered: 10, active1d: 2, active7d: 5, active30d: 8 },
      clients: { web: 3, desktop: 2, mobile: 0 },
      content: { messages7d: 100, storageMiB: 50 },
      features: { voice: true, federation: false },
      ...over,
    },
  };
}

// Five instances reporting on two days each, so every dimension clears the fold threshold.
function fleet(day2: string, day1: string): PingRow[] {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  return ids.flatMap((id) => [row(id, day1), row(id, day2)]);
}

describe('parseExportNdjson', () => {
  it('parses lines and skips malformed ones', () => {
    const line = JSON.stringify({ instance: 'a', day: '2026-09-06', receivedAt: 'x', country: 'DE', schema: 1, body: JSON.stringify({ users: { registered: 3 } }) });
    const out = parseExportNdjson(`${line}\nnot json\n\n`);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ instance: 'a', day: '2026-09-06', country: 'DE', body: { users: { registered: 3 } } });
    expect(out.skipped).toBe(1);
  });
});

describe('aggregateTelemetry', () => {
  it('sums the snapshot over instances seen on two days and counts instances by window', () => {
    const rows = [...fleet('2026-09-05', '2026-09-06'), row('once', '2026-09-06')];
    const agg = aggregateTelemetry(rows, '2026-09-06');
    expect(agg.network).toEqual({
      date: '2026-09-06', instances_1d: 5, instances_7d: 5, instances_30d: 5,
      users_registered: 50, users_active1d: 10, users_active7d: 25, users_active30d: 40,
      messages7d: 500, storage_mib: 250, voice_instances: 5, federation_instances: 0,
    });
  });
  it('uses the latest row per instance inside the 7-day window and active1d only from the day itself', () => {
    const rows = [row('a', '2026-09-01'), row('a', '2026-09-03', { users: { registered: 20, active1d: 9, active7d: 9, active30d: 9 } })];
    const agg = aggregateTelemetry(rows, '2026-09-06');
    expect(agg.network.instances_1d).toBe(0);
    expect(agg.network.instances_7d).toBe(1);
    expect(agg.network.users_registered).toBe(20);
    expect(agg.network.users_active1d).toBe(0);
  });
  it('drops instances outside the 7-day window from sums but keeps them in instances_30d', () => {
    const rows = [row('a', '2026-08-20'), row('a', '2026-08-21')];
    const agg = aggregateTelemetry(rows, '2026-09-06');
    expect(agg.network.instances_7d).toBe(0);
    expect(agg.network.instances_30d).toBe(1);
    expect(agg.network.users_registered).toBe(0);
  });
  it('folds dimension values held by fewer than three instances into other', () => {
    const rows = [...fleet('2026-09-05', '2026-09-06'), row('x', '2026-09-05', { build: { version: '9.9.9' } }, 'LI'), row('x', '2026-09-06', { build: { version: '9.9.9' } }, 'LI')];
    const agg = aggregateTelemetry(rows, '2026-09-06');
    expect(agg.versions).toEqual([
      { snapshot_date: '2026-09-06', dimension: '1.1.2', title: '', count: 5, uniques: 5 },
      { snapshot_date: '2026-09-06', dimension: 'other', title: '', count: 1, uniques: 1 },
    ]);
    expect(agg.countries.find((r) => r.dimension === 'LI')).toBeUndefined();
    expect(agg.countries.find((r) => r.dimension === 'other')?.count).toBe(1);
  });
  it('reports client kinds as user sums and caps absurd values', () => {
    const rows = [...fleet('2026-09-05', '2026-09-06'), row('z', '2026-09-05', { users: { registered: 1e15 } }), row('z', '2026-09-06', { users: { registered: 1e15 } })];
    const agg = aggregateTelemetry(rows, '2026-09-06');
    expect(agg.clients.find((r) => r.dimension === 'desktop')?.count).toBe(10);
    expect(agg.network.users_registered).toBe(50 + 1_000_000_000);
  });
});

describe('createTelemetryFetcher', () => {
  it('calls the export route with the bearer token and parses the answer', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return new Response(JSON.stringify({ instance: 'a', day: '2026-09-06', receivedAt: 'x', country: 'DE', schema: 1, body: '{}' }) + '\n', { status: 200 });
    }) as typeof fetch;
    const rows = await createTelemetryFetcher(fetchFn, 'https://hello.test', 'tok')('2026-09-01', '2026-09-06');
    expect(rows).toHaveLength(1);
    expect(calls[0]![0]).toBe('https://hello.test/v1/export?from=2026-09-01&to=2026-09-06');
    expect((calls[0]![1]?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });
  it('throws on a non-200 answer', async () => {
    const fetchFn = (async () => new Response(null, { status: 401 })) as typeof fetch;
    await expect(createTelemetryFetcher(fetchFn, 'https://hello.test', 'tok')('2026-09-01', '2026-09-06')).rejects.toThrow(/401/);
  });
});
```

Run: `cd scripts/metrics && npx vitest run src/telemetry.test.ts` → FAIL.

- [ ] **Step 2: Implement**

Add `NetworkPoint` to `types.ts` as shown in Interfaces. Then:

```ts
// scripts/metrics/src/telemetry.ts
import type { DimensionRow, IsoDate, NetworkPoint } from './types.ts';
import { MS_PER_DAY, utcDayStart } from './series.ts';

export interface PingBody {
  build?: { version?: unknown };
  users?: Record<string, unknown>;
  clients?: Record<string, unknown>;
  content?: Record<string, unknown>;
  features?: Record<string, unknown>;
}
export interface PingRow { instance: string; day: IsoDate; country: string; schema: number; body: PingBody }
export interface TelemetryAggregate { network: NetworkPoint; versions: DimensionRow[]; countries: DimensionRow[]; clients: DimensionRow[] }
export type TelemetryFetcher = (from: IsoDate, to: IsoDate) => Promise<PingRow[]>;

export const MIN_INSTANCES_PER_DIMENSION = 3;
export const MAX_ROW_VALUE = 1_000_000_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseExportNdjson(text: string): { rows: PingRow[]; skipped: number } {
  const rows: PingRow[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const raw: unknown = JSON.parse(line);
      if (!isRecord(raw) || typeof raw['instance'] !== 'string' || typeof raw['day'] !== 'string' || !ISO_DAY.test(raw['day'])
        || typeof raw['country'] !== 'string' || typeof raw['schema'] !== 'number' || typeof raw['body'] !== 'string') {
        skipped += 1;
        continue;
      }
      const body: unknown = JSON.parse(raw['body']);
      if (!isRecord(body)) { skipped += 1; continue; }
      rows.push({ instance: raw['instance'], day: raw['day'], country: raw['country'], schema: raw['schema'], body: body as PingBody });
    } catch {
      skipped += 1;
    }
  }
  return { rows, skipped };
}

function addDays(day: IsoDate, delta: number): IsoDate {
  return new Date(utcDayStart(day) + delta * MS_PER_DAY).toISOString().slice(0, 10);
}

function num(group: Record<string, unknown> | undefined, field: string): number {
  const v = group?.[field];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.min(Math.floor(v), MAX_ROW_VALUE);
}

function bool(group: Record<string, unknown> | undefined, field: string): boolean {
  return group?.[field] === true;
}

/** Latest row per instance with day in [from, to]. */
function latestPerInstance(rows: readonly PingRow[], from: IsoDate, to: IsoDate): Map<string, PingRow> {
  const latest = new Map<string, PingRow>();
  for (const row of rows) {
    if (row.day < from || row.day > to) continue;
    const current = latest.get(row.instance);
    if (!current || row.day > current.day) latest.set(row.instance, row);
  }
  return latest;
}

function foldSmall(counts: Map<string, number>, date: IsoDate): DimensionRow[] {
  let other = 0;
  const kept: DimensionRow[] = [];
  for (const [dimension, count] of counts) {
    if (count < MIN_INSTANCES_PER_DIMENSION) other += count;
    else kept.push({ snapshot_date: date, dimension, title: '', count, uniques: count });
  }
  kept.sort((a, b) => b.count - a.count || (a.dimension < b.dimension ? -1 : 1));
  if (other > 0) kept.push({ snapshot_date: date, dimension: 'other', title: '', count: other, uniques: other });
  return kept;
}

/**
 * The network snapshot for `date`: the latest row per instance in the seven
 * days ending on `date`, restricted to instances that reported on at least two
 * distinct days in the trailing thirty. `users_active1d` comes only from rows
 * dated `date` itself; every other sum uses the snapshot. Dimension values
 * held by fewer than three instances fold into `other`. See spec §8.
 */
export function aggregateTelemetry(rows: readonly PingRow[], date: IsoDate): TelemetryAggregate {
  const from30 = addDays(date, -29);
  const from7 = addDays(date, -6);

  const daysByInstance = new Map<string, Set<IsoDate>>();
  for (const row of rows) {
    if (row.day < from30 || row.day > date) continue;
    let days = daysByInstance.get(row.instance);
    if (!days) { days = new Set(); daysByInstance.set(row.instance, days); }
    days.add(row.day);
  }
  const eligible = new Set([...daysByInstance].filter(([, days]) => days.size >= 2).map(([id]) => id));
  const eligibleRows = rows.filter((row) => eligible.has(row.instance));

  const snapshot = [...latestPerInstance(eligibleRows, from7, date).values()];
  const onDay = snapshot.filter((row) => row.day === date);
  const within30 = latestPerInstance(eligibleRows, from30, date);

  const sum = (pick: (row: PingRow) => number, over: readonly PingRow[] = snapshot): number =>
    over.reduce((acc, row) => acc + pick(row), 0);

  const network: NetworkPoint = {
    date,
    instances_1d: onDay.length,
    instances_7d: snapshot.length,
    instances_30d: within30.size,
    users_registered: sum((r) => num(r.body.users, 'registered')),
    users_active1d: sum((r) => num(r.body.users, 'active1d'), onDay),
    users_active7d: sum((r) => num(r.body.users, 'active7d')),
    users_active30d: sum((r) => num(r.body.users, 'active30d')),
    messages7d: sum((r) => num(r.body.content, 'messages7d')),
    storage_mib: sum((r) => num(r.body.content, 'storageMiB')),
    voice_instances: snapshot.filter((r) => bool(r.body.features, 'voice')).length,
    federation_instances: snapshot.filter((r) => bool(r.body.features, 'federation')).length,
  };

  const versionCounts = new Map<string, number>();
  const countryCounts = new Map<string, number>();
  const clientInstances = new Map<string, number>();
  const clientUsers = new Map<string, number>();
  for (const row of snapshot) {
    const version = typeof row.body.build?.version === 'string' ? row.body.build.version : 'unknown';
    versionCounts.set(version, (versionCounts.get(version) ?? 0) + 1);
    countryCounts.set(row.country, (countryCounts.get(row.country) ?? 0) + 1);
    for (const kind of ['web', 'desktop', 'mobile'] as const) {
      const users = num(row.body.clients, kind);
      if (users === 0) continue;
      clientInstances.set(kind, (clientInstances.get(kind) ?? 0) + 1);
      clientUsers.set(kind, (clientUsers.get(kind) ?? 0) + users);
    }
  }

  // Client kinds fold by how many instances carry them, but report user sums.
  const clients: DimensionRow[] = [];
  let otherUsers = 0;
  for (const [kind, instances] of clientInstances) {
    const users = clientUsers.get(kind) ?? 0;
    if (instances < MIN_INSTANCES_PER_DIMENSION) otherUsers += users;
    else clients.push({ snapshot_date: date, dimension: kind, title: '', count: users, uniques: users });
  }
  clients.sort((a, b) => b.count - a.count);
  if (otherUsers > 0) clients.push({ snapshot_date: date, dimension: 'other', title: '', count: otherUsers, uniques: otherUsers });

  return { network, versions: foldSmall(versionCounts, date), countries: foldSmall(countryCounts, date), clients };
}

export function createTelemetryFetcher(fetchFn: typeof fetch, endpoint: string, token: string): TelemetryFetcher {
  return async (from, to) => {
    const url = `${endpoint.replace(/\/$/, '')}/v1/export?from=${from}&to=${to}`;
    const response = await fetchFn(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/x-ndjson' } });
    if (response.status !== 200) throw new Error(`telemetry export answered ${response.status}`);
    const { rows, skipped } = parseExportNdjson(await response.text());
    if (skipped > 0) console.warn(`telemetry export: skipped ${skipped} malformed row(s)`);
    return rows;
  };
}
```

- [ ] **Step 3: Run, expect pass; commit**

```bash
cd scripts/metrics && npx vitest run src/telemetry.test.ts && npx tsc --noEmit
git add scripts/metrics/src/types.ts scripts/metrics/src/telemetry.ts scripts/metrics/src/telemetry.test.ts
git commit -m "feat(metrics): telemetry export parsing and network snapshot aggregation"
```

### Task C2: The collect step, the CLI variables, the workflow, backfill

**Files:**
- Modify: `scripts/metrics/src/collect.ts` (`CollectOptions`, the write phase), `src/cli-collect.ts`, `src/backfill.ts`, `.github/workflows/metrics.yml:152-165`, `docs/systems/metrics.md`
- Test: `scripts/metrics/src/collect.telemetry.test.ts`

**Interfaces:**
- Consumes: C1.
- Produces: files `telemetry/network.csv`, `telemetry/versions.ndjson`, `telemetry/countries.ndjson`, `telemetry/clients.ndjson` on the data branch; `CollectOptions.telemetry?: TelemetryFetcher`; env `TELEMETRY_EXPORT_TOKEN` (optional) and `TELEMETRY_ENDPOINT` (default `https://hello.backspacechat.com`).

- [ ] **Step 1: Failing test**

Read `scripts/metrics/src/collect.test.ts` first and reuse its fake `GitHubClient` and in-memory `Store` helpers (import them if exported, otherwise copy the minimal versions into this file).

```ts
// scripts/metrics/src/collect.telemetry.test.ts
import { describe, it, expect } from 'vitest';
import { collect } from './collect.ts';
import type { PingRow } from './telemetry.ts';
// import { fakeClient, memoryStore } from './collect.test.ts' or copy the helpers from there

function ping(instance: string, day: string): PingRow {
  return { instance, day, country: 'DE', schema: 1, body: { build: { version: '1.1.2' }, users: { registered: 4, active1d: 1, active7d: 2, active30d: 3 } } };
}

describe('collect with telemetry', () => {
  it('writes the four telemetry files for yesterday and the day before', async () => {
    const store = memoryStore();
    const seen: Array<[string, string]> = [];
    const telemetry = async (from: string, to: string) => {
      seen.push([from, to]);
      return ['a', 'b', 'c'].flatMap((id) => [ping(id, '2026-09-04'), ping(id, '2026-09-05')]);
    };
    const result = await collect({ client: fakeClient(), store, slug: 'o/r', today: '2026-09-06', now: '2026-09-06T15:19:00Z', telemetry });
    expect(seen).toEqual([['2026-08-06', '2026-09-05']]);
    expect(result.written).toEqual(expect.arrayContaining(['telemetry/network.csv', 'telemetry/versions.ndjson', 'telemetry/countries.ndjson', 'telemetry/clients.ndjson']));
    const network = store.readCsv('telemetry/network.csv');
    expect(network.map((r) => r.date)).toEqual(['2026-09-04', '2026-09-05']);
    expect(network[1]).toMatchObject({ instances_7d: '3', users_registered: '12' });
    expect(store.readNdjson('telemetry/versions.ndjson')).toEqual([
      { snapshot_date: '2026-09-04', dimension: '1.1.2', title: '', count: 3, uniques: 3 },
      { snapshot_date: '2026-09-05', dimension: '1.1.2', title: '', count: 3, uniques: 3 },
    ]);
    expect(store.readMeta()?.series_last_date['telemetry/network.csv']).toBe('2026-09-05');
  });
  it('skips telemetry when no fetcher is given and records a skip when the fetch fails', async () => {
    const store = memoryStore();
    let result = await collect({ client: fakeClient(), store, slug: 'o/r', today: '2026-09-06', now: '2026-09-06T15:19:00Z' });
    expect(result.written).not.toContain('telemetry/network.csv');
    result = await collect({ client: fakeClient(), store, slug: 'o/r', today: '2026-09-06', now: '2026-09-06T15:19:00Z', telemetry: async () => { throw new Error('401'); } });
    expect(result.skipped.some((s) => s.includes('telemetry'))).toBe(true);
    expect(result.written).not.toContain('telemetry/network.csv');
  });
});
```

Run: `cd scripts/metrics && npx vitest run src/collect.telemetry.test.ts` → FAIL (unknown option, files missing).

- [ ] **Step 2: Implement in `collect.ts`**

Add to `CollectOptions`:

```ts
  /**
   * Fetches raw telemetry rows for a day range from the receiver. Optional:
   * absent when TELEMETRY_EXPORT_TOKEN is unset, and a failure here is a
   * skipped series, never a failed run. The traffic archive must not depend on
   * a second service being up.
   */
  telemetry?: TelemetryFetcher;
```

In the fetch phase, after the workflow-runs fetch:

```ts
  const TELEMETRY_FETCH_DAYS = 31;
  let telemetryRows: PingRow[] | null = null;
  if (options.telemetry) {
    const to = daysBefore(today, 1);
    const from = daysBefore(today, TELEMETRY_FETCH_DAYS);
    try {
      telemetryRows = await options.telemetry(from, to);
    } catch (error) {
      skipped.push(`telemetry (${(error as Error).message})`);
    }
  }
```

In the write phase, after the dimensional writes:

```ts
  if (telemetryRows !== null) {
    const days = [daysBefore(today, 2), daysBefore(today, 1)];
    const aggregates = days.map((day) => aggregateTelemetry(telemetryRows, day));
    writeCsvSeries('telemetry/network.csv', NETWORK_HEADER, aggregates.map((a) => a.network));
    writeDimensional('telemetry/versions.ndjson', aggregates.flatMap((a) => a.versions));
    writeDimensional('telemetry/countries.ndjson', aggregates.flatMap((a) => a.countries));
    writeDimensional('telemetry/clients.ndjson', aggregates.flatMap((a) => a.clients));
  }
```

with, at module level:

```ts
import { aggregateTelemetry, type PingRow, type TelemetryFetcher } from './telemetry.ts';
export const NETWORK_HEADER = ['date', 'instances_1d', 'instances_7d', 'instances_30d', 'users_registered', 'users_active1d', 'users_active7d', 'users_active30d', 'messages7d', 'storage_mib', 'voice_instances', 'federation_instances'] as const;
```

`daysBefore` already exists in `collect.ts` (used for the workflow window); reuse it.

- [ ] **Step 3: The CLI and the workflow**

In `cli-collect.ts`, after `actionsToken`:

```ts
  // Optional like the actions token: without it the telemetry series are
  // skipped, and the traffic collection is unaffected.
  const telemetryToken = process.env['TELEMETRY_EXPORT_TOKEN'] ?? '';
  if (telemetryToken !== '') assertHeaderSafeToken(telemetryToken);
  const telemetryEndpoint = process.env['TELEMETRY_ENDPOINT'] ?? 'https://hello.backspacechat.com';
```

and pass `telemetry: telemetryToken === '' ? undefined : createTelemetryFetcher(globalThis.fetch, telemetryEndpoint, telemetryToken)` into `collect(...)`. Import `createTelemetryFetcher` from `./telemetry.ts`.

In `.github/workflows/metrics.yml`, in the Collect step's `env`:

```yaml
          # Optional. Unset until the receiver is live; the step logs a skip.
          TELEMETRY_EXPORT_TOKEN: ${{ secrets.TELEMETRY_EXPORT_TOKEN }}
```

- [ ] **Step 4: Backfill**

In `backfill.ts`, add `telemetry?: TelemetryFetcher` to `BackfillOptions`, add the four telemetry files to the allowlist of writable files, and, when the fetcher is present, fetch `[today-89, today-1]` in three calls of at most 31 days, aggregate every day in `[today-88, today-1]`, and write `network.csv` with `upsertByDate(existing, incoming, 'if-absent')` and the three dimensional files with `upsertDimensional`. Wire `TELEMETRY_EXPORT_TOKEN` and `TELEMETRY_ENDPOINT` into `cli-backfill.ts` the same way as in the collector, and add the secret to `backfill.yml`'s env. Add a test in `backfill.test.ts` that an existing `network.csv` row is not overwritten and a missing day is added.

- [ ] **Step 5: Run everything and document**

Run: `cd scripts/metrics && pnpm test`. Update `docs/systems/metrics.md`: the four files and their schemas in the archive section (§2 layout, the CSV/NDJSON schema section), the snapshot definition, the two-days rule, the folding rule, the fetch window, the optional secret, and backfill's telemetry window.

- [ ] **Step 6: Commit**

```bash
git add scripts/metrics/src .github/workflows/metrics.yml .github/workflows/backfill.yml docs/systems/metrics.md
git commit -m "feat(metrics): collect telemetry aggregates into the archive"
```

### Task C3: Bundle block and data tables

**Files:**
- Modify: `scripts/metrics/src/bundle.ts` (types, `buildDashboardData`, `downsampleWeekly`), `src/datapage.ts`, `docs/systems/metrics.md` §10.2 and §10.3
- Test: `scripts/metrics/src/bundle.telemetry.test.ts`, extend `datapage.test.ts`

**Interfaces:**
- Produces on `DashboardData`:
```ts
export interface TelemetryNetworkSeries {
  dates: string[];
  instances_1d: Array<number | null>; instances_7d: Array<number | null>; instances_30d: Array<number | null>;
  users_registered: Array<number | null>; users_active1d: Array<number | null>; users_active7d: Array<number | null>; users_active30d: Array<number | null>;
  messages7d: Array<number | null>; storage_mib: Array<number | null>; voice_instances: Array<number | null>; federation_instances: Array<number | null>;
}
export interface TelemetryBlock {
  network: TelemetryNetworkSeries;
  versions: DimensionSeries; countries: DimensionSeries; clients: DimensionSeries;
  /** The latest day's instances_7d, so the page applies the publication threshold without arithmetic. */
  instances7d: number | null;
}
// DashboardData gains: telemetry: TelemetryBlock;
```

- [ ] **Step 1: Failing tests**

```ts
// scripts/metrics/src/bundle.telemetry.test.ts
import { describe, it, expect } from 'vitest';
import { buildDashboardData, downsampleWeekly } from './bundle.ts';
// reuse the in-memory store helper from bundle.test.ts

describe('telemetry block', () => {
  it('is empty when the archive has no telemetry files', () => {
    const data = buildDashboardData(memoryStore(), '2026-09-06T00:00:00Z');
    expect(data.telemetry.network.dates).toEqual([]);
    expect(data.telemetry.instances7d).toBeNull();
    expect(data.telemetry.versions.latest).toEqual([]);
  });
  it('reads the network series and the latest instances_7d', () => {
    const store = memoryStore();
    store.writeCsv('telemetry/network.csv', ['date', 'instances_1d', 'instances_7d', 'instances_30d', 'users_registered', 'users_active1d', 'users_active7d', 'users_active30d', 'messages7d', 'storage_mib', 'voice_instances', 'federation_instances'], [
      { date: '2026-09-04', instances_1d: 2, instances_7d: 3, instances_30d: 3, users_registered: 12, users_active1d: 1, users_active7d: 4, users_active30d: 6, messages7d: 40, storage_mib: 9, voice_instances: 1, federation_instances: 0 },
      { date: '2026-09-05', instances_1d: 3, instances_7d: 11, instances_30d: 12, users_registered: 50, users_active1d: 3, users_active7d: 9, users_active30d: 20, messages7d: 90, storage_mib: 30, voice_instances: 4, federation_instances: 2 },
    ]);
    store.writeNdjson('telemetry/versions.ndjson', [{ snapshot_date: '2026-09-05', dimension: '1.1.2', title: '', count: 11, uniques: 11 }]);
    const data = buildDashboardData(store, '2026-09-06T00:00:00Z');
    expect(data.telemetry.network.dates).toEqual(['2026-09-04', '2026-09-05']);
    expect(data.telemetry.network.instances_7d).toEqual([3, 11]);
    expect(data.telemetry.instances7d).toBe(11);
    expect(data.telemetry.versions.latest[0]).toMatchObject({ dimension: '1.1.2', count: 11 });
  });
  it('downsamples the network series by keeping the last value of each week', () => {
    const store = memoryStore();
    const rows = Array.from({ length: 21 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10),
      instances_1d: i, instances_7d: i, instances_30d: i, users_registered: i, users_active1d: i, users_active7d: i, users_active30d: i, messages7d: i, storage_mib: i, voice_instances: i, federation_instances: i,
    }));
    store.writeCsv('telemetry/network.csv', ['date', 'instances_1d', 'instances_7d', 'instances_30d', 'users_registered', 'users_active1d', 'users_active7d', 'users_active30d', 'messages7d', 'storage_mib', 'voice_instances', 'federation_instances'], rows);
    const weekly = downsampleWeekly(buildDashboardData(store, '2026-09-22T00:00:00Z'));
    expect(weekly.downsampled).toBe(true);
    expect(weekly.telemetry.network.dates.length).toBeLessThan(21);
    expect(weekly.telemetry.network.instances_7d.at(-1)).toBe(20);
    expect(weekly.telemetry.instances7d).toBe(20);
  });
});
```

Run: `cd scripts/metrics && npx vitest run src/bundle.telemetry.test.ts` → FAIL.

- [ ] **Step 2: Implement in `bundle.ts`**

Add the constants `TELEMETRY_NETWORK_FILE = 'telemetry/network.csv'`, `TELEMETRY_VERSIONS_FILE`, `TELEMETRY_COUNTRIES_FILE`, `TELEMETRY_CLIENTS_FILE`; the two interfaces above; `telemetry: TelemetryBlock` on `DashboardData`.

```ts
const NETWORK_COLUMNS = ['instances_1d', 'instances_7d', 'instances_30d', 'users_registered', 'users_active1d', 'users_active7d', 'users_active30d', 'messages7d', 'storage_mib', 'voice_instances', 'federation_instances'] as const;

function readTelemetryNetwork(store: Store): TelemetryNetworkSeries {
  const rows = readDatedRows(store, TELEMETRY_NETWORK_FILE);
  const series = { dates: rows.map((row) => row.date) } as TelemetryNetworkSeries;
  for (const column of NETWORK_COLUMNS) {
    series[column] = rows.map((row) => toNumberOrNull(row.fields[column], `${TELEMETRY_NETWORK_FILE} ${column}`, row.date));
  }
  return series;
}

function readTelemetryBlock(store: Store): TelemetryBlock {
  const network = readTelemetryNetwork(store);
  const last = network.instances_7d.at(-1);
  return {
    network,
    versions: readDimensionSeries(store, TELEMETRY_VERSIONS_FILE),
    countries: readDimensionSeries(store, TELEMETRY_COUNTRIES_FILE),
    clients: readDimensionSeries(store, TELEMETRY_CLIENTS_FILE),
    instances7d: last === undefined ? null : last,
  };
}
```

`readDatedRows` throws on a missing file only if `store.readCsv` does; check `store.ts`: if a missing file already reads as no rows (it does for the other optional series such as `workflows.csv`), nothing more is needed. In `buildDashboardData`, add `telemetry: readTelemetryBlock(store)` to the returned object. In `downsampleWeekly`, add `telemetry: downsampleTelemetry(data.telemetry)`, where `downsampleTelemetry` keeps the dimension series as they are, and downsamples `network` the way `downsampleCount` does for gauges (the last value in each weekly bucket for every column, `dates` reduced to the bucket end dates); recompute `instances7d` from the downsampled series' last value so the two never disagree.

- [ ] **Step 3: Data tables**

In `datapage.ts`, after the "Popular paths" section, add a "Usage pings" section rendered only when `data.telemetry.network.dates.length > 0`: a paragraph explaining opt-in, lower bound, rounding and folding, a `seriesTable` of the network columns (labels: instances reporting today, within 7 days, within 30 days, registered users, active today, active 7 days, active 30 days, messages last 7 days, storage MiB, instances with voice, instances federating), and three `dimensionTable`s for versions, countries and client kinds. Extend `datapage.test.ts` with one test that the section appears with data and one that it does not without.

- [ ] **Step 4: Run, document, commit**

Run `cd scripts/metrics && pnpm test`. In `docs/systems/metrics.md` §10.2 add the `telemetry` block to the contract and in §10.3 the bucketing rule (gauges, last value per week; dimension series untouched).

```bash
git add scripts/metrics/src docs/systems/metrics.md
git commit -m "feat(metrics): carry telemetry aggregates into the dashboard bundle and data tables"
```

---

## Track D: web

Runs in parallel with A, B, C. D1 and D2 are plain TDD tasks. D3 is a design brief: iterative, judged on rendered frames. D4 and D5 depend on D1 to D3.

### Task D1: Client kind on connect, API client, settings store slice

**Files:**
- Create: `packages/web/src/platform/clientKind.ts`
- Modify: `packages/web/src/hooks/useWebSocket.ts:1380`, `packages/web/src/api/client.ts:358-370` and `:858-870`, `packages/web/src/stores/settingsStore.ts`
- Test: `packages/web/src/platform/clientKind.test.ts`, `packages/web/src/stores/settingsStore.telemetry.test.ts`

**Interfaces:**
- Produces:
  - `detectClientKind(): ClientKind` (`desktop` when `isElectron()`, `mobile` when `window.innerWidth < 768`, else `web`)
  - `api.admin.telemetry: { get(): Promise<TelemetryStatus>; set(enabled: boolean): Promise<TelemetryStatus>; preview(): Promise<TelemetryPayload> }`
  - settings store: `telemetry: TelemetryStatus | null`, `telemetryPreview: TelemetryPayload | null`, `fetchTelemetry(): Promise<void>`, `fetchTelemetryPreview(): Promise<void>`, `setTelemetryEnabled(enabled: boolean): Promise<void>`

- [ ] **Step 1: Failing tests**

```ts
// packages/web/src/platform/clientKind.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectClientKind } from './clientKind';

afterEach(() => { vi.unstubAllGlobals(); delete (window as { backspace?: unknown }).backspace; });

describe('detectClientKind', () => {
  it('reports desktop under the Electron bridge', () => {
    (window as { backspace?: unknown }).backspace = { platform: 'darwin' };
    expect(detectClientKind()).toBe('desktop');
  });
  it('reports mobile on a small viewport and web otherwise', () => {
    vi.stubGlobal('innerWidth', 500);
    expect(detectClientKind()).toBe('mobile');
    vi.stubGlobal('innerWidth', 1200);
    expect(detectClientKind()).toBe('web');
  });
});
```

```ts
// packages/web/src/stores/settingsStore.telemetry.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../api/client';
import { useSettingsStore } from './settingsStore';

const status = { enabled: null, id: null, lastDay: null, lastError: null };

beforeEach(() => {
  useSettingsStore.setState({ telemetry: null, telemetryPreview: null });
});

describe('settings store telemetry slice', () => {
  it('fetches the status', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(status);
    await useSettingsStore.getState().fetchTelemetry();
    expect(useSettingsStore.getState().telemetry).toEqual(status);
  });
  it('sets enabled and stores the answer', async () => {
    const set = vi.spyOn(api.admin.telemetry, 'set').mockResolvedValue({ ...status, enabled: true, id: 'abc', lastDay: '2026-09-06' });
    await useSettingsStore.getState().setTelemetryEnabled(true);
    expect(set).toHaveBeenCalledWith(true);
    expect(useSettingsStore.getState().telemetry?.enabled).toBe(true);
  });
  it('fetches the preview', async () => {
    vi.spyOn(api.admin.telemetry, 'preview').mockResolvedValue({ schema: 1, instance: 'preview' } as never);
    await useSettingsStore.getState().fetchTelemetryPreview();
    expect(useSettingsStore.getState().telemetryPreview?.instance).toBe('preview');
  });
});
```

Run: `cd packages/web && npx vitest run src/platform/clientKind.test.ts src/stores/settingsStore.telemetry.test.ts` → FAIL.

- [ ] **Step 2: Implement**

```ts
// packages/web/src/platform/clientKind.ts
import type { ClientKind } from '@backspace/shared';
import { isElectron } from './platform';

/** Sent once per WebSocket auth so the server can count client kinds by day. Never stored client-side. */
export function detectClientKind(): ClientKind {
  if (isElectron()) return 'desktop';
  if (typeof window !== 'undefined' && window.innerWidth < 768) return 'mobile';
  return 'web';
}
```

In `useWebSocket.ts` line 1380: `ws.send(JSON.stringify({ type: 'auth', token: conn.token, client: detectClientKind() }));` with the import.

In `api/client.ts`, in the `admin` interface add:

```ts
    telemetry: {
      get: () => Promise<TelemetryStatus>;
      set: (enabled: boolean) => Promise<TelemetryStatus>;
      preview: () => Promise<TelemetryPayload>;
    };
```

and in the constructor's `admin` object:

```ts
      telemetry: {
        get: () => request<TelemetryStatus>('GET', '/admin/telemetry'),
        set: (enabled) => request<TelemetryStatus>('PUT', '/admin/telemetry', { enabled }),
        preview: () => request<TelemetryPayload>('GET', '/admin/telemetry/preview'),
      },
```

Check `request`'s body parameter position against the other `PUT`/`PATCH` calls in the file and match it. Import the two types from `@backspace/shared`.

In `settingsStore.ts`, add to `SettingsState` and the store:

```ts
  telemetry: TelemetryStatus | null;
  telemetryPreview: TelemetryPayload | null;
  fetchTelemetry: () => Promise<void>;
  fetchTelemetryPreview: () => Promise<void>;
  setTelemetryEnabled: (enabled: boolean) => Promise<void>;
```

```ts
  telemetry: null,
  telemetryPreview: null,
  fetchTelemetry: async () => {
    const telemetry = await api.admin.telemetry.get();
    set({ telemetry });
  },
  fetchTelemetryPreview: async () => {
    const telemetryPreview = await api.admin.telemetry.preview();
    set({ telemetryPreview });
  },
  setTelemetryEnabled: async (enabled) => {
    const telemetry = await api.admin.telemetry.set(enabled);
    set({ telemetry });
  },
```

Errors propagate to the caller, which shows them; the store does not swallow them (same as `updateInstanceSettings`).

- [ ] **Step 3: Run, expect pass; commit**

```bash
cd packages/web && npx vitest run src/platform src/stores && npx tsc --noEmit
git add packages/web/src/platform/clientKind.ts packages/web/src/platform/clientKind.test.ts packages/web/src/hooks/useWebSocket.ts packages/web/src/api/client.ts packages/web/src/stores/settingsStore.ts packages/web/src/stores/settingsStore.telemetry.test.ts
git commit -m "feat(web): send the client kind on connect and add the telemetry API slice"
```

### Task D2: Ask timing: snooze and dismissal limit

**Files:**
- Create: `packages/web/src/lib/telemetryAsk.ts`
- Test: `packages/web/src/lib/telemetryAsk.test.ts`

**Interfaces:**
- Produces:
```ts
export const ASK_STORAGE_KEY = 'backspace-telemetry-ask';
export const ASK_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
export const ASK_MAX_DISMISSALS = 2;
type Store = Pick<Storage, 'getItem' | 'setItem'>;
export function shouldShowAsk(status: TelemetryStatus | null, isAdmin: boolean, storage: Store, now: number): boolean
export function recordDismissal(storage: Store, now: number): void
```

- [ ] **Step 1: Failing test**

```ts
// packages/web/src/lib/telemetryAsk.test.ts
import { describe, it, expect } from 'vitest';
import { shouldShowAsk, recordDismissal, ASK_SNOOZE_MS, ASK_STORAGE_KEY } from './telemetryAsk';

function memory(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}
const unanswered = { enabled: null, id: null, lastDay: null, lastError: null };
const T0 = Date.UTC(2026, 8, 6);

describe('shouldShowAsk', () => {
  it('shows only to admins while the instance was never asked', () => {
    expect(shouldShowAsk(unanswered, true, memory(), T0)).toBe(true);
    expect(shouldShowAsk(unanswered, false, memory(), T0)).toBe(false);
    expect(shouldShowAsk({ ...unanswered, enabled: false }, true, memory(), T0)).toBe(false);
    expect(shouldShowAsk({ ...unanswered, enabled: true }, true, memory(), T0)).toBe(false);
    expect(shouldShowAsk(null, true, memory(), T0)).toBe(false);
  });
  it('snoozes seven days after a dismissal and stops after the second', () => {
    const s = memory();
    recordDismissal(s, T0);
    expect(shouldShowAsk(unanswered, true, s, T0 + ASK_SNOOZE_MS - 1)).toBe(false);
    expect(shouldShowAsk(unanswered, true, s, T0 + ASK_SNOOZE_MS)).toBe(true);
    recordDismissal(s, T0 + ASK_SNOOZE_MS);
    expect(shouldShowAsk(unanswered, true, s, T0 + 10 * ASK_SNOOZE_MS)).toBe(false);
  });
  it('treats a corrupt record as no record', () => {
    const s = memory();
    s.setItem(ASK_STORAGE_KEY, '{nope');
    expect(shouldShowAsk(unanswered, true, s, T0)).toBe(true);
  });
});
```

Run: `cd packages/web && npx vitest run src/lib/telemetryAsk.test.ts` → FAIL.

- [ ] **Step 2: Implement**

```ts
// packages/web/src/lib/telemetryAsk.ts
import type { TelemetryStatus } from '@backspace/shared';

export const ASK_STORAGE_KEY = 'backspace-telemetry-ask';
export const ASK_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
export const ASK_MAX_DISMISSALS = 2;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
interface AskRecord { dismissals: number; snoozedUntil: number }

function read(storage: Store): AskRecord {
  try {
    const raw = storage.getItem(ASK_STORAGE_KEY);
    if (raw === null) return { dismissals: 0, snoozedUntil: 0 };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null
      && typeof (parsed as AskRecord).dismissals === 'number'
      && typeof (parsed as AskRecord).snoozedUntil === 'number') {
      return parsed as AskRecord;
    }
  } catch { /* storage unavailable or corrupt: behave as never dismissed */ }
  return { dismissals: 0, snoozedUntil: 0 };
}

/**
 * The ask is shown to admins of the home instance while the instance-wide
 * setting is still "never asked", subject to a per-browser snooze: a
 * dismissal hides it for seven days, and the second dismissal hides it for
 * good in that browser. Answers are stored server-side and end the ask for
 * every admin; dismissals are local and never leave the browser.
 */
export function shouldShowAsk(status: TelemetryStatus | null, isAdmin: boolean, storage: Store, now: number): boolean {
  if (!isAdmin || status === null || status.enabled !== null) return false;
  const record = read(storage);
  if (record.dismissals >= ASK_MAX_DISMISSALS) return false;
  return now >= record.snoozedUntil;
}

export function recordDismissal(storage: Store, now: number): void {
  const record = read(storage);
  const next: AskRecord = { dismissals: record.dismissals + 1, snoozedUntil: now + ASK_SNOOZE_MS };
  try { storage.setItem(ASK_STORAGE_KEY, JSON.stringify(next)); } catch { /* private mode: the ask returns next session, which is acceptable */ }
}
```

- [ ] **Step 3: Run, expect pass; commit**

```bash
cd packages/web && npx vitest run src/lib/telemetryAsk.test.ts
git add packages/web/src/lib/telemetryAsk.ts packages/web/src/lib/telemetryAsk.test.ts
git commit -m "feat(web): snooze rules for the telemetry ask"
```

### Task D3: The scene (design brief, iterative)

This task is not written as code on purpose. It is a loop of build, render, look, critique, revise, and the plan owns the constraints and the definition of done, not the drawing. A subagent with the frontend-design skill executes it; the main session reviews the contact sheets.

**Files:**
- Create: `packages/web/src/components/telemetry/scene/Void.tsx`, `Ship.tsx`, `Pilot.tsx`, `Beam.tsx`, `HelloScene.tsx`, `palette.ts`, `useSceneAnimation.ts`
- Create: `packages/web/src/dev/scene-preview.tsx` (harness entry, exports `mount(root: HTMLElement, mood: string): void`)
- Create: `packages/web/src/components/telemetry/scene/HelloScene.test.tsx` (smoke: renders each mood without throwing, is `aria-hidden`, respects reduced motion by starting no animations)
- Use: `packages/web/scripts/render-frames.mjs` (present; commit it in this task)

**Interfaces:**
- Produces:
```ts
export type SceneMood = 'idle' | 'happy' | 'farewell';
export interface HelloSceneProps { mood: SceneMood; className?: string }
export function HelloScene(props: HelloSceneProps): JSX.Element   // <svg viewBox="0 0 480 320" aria-hidden="true">
export const SCENE_PALETTE: { void: string; nebulaA: string; nebulaB: string; star: string; hull: string; hullShade: string; window: string; windowLit: string; pilot: string; beam: string }
```

**Constraints, all binding:**

- Inline SVG in React components. No raster, no Lottie, no new dependency, no external font.
- One coordinate system: `viewBox="0 0 480 320"`. Every layer is a `<g data-layer="void|nebula|stars|ship|window|pilot|beam">` so animations target layers by name, never by DOM position. Stable `data-part` names inside the ship and pilot for anything that moves (`arm`, `eyes`, `glow`).
- Colours only from `palette.ts`, which maps onto the Aether Drift tokens in `packages/web/src/styles/globals.css` and `docs/systems/design-system.md`: mint and lavender hull, a warm dark void (`#13131a` family), pastel nebula, warm white stars. No pure black, no pure white, no saturated primaries.
- Style: flat geometric shapes, at most three tones per object via radial gradients, no outlines or one consistent stroke width, soft glow via an SVG `feGaussianBlur` filter on the window and the beam, nebula via `feTurbulence` at low opacity behind a mask. The pilot is a silhouette with two eyes and one raised arm, no face detail. Calm over flashy.
- Motion in two tiers. CSS keyframes (in a `<style>` inside the SVG or a CSS module) for the infinite ambient loops: star twinkle at three different periods, slow parallax drift of two star layers, the ship's bob (about 6 px, 4 s), the arm wave (idle only, 1.2 s, eased). Web Animations API (`element.animate`, the pattern in `hooks/useMascotAnimation.ts`) for the choreography of `happy` and `farewell`, driven by a `useSceneAnimation(svgRef, mood)` hook. Only `transform` and `opacity` animate. `prefers-reduced-motion: reduce` disables every loop and turns each mood into a single still frame reached by a 200 ms opacity cross-fade.
- Choreography, `happy` (from the moment `mood` becomes `happy`): 0 ms window brightens (300 ms); 200 ms beam scales out from the window along its length (900 ms, ease-out) and holds at 60 % opacity; 600 ms six chosen stars pulse once (400 ms); the arm holds up, no wave. `farewell`: 0 ms the arm gives one slow wave (1.5 s) and settles down; the window stays lit; the ship keeps bobbing; nothing dims, nothing cries. `idle`: loops only.
- Budget: the five components together under 24 KB of source, the rendered SVG under 200 nodes.
- Accessibility: root `<svg aria-hidden="true" focusable="false">`. The scene carries no text.

**Render loop (mandatory, every iteration):**

```bash
cd packages/web
node scripts/render-frames.mjs --entry ./src/dev/scene-preview.tsx --out /tmp/scene-round-N \
  --width 480 --height 320 --scale 1 --times 0,400,1200,2500 --moods idle,happy,farewell
```

Open `/tmp/scene-round-N/contact-sheet.png` (the Read tool renders images) and write a three-line critique before touching code again: what reads correctly at a glance, what does not, what changes next. Repeat at least three rounds. Also render once at `--width 360 --height 240` to check the mobile size, and once with the `happy` frames at `--times 0,300,900,1500` to check the beam timing.

**Definition of done (checklist, verified on frames):**

- [ ] A stranger names the subject as "a small spaceship with someone waving inside" from the 480-wide idle frame at 0 ms.
- [ ] The beam is visible against the nebula in the `happy` 1200 ms frame; the window is visibly brighter than in idle.
- [ ] `farewell` 1200 ms differs from idle only in the arm position; nothing is dimmer.
- [ ] The three still frames used for reduced motion each look finished on their own.
- [ ] At 360 wide the ship still reads; stars are not noise.
- [ ] Palette check: every colour resolves to a `SCENE_PALETTE` entry.
- [ ] Source budget and node count met; `npx tsc --noEmit` clean; smoke tests pass; contact sheets of the final round attached to the PR description.

- [ ] **Commit** after the last round:

```bash
git add packages/web/src/components/telemetry/scene packages/web/src/dev/scene-preview.tsx packages/web/scripts/render-frames.mjs
git commit -m "feat(web): the hello scene for the telemetry ask"
```

### Task D4: The modal, the copy, the mount

**Files:**
- Create: `packages/web/src/components/telemetry/HelloModal.tsx`, `TelemetryAsk.tsx`, `PayloadPreview.tsx`
- Create: `packages/web/src/locales/en/telemetry.json`, `de/telemetry.json`, `ru/telemetry.json`
- Modify: `packages/web/src/i18n/resources.ts` (import and register `telemetry`), `packages/web/src/App.tsx:58` (mount `<TelemetryAsk />` after `<SwAutoUpdate />`)
- Test: `packages/web/src/components/telemetry/HelloModal.test.tsx`, `TelemetryAsk.test.tsx`

**Interfaces:**
- Consumes: D1 store slice, D2 `shouldShowAsk`/`recordDismissal`, D3 `HelloScene`.
- Produces: `HelloModal({ open, onAnswer(enabled: boolean): Promise<void>, onDismiss(): void, preview: TelemetryPayload | null })`, `TelemetryAsk()` (self-contained: decides visibility, fetches status and preview, saves, then animates).

- [ ] **Step 1: The catalogs**

`packages/web/src/locales/en/telemetry.json`:

```json
{
  "ask": {
    "title": "Hi. It's Jannis. I built this.",
    "p1": "Backspace tracks nobody, and that includes me. No numbers, no dashboards, nothing. I can see the download counter, and then it goes quiet. Building this feels like shouting into space and never hearing anything back.",
    "p2": "So this is me asking. Once a day, would your instance send me a tiny hello? Not who you are, not what anyone said. Just rounded counts: how many people are here, which version runs, whether voice and federation are on, and which country the hello came from. No names, no messages, no address of any kind.",
    "previewLead": "Here is exactly what it would say today:",
    "previewToggleShow": "Show the message",
    "previewToggleHide": "Hide the message",
    "previewLoading": "Putting the message together",
    "p3": "Everything that comes back is published as open data on the project's insights page, and charts appear once at least ten instances say hi. It stays off until you say yes, and you can turn it off again whenever you like.",
    "yes": "Say hi",
    "no": "No thanks",
    "later": "Decide later",
    "footnote": "The receiver runs on Cloudflare, which sees the request like any web host and derives the country from it. Nothing else about you is stored. You can change this any time under Instance settings.",
    "saving": "Saving your choice",
    "error": "Your choice could not be saved. Nothing was sent. Please try again."
  },
  "yes": {
    "title": "Signal acquired.",
    "body": "The first hello goes out tomorrow at a random minute, and every day after. Thank you. It is a lot less quiet out here now.",
    "close": "Close"
  },
  "no": {
    "title": "Understood.",
    "body": "Nothing will be sent. I'll drift on, and if you ever change your mind, I'm one toggle away in Instance settings.",
    "close": "Close"
  },
  "panel": {
    "title": "Say hi to Jannis",
    "intro": "An optional daily usage report to the maintainer: rounded counts and the version, nothing about people. Off until you switch it on.",
    "toggle": "Send a daily hello",
    "status": {
      "never": "Never asked",
      "off": "Off",
      "on": "On",
      "lastDay": "Last hello sent on {{date}}",
      "none": "No hello sent yet",
      "error": "The last attempt on {{date}} failed with status {{status}}. It will try again tomorrow.",
      "id": "Instance id (random, not your domain): {{id}}"
    },
    "previewTitle": "What would be sent today",
    "learnMore": "What is sent and why",
    "refreshPreview": "Refresh"
  }
}
```

`packages/web/src/locales/de/telemetry.json`:

```json
{
  "ask": {
    "title": "Hi, ich bin Jannis. Ich habe das hier gebaut.",
    "p1": "Backspace trackt niemanden, mich eingeschlossen. Keine Zahlen, keine Dashboards, nichts. Ich sehe den Download-Zähler, und danach wird es still. Das hier zu bauen fühlt sich an, als würde man ins All rufen und nie etwas zurückhören.",
    "p2": "Deshalb frage ich. Würde deine Instanz mir einmal am Tag ein kleines Hallo schicken? Nicht wer du bist, nicht was jemand geschrieben hat. Nur gerundete Zahlen: wie viele Leute hier sind, welche Version läuft, ob Sprache und Föderation an sind und aus welchem Land das Hallo kam. Keine Namen, keine Nachrichten, keine Adresse irgendeiner Art.",
    "previewLead": "Das würde heute genau gesendet werden:",
    "previewToggleShow": "Nachricht anzeigen",
    "previewToggleHide": "Nachricht ausblenden",
    "previewLoading": "Nachricht wird zusammengestellt",
    "p3": "Alles, was zurückkommt, wird als offene Daten auf der Insights-Seite des Projekts veröffentlicht. Diagramme erscheinen, sobald mindestens zehn Instanzen Hallo sagen. Es bleibt aus, bis du Ja sagst, und du kannst es jederzeit wieder ausschalten.",
    "yes": "Hallo sagen",
    "no": "Nein danke",
    "later": "Später entscheiden",
    "footnote": "Der Empfänger läuft bei Cloudflare, das die Anfrage wie jeder Webhost sieht und daraus das Land ableitet. Sonst wird nichts über dich gespeichert. Du kannst das jederzeit in den Instanz-Einstellungen ändern.",
    "saving": "Deine Wahl wird gespeichert",
    "error": "Deine Wahl konnte nicht gespeichert werden. Es wurde nichts gesendet. Bitte versuch es noch einmal."
  },
  "yes": {
    "title": "Signal empfangen.",
    "body": "Das erste Hallo geht morgen zu einer zufälligen Minute raus, und danach jeden Tag. Danke. Es ist gerade deutlich weniger still hier draußen.",
    "close": "Schließen"
  },
  "no": {
    "title": "Verstanden.",
    "body": "Es wird nichts gesendet. Ich treibe weiter, und falls du es dir anders überlegst, bin ich in den Instanz-Einstellungen nur einen Schalter entfernt.",
    "close": "Schließen"
  },
  "panel": {
    "title": "Jannis Hallo sagen",
    "intro": "Ein optionaler täglicher Nutzungsbericht an den Maintainer: gerundete Zahlen und die Version, nichts über Personen. Aus, bis du es einschaltest.",
    "toggle": "Täglich ein Hallo senden",
    "status": {
      "never": "Noch nie gefragt",
      "off": "Aus",
      "on": "An",
      "lastDay": "Letztes Hallo gesendet am {{date}}",
      "none": "Noch kein Hallo gesendet",
      "error": "Der letzte Versuch am {{date}} schlug mit Status {{status}} fehl. Morgen wird es erneut versucht.",
      "id": "Instanz-ID (zufällig, nicht deine Domain): {{id}}"
    },
    "previewTitle": "Was heute gesendet würde",
    "learnMore": "Was gesendet wird und warum",
    "refreshPreview": "Aktualisieren"
  }
}
```

`packages/web/src/locales/ru/telemetry.json`:

```json
{
  "ask": {
    "title": "Привет. Это Яннис. Я это создал.",
    "p1": "Backspace никого не отслеживает, и меня в том числе. Ни цифр, ни дашбордов, ничего. Я вижу счётчик загрузок, а дальше тишина. Разрабатывать это всё равно что кричать в космос и никогда не слышать ответа.",
    "p2": "Поэтому я прошу. Может ли ваш сервер раз в день отправлять мне маленькое «привет»? Не кто вы, не что кто-то написал. Только округлённые числа: сколько здесь людей, какая версия запущена, включены ли голос и федерация и из какой страны пришло это «привет». Ни имён, ни сообщений, никаких адресов.",
    "previewLead": "Вот что именно было бы отправлено сегодня:",
    "previewToggleShow": "Показать сообщение",
    "previewToggleHide": "Скрыть сообщение",
    "previewLoading": "Собираем сообщение",
    "p3": "Всё, что приходит, публикуется как открытые данные на странице Insights проекта, а графики появятся, когда «привет» скажут хотя бы десять серверов. Это выключено, пока вы не скажете «да», и вы можете выключить это снова в любой момент.",
    "yes": "Сказать привет",
    "no": "Нет, спасибо",
    "later": "Решить позже",
    "footnote": "Приёмник работает на Cloudflare, который видит запрос, как любой веб-хост, и определяет по нему страну. Больше о вас ничего не хранится. Изменить это можно в любой момент в настройках сервера.",
    "saving": "Сохраняем ваш выбор",
    "error": "Не удалось сохранить ваш выбор. Ничего не отправлено. Попробуйте ещё раз."
  },
  "yes": {
    "title": "Сигнал принят.",
    "body": "Первое «привет» уйдёт завтра в случайную минуту, и потом каждый день. Спасибо. Здесь стало гораздо менее тихо.",
    "close": "Закрыть"
  },
  "no": {
    "title": "Понял.",
    "body": "Ничего отправлено не будет. Я полечу дальше, а если передумаете, я в одном переключателе от вас, в настройках сервера.",
    "close": "Закрыть"
  },
  "panel": {
    "title": "Сказать привет Яннису",
    "intro": "Необязательный ежедневный отчёт об использовании для мейнтейнера: округлённые числа и версия, ничего о людях. Выключено, пока вы не включите.",
    "toggle": "Отправлять ежедневное «привет»",
    "status": {
      "never": "Ещё не спрашивали",
      "off": "Выключено",
      "on": "Включено",
      "lastDay": "Последнее «привет» отправлено {{date}}",
      "none": "«Привет» ещё не отправлялось",
      "error": "Последняя попытка {{date}} завершилась со статусом {{status}}. Завтра будет новая попытка.",
      "id": "Идентификатор сервера (случайный, не ваш домен): {{id}}"
    },
    "previewTitle": "Что было бы отправлено сегодня",
    "learnMore": "Что отправляется и зачем",
    "refreshPreview": "Обновить"
  }
}
```

Register the namespace in `resources.ts` (import `telemetry from '../locales/en/telemetry.json'`, add `telemetry,` to `en`). Run `node scripts/check-i18n.mjs` from the repo root; it must pass with the three files present.

- [ ] **Step 2: Failing tests**

```tsx
// packages/web/src/components/telemetry/HelloModal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelloModal } from './HelloModal';

vi.mock('./scene/HelloScene', () => ({ HelloScene: ({ mood }: { mood: string }) => <div data-testid="scene" data-mood={mood} /> }));

const preview = { schema: 1, instance: 'preview', day: '2026-09-06' } as never;

describe('HelloModal', () => {
  it('shows the ask with two equal buttons and the preview', async () => {
    render(<HelloModal open onAnswer={vi.fn().mockResolvedValue(undefined)} onDismiss={vi.fn()} preview={preview} />);
    expect(screen.getByText("Hi. It's Jannis. I built this.")).toBeInTheDocument();
    const yes = screen.getByRole('button', { name: 'Say hi' });
    const no = screen.getByRole('button', { name: 'No thanks' });
    expect(yes.className).toBe(no.className.replace('btn-secondary', 'btn-primary'));
    await userEvent.click(screen.getByRole('button', { name: 'Show the message' }));
    expect(screen.getByText(/"instance": "preview"/)).toBeInTheDocument();
    expect(screen.getByTestId('scene')).toHaveAttribute('data-mood', 'idle');
  });
  it('saves before switching to the happy state', async () => {
    let resolve!: () => void;
    const onAnswer = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<HelloModal open onAnswer={onAnswer} onDismiss={vi.fn()} preview={preview} />);
    await userEvent.click(screen.getByRole('button', { name: 'Say hi' }));
    expect(onAnswer).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('scene')).toHaveAttribute('data-mood', 'idle');
    resolve();
    expect(await screen.findByText('Signal acquired.')).toBeInTheDocument();
    expect(screen.getByTestId('scene')).toHaveAttribute('data-mood', 'happy');
  });
  it('shows the farewell after no, with a close button', async () => {
    render(<HelloModal open onAnswer={vi.fn().mockResolvedValue(undefined)} onDismiss={vi.fn()} preview={preview} />);
    await userEvent.click(screen.getByRole('button', { name: 'No thanks' }));
    expect(await screen.findByText('Understood.')).toBeInTheDocument();
    expect(screen.getByTestId('scene')).toHaveAttribute('data-mood', 'farewell');
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
  });
  it('shows an error and stays on the ask when saving fails', async () => {
    render(<HelloModal open onAnswer={vi.fn().mockRejectedValue(new Error('x'))} onDismiss={vi.fn()} preview={preview} />);
    await userEvent.click(screen.getByRole('button', { name: 'Say hi' }));
    expect(await screen.findByText(/could not be saved/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Say hi' })).toBeEnabled();
  });
  it('calls onDismiss for the later link and for Escape', async () => {
    const onDismiss = vi.fn();
    render(<HelloModal open onAnswer={vi.fn()} onDismiss={onDismiss} preview={preview} />);
    await userEvent.click(screen.getByRole('button', { name: 'Decide later' }));
    await userEvent.keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
```

```tsx
// packages/web/src/components/telemetry/TelemetryAsk.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TelemetryAsk } from './TelemetryAsk';
import { useSettingsStore } from '../../stores/settingsStore';
import { api } from '../../api/client';
import { ASK_STORAGE_KEY } from '../../lib/telemetryAsk';

vi.mock('./scene/HelloScene', () => ({ HelloScene: () => <div data-testid="scene" /> }));
const never = { enabled: null, id: null, lastDay: null, lastError: null };

beforeEach(() => {
  localStorage.removeItem(ASK_STORAGE_KEY);
  useSettingsStore.setState({ isAdmin: true, telemetry: null, telemetryPreview: null });
  vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(never);
  vi.spyOn(api.admin.telemetry, 'preview').mockResolvedValue({ schema: 1, instance: 'preview' } as never);
});

describe('TelemetryAsk', () => {
  it('asks an admin of a never-asked instance', async () => {
    render(<TelemetryAsk />);
    expect(await screen.findByText("Hi. It's Jannis. I built this.")).toBeInTheDocument();
  });
  it('never asks a non-admin and never fetches for them', async () => {
    useSettingsStore.setState({ isAdmin: false });
    render(<TelemetryAsk />);
    await waitFor(() => expect(api.admin.telemetry.get).not.toHaveBeenCalled());
    expect(screen.queryByText(/Jannis/)).not.toBeInTheDocument();
  });
  it('does not ask once answered', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue({ ...never, enabled: false });
    render(<TelemetryAsk />);
    await waitFor(() => expect(api.admin.telemetry.get).toHaveBeenCalled());
    expect(screen.queryByText(/Jannis/)).not.toBeInTheDocument();
  });
  it('does not ask while snoozed', async () => {
    localStorage.setItem(ASK_STORAGE_KEY, JSON.stringify({ dismissals: 1, snoozedUntil: Date.now() + 1_000_000 }));
    render(<TelemetryAsk />);
    await waitFor(() => expect(api.admin.telemetry.get).toHaveBeenCalled());
    expect(screen.queryByText(/Jannis/)).not.toBeInTheDocument();
  });
});
```

Run: `cd packages/web && npx vitest run src/components/telemetry` → FAIL.

- [ ] **Step 3: Implement**

`PayloadPreview.tsx`: a collapsible `<pre>` with the pretty-printed JSON, a toggle button labelled with `ask.previewToggleShow`/`Hide`, and `ask.previewLoading` while `preview` is null. Styling: `bg-surface-input rounded-lg font-mono text-xs p-3 overflow-x-auto max-h-64`.

`HelloModal.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { HelloScene, type SceneMood } from './scene/HelloScene';
import { PayloadPreview } from './PayloadPreview';
import type { TelemetryPayload } from '@backspace/shared';

interface HelloModalProps {
  open: boolean;
  onAnswer: (enabled: boolean) => Promise<void>;
  onDismiss: () => void;
  preview: TelemetryPayload | null;
}

type Stage = 'ask' | 'saving' | 'yes' | 'no';

const BUTTON_BASE = 'flex-1 rounded-xl px-4 py-3 text-sm font-medium transition-colors';

export function HelloModal({ open, onAnswer, onDismiss, preview }: HelloModalProps) {
  const { t } = useTranslation('telemetry');
  const [stage, setStage] = useState<Stage>('ask');
  const [error, setError] = useState(false);

  useEffect(() => { if (open) { setStage('ask'); setError(false); } }, [open]);

  const mood: SceneMood = stage === 'yes' ? 'happy' : stage === 'no' ? 'farewell' : 'idle';

  const answer = async (enabled: boolean) => {
    setStage('saving');
    setError(false);
    try {
      await onAnswer(enabled);            // saved first, animated second
      setStage(enabled ? 'yes' : 'no');
    } catch {
      setError(true);
      setStage('ask');
    }
  };

  const close = () => { if (stage === 'yes' || stage === 'no') onDismissAnswered(); else onDismiss(); };
  // After an answer the modal closes without recording a dismissal: the server state ends the ask.
  const onDismissAnswered = () => onDismiss();

  return (
    <Modal isOpen={open} onClose={close} maxWidth="max-w-3xl" mobileStyle="fullscreen">
      <div className="flex flex-col md:flex-row gap-6">
        <div className="md:w-1/2 rounded-2xl overflow-hidden bg-surface-base">
          <HelloScene mood={mood} className="w-full h-auto" />
        </div>
        <div className="md:w-1/2 space-y-4 text-sm text-txt-secondary">
          {stage === 'yes' && (
            <>
              <h2 className="text-lg font-semibold text-txt-primary">{t('yes.title')}</h2>
              <p>{t('yes.body')}</p>
              <button type="button" className={`${BUTTON_BASE} btn-primary w-full`} onClick={close}>{t('yes.close')}</button>
            </>
          )}
          {stage === 'no' && (
            <>
              <h2 className="text-lg font-semibold text-txt-primary">{t('no.title')}</h2>
              <p>{t('no.body')}</p>
              <button type="button" className={`${BUTTON_BASE} btn-primary w-full`} onClick={close}>{t('no.close')}</button>
            </>
          )}
          {(stage === 'ask' || stage === 'saving') && (
            <>
              <h2 className="text-lg font-semibold text-txt-primary">{t('ask.title')}</h2>
              <p>{t('ask.p1')}</p>
              <p>{t('ask.p2')}</p>
              <p className="text-txt-primary">{t('ask.previewLead')}</p>
              <PayloadPreview preview={preview} />
              <p>{t('ask.p3')}</p>
              {error && <p role="alert" className="text-accent-rose">{t('ask.error')}</p>}
              <div className="flex gap-3">
                <button type="button" disabled={stage === 'saving'} className={`${BUTTON_BASE} btn-primary`} onClick={() => void answer(true)}>{t('ask.yes')}</button>
                <button type="button" disabled={stage === 'saving'} className={`${BUTTON_BASE} btn-secondary`} onClick={() => void answer(false)}>{t('ask.no')}</button>
              </div>
              <div className="flex items-center justify-between text-xs text-txt-tertiary">
                <span>{stage === 'saving' ? t('ask.saving') : ''}</span>
                <button type="button" className="underline" onClick={onDismiss}>{t('ask.later')}</button>
              </div>
              <p className="text-xs text-txt-tertiary">{t('ask.footnote')}</p>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
```

Use the button classes the rest of the app uses for primary and secondary actions (grep `btn-primary`, or the utility classes on the `ConfirmDialog` buttons) so both buttons share size and weight and differ only in colour; the test compares the class strings under that assumption. If the `Modal` component always renders a close button, pass no `title` and keep its close button; it acts as another dismissal path and calls `onClose`.

`TelemetryAsk.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { shouldShowAsk, recordDismissal } from '../../lib/telemetryAsk';
import { HelloModal } from './HelloModal';

/** Mounted once in App. Decides on its own whether the home-instance admin should be asked. */
export function TelemetryAsk() {
  const isAdmin = useSettingsStore((s) => s.isAdmin);
  const telemetry = useSettingsStore((s) => s.telemetry);
  const preview = useSettingsStore((s) => s.telemetryPreview);
  const fetchTelemetry = useSettingsStore((s) => s.fetchTelemetry);
  const fetchPreview = useSettingsStore((s) => s.fetchTelemetryPreview);
  const setEnabled = useSettingsStore((s) => s.setTelemetryEnabled);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    void fetchTelemetry().catch(() => undefined);
  }, [isAdmin, fetchTelemetry]);

  useEffect(() => {
    if (!isAdmin || telemetry === null) return;
    if (shouldShowAsk(telemetry, isAdmin, localStorage, Date.now())) {
      setOpen(true);
      void fetchPreview().catch(() => undefined);
    }
  }, [isAdmin, telemetry, fetchPreview]);

  if (!open) return null;

  return (
    <HelloModal
      open={open}
      preview={preview}
      onAnswer={(enabled) => setEnabled(enabled)}
      onDismiss={() => {
        const current = useSettingsStore.getState().telemetry;
        if (current?.enabled === null) recordDismissal(localStorage, Date.now());
        setOpen(false);
      }}
    />
  );
}
```

Mount `<TelemetryAsk />` in `App.tsx` directly after `<SwAutoUpdate />`.

- [ ] **Step 4: Run tests, boot, look**

Run: `cd packages/web && npx vitest run src/components/telemetry && npx tsc --noEmit`, then `pnpm dev` from the root, log in as the admin, confirm the modal appears once, the preview shows the real payload, "Decide later" hides it and a reload does not bring it back, and after "Say hi" the toggle under Instance settings (D5) is on. Check the mobile shell by narrowing the window below 768 px.

- [ ] **Step 5: Docs and commit**

Add the `telemetry` namespace to the namespace list in `docs/systems/localization.md` (§Namespaces, line 82).

```bash
git add packages/web/src/components/telemetry packages/web/src/locales packages/web/src/i18n/resources.ts packages/web/src/App.tsx docs/systems/localization.md
git commit -m "feat(web): the telemetry ask, in three languages"
```

### Task D5: The settings section

**Files:**
- Create: `packages/web/src/components/modals/instanceSettingsPanels/TelemetryPanel.tsx`
- Modify: `packages/web/src/components/modals/settingsPanels/InstancePanel.tsx:15-57`, `packages/web/src/locales/{en,de,ru}/settings.json` (`instance.tabs.telemetry`: "Say hi" / "Hallo sagen" / "Привет"), `docs/systems/admin.md`
- Test: `packages/web/src/components/modals/instanceSettingsPanels/TelemetryPanel.test.tsx`

- [ ] **Step 1: Failing test** (pattern of `UpdatesPanel.test.tsx`)

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TelemetryPanel } from './TelemetryPanel';
import { useSettingsStore } from '../../../stores/settingsStore';
import { api } from '../../../api/client';

const off = { enabled: false, id: null, lastDay: null, lastError: null };
const on = { enabled: true, id: '3f6c9e2a-1b2c-4d5e-8f90-1234567890ab', lastDay: '2026-09-06', lastError: null };

beforeEach(() => {
  useSettingsStore.setState({ telemetry: null, telemetryPreview: null });
  vi.spyOn(api.admin.telemetry, 'preview').mockResolvedValue({ schema: 1, instance: 'preview' } as never);
});

describe('TelemetryPanel', () => {
  it('shows the state, the masked id and the last day when on', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(on);
    render(<TelemetryPanel />);
    expect(await screen.findByText('On')).toBeInTheDocument();
    expect(screen.getByText(/3f6c9e2a/)).toBeInTheDocument();
    expect(screen.queryByText(/1234567890ab/)).not.toBeInTheDocument();
    expect(screen.getByText(/Last hello sent on/)).toBeInTheDocument();
  });
  it('toggles through the API', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(off);
    const set = vi.spyOn(api.admin.telemetry, 'set').mockResolvedValue(on);
    render(<TelemetryPanel />);
    await screen.findByText('Off');
    await userEvent.click(screen.getByRole('switch'));
    expect(set).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.getByText('On')).toBeInTheDocument());
  });
  it('shows the last error', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue({ ...on, lastError: { day: '2026-09-07', status: 503 } });
    render(<TelemetryPanel />);
    expect(await screen.findByText(/status 503/)).toBeInTheDocument();
  });
  it('renders the preview JSON', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(off);
    render(<TelemetryPanel />);
    expect(await screen.findByText(/"instance": "preview"/)).toBeInTheDocument();
  });
});
```

If `Toggle` does not render `role="switch"`, query it the way `GeneralPanel`'s tests do (or by its accessible label) and keep the assertion.

- [ ] **Step 2: Implement `TelemetryPanel.tsx`**

Layout in the style of `GeneralPanel`/`UpdatesPanel`: heading `panel.title`, `panel.intro`, a row with `Toggle` and `panel.toggle`, the status line (`panel.status.never|off|on`), `panel.status.lastDay` with `useFormatters().formatLongDate` or `panel.status.none`, the error line when present, the id masked to its first block (`id.split('-')[0]` followed by an ellipsis) with `panel.status.id`, a link `panel.learnMore` to `https://github.com/TheZwiss/backspace/blob/main/docs/systems/telemetry.md`, and the `PayloadPreview` from D4 under `panel.previewTitle` with a `panel.refreshPreview` button. On mount call `fetchTelemetry` and `fetchTelemetryPreview`; on toggle call `setTelemetryEnabled` and show errors through `addToast` like `GeneralPanel`. Add `'telemetry'` to `SubTab` and the sections list in `InstancePanel.tsx`, after `updates`, and render `<TelemetryPanel />` for it.

- [ ] **Step 3: Run, document, commit**

Run: `cd packages/web && npx vitest run src/components/modals && npx tsc --noEmit && node ../../scripts/check-i18n.mjs`. Add the panel to the Admin UI Panels list in `docs/systems/admin.md`.

```bash
git add packages/web/src/components/modals packages/web/src/locales docs/systems/admin.md
git commit -m "feat(web): telemetry section under Instance settings"
```

---

## Track E: insights dashboard facelift (separate spec)

Not part of this plan. The page at `site/insights/index.html` is rebuilt under its own brainstorm and spec before Track F. The only contract Track E must preserve is the `data.json` shape produced by C3, including the `telemetry` block, and the `2 MB` budget.

## Track F: dashboard charts (after E)

**Files:** `site/insights/index.html` (modify), `docs/systems/metrics.md` §10 (modify)

Brief, written as constraints, executed after the facelift on the rebuilt page:

- Render a "Usage pings" section only when `data.telemetry.instances7d !== null && data.telemetry.instances7d >= 10`. Below the threshold render nothing, not a placeholder.
- Section note: "Opt-in numbers from instances that chose to say hi. A lower bound, never the whole network. Counts are rounded and small groups are folded."
- Charts with uPlot, same synced cursor and time axis conventions as the traffic charts: instances reporting (1d, 7d, 30d as three lines), active users (1d, 7d, 30d), registered users, messages per week; three ranked bar lists for versions, countries, client kinds from the `latest` arrays.
- Respect `downsampled` labelling like the other series.
- Verify with `node scripts/metrics/src/cli-bundle.ts` against a local archive that includes telemetry rows and a screenshot of the page above and below the threshold (temporarily edit `data.json` locally for the two states, never commit it).
- Update §10 of `docs/systems/metrics.md` with the section and the threshold rule.

---

## Integration and rollout checklist (main session)

- [ ] A1 to A8 merged; `pnpm dev` starts clean; preview endpoint returns the payload.
- [ ] B1 to B4 merged; `wrangler d1 create backspace-telemetry` done by hand, `database_id` committed; `EXPORT_TOKEN` set with `wrangler secret put`; custom domain attached in the Cloudflare dashboard; first deploy green; `curl https://hello.backspacechat.com/` serves the page.
- [ ] A staging instance with `TELEMETRY_ENDPOINT` pointed at the live receiver opts in; the next day's ping appears in `wrangler d1 execute backspace-telemetry --remote --command "SELECT day, country FROM pings"`.
- [ ] `TELEMETRY_EXPORT_TOKEN` added to the repository secrets; the next `metrics.yml` run writes `telemetry/network.csv` on `metrics-data`; the data tables show the section.
- [ ] D1 to D5 merged; the modal reviewed on the running app on desktop and mobile widths and in all three languages; the final contact sheet approved.
- [ ] README privacy paragraph added (main session).
- [ ] Release as the next minor version; release notes name the feature, the opt-in default and the docs link.
- [ ] Track E spec, then Track F.
