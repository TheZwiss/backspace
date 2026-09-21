# Space Directory ("Outer Space") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Model rule:** every subagent this plan dispatches, implementer or reviewer, runs on Opus. Pass `model: "opus"` on every Agent call. Never a fork from a Fable session, never Fable.

**Goal:** An opt-in public directory of spaces, fed by instances' own public endpoint, indexed by a free Cloudflare Worker, shown as an "Outer Space" section under the existing Explore list, with delisting that lands within seconds.

**Architecture:** The instance serves `GET /api/directory/spaces` (what it wants listed) and pings the hub with nothing but its origin; the hub verifies by fetching that endpoint and replaces the origin's rows on success only. A version-guarded dirty flag plus a cache that is dropped on every change makes an immediate delist honest end to end. The client reads the feed only through its own instance's proxy and dedupes it by connected origin.

**Tech Stack:** Fastify 4 + Drizzle + better-sqlite3 (server), Cloudflare Workers + D1 + `@cloudflare/vitest-pool-workers` (hub), React 18 + Zustand 5 + i18next (web), Vitest everywhere.

**Spec:** `docs/superpowers/specs/2026-09-21-space-directory-design.md`. The plan argues from the spec; read the section each task names before starting it.

## Global Constraints

- No new runtime dependencies anywhere. The hub keeps `no-runtime-deps.test.ts` green.
- TypeScript strict, no `any`, no placeholders, no TODOs. Every function fully implemented.
- Every user-facing string goes through i18next with keys in all four catalogs (`en`, `de`, `ru`, `zh`); every server error is a registered `ErrorCode` with English text in `httpErrors.ts` and a message in the four `errors.json`. Run `pnpm --filter @backspace/web i18n:check` (or whatever `localization.md` names as the consistency check) before declaring a web task done.
- No em dashes and no marketing register in any copy, comment, commit message or doc (project rule).
- Federation rule: never assume a single global id. Spaces are addressed as `(origin, id)`.
- Design system: Aether Drift. New surfaces reuse existing classes (`input-search`, `input-standard`, `glass-modal`, `bg-surface-channel`). Nothing floating uses `bg-surface-elevated`.
- Commit after every task with a `feat(directory): ...`, `feat(hub): ...`, `feat(web): ...`, `docs: ...` subject. No push. The branch is `feat/space-directory`, already checked out; nothing goes to a PR until the whole feature has been tested end to end.
- Server tests: `cd packages/server && npx vitest run <file>`. Web tests: `cd packages/web && npx vitest run <file>`. Hub tests: `cd scripts/directory-hub && pnpm test`. Typecheck: `pnpm -r typecheck` (or the per-package `typecheck` script).
- Numbers fixed by the spec and used verbatim: debounce 3 s; endpoint cache 30 s; hub per-origin cooldown 10 s with `Retry-After: 10`; hub per-address limit 2 per 10 s; fetch timeout 10 s; body cap 512 KB; document caps 200 spaces, name 100, description 200; feed `limit` 1..100 default 50, `offset` max 1000; feed cutoff 3 days; hub housekeeping 30 days; proxy cache 60 s, LRU 64, 30 requests per minute per user; backoff 1, 5, 15, 60 minutes then hourly; `Retry-After` default 10 s.

---

## File structure

**Shared** (`packages/shared/src/`)
- `types.ts`: `DirectoryPingError`, `DirectoryDocumentSpace`, `DirectoryDocument`, `DirectoryEntry`, `DirectoryFeed`; `Space.directoryListed`, `UpdateSpaceRequest.directoryListed`, `InstanceAdminSettings.directoryEnabled|directoryLastPingAt|directoryLastError`, `InstanceInfoResponse.directoryEnabled`.
- `errors.ts`: four new codes.

**Server** (`packages/server/`)
- `drizzle/0015_*.sql` (generated): five columns.
- `src/db/schema.ts`: the five columns.
- `src/directory/state.ts`: dirty flag, in-memory document version, listeners, ping bookkeeping. One module owns every write to the four `instance_settings` columns.
- `src/directory/document.ts`: pure builder of the served document from SQLite.
- `src/directory/pinger.ts`: the pinger: send, answer table, backoff, debounce, boot, daily slot.
- `src/routes/directory.ts`: `GET /api/directory/spaces` (public, cached) and `GET /api/directory` (authenticated proxy).
- `src/routes/settings.ts`, `src/routes/spaces.ts`, `src/routes/instance.ts`: wiring, invariant, new fields.
- `src/utils/httpErrors.ts`: English text for the four codes.
- `src/config.ts`: `directory.endpoint`.
- `src/index.ts`: route registration, pinger start and stop.

**Hub** (`scripts/directory-hub/`, copied from `scripts/telemetry-receiver/`)
- `src/env.ts`, `src/validate.ts` (origin and document validation, pure), `src/store.ts` (every D1 statement), `src/index.ts` (routes, scheduled), `migrations/0001_directory.sql`, `wrangler.toml`, `package.json`, `vitest.config.ts`, `test/apply-migrations.ts`, tests.
- `.github/workflows/directory-hub.yml`.

**Web** (`packages/web/src/`)
- `api/client.ts`: `directory.list`.
- `utils/directory.ts`: `dedupeAgainstConnected` (pure).
- `stores/directoryStore.ts`: feed state, paging, `connectAndJoin`.
- `stores/exploreStore.ts`: export `getApiForOrigin`; `myRequests` keyed by origin.
- `hooks/useSpaceJoin.ts`: origin-aware pending check.
- `components/chat/SpaceCard.tsx` (extracted from `ExplorePage.tsx`), `components/chat/ExplorePage.tsx` (Outer Space section), `components/chat/OuterSpaceSection.tsx`.
- `components/modals/ConnectAndJoinModal.tsx`; `stores/uiStore.ts` (`'connectAndJoin'`); the modal host that renders `activeModal` (find it: `grep -rn "activeModal ===" packages/web/src/components`).
- `components/modals/instanceSettingsPanels/GeneralPanel.tsx`, `components/modals/SpaceSettings.tsx`.
- `components/layout/ChannelSidebar.tsx`: the Explore entry.
- `locales/{en,de,ru,zh}/{spaces,admin,errors}.json`.

**Docs**: `docs/systems/directory.md` (new), `database.md`, `api.md`, `admin.md`, `spaces.md`, `client-federation.md`, `localization.md`, `deployment.md`, `telemetry.md`, `.env.example`, `CLAUDE.md`.

**Plan depth, decided per task:** tasks 2, 3, 5, 7, 8 and 9 carry real code because they hold the logic the review found bugs in (cache invalidation, version guard, cooldown on unknown origins, diff writes, origin dedupe). Tasks 1, 4, 6, 10 to 15 are briefs with exact contracts, because they follow patterns that already exist in the files they touch.

---

### Task 1: Shared contracts

**Spec:** sections 4, 5, 7, 13.

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/server/src/utils/httpErrors.ts`
- Modify: `packages/web/src/locales/en/errors.json`, `de/errors.json`, `ru/errors.json`, `zh/errors.json`

**Interfaces:**
- Produces: every type and code below, used by all later tasks verbatim.

- [ ] **Step 1: Add the types** to `packages/shared/src/types.ts`, next to `ExploreSpace`:

```ts
/** Why the last directory ping did not go through. `reason` is set when `status` is 'fetch'. */
export interface DirectoryPingError {
  at: number;
  status: number | 'network' | 'timeout' | 'origin' | 'fetch';
  reason?: 'unreachable' | 'status' | 'invalid' | 'origin-mismatch';
}

/** One space as an instance serves it on GET /api/directory/spaces. */
export interface DirectoryDocumentSpace {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  banner: string | null;
  avatarColor: AvatarColor | null;
  visibility: 'public' | 'request';
  memberCount: number;
  createdAt: number;
}

/** The document an instance serves. `schema` is fixed at 1 for this release. */
export interface DirectoryDocument {
  schema: 1;
  origin: string;
  instance: { name: string; federatedRegistrationOpen: boolean; version: string };
  spaces: DirectoryDocumentSpace[];
}

/** One entry of the hub's feed: a document space plus the origin it came from. */
export interface DirectoryEntry extends DirectoryDocumentSpace {
  origin: string;
  instanceName: string;
  federatedRegistrationOpen: boolean;
}

export interface DirectoryFeed {
  schema: 1;
  spaces: DirectoryEntry[];
}
```

Then add `directoryListed: boolean;` to `Space` (after `visibility`), `directoryListed?: boolean;` to `UpdateSpaceRequest`, and to `InstanceAdminSettings`:

```ts
  directoryEnabled: boolean;
  /** Read-only on the wire; the server ignores them on PATCH. */
  directoryLastPingAt: number | null;
  directoryLastError: DirectoryPingError | null;
```

and `directoryEnabled: boolean;` to `InstanceInfoResponse`.

- [ ] **Step 2: Register the codes** in `packages/shared/src/errors.ts` under a new `// Directory` group: `'directory_disabled'`, `'directory_unreachable'`, `'directory_private_space'`, `'directory_requires_discovery'`.

- [ ] **Step 3: English text** in `packages/server/src/utils/httpErrors.ts`:

```ts
  directory_disabled: 'The directory is not configured on this instance',
  directory_unreachable: 'The directory could not be reached',
  directory_private_space: 'A private space cannot be listed in the directory',
  directory_requires_discovery: 'Turn on space discovery before enabling the directory',
```

- [ ] **Step 4: Catalog messages** in the four `errors.json` files (flat keys, alphabetical position does not matter). English:

```json
  "directory_disabled": "This instance is not connected to a directory.",
  "directory_unreachable": "Outer Space is not reachable right now. Inner Space still works.",
  "directory_private_space": "Set the space to public or request to join before listing it.",
  "directory_requires_discovery": "Turn on space discovery first."
```

German, Russian and Chinese: translate these four in the register of the neighbouring entries in each file (formal "Sie" is not used in the German catalog; check two existing entries and match them).

- [ ] **Step 5: Typecheck and the catalog check.** `pnpm -r typecheck` passes (the new `Space.directoryListed` will break `rowToSpace` in `spaces.ts` and any fixture that builds a `Space`; fix those to `directoryListed: false` now, Task 4 wires the real value). Run the i18n consistency check named in `docs/systems/localization.md`.

- [ ] **Step 6: Commit** `feat(directory): shared types and error codes`.

---

### Task 2: Migration and the state module

**Spec:** sections 3 (the "one rule"), 4, 6 (version-guarded clear).

**Files:**
- Modify: `packages/server/src/db/schema.ts` (`spaces`, `instanceSettings`)
- Create: `packages/server/drizzle/0015_*.sql` via `cd packages/server && pnpm db:generate`
- Create: `packages/server/src/directory/state.ts`
- Test: `packages/server/src/directory/state.test.ts`

**Interfaces:**
- Produces:
  - `readDirectoryState(sqlite): DirectoryState` where `DirectoryState = { enabled: boolean; dirty: boolean; lastPingAt: number | null; lastError: DirectoryPingError | null }`
  - `markDirectoryDirty(sqlite): void`
  - `getDocumentVersion(): number`
  - `onDirectoryDirty(listener: () => void): () => void`
  - `recordDirectoryPingSuccess(sqlite, sentVersion: number, at: number): boolean` (true when it cleared the flag)
  - `recordDirectoryPingFailure(sqlite, error: DirectoryPingError): void`
  - `clearDirectoryDirty(sqlite): void` (the 410 path only)
  - `_resetDirectoryStateForTests(): void`

- [ ] **Step 1: Schema.** In `schema.ts` add to `spaces`: `directoryListed: integer('directory_listed').notNull().default(0),` after `visibility`. Add to `instanceSettings` after the telemetry block:

```ts
  /** The admin allows spaces on this instance to be listed in the directory. */
  directoryEnabled: integer('directory_enabled').notNull().default(0),
  /** A directory ping is owed. Survives restarts and the toggle being off. */
  directoryDirty: integer('directory_dirty').notNull().default(0),
  /** ms timestamp of the last successful directory ping. */
  directoryLastPingAt: integer('directory_last_ping_at'),
  /** JSON DirectoryPingError of the last failed ping, null after a success. */
  directoryLastError: text('directory_last_error'),
```

Run `pnpm db:generate`; confirm one new `0015_*.sql` with five `ALTER TABLE ... ADD` statements and nothing else. If drizzle-kit emits anything unrelated, stop and reconcile the schema first.

- [ ] **Step 2: Write the failing tests** `state.test.ts`. Use the `applyMigrations` + `ensureDefaults` in-memory pattern from `src/telemetry/reporter.test.ts` (copy those twelve lines; do not import from the test file).

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaults } from '../db/migrate.js';
import {
  readDirectoryState, markDirectoryDirty, getDocumentVersion, onDirectoryDirty,
  recordDirectoryPingSuccess, recordDirectoryPingFailure, clearDirectoryDirty, _resetDirectoryStateForTests,
} from './state.js';

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
beforeEach(() => { db = new Database(':memory:'); applyMigrations(db); ensureDefaults(db); _resetDirectoryStateForTests(); });

describe('directory state', () => {
  it('starts off, clean and unversioned', () => {
    expect(readDirectoryState(db)).toEqual({ enabled: false, dirty: false, lastPingAt: null, lastError: null });
    expect(getDocumentVersion()).toBe(0);
  });

  it('marking dirty sets the flag, bumps the version and notifies', () => {
    const seen: number[] = [];
    const off = onDirectoryDirty(() => seen.push(getDocumentVersion()));
    markDirectoryDirty(db);
    markDirectoryDirty(db);
    off();
    markDirectoryDirty(db);
    expect(readDirectoryState(db).dirty).toBe(true);
    expect(getDocumentVersion()).toBe(3);
    expect(seen).toEqual([1, 2]);
  });

  it('a success clears the flag only when nothing changed since the ping was sent', () => {
    markDirectoryDirty(db);
    const sent = getDocumentVersion();
    markDirectoryDirty(db);
    expect(recordDirectoryPingSuccess(db, sent, 1000)).toBe(false);
    expect(readDirectoryState(db)).toMatchObject({ dirty: true, lastPingAt: 1000, lastError: null });
    expect(recordDirectoryPingSuccess(db, getDocumentVersion(), 2000)).toBe(true);
    expect(readDirectoryState(db)).toMatchObject({ dirty: false, lastPingAt: 2000 });
  });

  it('a failure keeps the flag and records the error; the next success clears the error', () => {
    markDirectoryDirty(db);
    recordDirectoryPingFailure(db, { at: 5, status: 'fetch', reason: 'origin-mismatch' });
    expect(readDirectoryState(db)).toMatchObject({ dirty: true, lastError: { at: 5, status: 'fetch', reason: 'origin-mismatch' } });
    recordDirectoryPingSuccess(db, getDocumentVersion(), 6);
    expect(readDirectoryState(db).lastError).toBeNull();
  });

  it('a corrupt stored error reads as none', () => {
    db.prepare("UPDATE instance_settings SET directory_last_error = '{not json' WHERE id = 1").run();
    expect(readDirectoryState(db).lastError).toBeNull();
  });

  it('clearDirectoryDirty is unconditional', () => {
    markDirectoryDirty(db);
    clearDirectoryDirty(db);
    expect(readDirectoryState(db).dirty).toBe(false);
  });
});
```

- [ ] **Step 3: Run it** (`npx vitest run src/directory/state.test.ts`): fails, module missing.

- [ ] **Step 4: Implement** `state.ts`:

```ts
import type Database from 'better-sqlite3';
import type { DirectoryPingError } from '@backspace/shared';

export interface DirectoryState {
  enabled: boolean;
  dirty: boolean;
  lastPingAt: number | null;
  lastError: DirectoryPingError | null;
}

interface Row {
  directory_enabled: number;
  directory_dirty: number;
  directory_last_ping_at: number | null;
  directory_last_error: string | null;
}

/**
 * In-memory generation of the served document. Bumped by every
 * markDirectoryDirty. Not persisted on purpose: a restart sends a boot ping
 * whenever the flag is set, so a counter that starts over cannot clear a
 * stale flag (section 4 of the spec).
 */
let documentVersion = 0;
const listeners = new Set<() => void>();

const STATUSES = new Set(['network', 'timeout', 'origin', 'fetch']);
const REASONS = new Set(['unreachable', 'status', 'invalid', 'origin-mismatch']);

function parseError(raw: string | null): DirectoryPingError | null {
  if (raw === null) return null;
  try {
    const p: unknown = JSON.parse(raw);
    if (typeof p !== 'object' || p === null) return null;
    const { at, status, reason } = p as { at?: unknown; status?: unknown; reason?: unknown };
    if (typeof at !== 'number') return null;
    const statusOk = typeof status === 'number' || (typeof status === 'string' && STATUSES.has(status));
    if (!statusOk) return null;
    const out: DirectoryPingError = { at, status: status as DirectoryPingError['status'] };
    if (typeof reason === 'string' && REASONS.has(reason)) out.reason = reason as DirectoryPingError['reason'];
    return out;
  } catch {
    return null;
  }
}

export function readDirectoryState(sqlite: Database.Database): DirectoryState {
  const row = sqlite.prepare(
    'SELECT directory_enabled, directory_dirty, directory_last_ping_at, directory_last_error FROM instance_settings WHERE id = 1',
  ).get() as Row | undefined;
  if (!row) return { enabled: false, dirty: false, lastPingAt: null, lastError: null };
  return {
    enabled: row.directory_enabled === 1,
    dirty: row.directory_dirty === 1,
    lastPingAt: row.directory_last_ping_at,
    lastError: parseError(row.directory_last_error),
  };
}

export function getDocumentVersion(): number {
  return documentVersion;
}

/** Subscribe to dirty marks. The pinger's debounce hangs off this. */
export function onDirectoryDirty(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The one call every change to the served document goes through. Persists
 * the flag, moves the version (which also invalidates the endpoint cache,
 * keyed on it), then tells the pinger.
 */
export function markDirectoryDirty(sqlite: Database.Database): void {
  sqlite.prepare('UPDATE instance_settings SET directory_dirty = 1 WHERE id = 1').run();
  documentVersion += 1;
  for (const l of listeners) l();
}

/** Clears the flag only if the document is still the one the ping was sent for. */
export function recordDirectoryPingSuccess(sqlite: Database.Database, sentVersion: number, at: number): boolean {
  const unchanged = sentVersion === documentVersion;
  sqlite.prepare(
    `UPDATE instance_settings SET directory_last_ping_at = ?, directory_last_error = NULL${unchanged ? ', directory_dirty = 0' : ''} WHERE id = 1`,
  ).run(at);
  return unchanged;
}

export function recordDirectoryPingFailure(sqlite: Database.Database, error: DirectoryPingError): void {
  sqlite.prepare('UPDATE instance_settings SET directory_last_error = ? WHERE id = 1').run(JSON.stringify(error));
}

/** The hub answered 410: nothing is owed any more, whatever changed. */
export function clearDirectoryDirty(sqlite: Database.Database): void {
  sqlite.prepare('UPDATE instance_settings SET directory_dirty = 0 WHERE id = 1').run();
}

export function _resetDirectoryStateForTests(): void {
  documentVersion = 0;
  listeners.clear();
}
```

- [ ] **Step 5: Run the tests**: pass. `pnpm -r typecheck` passes.

- [ ] **Step 6: Commit** `feat(directory): state columns and the dirty flag`.

---

### Task 3: The document builder and the public endpoint

**Spec:** section 5.

**Files:**
- Create: `packages/server/src/directory/document.ts`
- Create: `packages/server/src/routes/directory.ts` (the public route only; Task 6 adds the proxy to the same file)
- Modify: `packages/server/src/config.ts`, `packages/server/src/index.ts` (register `directoryRoutes` next to `exploreRoutes`)
- Test: `packages/server/src/directory/document.test.ts`, `packages/server/src/routes/directory.test.ts`

**Interfaces:**
- Consumes: `getDocumentVersion` (Task 2), `resolveLocalOrigin` (`routes/federation/origin.ts`), `config.version`.
- Produces: `buildDirectoryDocument(sqlite, ctx: { origin: string; version: string }): DirectoryDocument`; `config.directory.endpoint: string` (empty string means disabled); `directoryRoutes(app)`.

- [ ] **Step 1: Config.** In `config.ts` after `telemetry`:

```ts
  directory: {
    /**
     * Hub base URL for the opt-in space directory. Empty disables the pinger
     * and the proxy entirely (forks, air-gapped installs).
     */
    endpoint: envOptional('DIRECTORY_ENDPOINT') ?? 'https://explore.backspacechat.com',
  },
```

`envOptional` returns `undefined` for unset; make sure an explicitly empty `DIRECTORY_ENDPOINT=` yields `''` (check `envOptional`'s treatment of empty strings and adjust the expression so empty means empty, not default).

- [ ] **Step 2: Failing tests for the builder** `document.test.ts` (same in-memory harness as Task 2). Seed with raw SQL: two users, four spaces (A public listed with 2 members, B request listed with 1 member, C public not listed, D private with `directory_listed = 1`), `instance_name = 'Example'`, `federated_registration_open = 1`, `discovery_enabled = 1`, `directory_enabled = 1`. Assert:
  - the document is `{ schema: 1, origin: 'https://home.test', instance: { name: 'Example', federatedRegistrationOpen: true, version: '1.4.0' }, spaces: [A, B] }` ordered A then B (member count desc), each space with `memberCount` from `space_members`, `icon`/`banner` rewritten to `https://home.test/api/uploads/<file>` when stored as a bare filename and left alone when already absolute;
  - with `directory_enabled = 0`, `spaces` is `[]` and the envelope is intact;
  - with `discovery_enabled = 0`, same;
  - a description longer than 200 characters is cut to 200 and a name longer than 100 to 100;
  - 250 listed spaces yield 200.

- [ ] **Step 3: Implement** `document.ts`. Reuse the Explore query shape (`routes/explore.ts`, the `LEFT JOIN space_members` with `COUNT(sm.user_id)`), adding `AND s.directory_listed = 1`, `GROUP BY s.id ORDER BY member_count DESC, s.created_at DESC LIMIT 200`, and the gates read from `instance_settings` in one `SELECT instance_name, federated_registration_open, discovery_enabled, directory_enabled`. Asset URL rule: a value starting with `http` or `/` is kept, otherwise `${origin}/api/uploads/${value}`; a `/`-relative value is prefixed with `origin`. Both branches must produce a URL that starts with `origin + '/'`, since the hub rejects anything else.

- [ ] **Step 4: Failing route tests** `routes/directory.test.ts` (copy the Fastify + mocked `getDb`/`getRawDb` harness from `routes/settings.test.ts`; mock `../routes/federation/origin.js` `resolveLocalOrigin` to return `'https://home.test'`; mock `../config.js` with `{ config: { version: '1.4.0', directory: { endpoint: 'https://hub.test' } } }`). Assert:
  - `GET /api/directory/spaces` with no auth header returns 200 and the document;
  - two requests inside 30 s hit the builder once (spy on the builder module);
  - after `markDirectoryDirty`, the next request rebuilds (spy count 2);
  - after 30 s (inject `now` through a module-level `setDirectoryClockForTests` or `vi.useFakeTimers`), the next request rebuilds.

- [ ] **Step 5: Implement the route.** Cache shape: `let cache: { version: number; at: number; doc: DirectoryDocument } | null`. Serve `cache.doc` when `cache.version === getDocumentVersion() && now - cache.at < 30_000`. The route sets `cache-control: public, max-age=30` and no auth `preHandler`. Register in `index.ts` right after `exploreRoutes`.

- [ ] **Step 6: Run both test files**: pass. Commit `feat(directory): public document endpoint`.

---

### Task 4: Settings, space routes and the instance info field

**Spec:** section 4 (transitions, invariant), section 10 (wire fields).

**Files:**
- Modify: `packages/server/src/routes/settings.ts`, `packages/server/src/routes/spaces.ts`, `packages/server/src/routes/instance.ts`
- Test: extend `packages/server/src/routes/settings.test.ts`, `packages/server/src/routes/spaces.test.ts` (or create `spaces.directory.test.ts` with the same harness), `packages/server/src/routes/instance.test.ts` if it exists, else add the assertion where `/api/instance/info` is already tested.

**Interfaces:**
- Consumes: `markDirectoryDirty` (Task 2), the four error codes (Task 1).
- Produces: `InstanceAdminSettings.directoryEnabled|directoryLastPingAt|directoryLastError` on both `/api/settings/instance` responses; `Space.directoryListed` in `rowToSpace`; `PATCH /api/spaces/:id` accepting `directoryListed`; `InstanceInfoResponse.directoryEnabled`.

Brief:

1. **One helper for the invariant**, in `settings.ts` (module-private): `applyDiscoveryAndDirectory(body, updateData, currentRow, reply): boolean`. Rules: `directoryEnabled: true` while the resulting discovery state is off returns `sendError(reply, 400, 'directory_requires_discovery')`; `discoveryEnabled: false` also writes `directoryEnabled = 0`. Call it from both `PATCH /api/settings/streaming` and `PATCH /api/settings/instance`, after the existing `discoveryEnabled` handling.
2. **Dirty marks** after the write succeeds, when any of these changed value: `directoryEnabled`, `discoveryEnabled`, `instanceName`, `federatedRegistrationOpen`. Compare the row before and after; a PATCH that sends the same value marks nothing.
3. **GET and PATCH `/api/settings/instance`** responses include the three fields (`directoryLastError` parsed through `readDirectoryState`, not re-parsed by hand). The PATCH ignores `directoryLastPingAt` and `directoryLastError` in the body.
4. **`PATCH /api/spaces/:id`**: accept `directoryListed` (boolean, else `400 field_not_boolean`); `true` on a space whose resulting visibility is `private` returns `400 directory_private_space`; a visibility change to `private` writes `directoryListed = 0` in the same update. Mark dirty when: `directoryListed` changed in either direction; or the space is listed after the update and any of `name`, `description`, `icon`, `banner`, `avatarColor`, `visibility` changed.
5. **`DELETE /api/spaces/:id`**: mark dirty after the transaction when the deleted row had `directory_listed = 1`.
6. **`rowToSpace`**: `directoryListed: row.directoryListed === 1`.
7. **`/api/instance/info`**: `directoryEnabled: settings?.directoryEnabled === 1`.

Tests to write first, one `it` each: the invariant on both routes (rejects enabling without discovery; discovery off clears directory); each dirty transition marks (spy on `markDirectoryDirty` via `vi.mock('../directory/state.js')`) and an unchanged PATCH does not; `directoryListed` on a private space rejected; visibility to private clears the flag; delete of a listed space marks, delete of an unlisted one does not; GET returns the three fields; info returns `directoryEnabled`.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them, confirm they fail for the right reason.**
- [ ] **Step 3: Implement the seven points above.**
- [ ] **Step 4: Run the full server suite** (`npx vitest run`): green.
- [ ] **Step 5: Commit** `feat(directory): settings invariant, space listing flag, dirty marks`.

---

### Task 5: The pinger

**Spec:** section 6 in full.

**Files:**
- Create: `packages/server/src/directory/pinger.ts`
- Modify: `packages/server/src/index.ts` (start after `startBackupWorker()`, outside the workers guard; stop in `shutdown`)
- Test: `packages/server/src/directory/pinger.test.ts`

**Interfaces:**
- Consumes: Task 2 state API; `slotMinute` from `../telemetry/reporter.js` (reuse, do not copy); `getInstanceId` from `../utils/federationEpoch.js`; `config.directory.endpoint`, `config.version`; `resolveLocalOrigin`.
- Produces: `sendDirectoryPing(deps, mem): Promise<PingOutcome>`, `pingerTick(deps, mem): Promise<'sent' | 'skipped' | ...>`, `startDirectoryPinger()`, `stopDirectoryPinger()`, `createPingerMemory()`.

- [ ] **Step 1: Failing tests.** Harness as Task 2 plus a `fetchMock` per test that resolves `new Response(body, { status, headers })`. Deps factory:

```ts
function deps(nowIso: string, respond: () => Response | Promise<Response>): PingerDeps {
  fetchMock = vi.fn().mockImplementation(respond);
  return {
    sqlite: db, endpoint: 'https://hub.test', origin: 'https://home.test', instanceId: 'epoch-1',
    fetch: fetchMock as unknown as typeof fetch, now: () => new Date(nowIso), version: '1.4.0',
    log: { info: vi.fn(), debug: vi.fn() },
  };
}
```

Cases (each its own `it`):
  - body is exactly `{"schema":1,"origin":"https://home.test"}` with `content-type: application/json` and a `user-agent` of `backspace-server/1.4.0`;
  - `204` clears dirty when unchanged, sets `lastPingAt`, resets `mem.failures`;
  - `204` after a concurrent `markDirectoryDirty` (bump the version inside the fetch mock) leaves dirty set and `mem.nextRetryAt` null (the debounce, not the retry loop, sends the next one);
  - `429` with `Retry-After: 7` sets `mem.nextRetryAt = now + 7000`, dirty stays; `429` without the header uses 10 s;
  - `400` records `{ status: 'origin' }` and sets `mem.haltedVersion` to the sent version; a later tick with the same version does not fetch; after `markDirectoryDirty` it fetches again;
  - `410` calls `clearDirectoryDirty`, records `{ status: 410 }`, sets `mem.retired = true`, and no later tick fetches;
  - `502` with `{"reason":"origin-mismatch"}` records `{ status: 'fetch', reason: 'origin-mismatch' }`, dirty stays, backoff 1 minute; a second failure backs off 5, then 15, then 60, then 60;
  - a rejected fetch records `{ status: 'network' }`; an `AbortError`-named rejection records `'timeout'`;
  - `pingerTick` with the endpoint `''` never fetches;
  - daily: with `directory_enabled = 1`, clean, `lastPingAt` yesterday, a tick one minute before the slot skips and a tick at the slot sends; an event ping earlier today (set `lastPingAt` to 00:05 today, slot at 09:00) does not satisfy the slot; after a failed slot attempt the same day, later ticks skip (attempted guard) unless dirty;
  - retry: with dirty and `mem.nextRetryAt` in the future the tick skips; in the past it sends regardless of `directory_enabled`.

- [ ] **Step 2: Run, fail.**

- [ ] **Step 3: Implement.** Skeleton to fill in exactly:

```ts
export interface PingerDeps {
  sqlite: Database.Database;
  endpoint: string;
  origin: string;
  instanceId: string;
  fetch: typeof fetch;
  now: () => Date;
  version: string;
  log: { info(msg: string): void; debug(msg: string): void };
}

export interface PingerMemory {
  failures: number;
  nextRetryAt: number | null;
  haltedVersion: number | null;
  retired: boolean;
  attemptedDay: string | null;
}

export function createPingerMemory(): PingerMemory {
  return { failures: 0, nextRetryAt: null, haltedVersion: null, retired: false, attemptedDay: null };
}

const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];
const TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER_S = 10;

export type PingOutcome = 'accepted' | 'cooldown' | 'origin-rejected' | 'retired' | 'fetch-failed' | 'failed';
```

`sendDirectoryPing`: records `sentVersion = getDocumentVersion()` before the request; POSTs; then the answer table from spec section 6, writing through the Task 2 functions only. Backoff: `mem.nextRetryAt = now + BACKOFF_MS[Math.min(mem.failures, 3)]`, then `mem.failures += 1`. A `204` sets `failures = 0, nextRetryAt = null`.

`pingerTick(deps, mem)`: returns `'skipped'` when `endpoint === ''` or `mem.retired`; reads state; if `dirty` and `mem.haltedVersion !== getDocumentVersion()` and (`mem.nextRetryAt === null || now >= mem.nextRetryAt`) then send; else if `enabled` and the daily rule holds (minute of day `>= slotMinute(instanceId)`, `lastPingAt === null || lastPingAt < todaySlotInstant`, `mem.attemptedDay !== today`) then set `mem.attemptedDay = today` and send; else `'skipped'`.

`startDirectoryPinger()`: build production deps (`getRawDb()`, `config.directory.endpoint`, `resolveLocalOrigin()`, `getInstanceId()`, `globalThis.fetch`, `config.version`); one `PingerMemory`; subscribe `onDirectoryDirty` to a 3 s debounced `sendDirectoryPing`; run `pingerTick` once at boot and every 60 s. `stopDirectoryPinger()` clears the interval, the debounce timer and the subscription. Guard: when `config.directory.endpoint === ''`, `start` logs one line and returns.

- [ ] **Step 4: Run tests: pass.** Wire `index.ts`. Boot `pnpm dev` once and confirm the log shows the pinger starting and, with `DIRECTORY_ENDPOINT=` empty, the disabled line.

- [ ] **Step 5: Commit** `feat(directory): pinger with version-guarded delist`.

---

### Task 6: The proxy route

**Spec:** section 9 (proxy paragraph).

**Files:**
- Modify: `packages/server/src/routes/directory.ts`
- Test: extend `packages/server/src/routes/directory.test.ts`

**Interfaces:**
- Consumes: `config.directory.endpoint`; `DirectoryFeed` (Task 1).
- Produces: `GET /api/directory?q=&limit=&offset=` (authenticated) returning `DirectoryFeed`; `404 directory_disabled`; `502 directory_unreachable`.

Brief: validate `q` (trim, max 100 chars), `limit` (1..100, default 50), `offset` (0..1000); forward to `${endpoint}/v1/spaces?...` with a 10 s timeout and `accept: application/json`; on a non-200 or a body that is not `{ schema: 1, spaces: [...] }` answer `502 directory_unreachable`; cache per exact `(q, limit, offset)` for 60 s in a Map with insertion-order eviction at 64 entries; coalesce identical in-flight requests by sharing the promise; route config `rateLimit: { max: 30, timeWindow: '1 minute' }` (the same shape `request-join` uses in `explore.ts`); when `endpoint === ''` answer `404 directory_disabled` before anything else. `_resetDirectoryProxyForTests()` clears the cache.

Tests: disabled endpoint; passthrough of validated params (assert the upstream URL); clamping of out-of-range params; cache hit within 60 s (upstream called once for two requests); different `q` misses; 65th distinct query evicts the first; two concurrent identical requests call upstream once; upstream 500 and upstream garbage both map to 502 with the code.

- [ ] **Step 1: Failing tests. Step 2: Implement. Step 3: Suite green. Step 4: Commit** `feat(directory): feed proxy with cache and limiter`.

---

### Task 7: Hub package, migration, validators

**Spec:** section 7 (tables, ping steps 3 and 6).

**Files:**
- Create: `scripts/directory-hub/` by copying `scripts/telemetry-receiver/` (`package.json` renamed to `@backspace/directory-hub`, `tsconfig.json`, `vitest.config.ts` without `EXPORT_TOKEN`, `test/apply-migrations.ts`, `src/no-runtime-deps.test.ts`, `src/harness.test.ts` adapted to assert the four tables). Delete `page.ts`, the export route and everything telemetry-specific. Add the package to `pnpm-workspace.yaml` if the workspace globs do not already cover `scripts/*`.
- Create: `scripts/directory-hub/migrations/0001_directory.sql` with the DDL from spec section 7 verbatim.
- Create: `scripts/directory-hub/wrangler.toml`: `name = "backspace-directory-hub"`, `routes = [{ pattern = "explore.backspacechat.com", custom_domain = true }]`, `RETIRED = "0"`, D1 binding `DB` with `database_name = "backspace-directory"` and `database_id = "REPLACE-AT-ROLLOUT"`, rate limiter `namespace_id = "1002"` with `limit = 2, period = 10`, cron `"23 3 * * *"`, same `compatibility_date` as the receiver.
- Create: `src/env.ts` (`DB`, `RATE_LIMITER?`, `RETIRED?`, `TEST_MIGRATIONS?`, `HUB_HOST?`), `src/validate.ts`, `src/validate.test.ts`.

**Interfaces:**
- Produces: `parseOrigin(raw: unknown, selfHost: string): { ok: true; origin: string } | { ok: false }`; `parseDocument(text: string, expectedOrigin: string): { ok: true; doc: ValidDocument } | { ok: false; reason: 'invalid' | 'origin-mismatch' }` where `ValidDocument = { instanceName: string; federatedRegistrationOpen: boolean; version: string | null; spaces: ValidSpace[] }` and `ValidSpace = { id, name, description, icon, banner, avatarColor, visibility, memberCount, createdAt }` (same field set and types as `DirectoryDocumentSpace`, re-declared locally because the hub has no dependency on `@backspace/shared`); `MAX_DOCUMENT_BYTES = 512 * 1024`; `MAX_PING_BYTES = 1024`.

- [ ] **Step 1: Failing tests** `validate.test.ts`:

`parseOrigin` accepts `'https://chat.example.org'` and canonicalises `'HTTPS://Chat.Example.org'` to the lowercase origin; rejects: not a string, `http://`, a port, userinfo, a path, a query, a fragment, `https://localhost`, `https://127.0.0.1`, `https://[::1]`, a bare `https://example` (no dot), the hub's own host, a body over 1024 bytes (tested at the handler level in Task 8, not here).

`parseDocument`: a well-formed document passes and returns the typed shape; `schema: 2` rejects `invalid`; `origin` different from `expectedOrigin` rejects `origin-mismatch`; a 201-space document rejects; name of 101 characters rejects; description of 201 rejects; `icon: 'https://other.example/x.png'` rejects (must start with `expectedOrigin + '/'`); `icon: null` passes; `memberCount: -1`, `1.5`, `10**9 + 1` reject; `visibility: 'private'` rejects; `avatarColor` must be null or a string of at most 32 characters; `instance.version` must be null/absent or match `/^[0-9A-Za-z.+-]{1,32}$/`; `instance.name` at most 100 characters; a body larger than `MAX_DOCUMENT_BYTES` rejects (measure encoded bytes like the receiver's `parsePing`); unknown top-level fields are ignored, unknown space fields are ignored.

- [ ] **Step 2: Run, fail. Step 3: Implement** `validate.ts` as pure functions with no IO, mirroring the style of the receiver's `validate.ts` (documented constants, one exported function per concern). The IP-literal check: reject when the hostname matches `/^\d{1,3}(\.\d{1,3}){3}$/` or starts with `[`.

- [ ] **Step 4: `pnpm test` green in the hub package** (the harness test asserts the tables exist; the no-runtime-deps test passes). `pnpm typecheck` green.

- [ ] **Step 5: Commit** `feat(hub): directory hub scaffold and validators`.

---

### Task 8: Hub routes, store and workflow

**Spec:** section 7 (ping steps 1 to 8, the feed, scheduled job), section 11.

**Files:**
- Create: `scripts/directory-hub/src/store.ts`, `src/index.ts`, `src/index.test.ts`, `src/store.test.ts`
- Create: `.github/workflows/directory-hub.yml` (copy `telemetry-receiver.yml`; rename job names, paths filter and working directory; dispatch-only deploy with the same `if:` guard)

**Interfaces:**
- Consumes: Task 7 validators.
- Produces (store): `getLastFetchAt(db, origin): Promise<number | null>`, `touchFetchAttempt(db, origin, at)`, `readOriginHash(db, origin): Promise<string | null>`, `applyDocument(db, origin, doc: ValidDocument, documentHash: string, at: number): Promise<{ inserted: number; updated: number; deleted: number }>`, `touchOriginOk(db, origin, at)`, `feed(db, opts: { q: string; limit: number; offset: number; since: number }): Promise<FeedRow[]>`, `deleteOlderThan(db, cutoff: number): Promise<number>`, `isBlocked` folded into the feed query.

- [ ] **Step 1: Failing store tests** (`cloudflare:test` `env.DB`, like the receiver's harness test):
  - `applyDocument` on an empty origin inserts every row and the `origins` row with `first_seen_at = last_ok_at = at` and `document_hash`;
  - applying the same document again with the same hash is the caller's skip (test `touchOriginOk` alone updates `last_ok_at` and nothing else, by comparing `spaces` rows before and after);
  - applying a document where one space changed `member_count`, one is new and one is gone: exactly one update, one insert, one delete, unchanged rows keep their `row_hash`;
  - applying an empty `spaces` deletes all rows for that origin and keeps the `origins` row;
  - `feed` orders by `member_count DESC, created_at DESC`, honours `limit` and `offset`, excludes origins with `last_ok_at < since`, excludes a blocked origin (`space_id = '*'`) and a blocked single space, matches `q` against name or description case-insensitively, and treats `%` and `_` in `q` literally (a `q` of `50%` matches a description containing `50%` and not one containing `50 percent`);
  - `deleteOlderThan` removes `origins` (with cascade) and `fetch_attempts` rows older than the cutoff and nothing newer.

- [ ] **Step 2: Failing handler tests** `index.test.ts` (`SELF.fetch` from `cloudflare:test`, `fetchMock` from `cloudflare:test` for the outbound call: `fetchMock.activate(); fetchMock.disableNetConnect(); fetchMock.get('https://chat.example.org').intercept({ path: '/api/directory/spaces' }).reply(200, body)`):
  - `410` while `RETIRED = '1'`;
  - `400` on a body over 1024 bytes, on a missing `origin`, on each rejected origin shape (one representative);
  - a valid ping fetches `https://chat.example.org/api/directory/spaces` with `accept: application/json` and no redirect following (reply `302` → `502 { reason: 'status' }`);
  - a valid document answers `204` and the feed then lists its spaces with `origin`, `instanceName`, `federatedRegistrationOpen`;
  - a second ping within 10 s answers `429` with `retry-after: 10` and does not fetch; a ping for a *never valid* origin (fetch replied 500) still writes `fetch_attempts`, so its second ping inside 10 s is also `429`;
  - a fetch that fails (network error) answers `502 { reason: 'unreachable' }` and leaves earlier rows intact;
  - an invalid document answers `502 { reason: 'invalid' }`; an origin mismatch `502 { reason: 'origin-mismatch' }`; rows intact in both;
  - an empty `spaces` answers `204` and the feed no longer lists that origin's spaces;
  - a document identical to the stored one (same hash) answers `204` and updates only `last_ok_at` (assert `spaces` rows untouched via `row_hash`s and a `SELECT` count);
  - `GET /v1/spaces` validates `limit` and `offset` like the proxy, returns `{ schema: 1, spaces }`, sends `cache-control: public, max-age=60`, and omits an origin whose `last_ok_at` is older than 3 days;
  - `scheduled` deletes origins older than 30 days.

- [ ] **Step 3: Implement.** `handlePing` in the order of spec section 7 steps 1 to 8. The document hash: `SHA-256` of `JSON.stringify` of the *validated* document with spaces sorted by `id` (canonical). The row hash: `SHA-256` of `JSON.stringify` of the validated space fields in a fixed key order. `applyDocument` builds one `db.batch([...])`: `INSERT ... ON CONFLICT(origin) DO UPDATE` for `origins`, one `DELETE` per vanished id, one `INSERT ... ON CONFLICT(origin, id) DO UPDATE` per new or changed row. `GET /v1/spaces`: check `caches.default.match(request)` first; on a miss build the response with the header and `ctx.waitUntil(caches.default.put(request, response.clone()))`; apply the same per-address limiter as the ping. Cache API is available in the Workers vitest pool; if `caches.default` proves unavailable there, guard with `typeof caches !== 'undefined'` and test the header only. `scheduled`: `deleteOlderThan(env.DB, controller.scheduledTime - 30 * 86_400_000)`.

- [ ] **Step 4: Also test the batch size.** One test applies a 200-space document and asserts 200 rows: this is the check the spec flags for the maximum statements per `batch()`. If it fails, chunk the batch at 100 statements and note it in `directory.md`.

- [ ] **Step 5: `pnpm test` and `pnpm typecheck` green.** Workflow file: `actionlint` passes (`brew list actionlint` or run it through the repo's usual lint step).

- [ ] **Step 6: Commit** `feat(hub): ping verification, diff writes and the feed`.

---

### Task 9: Web API client, dedupe and the directory store

**Spec:** section 8 (dedupe rule), section 9 (`connectAndJoin` continuation, steps 1 to 4).

**Files:**
- Modify: `packages/web/src/api/client.ts`, `packages/web/src/stores/exploreStore.ts` (export `getApiForOrigin`)
- Create: `packages/web/src/utils/directory.ts`, `packages/web/src/utils/directory.test.ts`, `packages/web/src/stores/directoryStore.ts`, `packages/web/src/stores/directoryStore.test.ts`

**Interfaces:**
- Consumes: `DirectoryFeed`, `DirectoryEntry` (Task 1); `isSelfOrigin`, `useInstanceStore` (`instances[].origin`), `useInstanceConnect` semantics; `exploreStore.publicJoin`/`requestJoin` (they take a `TaggedExploreSpace`; build one from the entry with `_instanceOrigin: entry.origin`, `joined: false`).
- Produces: `api.directory.list(q?: string, limit = 50, offset = 0): Promise<DirectoryFeed>`; `dedupeAgainstConnected(entries: DirectoryEntry[], connectedOrigins: string[]): DirectoryEntry[]`; store below.

- [ ] **Step 1: The pure helper, test first** (`directory.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { dedupeAgainstConnected } from './directory';

const e = (origin: string, id: string) => ({ origin, id, name: id, description: null, icon: null, banner: null, avatarColor: null, visibility: 'public' as const, memberCount: 1, createdAt: 1, instanceName: origin, federatedRegistrationOpen: true });

describe('dedupeAgainstConnected', () => {
  it('drops entries whose origin is connected, in any spelling', () => {
    const out = dedupeAgainstConnected(
      [e('https://a.test', '1'), e('https://B.test', '2'), e('https://c.test', '3')],
      ['https://a.test', 'https://b.test/'],
    );
    expect(out.map((x) => x.id)).toEqual(['3']);
  });
  it('drops nothing when nothing is connected', () => {
    expect(dedupeAgainstConnected([e('https://a.test', '1')], [])).toHaveLength(1);
  });
});
```

Implement with `new URL(x).origin` on both sides (a value that does not parse is dropped from `connectedOrigins` and kept in entries).

- [ ] **Step 2: The store, test first** (`directoryStore.test.ts`; mock `../api/client` and `./instanceStore` the way `exploreStore` tests or `JoinSpace.test.tsx` mock them):
  - `fetch('')` calls `api.directory.list('', 50, 0)`, stores entries minus connected origins (`isSelfOrigin` true for `window.location.origin`, plus `useInstanceStore.getState().instances.map(i => i.origin)`), `hasMore` true when a full page came back;
  - `loadMore()` requests `offset + 50` and appends without duplicates by `(origin, id)`;
  - a `404 directory_disabled` sets `status: 'disabled'`, a `502` sets `status: 'unreachable'`, anything else `status: 'error'`; success sets `'ok'`;
  - `fetch(q)` resets `offset` and `entries`.

Store shape:

```ts
interface DirectoryState {
  entries: DirectoryEntry[];
  status: 'idle' | 'loading' | 'ok' | 'disabled' | 'unreachable' | 'error';
  query: string;
  offset: number;
  hasMore: boolean;
  fetch: (query: string) => Promise<void>;
  loadMore: () => Promise<void>;
  connectAndJoin: (entry: DirectoryEntry, password: string, message?: string) => Promise<ConnectAndJoinResult>;
  reset: () => void;
}
type ConnectAndJoinResult =
  | { kind: 'joined'; spaceId: string; origin: string }
  | { kind: 'requested' }
  | { kind: 'needs-remote-password'; remoteUsername: string };
```

`connectAndJoin`: connect via the same logic `useInstanceConnect.connect` runs (extract that body into an exported plain function `connectToInstance(host, password): Promise<'new' | 'reconnect'>` in the hook file and have the hook call it, so the store and the hook share one path, including the `DifferentPasswordError` branch which the store surfaces as `needs-remote-password`); then `publicJoin` or `requestJoin` through `exploreStore` with a `TaggedExploreSpace` built from the entry; a `409 already_member` from `publicJoin` (check how `describeError`/the API client expose the code; match on the code, not the text) resolves as `joined`; finally `useExploreStore.getState().fetchMyRequests()` and remove the entry from `entries` (its origin is now connected).

- [ ] **Step 3: `api.directory.list`** in `client.ts`, next to `explore`; `getApiForOrigin` exported from `exploreStore.ts`.

- [ ] **Step 4: Tests green, typecheck green. Commit** `feat(web): directory store and origin dedupe`.

---

### Task 10: SpaceCard extraction and the Outer Space section

**Spec:** section 8 in full, section 2 (names and subtitles).

**Files:**
- Create: `packages/web/src/components/chat/SpaceCard.tsx` (moved out of `ExplorePage.tsx` unchanged in markup, plus the props below)
- Create: `packages/web/src/components/chat/OuterSpaceSection.tsx`
- Modify: `packages/web/src/components/chat/ExplorePage.tsx`
- Modify: `packages/web/src/locales/{en,de,ru,zh}/spaces.json`
- Test: `packages/web/src/components/chat/OuterSpaceSection.test.tsx`, `packages/web/src/components/chat/SpaceCard.test.tsx`

**Interfaces:**
- Consumes: Task 9 store; `useSpaceJoin`.
- Produces: `SpaceCard` props `{ space: TaggedExploreSpace; onJoinSuccess(spaceId: string): void }` unchanged for Inner, plus an optional `outer?: { entry: DirectoryEntry; onConnect(entry: DirectoryEntry): void }`. When `outer` is set the card renders the origin chip always, a "Closed to new accounts" badge when `entry.federatedRegistrationOpen === false`, and a single action button "Connect and join" (public) or "Connect and request" (request) calling `onConnect`; it does not use `useSpaceJoin`'s join/request actions.

Brief:

1. Extract `SpaceCard` verbatim, then add the `outer` branch. Build the `TaggedExploreSpace` for an outer entry as `{ ...entry, _instanceOrigin: entry.origin, joined: false }`.
2. `ExplorePage`: wrap the existing content (unjoined grid, joined section) under a section header "Inner Space" with subtitle "Spaces on your instances", using the same header typography the joined section uses (`text-xs font-semibold uppercase tracking-wider text-txt-tertiary`) with the subtitle in `text-[13px] text-txt-tertiary` beneath. Below it render `<OuterSpaceSection query={searchQuery} onConnect={...} />` whenever `directoryStore.status !== 'disabled'`. The existing true-empty state (no Inner spaces at all) must not hide Outer Space: restructure so the Inner empty copy renders inside the Inner section and Outer still renders below.
3. The search input drives both: the existing 300 ms debounce also calls `directoryStore.fetch(value)`.
4. `OuterSpaceSection`: header "Outer Space", subtitle "Communities across Backspace"; states: `loading` (skeleton or `LoadingSpinner` inline in the header when entries exist, full-height spinner when they do not), `unreachable` (the `directory_unreachable` copy from `errors.json`, in the amber notice style ExplorePage uses for `discoveryDisabled`), `error` (rose notice), `ok` with zero entries and a query (`spaces:explore.outer.noMatches`), `ok` with zero entries and no query (`spaces:explore.outer.empty`, using `Mascot state="lonely"` like the page's empty state), `ok` with entries (grid identical to Inner's, `SpaceCard` with `outer`), and a "Show more" button when `hasMore`. On mount call `fetch(query)`.
5. Keys, English (add to `spaces.explore`):

```json
"inner": { "title": "Inner Space", "subtitle": "Spaces on your instances" },
"outer": {
  "title": "Outer Space",
  "subtitle": "Communities across Backspace",
  "empty": "Nothing out there yet. Spaces that opt in to the directory appear here.",
  "noMatches": "Nothing in Outer Space matches your search.",
  "showMore": "Show more",
  "connectAndJoin": "Connect and join",
  "connectAndRequest": "Connect and request",
  "closedBadge": "Closed to new accounts"
}
```

German, Russian, Chinese: "Inner Space"/"Outer Space" are translated literally ("Innerer Space"/"Äußerer Space" keeps the loanword the German catalog already uses for Space; "Внутреннее пространство"/"Внешнее пространство"; "内部空间"/"外部空间"). The rest in each catalog's register.

6. Tests: `SpaceCard` outer branch renders the chip, the badge when closed, the right action label per visibility, and calls `onConnect` with the entry. `OuterSpaceSection` renders each of the seven states from a mocked store and calls `loadMore` on "Show more".

- [ ] **Step 1: Failing tests. Step 2: Implement. Step 3: Tests, typecheck and the i18n check green.**
- [ ] **Step 4: Screenshots.** Run the dev harness (`pnpm dev`, the `run` skill or the repo's screenshot helper if one exists) and capture the Explore page in: both sections populated; Inner empty and Outer populated; Outer unreachable; Outer empty. Save under the scratchpad and list the paths in the task report. The section layout is reviewed on those screenshots before Task 11 starts.
- [ ] **Step 5: Commit** `feat(web): Outer Space section on the Explore page`.

---

### Task 11: Connect-and-join modal and origin-keyed pending requests

**Spec:** section 9 (steps 1 to 4), section 12.

**Files:**
- Create: `packages/web/src/components/modals/ConnectAndJoinModal.tsx`, `ConnectAndJoinModal.test.tsx`
- Modify: `packages/web/src/stores/uiStore.ts` (`'connectAndJoin'` in `ModalType`), the modal host component that switches on `activeModal`, `packages/web/src/components/modals/ConnectedInstances.tsx` (share the password step), `packages/web/src/hooks/useSpaceJoin.ts`, `packages/web/src/stores/exploreStore.ts`, `packages/web/src/components/chat/ExplorePage.tsx` (wire `onConnect` to `openModal('connectAndJoin', { entry })`)
- Modify: `packages/web/src/locales/{en,de,ru,zh}/spaces.json`, `federation.json` if the shared password step's keys live there

**Interfaces:**
- Consumes: `directoryStore.connectAndJoin` (Task 9); `probeInstance`, `loginToRemote` from `instanceStore`; `describeError`.
- Produces: the modal; `useSpaceJoin` pending check on `(origin, spaceId)`; `exploreStore.myRequests` as `Array<JoinRequest & { _instanceOrigin: string }>` and `fetchMyRequests(origins?: string[])` that queries home plus every connected instance (`Promise.allSettled`, tag each result).

Brief:

1. **Modal.** `glass-modal` with `bg-black/50` backdrop like the other modals. On open: run `probeInstance(new URL(entry.origin).host)` immediately (the probe performs the self and duplicate checks and returns `federatedRegistrationOpen`); show the instance name and host from the probe result; the amber `registrationClosed` banner when closed; the intro line `spaces:explore.connect.intro` ("This space lives on {{host}}. Enter your password for {{home}} to create your identity there.") with `home` = the user's home host (`useAuthStore` user `homeInstance` or `window.location.host`); the same password form the `AddInstanceFlow` auth step renders (extract that step's JSX into a shared `RemotePasswordStep` component in `ConnectedInstances.tsx`'s folder and use it in both places rather than duplicating it); on submit call `connectAndJoin(entry, password, message?)`. For a `request` space the modal shows the optional request message textarea (same `REQUEST_MESSAGE_MAX_LENGTH` and placeholder keys as the card). Results: `joined` closes the modal, `setCurrentSpace(spaceId)`, `navigate('/channels/' + spaceId)` (same as `handleJoinSuccess` in ExplorePage); `requested` closes the modal and shows a toast `spaces:explore.connect.requested`; `needs-remote-password` switches the modal into the fallback login phase (`RemotePasswordStep`'s fallback variant, `loginToRemote`) and then continues with the join. Errors through `describeError` in the modal.
2. **Pending requests by origin.** `exploreStore.fetchMyRequests` queries every connected instance and tags results; `useSpaceJoin.isPending` compares `r.spaceId === space.id && r._instanceOrigin === space._instanceOrigin`. `directoryStore.connectAndJoin` calls `fetchMyRequests()` after a successful connection so the just-connected origin is included.
3. **Wire** the card's `onConnect` in `ExplorePage` to `openModal('connectAndJoin', { entry })`; the modal host reads `modalData.entry`.
4. Keys: `spaces.explore.connect.{title, intro, requested, connecting}`; reuse `federation:connections.add.*` for the password labels and the closed banner.

Tests: modal probes on open and shows host and name; closed banner when the probe says closed; submit calls `connectAndJoin` with the entry and password; `joined` navigates; `requested` closes with a toast; `needs-remote-password` shows the fallback form; `useSpaceJoin` marks pending only for the matching origin.

- [ ] **Step 1: Failing tests. Step 2: Implement. Step 3: Green, typecheck, i18n check. Step 4: Screenshot the modal in the password and the fallback phases. Step 5: Commit** `feat(web): connect and join from an Outer Space card`.

---

### Task 12: Admin toggle and the space switch

**Spec:** section 10.

**Files:**
- Modify: `packages/web/src/components/modals/instanceSettingsPanels/GeneralPanel.tsx`, `packages/web/src/components/modals/SpaceSettings.tsx` (`DiscoveryPanel`), `packages/web/src/stores/settingsStore.ts` (the draft includes `directoryEnabled`)
- Modify: `packages/web/src/locales/{en,de,ru,zh}/admin.json`, `spaces.json`
- Test: `GeneralPanel.directory.test.tsx`, `SpaceSettings.directorySwitch.test.tsx`

**Interfaces:**
- Consumes: `InstanceAdminSettings.directoryEnabled|directoryLastPingAt|directoryLastError`, `Space.directoryListed`, `InstanceInfoResponse.directoryEnabled` (for the space panel on a remote instance, read the instance's info through `getApiForOrigin(origin).instance.info()`; on home read `settingsStore.instanceSettings` if the user is admin, else `api.instance.info()`).

Brief:

1. **GeneralPanel**, under the discovery block: a second `Toggle` "List spaces in the Backspace directory" with description; `disabled` when `draft.discoveryEnabled === false`, with the reason `admin:general.directory.needsDiscovery` under it; when `federatedRegistrationOpen === false` show the amber note `admin:general.directory.registrationClosed`; a status line like `TelemetryPanel`'s: `admin:general.directory.status.never` / `.lastPing` (with the formatted date and time via `useFormatters`) / `.lastError` (with `status` and, when present, `reason` rendered through a small map to the keys `admin:general.directory.reasons.{unreachable,status,invalid,origin-mismatch}`); the disclosure sentence `admin:general.directory.disclosure`. Turning discovery off in the draft also turns the directory toggle off in the draft (mirrors the server invariant).
2. **DiscoveryPanel**: a `Toggle` row "List in the Backspace directory" placed after the visibility options and before the description; states: enabled when `directoryEnabled` (instance) and `visibility !== 'private'` (draft value); disabled with `spaces:settings.discovery.directory.adminOff` when the instance has it off; disabled with `spaces:settings.discovery.directory.privateSpace` when the draft visibility is private (and the draft value is forced to off); the disclosure `spaces:settings.discovery.directory.disclosure`. Saved through `api.spaces.update(spaceId, { ..., directoryListed })` in the same save the panel already does. Never hidden.
3. Keys, English:

```json
"admin.general.directory": {
  "label": "Directory",
  "toggleLabel": "List spaces in the Backspace directory",
  "toggleDescription": "Spaces that opt in appear in Outer Space on every Backspace instance",
  "needsDiscovery": "Turn on space discovery first.",
  "registrationClosed": "New accounts from other instances are closed, so listed spaces will show as closed to new accounts.",
  "disclosure": "For each listed space this makes public: its name, description, icon, banner, member count and this instance's address. People browsing the directory load the icon and banner from this instance.",
  "status": { "never": "Never reported", "lastPing": "Last reported {{date}}", "lastError": "Last attempt failed ({{status}})" },
  "reasons": { "unreachable": "the directory could not reach this instance", "status": "this instance answered with an error", "invalid": "this instance served an invalid document", "origin-mismatch": "this instance reports a different address than the one it was reached at" }
}
"spaces.settings.discovery.directory": {
  "label": "List in the Backspace directory",
  "hint": "Show this space in Outer Space on every Backspace instance.",
  "adminOff": "Your admin has to enable the directory for this instance.",
  "privateSpace": "Set visibility to public or request to join first.",
  "disclosure": "Listing makes public: the space's name, description, icon, banner, member count and this instance's address."
}
```

Tests: toggle disabled with reason when discovery is off; enabled otherwise; amber note when federated registration is closed; status line for each of the three states; space switch in each of its three states; save sends `directoryListed`.

- [ ] **Step 1: Failing tests. Step 2: Implement. Step 3: Green, typecheck, i18n check. Step 4: Screenshot both panels. Step 5: Commit** `feat(web): directory toggle and per-space listing switch`.

---

### Task 13: The home sidebar entry

**Spec:** section 8 (navigation).

**Files:**
- Modify: `packages/web/src/components/layout/ChannelSidebar.tsx` (the first placeholder nav item after Friends), `packages/web/src/locales/{en,de,ru,zh}/spaces.json` (`sidebar.dmList.explore` = "Explore"; reuse `spaces:explore.title` if identical)

Brief: replace the first "Coming Soon" item with a clickable item that renders the compass SVG from `ExplorePage`'s header, the label, `onClick={() => navigate('/explore')}`, and the selected style (`bg-interactive-selected text-white`) when `location.pathname === '/explore'`; update the Home item's selected condition, which already excludes `/explore`. Leave the second placeholder untouched.

- [ ] **Step 1: Implement. Step 2: Typecheck, i18n check, screenshot the home sidebar with Explore selected. Step 3: Commit** `feat(web): Explore entry in the home sidebar`.

---

### Task 14: Documentation

**Spec:** section 14.

**Files:**
- Create: `docs/systems/directory.md`
- Modify: `docs/systems/database.md`, `api.md`, `admin.md`, `spaces.md`, `client-federation.md`, `localization.md`, `deployment.md`, `telemetry.md`, `.env.example`, `CLAUDE.md`

Brief: `directory.md` follows the structure of `telemetry.md` (source files list, why it exists, the three facts and the one rule from spec section 3, the state columns with the transition list, the document with its field table, the pinger's answer table, the hub's routes and tables, the blocklist procedure with the exact `wrangler d1 execute backspace-directory --command "INSERT INTO blocks ..."` lines for an origin block and a space block, the WAF rule to create, `DIRECTORY_ENDPOINT`, the free-plan paragraph, and what is deferred). Each other doc gets the delta spec section 14 names, in that doc's existing style. `.env.example` gets a `DIRECTORY_ENDPOINT` block after the telemetry one in the same voice. `CLAUDE.md` subsystem table gets a `directory.md` row. `telemetry.md` gets the honest paragraph from spec section 14, not a claim of independence.

- [ ] **Step 1: Write. Step 2: Read each changed doc once end to end for placeholders and stale claims. Step 3: Commit** `docs: space directory subsystem`.

---

### Task 15: End-to-end in the federation harness

**Spec:** section 15 (harness case), section 3.

**Files:**
- Create: `packages/server/test/directory-e2e.test.ts`
- Modify: `packages/server/test/helpers/twoInstanceHarness.ts` (`SpawnInstanceOptions.directoryEndpoint?: string` passed through as `DIRECTORY_ENDPOINT`; `BootOptions.directoryEndpoint?: string`)

Brief: start a stub hub in the test process (a plain `node:http` server on an ephemeral port) that records pings and, on each, fetches `${origin}/api/directory/spaces` itself and stores the result per origin, answering `204`. Boot two instances with `directoryEndpoint` pointed at the stub and `publicOriginAsTransport: true` (so the served `origin` matches the transport origin the stub fetches). Then: register an admin on instance A, enable discovery and the directory, create a public space, set `directoryListed: true`, and wait (poll up to 10 s) until the stub holds that space for A's origin. Then set `directoryListed: false` and assert the stub's next stored document for A has no spaces within 10 s. Then switch the directory off and assert the same. Finally, with the stub answering `502 { reason: 'unreachable' }` for one ping, assert `GET /api/settings/instance` on A shows `directoryLastError.status === 'fetch'` and `reason === 'unreachable'`, and that after the stub recovers the next ping clears it.

- [ ] **Step 1: Write the test. Step 2: Run `npx vitest run test/directory-e2e.test.ts`: green. Step 3: Full server suite green. Step 4: Commit** `test(directory): end to end listing and delisting`.

---

## Self-review against the spec

- Section 2 naming: Task 10 (headers and subtitles), Task 13 (sidebar).
- Section 3 facts and the one rule: Task 2 (version), Task 3 (cache keyed on version), Task 5 (version-guarded clear), Task 8 (never delete on failure, replace not merge).
- Section 4: Task 2 (columns, state), Task 4 (transitions, invariant, wire fields), Task 1 (types).
- Section 5: Task 3.
- Section 6: Task 5 (boot ping and daily slot and answer table and backoff and the own guard).
- Section 7: Tasks 7 and 8 (tables, validators, ping steps, feed, scheduled, workflow).
- Section 8: Tasks 9 (dedupe by origin, `getApiForOrigin` export), 10 (sections, card, states), 13 (sidebar).
- Section 9: Task 6 (proxy), Task 11 (modal, continuation, origin-keyed requests), Task 9 (`connectAndJoin`).
- Section 10: Task 12.
- Section 11: Task 7 (URL pinning, origin validation), Task 8 (cooldown on every origin, limiter), Task 12 (disclosure copy), Task 14 (blocklist procedure, WAF rule).
- Section 13: Tasks 1, 10, 11, 12.
- Section 14: Task 14. Section 15: every task's tests plus Task 15. Section 18 (rollout: D1, domain, WAF rule, deploy dispatch) is a manual step for the maintainer after merge, documented in `directory.md`.

Type names used across tasks: `DirectoryPingError`, `DirectoryDocument`, `DirectoryDocumentSpace`, `DirectoryEntry`, `DirectoryFeed` (Task 1); `readDirectoryState`, `markDirectoryDirty`, `getDocumentVersion`, `onDirectoryDirty`, `recordDirectoryPingSuccess`, `recordDirectoryPingFailure`, `clearDirectoryDirty` (Task 2, used by 3, 4, 5); `buildDirectoryDocument`, `config.directory.endpoint` (Task 3, used by 5, 6); `parseOrigin`, `parseDocument`, `ValidDocument` (Task 7, used by 8); `api.directory.list`, `dedupeAgainstConnected`, `useDirectoryStore` with `connectAndJoin` and `ConnectAndJoinResult` (Task 9, used by 10, 11); `SpaceCard` `outer` prop (Task 10, used by 11).
