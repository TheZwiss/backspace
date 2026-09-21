# Space Directory ("Outer Space") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Model rule:** every subagent this plan dispatches, implementer or reviewer, runs on Opus. Pass `model: "opus"` on every Agent call. Never a fork from a Fable session, never Fable.

**Goal:** An opt-in public directory of spaces, fed by instances' own public endpoint, indexed by a free Cloudflare Worker, shown as an "Outer Space" section under the existing Explore list, with delisting that lands within seconds.

**Architecture:** The instance serves `GET /api/directory/spaces` (what it wants listed) and pings the hub with nothing but its origin; the hub verifies by fetching that endpoint and replaces the origin's rows on success only. A version-guarded dirty flag plus a cache that is dropped on every change makes an immediate delist honest end to end. The client reads the feed only through its own instance's proxy and dedupes it by connected origin.

**Tech Stack:** Fastify 4 + Drizzle + better-sqlite3 (server), Cloudflare Workers + D1 + `@cloudflare/vitest-pool-workers` (hub), React 18 + Zustand 5 + i18next (web), Vitest everywhere.

**Spec:** `docs/superpowers/specs/2026-09-21-space-directory-design.md`. The plan argues from the spec; read the section each task names before starting it. Revised 2026-09-21 after an independent review of the plan; the review's findings are folded in below, not listed separately.

## Global Constraints

- No new runtime dependencies anywhere. The hub keeps `no-runtime-deps.test.ts` green.
- TypeScript strict, no `any`, no placeholders, no TODOs. Every function fully implemented.
- Every user-facing string goes through i18next with keys in all four catalogs (`en`, `de`, `ru`, `zh`); every server error is a registered `ErrorCode` with English text in `httpErrors.ts` and a message in the four `errors.json`. The catalog consistency check is `pnpm check:i18n`, run from the repo root.
- Typecheck is `pnpm typecheck` from the repo root (it builds `@backspace/shared` first, then typechecks every package, then runs the i18n check). `pnpm -r typecheck` alone sees stale shared types after Task 1.
- No em dashes and no marketing register in any copy, comment, commit message or doc (project rule).
- Federation rule: never assume a single global id. Spaces are addressed as `(origin, id)`.
- Design system: Aether Drift. New surfaces reuse existing classes (`input-search`, `input-standard`, `glass-modal`, `bg-surface-channel`). Nothing floating uses `bg-surface-elevated`.
- Commit after every task with a `feat(directory): ...`, `feat(hub): ...`, `feat(web): ...`, `docs: ...` subject. No push. The branch is `feat/space-directory`, already checked out; nothing goes to a PR until the whole feature has been tested end to end.
- Server tests: `cd packages/server && npx vitest run <file>`. Web tests: `cd packages/web && npx vitest run <file>`. Hub tests: `cd scripts/directory-hub && pnpm test`.
- Numbers fixed by the spec and used verbatim: debounce 3 s; endpoint cache 30 s; hub per-origin cooldown 10 s with `Retry-After: 10`; hub per-address limit 2 per 10 s; fetch timeout 10 s; body cap 512 KB; document caps 200 spaces, name 100, description 200; feed `limit` 1..100 default 50, `offset` max 1000; feed cutoff 3 days; hub housekeeping 30 days; proxy cache 60 s, LRU 64, 30 requests per minute per user; backoff 1, 5, 15, 60 minutes then hourly; `Retry-After` default 10 s.

---

## File structure

**Shared** (`packages/shared/src/`)
- `types.ts`: `DirectoryPingError`, `DirectoryDocumentSpace`, `DirectoryDocument`, `DirectoryEntry`, `DirectoryFeed`; `Space.directoryListed`, `UpdateSpaceRequest.directoryListed`, `InstanceAdminSettings.directoryEnabled|directoryLastPingAt|directoryLastError`, `InstanceInfoResponse.directoryEnabled`.
- `errors.ts`: four new codes.

**Server** (`packages/server/`)
- `drizzle/0015_*.sql` plus `drizzle/meta/_journal.json` and `0015_snapshot.json` (generated): five columns.
- `src/db/schema.ts`: the five columns.
- `src/directory/state.ts`: dirty flag, in-memory document version, listeners, ping bookkeeping. One module owns every write to the four `instance_settings` columns.
- `src/directory/document.ts`: pure builder of the served document from SQLite.
- `src/directory/pinger.ts`: the pinger: send, answer table, backoff, debounce, boot, daily slot.
- `src/routes/directory.ts`: `GET /api/directory/spaces` (public, cached) and `GET /api/directory` (authenticated proxy).
- `src/routes/settings.ts`, `src/routes/spaces.ts`, `src/routes/instance.ts`: wiring, invariant, new fields.
- `src/utils/httpErrors.ts`: English text for the four codes.
- `src/config.ts`: `directory.endpoint`.
- `src/index.ts`: route registration, pinger start and stop.
- `test/helpers/twoInstanceHarness.ts`: `DIRECTORY_ENDPOINT` set explicitly for every spawned instance.

**Hub** (`scripts/directory-hub/`, copied from `scripts/telemetry-receiver/`)
- `src/env.ts` (with the `declare global { namespace Cloudflare { interface Env ... } }` block the receiver's file carries), `src/validate.ts` (origin and document validation, pure), `src/store.ts` (every D1 statement), `src/index.ts` (routes, scheduled), `migrations/0001_directory.sql`, `wrangler.toml`, `package.json`, `vitest.config.ts`, `test/apply-migrations.ts`, tests.
- `pnpm-workspace.yaml`: the package listed explicitly (the file lists tooling packages one by one on purpose; `scripts/*` is not globbed).
- `.github/workflows/directory-hub.yml`.

**Web** (`packages/web/src/`)
- `api/client.ts`: `directory.list`.
- `utils/directory.ts`: `dedupeAgainstConnected` (pure).
- `stores/instanceStore.ts`: export `normalizeOrigin`; new `connectToInstance` (the shared connect path, see Task 9).
- `stores/directoryStore.ts`: feed state, paging, `connectAndJoin`.
- `stores/exploreStore.ts`: `myRequests` keyed by origin, `fetchMyRequests` fanning out over connected instances.
- `hooks/useSpaceJoin.ts`: origin-aware pending check. `hooks/useInstanceConnect.ts`: deleted (unused today; its one job moves into `connectToInstance`).
- `components/chat/SpaceCard.tsx` (extracted from `ExplorePage.tsx`), `components/chat/ExplorePage.tsx` (Outer Space section), `components/chat/OuterSpaceSection.tsx`.
- `components/modals/ConnectAndJoinModal.tsx` (self-gating on `activeModal`, like every other modal); `components/modals/RemotePasswordStep.tsx` (extracted from `ConnectedInstances.tsx`); `stores/uiStore.ts` (`'connectAndJoin'` in the `ModalType` union, which is not exported and stays that way); `components/layout/AppLayout.tsx` (the modal is added to both the mobile and the desktop modal lists, which render every modal unconditionally).
- `components/modals/instanceSettingsPanels/GeneralPanel.tsx`, `components/modals/SpaceSettings.tsx`, `stores/settingsStore.ts` (the `discoveryEnabled` mirror into `streamingLimits` gains `directoryEnabled`).
- `components/layout/ChannelSidebar.tsx`: the Explore entry.
- `locales/{en,de,ru,zh}/{spaces,admin,errors}.json`.

**Docs**: `docs/systems/directory.md` (new), `database.md`, `api.md`, `admin.md`, `spaces.md`, `client-federation.md`, `localization.md`, `deployment.md`, `telemetry.md`, `.env.example`, `CLAUDE.md`.

**Cross-module facts every task relies on** (verified against the code on 2026-09-21):
- `getApiForOrigin` exists three times. The one to use everywhere in this plan is the exported `getApiForOrigin(origin): BackspaceApiClient` in `utils/crossStoreResolvers.ts` (also re-exported from `stores/spaceStore.ts`). Do not export the private copy in `exploreStore.ts` or `socialStore.ts`. The resolver returns the home client for `''`.
- `resolveLocalOrigin()` (`routes/federation/origin.ts`) delegates to `getOurOrigin()`: `PUBLIC_ORIGIN`, else `https://DOMAIN`, else `http://localhost:<port>`. The third value is what a dev instance serves and the hub rejects it (`http`, no dot); it shows up as `directory_last_error.status: 'origin'`, which is correct behaviour and is documented in Task 14.
- The modal host is `AppLayout.tsx`: two lists (mobile and desktop) render every modal component unconditionally; each modal reads `useUIStore` and gates itself on `activeModal === '<name>'`, reading its inputs from `modalData: Record<string, unknown>` and narrowing them at the use site.
- `describeError(err)` (`i18n/errors.ts`) reads the `HttpError.code` the API client attaches; a caller that needs the code itself reads `err.code` after an `instanceof HttpError` check (see `api/client.ts`).
- Server route tests build a bare Fastify without `@fastify/rate-limit`, so a route's `config.rateLimit` is asserted by reading the route options, not by sending 31 requests.
- The hub test convention is the receiver's: `worker.fetch(req, env, ctx)` with `createExecutionContext()` / `waitOnExecutionContext()`, env varied by spreading (`{ ...env, RETIRED: '1' }`), `scheduled` called directly, and a `nextAddress()` helper that gives every request a distinct `cf-connecting-ip` so the shared rate-limit bucket is never the thing under test.

**Plan depth, decided per task:** tasks 2, 3, 5, 7, 8a and 9 carry real code because they hold the logic the reviews found bugs in (cache invalidation, version guard, cooldown on unknown origins, diff writes, origin dedupe, the connect path). The rest are briefs with exact contracts, because they follow patterns that already exist in the files they touch.

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
  instance: { name: string; federatedRegistrationOpen: boolean; version: string | null };
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

- [ ] **Step 4: Catalog messages** in the four `errors.json` files (flat keys). English:

```json
  "directory_disabled": "This instance is not connected to a directory.",
  "directory_unreachable": "Outer Space is not reachable right now. Inner Space still works.",
  "directory_private_space": "Set the space to public or request to join before listing it.",
  "directory_requires_discovery": "Turn on space discovery first."
```

German, Russian and Chinese: translate these four in the register of the neighbouring entries in each file (read two existing entries per file first and match their form of address).

- [ ] **Step 5: `pnpm typecheck` from the root.** The new `Space.directoryListed` breaks `rowToSpace` in `routes/spaces.ts` and any fixture that builds a `Space`; set `directoryListed: false` in those now, Task 4 wires the real value. The i18n check at the end of `pnpm typecheck` must pass.

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

Run `pnpm db:generate`. Confirm: one new `0015_*.sql` with five `ALTER TABLE ... ADD` statements and nothing else; `drizzle/meta/_journal.json` gained an entry with `idx: 15`; `drizzle/meta/0015_snapshot.json` exists. The server applies migrations through drizzle's `migrate()`, which reads the journal; a `.sql` file without a journal entry is a silent no-op at boot while still passing the test harness (which globs `*.sql`). If drizzle-kit emits anything unrelated, stop and reconcile the schema first.

- [ ] **Step 2: Write the failing tests** `state.test.ts`. Use the `applyMigrations` + `ensureDefaults` in-memory pattern from `src/telemetry/reporter.test.ts` (copy those lines; do not import from the test file).

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

- [ ] **Step 5: Run the tests**: pass. `pnpm typecheck` passes.

- [ ] **Step 6: Commit** `feat(directory): state columns and the dirty flag`.

---

### Task 3: The document builder and the public endpoint

**Spec:** section 5.

**Files:**
- Create: `packages/server/src/directory/document.ts`
- Create: `packages/server/src/routes/directory.ts` (the public route only; Task 6 adds the proxy to the same file)
- Modify: `packages/server/src/config.ts`, `packages/server/src/index.ts` (register `directoryRoutes` next to `exploreRoutes`)
- Test: `packages/server/src/directory/document.test.ts`, `packages/server/src/routes/directory.test.ts`, `packages/server/src/config.test.ts` (create if absent, or add to the existing config test)

**Interfaces:**
- Consumes: `getDocumentVersion` (Task 2), `resolveLocalOrigin` (`routes/federation/origin.ts`), `config.version`.
- Produces: `buildDirectoryDocument(sqlite, ctx: { origin: string; version: string }): DirectoryDocument`; `config.directory.endpoint: string` (empty string means disabled); `directoryRoutes(app)`.

- [ ] **Step 1: Config.** `envOptional` in `config.ts` is `process.env[key] || undefined`, so an empty value is indistinguishable from unset and would take the default. The directory needs empty to mean disabled, so the expression is written out:

```ts
  directory: {
    /**
     * Hub base URL for the opt-in space directory. Unset means the project
     * hub. Set to an empty string to disable the pinger and the proxy
     * entirely (forks, air-gapped installs). Trailing slashes are dropped.
     */
    endpoint: process.env.DIRECTORY_ENDPOINT === undefined
      ? 'https://explore.backspacechat.com'
      : process.env.DIRECTORY_ENDPOINT.trim().replace(/\/+$/, ''),
  },
```

Config test: unset gives the hub URL; `''` gives `''`; `'https://x.test/'` gives `'https://x.test'`. (Set `process.env` in the test and re-import the module with `vi.resetModules()`.)

- [ ] **Step 2: Failing tests for the builder** `document.test.ts` (same in-memory harness as Task 2). Seed with raw SQL: two users, four spaces (A public listed with 2 members, B request listed with 1 member, C public not listed, D private with `directory_listed = 1`), `instance_name = 'Example'`, `federated_registration_open = 1`, `discovery_enabled = 1`, `directory_enabled = 1`. Assert:
  - the document is `{ schema: 1, origin: 'https://home.test', instance: { name: 'Example', federatedRegistrationOpen: true, version: '1.4.0' }, spaces: [A, B] }` ordered A then B (member count desc);
  - each `memberCount` equals what `GET /api/spaces/explore` reports for the same seed (run the explore route's query, `routes/explore.ts`, against the same database in the test and compare per id, so the two never drift);
  - `icon` stored as a bare filename `x.png` becomes `https://home.test/api/uploads/x.png`; stored as `/api/uploads/x.png` becomes `https://home.test/api/uploads/x.png`; stored as `https://home.test/api/uploads/x.png` is kept; stored as `https://other.test/x.png` becomes `null` (never rejected, never forwarded: one foreign icon must not delist the whole document at the hub);
  - with `directory_enabled = 0`, `spaces` is `[]` and the envelope is intact;
  - with `discovery_enabled = 0`, same;
  - a description longer than 200 characters is cut to 200 and a name longer than 100 to 100;
  - 250 listed spaces yield 200.

- [ ] **Step 3: Implement** `document.ts`. Reuse the Explore query shape (`routes/explore.ts`, the `LEFT JOIN space_members` with `COUNT(sm.user_id)`), adding `AND s.directory_listed = 1`, `GROUP BY s.id ORDER BY member_count DESC, s.created_at DESC LIMIT 200`, and the gates read from `instance_settings` in one `SELECT instance_name, federated_registration_open, discovery_enabled, directory_enabled`. The one asset rule, as a small exported `absoluteAssetUrl(value: string | null, origin: string): string | null`: `null` stays `null`; a value starting with `origin + '/'` is kept; any other value starting with `http://` or `https://` becomes `null`; a value starting with `/` becomes `origin + value`; anything else becomes `${origin}/api/uploads/${value}`.

- [ ] **Step 4: Failing route tests** `routes/directory.test.ts` (copy the Fastify + mocked `getDb`/`getRawDb` harness from `routes/settings.test.ts`; mock `../routes/federation/origin.js` `resolveLocalOrigin` to return `'https://home.test'`; mock `../config.js` with `{ config: { version: '1.4.0', directory: { endpoint: 'https://hub.test' } } }`). Assert:
  - `GET /api/directory/spaces` with no auth header returns 200 and the document, with `cache-control: public, max-age=30`;
  - two requests inside 30 s hit the builder once (`vi.spyOn` on the `document.js` module export, mocked via `vi.mock` with a passthrough);
  - after `markDirectoryDirty`, the next request rebuilds (spy count 2);
  - after 30 s (`vi.useFakeTimers()` and `vi.setSystemTime`), the next request rebuilds.

- [ ] **Step 5: Implement the route.** Cache shape: `let cache: { version: number; at: number; doc: DirectoryDocument } | null`. Serve `cache.doc` when `cache.version === getDocumentVersion() && Date.now() - cache.at < 30_000`. No auth `preHandler`. Register in `index.ts` right after `exploreRoutes`. Export `_resetDirectoryRouteCacheForTests()`.

- [ ] **Step 6: Run the three test files**: pass. `pnpm typecheck` passes. Commit `feat(directory): public document endpoint`.

---

### Task 4: Settings, space routes and the instance info field

**Spec:** section 4 (transitions, invariant), section 10 (wire fields).

**Files:**
- Modify: `packages/server/src/routes/settings.ts`, `packages/server/src/routes/spaces.ts`, `packages/server/src/routes/instance.ts`
- Test: extend `packages/server/src/routes/settings.test.ts`; create `packages/server/src/routes/spaces.directory.test.ts` with the same harness; add the `directoryEnabled` assertion wherever `/api/instance/info` is already tested (grep for `instance/info` under `src/routes/*.test.ts`; if nowhere, add `instance.test.ts` with the settings harness).

**Interfaces:**
- Consumes: `markDirectoryDirty`, `readDirectoryState` (Task 2), the four error codes (Task 1).
- Produces: `InstanceAdminSettings.directoryEnabled|directoryLastPingAt|directoryLastError` on both `/api/settings/instance` responses; `Space.directoryListed` in `rowToSpace`; `PATCH /api/spaces/:id` accepting `directoryListed`; `InstanceInfoResponse.directoryEnabled`.

Brief:

1. **One response mapper.** `settings.ts` builds the `InstanceAdminSettings` response twice, verbatim, in `GET` and `PATCH /api/settings/instance`. Extract it into a module-private `rowToAdminSettings(row, sqlite)` first and add the three fields there (`directoryLastError` and `directoryLastPingAt` through `readDirectoryState`, not re-parsed by hand). Both routes use it.
2. **Pre-write read.** `PATCH /api/settings/instance` reads the row only after the write today. Add a `SELECT` of the row before the update in both `PATCH /api/settings/instance` and `PATCH /api/settings/streaming` (the latter already reads `currentRow` for range validation; reuse it).
3. **One helper for the invariant**, module-private: `applyDiscoveryAndDirectory(body, updateData, currentRow, reply): boolean`. Rules: `directoryEnabled: true` while the resulting discovery state is off returns `sendError(reply, 400, 'directory_requires_discovery')`; `discoveryEnabled: false` also writes `directoryEnabled = 0`. Called from both PATCH routes after the existing `discoveryEnabled` handling. The PATCH ignores `directoryLastPingAt` and `directoryLastError` in the body.
4. **Dirty marks** after the write, when any of these changed value between the pre-write row and the body: `directoryEnabled`, `discoveryEnabled`, `instanceName`, `federatedRegistrationOpen`. A PATCH that sends the same value marks nothing.
5. **`PATCH /api/spaces/:id`**: accept `directoryListed` (boolean, else `400 field_not_boolean`); `true` on a space whose resulting visibility is `private` returns `400 directory_private_space`; a visibility change to `private` writes `directoryListed = 0` in the same update. Mark dirty when: `directoryListed` changed in either direction; or the space is listed after the update and any of `name`, `description`, `icon`, `banner`, `avatarColor`, `visibility` changed.
6. **`DELETE /api/spaces/:id`**: mark dirty after the transaction when the deleted row had `directory_listed = 1`.
7. **`rowToSpace`**: `directoryListed: row.directoryListed === 1`.
8. **`/api/instance/info`**: `directoryEnabled: settings?.directoryEnabled === 1`.

Tests to write first, one `it` each: the invariant on both routes (rejects enabling without discovery; discovery off clears directory); each dirty transition marks (spy via `vi.mock('../directory/state.js', async (orig) => ({ ...(await orig()), markDirectoryDirty: vi.fn() }))`) and an unchanged PATCH does not; `directoryListed` on a private space rejected; visibility to private clears the flag; delete of a listed space marks, delete of an unlisted one does not; GET returns the three fields; info returns `directoryEnabled`.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them, confirm they fail for the right reason.**
- [ ] **Step 3: Implement the eight points above.**
- [ ] **Step 4: Run the full server suite** (`npx vitest run`): green. `pnpm typecheck` green.
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
- Produces: `sendDirectoryPing(deps, mem): Promise<PingOutcome>`, `pingerTick(deps, mem, opts?: { boot?: boolean }): Promise<'sent' | 'skipped'>`, `startDirectoryPinger()`, `stopDirectoryPinger()`, `createPingerMemory()`.

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
  - a rejected fetch records `{ status: 'network' }`; a rejection whose `name` is `'TimeoutError'` or `'AbortError'` records `'timeout'`;
  - `pingerTick` with the endpoint `''` never fetches;
  - **boot**: enabled, clean, `lastPingAt` set to today *after* the slot (so the daily rule is not due), `pingerTick(deps, mem, { boot: true })` sends; disabled and clean, boot does not send; disabled and dirty, boot sends;
  - daily: with `directory_enabled = 1`, clean, `lastPingAt` yesterday, a tick one minute before the slot skips and a tick at the slot sends; an event ping earlier today (set `lastPingAt` to 00:05 today, slot at 09:00) does not satisfy the slot;
  - **per-day guard, persisted**: after a failed slot attempt (`directory_last_error.at` on today), later ticks the same day skip even with a fresh `PingerMemory` (simulating a restart), unless dirty;
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
}

export function createPingerMemory(): PingerMemory {
  return { failures: 0, nextRetryAt: null, haltedVersion: null, retired: false };
}

const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];
const TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER_S = 10;

export type PingOutcome = 'accepted' | 'cooldown' | 'origin-rejected' | 'retired' | 'fetch-failed' | 'failed';
```

`sendDirectoryPing`: records `sentVersion = getDocumentVersion()` before the request; POSTs with `signal: AbortSignal.timeout(TIMEOUT_MS)`; then the answer table from spec section 6, writing through the Task 2 functions only. Backoff: `mem.nextRetryAt = now + BACKOFF_MS[Math.min(mem.failures, 3)]`, then `mem.failures += 1`. A `204` sets `failures = 0, nextRetryAt = null`.

`pingerTick(deps, mem, opts = {})`: returns `'skipped'` when `deps.endpoint === ''` or `mem.retired`; reads state; then in order:
  1. if `opts.boot` and (`state.enabled` or `state.dirty`): send (the boot ping the spec requires, independent of the slot);
  2. if `state.dirty` and `mem.haltedVersion !== getDocumentVersion()` and (`mem.nextRetryAt === null || now >= mem.nextRetryAt`): send;
  3. if `state.enabled` and the daily rule holds: minute of day `>= slotMinute(deps.instanceId)`, `state.lastPingAt === null || state.lastPingAt < todaySlotInstant`, and the per-day guard `utcDay(state.lastError?.at) !== today` (the guard is derived from the persisted error, the way the reporter derives its own from `lastError.day`, so a restart loop cannot re-attempt a failing hub more than once a day): send;
  4. else `'skipped'`.

`startDirectoryPinger()`: build production deps (`getRawDb()`, `config.directory.endpoint`, `resolveLocalOrigin()`, `getInstanceId()`, `globalThis.fetch`, `config.version`); one `PingerMemory`; subscribe `onDirectoryDirty` to a 3 s debounced `sendDirectoryPing`; run `pingerTick(deps, mem, { boot: true })` once at boot and `pingerTick(deps, mem)` every 60 s. `stopDirectoryPinger()` clears the interval, the debounce timer and the subscription. Guard: when `config.directory.endpoint === ''`, `start` logs one line and returns.

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

Tests: disabled endpoint; passthrough of validated params (assert the upstream URL); clamping of out-of-range params; cache hit within 60 s (upstream called once for two requests); different `q` misses; 65th distinct query evicts the first; two concurrent identical requests call upstream once; upstream 500 and upstream garbage both map to 502 with the code; the limiter is present with `max: 30` (read it from the route's options: register the routes on a Fastify instance with an `onRoute` hook that captures `routeOptions.config`, since the test app has no `@fastify/rate-limit`).

- [ ] **Step 1: Failing tests. Step 2: Implement. Step 3: Suite green. Step 4: Commit** `feat(directory): feed proxy with cache and limiter`.

---

### Task 7: Hub package, migration, validators

**Spec:** section 7 (tables, ping steps 3 and 6).

**Files:**
- Create: `scripts/directory-hub/` by copying `scripts/telemetry-receiver/` (`package.json` renamed to `@backspace/directory-hub`, `tsconfig.json`, `vitest.config.ts` without `EXPORT_TOKEN`, `test/apply-migrations.ts`, `src/no-runtime-deps.test.ts`, `src/harness.test.ts` adapted to assert the four tables). Delete `page.ts`, the export route and everything telemetry-specific.
- Modify: `pnpm-workspace.yaml`: add `- "scripts/directory-hub"` under the other tooling entries with a one-line comment (`# The space directory hub. See docs/systems/directory.md.`). This is unconditional; the file lists tooling packages one by one on purpose and does not glob `scripts/*`. Run `pnpm install` afterwards so the package is linked.
- Create: `scripts/directory-hub/migrations/0001_directory.sql` with the DDL from spec section 7 verbatim.
- Create: `scripts/directory-hub/wrangler.toml`: `name = "backspace-directory-hub"`, `routes = [{ pattern = "explore.backspacechat.com", custom_domain = true }]`, `RETIRED = "0"`, D1 binding `DB` with `database_name = "backspace-directory"` and `database_id = "REPLACE-AT-ROLLOUT"`, rate limiter `namespace_id = "1002"` with `limit = 2, period = 10`, cron `"23 3 * * *"`, same `compatibility_date` as the receiver.
- Create: `src/env.ts` (copy the receiver's file including its `declare global { namespace Cloudflare { interface Env extends ... {} } }` block, renaming the alias; fields `DB`, `RATE_LIMITER?`, `RETIRED?`, `TEST_MIGRATIONS?`, `HUB_HOST?`), `src/validate.ts`, `src/validate.test.ts`.

**Interfaces:**
- Produces: `parseOrigin(raw: unknown, selfHost: string): { ok: true; origin: string } | { ok: false }`; `parseDocument(text: string, expectedOrigin: string): { ok: true; doc: ValidDocument } | { ok: false; reason: 'invalid' | 'origin-mismatch' }` where `ValidDocument = { instanceName: string; federatedRegistrationOpen: boolean; version: string | null; spaces: ValidSpace[] }` and `ValidSpace = { id, name, description, icon, banner, avatarColor, visibility, memberCount, createdAt }` with the same types as `DirectoryDocumentSpace`, re-declared locally because the hub has no dependency on `@backspace/shared`, and `avatarColor` typed as the literal union `'mint' | 'peach' | 'lavender' | 'sky' | 'amber' | 'rose' | 'coral' | null` (copy the seven values from `AvatarColor` in `packages/shared/src/types.ts` and check them there first); `MAX_DOCUMENT_BYTES = 512 * 1024`; `MAX_PING_BYTES = 1024`.

- [ ] **Step 1: Failing tests** `validate.test.ts`:

`parseOrigin` accepts `'https://chat.example.org'` and canonicalises `'HTTPS://Chat.Example.org'` to the lowercase origin; rejects: not a string, `http://`, a port, userinfo, a path, a query, a fragment, `https://localhost`, `https://127.0.0.1`, `https://[::1]`, a bare `https://example` (no dot), the hub's own host.

`parseDocument`: a well-formed document passes and returns the typed shape; `schema: 2` rejects `invalid`; `origin` different from `expectedOrigin` rejects `origin-mismatch`; a 201-space document rejects; name of 101 characters rejects; description of 201 rejects; `icon: 'https://other.example/x.png'` rejects (must start with `expectedOrigin + '/'`); `icon: null` passes; `memberCount: -1`, `1.5`, `10**9 + 1` reject; `visibility: 'private'` rejects; `avatarColor` must be null or one of the seven literals, anything else becomes `null` (mapped, not rejected: it is cosmetic); `instance.version` must be null/absent or match `/^[0-9A-Za-z.+-]{1,32}$/`; `instance.name` at most 100 characters; a text larger than `MAX_DOCUMENT_BYTES` rejects (measure encoded bytes like the receiver's `parsePing`; this is the second line of defence, the first is the capped reader in Task 8b); unknown top-level fields are ignored, unknown space fields are ignored.

- [ ] **Step 2: Run, fail. Step 3: Implement** `validate.ts` as pure functions with no IO, mirroring the style of the receiver's `validate.ts` (documented constants, one exported function per concern). The IP-literal check: reject when the hostname matches `/^\d{1,3}(\.\d{1,3}){3}$/` or starts with `[`.

- [ ] **Step 4: `pnpm test` green in the hub package** (the harness test asserts the four tables exist; the no-runtime-deps test passes). `pnpm --filter @backspace/directory-hub typecheck` green.

- [ ] **Step 5: Commit** `feat(hub): directory hub scaffold and validators`.

---

### Task 8a: Hub store, hashing and diff writes

**Spec:** section 7 (tables, ping step 7, the feed query).

**Files:**
- Create: `scripts/directory-hub/src/store.ts`, `src/hash.ts`, `src/store.test.ts`, `src/hash.test.ts`

**Interfaces:**
- Consumes: `ValidDocument`, `ValidSpace` (Task 7).
- Produces:
  - `hash.ts`: `documentHash(doc: ValidDocument): Promise<string>` (SHA-256 hex of `JSON.stringify` of the validated document with `spaces` sorted by `id` and each space's keys in the fixed order `id, name, description, icon, banner, avatarColor, visibility, memberCount, createdAt`); `rowHash(space: ValidSpace): Promise<string>` (same key order).
  - `store.ts`: `getLastFetchAt(db, origin): Promise<number | null>`; `touchFetchAttempt(db, origin, at): Promise<void>` (upsert); `readOriginHash(db, origin): Promise<string | null>`; `touchOriginOk(db, origin, at): Promise<void>`; `applyDocument(db, origin, doc: ValidDocument, docHash: string, at: number): Promise<{ inserted: number; updated: number; deleted: number }>`; `feed(db, opts: { q: string; limit: number; offset: number; since: number }): Promise<FeedRow[]>` where `FeedRow` carries every `DirectoryEntry` field in snake case as SQLite returns it; `deleteOlderThan(db, cutoff: number): Promise<number>`.

- [ ] **Step 1: Failing tests** (`cloudflare:test` `env.DB`, like the receiver's harness test):
  - `hash`: the same document in a different `spaces` order and different key order hashes the same; changing one `memberCount` changes both the document hash and that row's hash and no other row's;
  - `applyDocument` on an empty origin inserts every row and the `origins` row with `first_seen_at = last_ok_at = at` and `document_hash`;
  - `touchOriginOk` alone updates `last_ok_at` and nothing else (compare `spaces` rows before and after);
  - applying a document where one space changed `member_count`, one is new and one is gone: exactly one update, one insert, one delete, unchanged rows keep their `row_hash`;
  - applying an empty `spaces` deletes all rows for that origin and keeps the `origins` row;
  - a 200-space document applies as 200 rows. This is a regression guard for the batch path, not a probe of the production statement cap: the local D1 in the test pool accepts far larger batches than production may (the receiver's tests run a 10,001-statement batch), so the cap stays unverified until it is observed against the deployed Worker. Task 14 records that.
  - `feed` orders by `member_count DESC, created_at DESC`, honours `limit` and `offset`, excludes origins with `last_ok_at < since`, excludes a blocked origin (`space_id = '*'`) and a blocked single space, matches `q` against name or description case-insensitively, and treats `%` and `_` in `q` literally (a `q` of `50%` matches a description containing `50%` and not one containing `50 percent`);
  - `deleteOlderThan` removes `origins` (with cascade) and `fetch_attempts` rows older than the cutoff and nothing newer.

- [ ] **Step 2: Implement.** `applyDocument` builds one `db.batch([...])`: `INSERT ... ON CONFLICT(origin) DO UPDATE` for `origins`, one `DELETE` per vanished id, one `INSERT ... ON CONFLICT(origin, id) DO UPDATE` per new or changed row; a document that changes nothing still refreshes `last_ok_at` and `document_hash`. Every statement binds at most 100 parameters (D1's per-statement cap). The `LIKE` uses `ESCAPE '\'` with `%`, `_` and `\` escaped in `q`.

- [ ] **Step 3: Tests green, typecheck green. Commit** `feat(hub): store with hashed diff writes`.

---

### Task 8b: Hub routes, scheduled job and workflow

**Spec:** section 7 (ping steps 1 to 8, the feed route, scheduled job), section 11.

**Files:**
- Create: `scripts/directory-hub/src/index.ts`, `src/index.test.ts`
- Create: `.github/workflows/directory-hub.yml`

**Interfaces:**
- Consumes: Task 7 validators, Task 8a store and hashes.
- Produces: the Worker. The outbound fetch is injectable: `export default` is built by `createWorker(outbound: typeof fetch = globalThis.fetch)`, and `handlePing(request, env, outbound)` takes it as a parameter, so the tests pass a spy and never depend on the pool's undici bridge (`fetchMock` from `cloudflare:test` is not used anywhere in this repo and its behaviour with `redirect: 'manual'` is unverified).

- [ ] **Step 1: Failing handler tests** `index.test.ts`, in the receiver's convention: `createWorker(spy).fetch(req, env, ctx)` with `createExecutionContext()`, a `nextAddress()` helper that gives every request a distinct `cf-connecting-ip` (copy it from the receiver's `index.test.ts`; without it the 2-per-10-s limiter from `wrangler.toml` fails the suite on the third request), and `scheduled` called directly:
  - `410` while `RETIRED = '1'`;
  - `400` on a body over 1024 bytes, on a missing `origin`, on each rejected origin shape (one representative);
  - a valid ping calls the spy with `https://chat.example.org/api/directory/spaces` and an init containing `redirect: 'manual'`, `signal` set, and `headers.accept` of `application/json` (assert the init object; this is how the redirect rule is tested);
  - a spy answering a `302` yields `502 { reason: 'status' }` and leaves rows intact;
  - a valid document answers `204` and the feed then lists its spaces with `origin`, `instanceName`, `federatedRegistrationOpen`;
  - a second ping within 10 s answers `429` with `retry-after: 10` and does not call the spy; a ping for a never-valid origin (spy replied 500) still writes `fetch_attempts`, so its second ping inside 10 s is also `429`;
  - a spy that rejects answers `502 { reason: 'unreachable' }` and leaves earlier rows intact;
  - an invalid document answers `502 { reason: 'invalid' }`; an origin mismatch `502 { reason: 'origin-mismatch' }`; rows intact in both;
  - a response whose body streams more than 512 KB is cut off and answers `502 { reason: 'invalid' }` without buffering the rest (build a `ReadableStream` that yields 1 MB of `"x"` in chunks and asserts the reader stopped pulling after the cap);
  - an empty `spaces` answers `204` and the feed no longer lists that origin's spaces;
  - a document identical to the stored one answers `204` and updates only `last_ok_at`;
  - `GET /v1/spaces` validates `limit` and `offset` like the proxy, returns `{ schema: 1, spaces }`, sends `cache-control: public, max-age=60`, and omits an origin whose `last_ok_at` is older than 3 days; the per-address limiter applies to it too;
  - `scheduled` deletes origins older than 30 days.

- [ ] **Step 2: Implement.** `handlePing` in the order of spec section 7 steps 1 to 8. The body read: check `content-length` first (over `MAX_DOCUMENT_BYTES` → `502 invalid` without reading), then read `response.body` through a reader that accumulates chunks and cancels the stream once the total passes the cap (never `response.text()` on an unbounded body). `GET /v1/spaces`: `caches.default.match(request)` first; on a miss build the response with the header and `ctx.waitUntil(caches.default.put(request, response.clone()))`. The Cache API works in the vitest pool (verified against the pinned `@cloudflare/vitest-pool-workers` 0.22.0), but isolated-storage rollback between tests is not guaranteed for it, so tests that read the feed after a write use a distinct query string per test (a `?t=<n>` the handler ignores) or call `caches.default.delete` in `beforeEach`. `scheduled`: `deleteOlderThan(env.DB, controller.scheduledTime - 30 * 86_400_000)`.

- [ ] **Step 3: Workflow.** Copy `telemetry-receiver.yml`. In the test job rename the `--filter @backspace/telemetry-receiver` targets to `@backspace/directory-hub` and the `paths:` filter to `scripts/directory-hub/**`; in the deploy job rename `environment:` to `directory-hub` and the two `workingDirectory: scripts/telemetry-receiver` values on the `wrangler-action` steps. The GitHub environment `directory-hub` must be created by hand at rollout (Task 14 records it). `actionlint` passes.

- [ ] **Step 4: `pnpm test` and typecheck green. Commit** `feat(hub): ping verification and the feed`.

---

### Task 9: Web API client, dedupe, the shared connect path and the directory store

**Spec:** section 8 (dedupe rule), section 9 (`connectAndJoin` continuation, steps 1 to 4).

**Files:**
- Modify: `packages/web/src/api/client.ts`, `packages/web/src/stores/instanceStore.ts` (export `normalizeOrigin`; add `connectToInstance`), `packages/web/src/components/modals/ConnectedInstances.tsx` (`handleConnect` and `handleFallbackLogin` call `connectToInstance`)
- Delete: `packages/web/src/hooks/useInstanceConnect.ts` (no caller in the repo; its branch is wrong for this use, see below)
- Create: `packages/web/src/utils/directory.ts`, `packages/web/src/utils/directory.test.ts`, `packages/web/src/stores/directoryStore.ts`, `packages/web/src/stores/directoryStore.test.ts`, `packages/web/src/stores/instanceStore.connect.test.ts`

**Interfaces:**
- Consumes: `DirectoryFeed`, `DirectoryEntry` (Task 1); `isSelfOrigin`, `probeInstance`, `connectToRemote`, `reauthenticateInstance`, `loginToRemote`, `DifferentPasswordError` (`instanceStore.ts`); `getApiForOrigin` from `utils/crossStoreResolvers.ts`; `exploreStore.publicJoin`/`requestJoin` (they take a `TaggedExploreSpace`; build one from the entry with `_instanceOrigin: entry.origin`, `joined: false`); `HttpError` and its `code` (`api/client.ts`).
- Produces:
  - `api.directory.list(q?: string, limit = 50, offset = 0): Promise<DirectoryFeed>`;
  - `normalizeOrigin(url: string): string` exported;
  - `connectToInstance(origin: string, password: string, displayName?: string): Promise<ConnectOutcome>` with `type ConnectOutcome = { kind: 'connected'; how: 'new' | 'reconnect' } | { kind: 'needs-remote-password'; remoteUsername: string }`;
  - `dedupeAgainstConnected(entries: DirectoryEntry[], connectedOrigins: string[]): DirectoryEntry[]`;
  - `useDirectoryStore` (shape below).

- [ ] **Step 1: The shared connect path, test first.** Today the only working connect code is inline in `AddInstanceFlow` (`ConnectedInstances.tsx`: `handleConnect` calls `connectToRemote`, catches `DifferentPasswordError` and switches to a fallback form that calls `loginToRemote`). `useInstanceConnect.ts` is unused, branches on whether the origin exists in the store at all (a connected instance would wrongly take the reauthenticate path) and has no fallback. Write `connectToInstance` in `instanceStore.ts` with the branch spec section 9 describes:

```ts
export async function connectToInstance(origin: string, password: string, displayName?: string): Promise<ConnectOutcome> {
  const store = useInstanceStore.getState();
  const canonical = normalizeOrigin(origin);
  const existing = store.instances.find((i) => normalizeOrigin(i.origin) === canonical);
  try {
    if (existing && (existing.status === 'error' || existing.status === 'disconnected')) {
      await store.reauthenticateInstance(existing.origin, password);
      return { kind: 'connected', how: 'reconnect' };
    }
    await store.connectToRemote(canonical, password, displayName);
    return { kind: 'connected', how: 'new' };
  } catch (err) {
    if (err instanceof DifferentPasswordError) return { kind: 'needs-remote-password', remoteUsername: err.remoteUsername };
    throw err;
  }
}
```

Tests (`instanceStore.connect.test.ts`, mocking `connectToRemote`/`reauthenticateInstance` on the store): a known `error` instance reconnects; a known `connected` instance goes through `connectToRemote` (the store's own duplicate handling decides); an unknown origin connects; `DifferentPasswordError` maps to `needs-remote-password`; other errors rethrow. Then make `AddInstanceFlow.handleConnect` call `connectToInstance(probeResult.origin, password, displayName)` and switch to the fallback phase on `needs-remote-password`; `handleFallbackLogin` stays on `loginToRemote`. Delete `useInstanceConnect.ts`.

- [ ] **Step 2: The pure helper, test first** (`directory.test.ts`):

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
  it('ignores a connected value that does not parse', () => {
    expect(dedupeAgainstConnected([e('https://a.test', '1')], ['not a url'])).toHaveLength(1);
  });
});
```

Implement with `new URL(x).origin` on both sides; a `connectedOrigins` value that does not parse is skipped; an entry whose origin does not parse is kept.

- [ ] **Step 3: The store, test first** (`directoryStore.test.ts`; mock `../api/client` and `./instanceStore` the way `components/modals/JoinSpace.test.tsx` mocks stores):
  - `fetch('')` calls `api.directory.list('', 50, 0)`, stores entries minus connected origins (`window.location.origin` plus `useInstanceStore.getState().instances.map(i => i.origin)`, every status), `hasMore` true when a full page came back;
  - `loadMore()` requests `offset + 50` and appends without duplicates by `(origin, id)`;
  - an `HttpError` with code `directory_disabled` sets `status: 'disabled'`, `directory_unreachable` sets `'unreachable'`, anything else `'error'`; success sets `'ok'`;
  - `fetch(q)` resets `offset` and `entries`;
  - `connectAndJoin` on a public entry: `connectToInstance` then `publicJoin`, resolves `{ kind: 'joined', spaceId, origin }`, removes the entry, calls `fetchMyRequests`; on a request entry: `requestJoin` with the message, resolves `{ kind: 'requested' }`; a `publicJoin` rejecting with `HttpError` code `already_member` resolves `joined`; `needs-remote-password` from the connect step is returned as is without joining; `loginAndJoin(entry, username, remotePassword, message?)` runs `loginToRemote` then the same join step.

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
  loginAndJoin: (entry: DirectoryEntry, username: string, remotePassword: string, message?: string) => Promise<ConnectAndJoinResult>;
  reset: () => void;
}
export type ConnectAndJoinResult =
  | { kind: 'joined'; spaceId: string; origin: string }
  | { kind: 'requested' }
  | { kind: 'needs-remote-password'; remoteUsername: string };
```

The join step is one private function `joinAfterConnect(entry, message)` shared by both actions.

- [ ] **Step 4: `api.directory.list`** in `client.ts`, next to `explore`: `request<DirectoryFeed>('GET', '/directory?' + params)`.

- [ ] **Step 5: Tests green, `pnpm typecheck` green. Commit** `feat(web): directory store, origin dedupe and the shared connect path`.

---

### Task 10: SpaceCard extraction and the Outer Space section

**Spec:** section 8 in full, section 2 (names and subtitles).

**Files:**
- Create: `packages/web/src/components/chat/SpaceCard.tsx` (moved out of `ExplorePage.tsx` unchanged in markup, plus the props below)
- Create: `packages/web/src/components/chat/OuterSpaceSection.tsx`
- Modify: `packages/web/src/components/chat/ExplorePage.tsx`
- Modify: `packages/web/src/locales/{en,de,ru,zh}/spaces.json`
- Test: `packages/web/src/components/chat/OuterSpaceSection.test.tsx`, `packages/web/src/components/chat/SpaceCard.test.tsx`, `packages/web/src/components/chat/ExplorePage.search.test.tsx`

**Interfaces:**
- Consumes: Task 9 store; `useSpaceJoin`; `api.instance.info()` for the gate.
- Produces: `SpaceCard` props `{ space: TaggedExploreSpace; onJoinSuccess(spaceId: string): void }` unchanged for Inner, plus an optional `outer?: { entry: DirectoryEntry; onConnect(entry: DirectoryEntry): void }`. When `outer` is set the card renders the origin chip always, a "Closed to new accounts" badge when `entry.federatedRegistrationOpen === false`, and a single action button "Connect and join" (public) or "Connect and request" (request) calling `onConnect`; it does not use `useSpaceJoin`'s join/request actions.

Brief:

1. Extract `SpaceCard` verbatim, then add the `outer` branch. Build the `TaggedExploreSpace` for an outer entry as `{ ...entry, _instanceOrigin: entry.origin, joined: false }`.
2. `ExplorePage`: wrap the existing content (unjoined grid, then the collapsible joined section below it, as today) under a section header "Inner Space" with subtitle "Spaces on your instances", using the header typography the joined section uses (`text-xs font-semibold uppercase tracking-wider text-txt-tertiary`) with the subtitle in `text-[13px] text-txt-tertiary` beneath. Below it render `<OuterSpaceSection query={searchQuery} onConnect={...} />`. The section is gated on the home instance's public `directoryEnabled` flag read once on mount through `api.instance.info()` (unauthenticated, cheap, and known before any fetch, so an instance with the directory off never flashes the header); not on the store's status, which starts `idle`. The existing true-empty state (no Inner spaces at all) must not hide Outer Space: the Inner empty copy renders inside the Inner section and Outer still renders below.
3. The search input drives both: the existing 300 ms debounce also calls `directoryStore.fetch(value)`.
4. `OuterSpaceSection`: header "Outer Space", subtitle "Communities across Backspace"; states: `loading` (inline `LoadingSpinner` in the header when entries exist, full-height spinner when they do not), `unreachable` (the `directory_unreachable` copy from `errors.json`, in the amber notice style ExplorePage uses for `discoveryDisabled`), `error` (rose notice), `ok` with zero entries and a query (`spaces:explore.outer.noMatches`), `ok` with zero entries and no query (`spaces:explore.outer.empty`, with `Mascot state="lonely"` like the page's empty state), `ok` with entries (grid identical to Inner's, `SpaceCard` with `outer`), and a "Show more" button when `hasMore`. On mount call `fetch(query)`.
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

German, Russian, Chinese: "Inner Space"/"Outer Space" translated literally ("Innerer Space"/"Äußerer Space" keeps the loanword the German catalog already uses; "Внутреннее пространство"/"Внешнее пространство"; "内部空间"/"外部空间"). The rest in each catalog's register.

6. Tests: `SpaceCard` outer branch renders the chip, the badge when closed, the right action label per visibility, and calls `onConnect` with the entry. `OuterSpaceSection` renders each of the seven states from a mocked store and calls `loadMore` on "Show more". `ExplorePage.search.test.tsx`: typing in the search box calls both `exploreStore.fetchSpaces` and `directoryStore.fetch` with the same value after the debounce; with `directoryEnabled: false` from the mocked `api.instance.info` the Outer header is never rendered.

- [ ] **Step 1: Failing tests. Step 2: Implement. Step 3: Tests, `pnpm typecheck` green.**
- [ ] **Step 4: Screenshots.** Run the dev harness (`pnpm dev`, or the `run` skill) and capture the Explore page in: both sections populated; Inner empty and Outer populated; Outer unreachable; Outer empty. Save under the scratchpad and list the paths in the task report. The section layout is reviewed on those screenshots before Task 11b starts.
- [ ] **Step 5: Commit** `feat(web): Outer Space section on the Explore page`.

---

### Task 11a: Pending join requests keyed by origin

**Spec:** section 9 step 3, section 12.

**Files:**
- Modify: `packages/web/src/stores/exploreStore.ts`, `packages/web/src/hooks/useSpaceJoin.ts`
- Test: `packages/web/src/stores/exploreStore.requests.test.ts`, `packages/web/src/hooks/useSpaceJoin.test.tsx` (extend if it exists)

**Interfaces:**
- Produces: `exploreStore.myRequests: Array<JoinRequest & { _instanceOrigin: string }>`; `fetchMyRequests(): Promise<void>` that queries home plus every instance with `status === 'connected'` via `Promise.allSettled`, tagging each result with its origin (`''` for home); `useSpaceJoin.isPending` comparing `r.spaceId === space.id && r._instanceOrigin === space._instanceOrigin`.

Brief: this is an existing single-global-id assumption (`useSpaceJoin` matches on `spaceId` alone and `fetchMyRequests` asks only home) that Outer Space would otherwise lean on. Fix it on its own so the modal task starts from a correct base. `requestJoin` tags the request it appends with the space's origin.

Tests: `fetchMyRequests` with one connected instance calls both clients and tags results; a rejected remote call keeps the home results; `isPending` is true only for the matching `(origin, spaceId)` pair and false for the same id on another origin.

- [ ] **Step 1: Failing tests. Step 2: Implement. Step 3: Green. Step 4: Commit** `fix(web): key pending join requests by instance origin`.

---

### Task 11b: The connect-and-join modal

**Spec:** section 9 (steps 1 to 4).

**Files:**
- Create: `packages/web/src/components/modals/RemotePasswordStep.tsx` (extracted from `AddInstanceFlow` in `ConnectedInstances.tsx`: the instance info line, the `registrationClosed` banner, the password form, and the fallback-login form as a `phase` prop), `packages/web/src/components/modals/ConnectAndJoinModal.tsx`, `ConnectAndJoinModal.test.tsx`
- Modify: `packages/web/src/components/modals/ConnectedInstances.tsx` (`AddInstanceFlow` renders `RemotePasswordStep`), `packages/web/src/stores/uiStore.ts` (`'connectAndJoin'` added to the `ModalType` union; the union stays unexported), `packages/web/src/components/layout/AppLayout.tsx` (add `<ConnectAndJoinModal />` to **both** modal lists, mobile and desktop; every modal there is rendered unconditionally and gates itself), `packages/web/src/components/chat/ExplorePage.tsx` (wire `onConnect` to `openModal('connectAndJoin', { entry })`)
- Modify: `packages/web/src/locales/{en,de,ru,zh}/spaces.json`

**Interfaces:**
- Consumes: `directoryStore.connectAndJoin` and `loginAndJoin` (Task 9); `probeInstance` (`instanceStore`); `describeError`; `useUIStore` (`activeModal`, `modalData`, `closeModal`, `showToast` or whatever the toast action is named in `uiStore.ts`).
- Produces: the modal.

Brief:

1. **Self-gating.** `const activeModal = useUIStore((s) => s.activeModal); const modalData = useUIStore((s) => s.modalData); if (activeModal !== 'connectAndJoin') return null;` then narrow `modalData.entry` at the use site with a type guard `isDirectoryEntry(v: unknown): v is DirectoryEntry` (checks `origin`, `id`, `name`, `visibility` are present with the right types); render nothing and log nothing if it fails.
2. **Modal.** `glass-modal` with `bg-black/50` backdrop like the other modals. On open: run `probeInstance(new URL(entry.origin).host)` immediately (the probe performs the self and duplicate checks and returns `federatedRegistrationOpen`); until it resolves show a spinner; on failure show `describeError` and a close button. Then `RemotePasswordStep` in the `password` phase with the intro line `spaces:explore.connect.intro` ("This space lives on {{host}}. Enter your password for {{home}} to create your identity there.") where `home` is the user's home host (`useAuthStore` user `homeInstance` or `window.location.host`). For a `request` space an optional request message textarea (same `REQUEST_MESSAGE_MAX_LENGTH` and placeholder keys as the card) sits above the submit button. Submit calls `connectAndJoin(entry, password, message)`. Results: `joined` closes the modal, `setCurrentSpace(spaceId)`, `navigate('/channels/' + spaceId)` (same as `handleJoinSuccess` in ExplorePage); `requested` closes the modal and shows a toast `spaces:explore.connect.requested`; `needs-remote-password` switches `RemotePasswordStep` to its `fallback` phase (username prefilled with `remoteUsername`), whose submit calls `loginAndJoin(entry, username, remotePassword, message)` and handles the result the same way. Errors through `describeError` inside the step.
3. **Wire** the card's `onConnect` in `ExplorePage` to `openModal('connectAndJoin', { entry })`.
4. Keys: `spaces.explore.connect.{title, intro, requested, connecting}`; reuse `federation:connections.add.*` for the password labels and the closed banner.

Tests: modal renders nothing when `activeModal` is something else; probes on open and shows host and name; closed banner when the probe says closed; submit calls `connectAndJoin` with the entry, password and message; `joined` navigates and closes; `requested` closes with a toast; `needs-remote-password` shows the fallback form and its submit calls `loginAndJoin`; a probe failure shows the error. `AddInstanceFlow` still connects and still falls back (extend its existing test if there is one, otherwise a smoke test that the password phase renders and submits).

- [ ] **Step 1: Failing tests. Step 2: Implement. Step 3: Green, `pnpm typecheck`. Step 4: Screenshot the modal in the password and the fallback phases. Step 5: Commit** `feat(web): connect and join from an Outer Space card`.

---

### Task 12: Admin toggle and the space switch

**Spec:** section 10.

**Files:**
- Modify: `packages/web/src/components/modals/instanceSettingsPanels/GeneralPanel.tsx` (the draft is component-local state in this file; add `directoryEnabled` to it), `packages/web/src/components/modals/SpaceSettings.tsx` (`DiscoveryPanel`), `packages/web/src/stores/settingsStore.ts` (`updateInstanceSettings` mirrors `discoveryEnabled` into `streamingLimits` because `DiscoveryPanel` reads the discovery flag from `streamingLimits`; extend the same mirror with `directoryEnabled`, and add `directoryEnabled` to `InstanceStreamingLimits` in `packages/shared/src/types.ts` plus `rowToLimits` in `routes/settings.ts` so `GET /api/settings/streaming`, which any user may read, carries it)
- Modify: `packages/web/src/locales/{en,de,ru,zh}/admin.json`, `spaces.json`
- Test: `GeneralPanel.directory.test.tsx`, `SpaceSettings.directorySwitch.test.tsx`

**Interfaces:**
- Consumes: `InstanceAdminSettings.directoryEnabled|directoryLastPingAt|directoryLastError`, `Space.directoryListed`, `InstanceStreamingLimits.directoryEnabled` (home) and, for a space on a connected remote instance, that instance's `getApiForOrigin(origin).settings.getStreaming()` from `utils/crossStoreResolvers.ts` (the panel already knows the space's origin through `getChannelOrigin`/the space store; follow how `DiscoveryPanel` resolves `discoveryEnabled` today and extend it the same way).

Brief:

1. **GeneralPanel**, under the discovery block: a second `Toggle` "List spaces in the Backspace directory" with description; `disabled` when `draft.discoveryEnabled === false`, with the reason `admin:general.directory.needsDiscovery` under it; turning discovery off in the draft also turns the directory toggle off in the draft (mirrors the server invariant); when `federatedRegistrationOpen === false` show the amber note `admin:general.directory.registrationClosed`; a status line like `TelemetryPanel`'s: `admin:general.directory.status.never` / `.lastPing` (formatted date and time via `useFormatters`) / `.lastError` (with `status` and, when present, `reason` rendered through a small map to `admin:general.directory.reasons.{unreachable,status,invalid,origin-mismatch}`; a `status` of `'origin'` uses `admin:general.directory.reasons.origin`, which explains that the instance's own address was refused, the case a dev instance with no `DOMAIN` hits); the disclosure sentence `admin:general.directory.disclosure`.
2. **DiscoveryPanel**: a `Toggle` row "List in the Backspace directory" placed after the visibility options and before the description; states: enabled when the instance's `directoryEnabled` is true and the draft `visibility !== 'private'`; disabled with `spaces:settings.discovery.directory.adminOff` when the instance has it off; disabled with `spaces:settings.discovery.directory.privateSpace` when the draft visibility is private (and the draft value is forced to off); the disclosure `spaces:settings.discovery.directory.disclosure`. Saved through `api.spaces.update(spaceId, { ..., directoryListed })` in the same save the panel already does. Never hidden.
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
  "reasons": {
    "unreachable": "the directory could not reach this instance",
    "status": "this instance answered with an error",
    "invalid": "this instance served an invalid document",
    "origin-mismatch": "this instance reports a different address than the one it was reached at",
    "origin": "the directory refused this instance's address; it must be an https domain with no port (set DOMAIN or PUBLIC_ORIGIN)"
  }
}
"spaces.settings.discovery.directory": {
  "label": "List in the Backspace directory",
  "hint": "Show this space in Outer Space on every Backspace instance.",
  "adminOff": "Your admin has to enable the directory for this instance.",
  "privateSpace": "Set visibility to public or request to join first.",
  "disclosure": "Listing makes public: the space's name, description, icon, banner, member count and this instance's address."
}
```

Tests: toggle disabled with reason when discovery is off; turning discovery off in the draft turns the directory off in the draft; enabled otherwise; amber note when federated registration is closed; status line for `never`, `lastPing`, a numeric error, a `fetch` error with reason, and an `origin` error; space switch in each of its three states; save sends `directoryListed`; `updateInstanceSettings` mirrors `directoryEnabled` into `streamingLimits`.

- [ ] **Step 1: Failing tests. Step 2: Implement (server `rowToLimits` and the shared type first, then the store mirror, then the panels). Step 3: Green, `pnpm typecheck`. Step 4: Screenshot both panels. Step 5: Commit** `feat(web): directory toggle and per-space listing switch`.

---

### Task 13: The home sidebar entry

**Spec:** section 8 (navigation).

**Files:**
- Modify: `packages/web/src/components/layout/ChannelSidebar.tsx` (the first of the two placeholder items after Friends), `packages/web/src/locales/{en,de,ru,zh}/spaces.json` (`sidebar.dmList.explore` = "Explore"; the `comingSoon` key stays, the second placeholder still uses it)

Brief: replace the first placeholder `div` with a clickable item that renders the compass SVG from `ExplorePage`'s header, the label, `onClick={() => navigate('/explore')}`, and the selected style (`bg-interactive-selected text-white`) when `location.pathname === '/explore'`, in the same markup as the Friends item above it. The Home item's row condition already excludes `/explore`; its inner SVG is still gated on bare `!currentChannelId`, so give the SVG the row's condition. Leave the second placeholder untouched.

- [ ] **Step 1: Implement. Step 2: `pnpm typecheck` green; screenshot the home sidebar with Explore selected. Step 3: Commit** `feat(web): Explore entry in the home sidebar`.

---

### Task 14: Documentation

**Spec:** section 14.

**Files:**
- Create: `docs/systems/directory.md`
- Modify: `docs/systems/database.md`, `api.md`, `admin.md`, `spaces.md`, `client-federation.md`, `localization.md`, `deployment.md`, `telemetry.md`, `.env.example`, `CLAUDE.md`

Brief: `directory.md` follows the structure of `telemetry.md` (source files list, why it exists, the three facts and the one rule from spec section 3, the state columns with the transition list, the document with its field table and the one asset URL rule, the pinger's answer table and the persisted per-day guard, the hub's routes and tables and the injectable outbound fetch, the blocklist procedure with the exact `wrangler d1 execute backspace-directory --command "INSERT INTO blocks ..."` lines for an origin block and a space block, the WAF rule to create, `DIRECTORY_ENDPOINT` and what empty means, the free-plan paragraph, the rollout checklist (D1 database and its id into `wrangler.toml`, custom domain, WAF rule, GitHub environment `directory-hub`, deploy dispatch), two known limits: the D1 `batch()` statement cap is unverified in production and a dev instance without `DOMAIN` serves `http://localhost:<port>` which the hub refuses as `status: 'origin'`, and what is deferred). Each other doc gets the delta spec section 14 names, in that doc's existing style; `api.md` also records `InstanceStreamingLimits.directoryEnabled`. `.env.example` gets a `DIRECTORY_ENDPOINT` block after the telemetry one in the same voice, saying that an empty value disables the feature. `CLAUDE.md` subsystem table gets a `directory.md` row. `telemetry.md` gets the honest paragraph from spec section 14, not a claim of independence.

- [ ] **Step 1: Write. Step 2: Read each changed doc once end to end for placeholders and stale claims. Step 3: Commit** `docs: space directory subsystem`.

---

### Task 15: End-to-end in the federation harness

**Spec:** section 15 (harness case), section 3.

**Files:**
- Create: `packages/server/test/directory-e2e.test.ts`
- Modify: `packages/server/test/helpers/twoInstanceHarness.ts`: `SpawnInstanceOptions.directoryEndpoint?: string` and `BootOptions.directoryEndpoint?: string`. The child env is built as `{ ...process.env, ... }`, so a developer's own `DIRECTORY_ENDPOINT` would otherwise reach every spawned instance and start a live pinger in unrelated federation tests. Set `env.DIRECTORY_ENDPOINT = opts.directoryEndpoint ?? ''` explicitly, in the same place and for the same reason `DISABLE_FEDERATION_WORKERS` is set explicitly in both branches.

Brief: start a stub hub in the test process (a plain `node:http` server on an ephemeral port) that records pings and, on each, fetches `${origin}/api/directory/spaces` itself and stores the result per origin, answering `204`. Boot two instances with `directoryEndpoint` pointed at the stub and `publicOriginAsTransport: true` (so the served `origin` matches the transport origin the stub fetches; the stub does not run the hub's origin validator, it only fetches). Then: register an admin on instance A, enable discovery and the directory, create a public space, set `directoryListed: true`, and wait (poll up to 10 s) until the stub holds that space for A's origin. Then set `directoryListed: false` and assert the stub's next stored document for A has no spaces within 10 s. Then switch the directory off and assert the same. Finally, with the stub answering `502 { reason: 'unreachable' }` for one ping, assert `GET /api/settings/instance` on A shows `directoryLastError.status === 'fetch'` and `reason === 'unreachable'`, and that after the stub recovers the next ping clears it.

- [ ] **Step 1: Write the test. Step 2: Run `npx vitest run test/directory-e2e.test.ts`: green. Step 3: Full server suite green (the existing federation tests must not have started a pinger: grep their logs for the pinger's start line, it must be absent). Step 4: Commit** `test(directory): end to end listing and delisting`.

---

## Self-review against the spec

- Section 2 naming: Task 10 (headers and subtitles), Task 13 (sidebar).
- Section 3 facts and the one rule: Task 2 (version), Task 3 (cache keyed on version), Task 5 (version-guarded clear), Task 8a and 8b (never delete on failure, replace not merge).
- Section 4: Task 2 (columns, state), Task 4 (transitions, invariant, wire fields), Task 1 (types).
- Section 5: Task 3 (including the one asset rule and the explore-count comparison).
- Section 6: Task 5 (explicit boot ping, daily slot, persisted per-day guard, answer table, backoff, own guard).
- Section 7: Tasks 7, 8a, 8b (tables, validators, ping steps, capped reader, feed, scheduled, workflow).
- Section 8: Tasks 9 (dedupe by origin), 10 (sections gated on the public flag, card, states, search driving both), 13 (sidebar).
- Section 9: Task 6 (proxy with limiter asserted), Task 9 (the shared connect path with the status branch, `connectAndJoin`, `loginAndJoin`), Task 11a (origin-keyed requests), Task 11b (modal, both `AppLayout` lists).
- Section 10: Task 12 (including the `streamingLimits` mirror so the space panel sees the flag).
- Section 11: Task 7 (URL pinning, origin validation), Task 8b (cooldown on every origin, limiter, size cap), Task 12 (disclosure copy), Task 14 (blocklist procedure, WAF rule).
- Section 13: Tasks 1, 10, 11b, 12.
- Section 14: Task 14. Section 15: every task's tests plus Task 15. Section 18 (rollout) is a manual checklist in `directory.md`.

Names used across tasks: `DirectoryPingError`, `DirectoryDocument` (with `instance.version: string | null`), `DirectoryDocumentSpace`, `DirectoryEntry`, `DirectoryFeed` (Task 1); `readDirectoryState`, `markDirectoryDirty`, `getDocumentVersion`, `onDirectoryDirty`, `recordDirectoryPingSuccess`, `recordDirectoryPingFailure`, `clearDirectoryDirty` (Task 2, used by 3, 4, 5); `buildDirectoryDocument`, `absoluteAssetUrl`, `config.directory.endpoint` (Task 3, used by 5, 6); `parseOrigin`, `parseDocument`, `ValidDocument`, `ValidSpace` (Task 7, used by 8a, 8b); `documentHash`, `rowHash`, `applyDocument`, `feed`, `touchFetchAttempt`, `getLastFetchAt`, `readOriginHash`, `touchOriginOk`, `deleteOlderThan` (Task 8a, used by 8b); `createWorker(outbound)` (Task 8b); `normalizeOrigin`, `connectToInstance`, `ConnectOutcome`, `api.directory.list`, `dedupeAgainstConnected`, `useDirectoryStore` with `connectAndJoin`, `loginAndJoin`, `ConnectAndJoinResult` (Task 9, used by 10, 11b); `SpaceCard` `outer` prop (Task 10, used by 11b); `myRequests[]._instanceOrigin` (Task 11a, used by `useSpaceJoin`); `RemotePasswordStep` (Task 11b); `InstanceStreamingLimits.directoryEnabled` (Task 12).
