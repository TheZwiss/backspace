# Instance Update Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an admin aware that a newer Backspace release exists without them having to open Instance settings -> Updates, via unread-style dots on the settings entry points plus one in-app toast per version.

**Architecture:** Entirely client-side. The existing admin-only `GET /api/admin/instance/update-status` is lifted out of `UpdatesPanel` into `settingsStore`, fetched once when the home-instance WebSocket reports an admin session and refreshed every 6h while that session lives. A pure module decides whether to badge and whether to toast, from the status plus a per-user localStorage acknowledgement record. No server change, no new route, no schema change.

**Tech Stack:** React 18, Zustand 5, TypeScript strict, Tailwind 3, i18next, Vitest + @testing-library/react.

**Spec:** `/private/tmp/claude-501/-Users-jbraun-backspace-public/5422ded3-2069-4358-84fb-0611dafbef36/scratchpad/update-badge-design.md` (revised after code review). Copy it into the worktree if the scratchpad is gone; the plan restates every decision it depends on.

## Global Constraints

- TypeScript strict. No `any`. No placeholder code, no TODO comments, no partial components (CLAUDE.md).
- **Every new user-facing string must be added to all three catalogs — `packages/web/src/locales/{en,ru,de}/admin.json` — in the same commit as the code that uses it.** `scripts/check-i18n.mjs` runs inside both `pnpm typecheck` and the web build, and `scripts/i18n-pending.txt` is empty, so the literal-string rule applies to every file this plan touches. A German value byte-identical to English fails Rule 5.
- New update strings belong to the **`admin`** namespace under `admin:updates.*`, not `settings`. Mobile row labels are `admin:mobile.sections.*`.
- Badge colour is `accent-amber`, matching the existing informational settings badge (`SettingsTabBar.tsx:26`). Do **not** use `accent-rose` / `bg-notification`, which this codebase reserves for mentions and unread messages.
- Federation rule: the update status is the **home instance only**. Never resolve it per-origin, and never derive the admin gate from anything origin-agnostic. `settingsStore.isAdmin` is safe because it is set only under `isHome`.
- Nothing in this plan may add a way to trigger an update from the UI. See `docs/systems/admin.md` "Why there is no endpoint that performs the update".
- Commit after each task. Do not squash tasks together.

**Running tests:** web tests are jsdom and need no native modules, so the server's `better-sqlite3` recipe does not apply. From the repo root:
```bash
cd packages/web && npx vitest run src/path/to/file.test.ts
```
Full gate before the final commit: `pnpm typecheck` from the repo root (this also runs the i18n check).

---

### Task 1: Acknowledgement record and badge derivation

Pure module, no React, no network. Mirrors the shape of `packages/web/src/utils/telemetryAsk.ts`: an injected `Store` so tests never touch real `localStorage`, and every read tolerant of corrupt or unavailable storage.

**Files:**
- Create: `packages/web/src/utils/updateAck.ts`
- Test: `packages/web/src/utils/updateAck.test.ts`

**Interfaces:**
- Consumes: `InstanceUpdateStatus` from `@backspace/shared`.
- Produces:
  - `interface UpdateAck { seenVersion: string | null; toastShownFor: string | null }`
  - `const EMPTY_ACK: UpdateAck`
  - `function ackStorageKey(userId: string): string`
  - `function readUpdateAck(storage: Store, userId: string | null): UpdateAck`
  - `function writeUpdateAck(storage: Store, userId: string | null, ack: UpdateAck): void`
  - `function shouldBadgeUpdate(status: InstanceUpdateStatus | null, ack: UpdateAck, isAdmin: boolean): boolean`
  - `function shouldToastUpdate(status: InstanceUpdateStatus | null, ack: UpdateAck, isAdmin: boolean): boolean`
  - `function pendingUpdateVersion(status: InstanceUpdateStatus | null): string | null`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/utils/updateAck.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { InstanceUpdateStatus } from '@backspace/shared';
import {
  EMPTY_ACK,
  ackStorageKey,
  readUpdateAck,
  writeUpdateAck,
  shouldBadgeUpdate,
  shouldToastUpdate,
  pendingUpdateVersion,
} from './updateAck';

/** In-memory Storage stand-in. `throwing` simulates private-mode denial. */
function makeStorage(seed: Record<string, string> = {}, throwing = false) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => {
      if (throwing) throw new Error('denied');
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throwing) throw new Error('denied');
      map.set(k, v);
    },
    dump: () => Object.fromEntries(map),
  };
}

function status(over: Partial<InstanceUpdateStatus> = {}): InstanceUpdateStatus {
  return {
    current: { version: '1.2.1', commit: 'abc1234' },
    latest: { version: '1.3.0', url: 'https://github.com/TheZwiss/backspace/releases/tag/v1.3.0', publishedAt: '2026-09-08T00:00:00Z' },
    state: 'update-available',
    checkedAt: 1_757_000_000_000,
    checkEnabled: true,
    reason: null,
    channel: 'prebuilt',
    ...over,
  };
}

describe('ackStorageKey', () => {
  it('scopes the key to the user id', () => {
    expect(ackStorageKey('u1')).toBe('backspace_update_ack_u1');
  });
});

describe('readUpdateAck', () => {
  it('returns the empty ack when nothing is stored', () => {
    expect(readUpdateAck(makeStorage(), 'u1')).toEqual(EMPTY_ACK);
  });

  it('returns the empty ack for a null user id', () => {
    expect(readUpdateAck(makeStorage(), null)).toEqual(EMPTY_ACK);
  });

  it('reads a stored record', () => {
    const storage = makeStorage({
      'backspace_update_ack_u1': JSON.stringify({ seenVersion: '1.3.0', toastShownFor: '1.3.0' }),
    });
    expect(readUpdateAck(storage, 'u1')).toEqual({ seenVersion: '1.3.0', toastShownFor: '1.3.0' });
  });

  it('returns the empty ack for corrupt JSON rather than throwing', () => {
    const storage = makeStorage({ 'backspace_update_ack_u1': '{not json' });
    expect(readUpdateAck(storage, 'u1')).toEqual(EMPTY_ACK);
  });

  it('returns the empty ack for a wrong-shaped record', () => {
    const storage = makeStorage({ 'backspace_update_ack_u1': JSON.stringify({ seenVersion: 7 }) });
    expect(readUpdateAck(storage, 'u1')).toEqual(EMPTY_ACK);
  });

  it('returns the empty ack when storage access throws', () => {
    expect(readUpdateAck(makeStorage({}, true), 'u1')).toEqual(EMPTY_ACK);
  });
});

describe('writeUpdateAck', () => {
  it('persists under the scoped key', () => {
    const storage = makeStorage();
    writeUpdateAck(storage, 'u1', { seenVersion: '1.3.0', toastShownFor: null });
    expect(JSON.parse(storage.dump()['backspace_update_ack_u1'] ?? '{}')).toEqual({
      seenVersion: '1.3.0',
      toastShownFor: null,
    });
  });

  it('writes nothing for a null user id', () => {
    const storage = makeStorage();
    writeUpdateAck(storage, null, { seenVersion: '1.3.0', toastShownFor: null });
    expect(storage.dump()).toEqual({});
  });

  it('swallows a storage denial', () => {
    expect(() => writeUpdateAck(makeStorage({}, true), 'u1', EMPTY_ACK)).not.toThrow();
  });
});

describe('pendingUpdateVersion', () => {
  it('returns the version when an update is available', () => {
    expect(pendingUpdateVersion(status())).toBe('1.3.0');
  });

  it('returns null for a null status', () => {
    expect(pendingUpdateVersion(null)).toBeNull();
  });

  it('returns null when the state is unknown even though latest is populated', () => {
    // Reachable: compareVersions returns null when the RUNNING version does not
    // parse, so the server can report a latest release alongside state 'unknown'.
    expect(pendingUpdateVersion(status({ state: 'unknown', reason: 'unparseable' }))).toBeNull();
  });

  it('returns null when up to date', () => {
    expect(pendingUpdateVersion(status({ state: 'up-to-date', latest: { version: '1.2.1', url: 'u', publishedAt: '' } }))).toBeNull();
  });
});

describe('shouldBadgeUpdate', () => {
  it('badges an unseen available update for an admin', () => {
    expect(shouldBadgeUpdate(status(), EMPTY_ACK, true)).toBe(true);
  });

  it('does not badge a non-admin', () => {
    expect(shouldBadgeUpdate(status(), EMPTY_ACK, false)).toBe(false);
  });

  it('does not badge a version already seen', () => {
    expect(shouldBadgeUpdate(status(), { seenVersion: '1.3.0', toastShownFor: null }, true)).toBe(false);
  });

  it('badges again when a newer version supersedes the seen one', () => {
    expect(shouldBadgeUpdate(status(), { seenVersion: '1.2.9', toastShownFor: null }, true)).toBe(true);
  });

  it('does not badge when the check is disabled', () => {
    expect(shouldBadgeUpdate(status({ state: 'unknown', reason: 'disabled', latest: null, checkEnabled: false }), EMPTY_ACK, true)).toBe(false);
  });

  it('does not badge on an unreachable lookup', () => {
    expect(shouldBadgeUpdate(status({ state: 'unknown', reason: 'unreachable', latest: null }), EMPTY_ACK, true)).toBe(false);
  });

  it('does not badge when the status has not loaded', () => {
    expect(shouldBadgeUpdate(null, EMPTY_ACK, true)).toBe(false);
  });
});

describe('shouldToastUpdate', () => {
  it('toasts an available update never toasted before', () => {
    expect(shouldToastUpdate(status(), EMPTY_ACK, true)).toBe(true);
  });

  it('does not toast the same version twice', () => {
    expect(shouldToastUpdate(status(), { seenVersion: null, toastShownFor: '1.3.0' }, true)).toBe(false);
  });

  it('toasts a newer version even after the panel was viewed for it', () => {
    expect(shouldToastUpdate(status(), { seenVersion: '1.3.0', toastShownFor: '1.2.9' }, true)).toBe(true);
  });

  it('does not toast a non-admin', () => {
    expect(shouldToastUpdate(status(), EMPTY_ACK, false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/utils/updateAck.test.ts`
Expected: FAIL — `Failed to resolve import "./updateAck"`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/utils/updateAck.ts`:

```ts
import type { InstanceUpdateStatus } from '@backspace/shared';

/**
 * Per-admin, per-browser record of what has already been acknowledged about an
 * available instance update.
 *
 * Two acknowledgements, deliberately kept apart:
 *
 *  - `toastShownFor` is written when the toast is SHOWN, not when it is
 *    dismissed. The toast model cannot distinguish a dismissal from its own
 *    5-second timeout, so "shown at most once per version per browser" is the
 *    only guarantee it can actually honour.
 *  - `seenVersion` is written when the admin opens the Updates panel, and is
 *    what clears the dot.
 *
 * Stored per user id, following the precedent at `stores/instanceStore.ts`
 * (`backspace_instances_<userId>`), so two admins sharing a browser do not
 * silence each other's dot. localStorage is already origin-partitioned and the
 * Electron renderer loads each instance by URL, so two instances never share a
 * record.
 *
 * Every access is wrapped: a browser in private mode throws on access, and the
 * right failure there is to show the dot again rather than to break the render.
 */

const STORAGE_KEY_PREFIX = 'backspace_update_ack';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export interface UpdateAck {
  /** Latest version whose Updates panel the admin has opened. Clears the dot. */
  seenVersion: string | null;
  /** Latest version the toast has been shown for. Suppresses a repeat toast. */
  toastShownFor: string | null;
}

export const EMPTY_ACK: UpdateAck = { seenVersion: null, toastShownFor: null };

export function ackStorageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}_${userId}`;
}

export function readUpdateAck(storage: Store, userId: string | null): UpdateAck {
  if (userId === null) return EMPTY_ACK;
  try {
    const raw = storage.getItem(ackStorageKey(userId));
    if (raw === null) return EMPTY_ACK;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' && parsed !== null
      && (typeof (parsed as UpdateAck).seenVersion === 'string' || (parsed as UpdateAck).seenVersion === null)
      && (typeof (parsed as UpdateAck).toastShownFor === 'string' || (parsed as UpdateAck).toastShownFor === null)
    ) {
      return parsed as UpdateAck;
    }
  } catch {
    /* storage unavailable or corrupt: behave as never acknowledged */
  }
  return EMPTY_ACK;
}

export function writeUpdateAck(storage: Store, userId: string | null, ack: UpdateAck): void {
  if (userId === null) return;
  try {
    storage.setItem(ackStorageKey(userId), JSON.stringify(ack));
  } catch {
    /* private mode: the dot returns next session, which is the safe failure */
  }
}

/**
 * The version an admin should be told about, or null.
 *
 * Guarded on `state` rather than on `latest` alone. `latest !== null` with
 * `state: 'unknown'` is reachable — the server reports `unknown` when the
 * RUNNING version fails to parse, even though it successfully read a release —
 * and badging off `latest` there would nag an operator the server cannot
 * actually compare. This mirrors `UpdatesPanel`'s own `updateAvailable` guard.
 */
export function pendingUpdateVersion(status: InstanceUpdateStatus | null): string | null {
  if (status === null) return null;
  if (status.state !== 'update-available') return null;
  return status.latest?.version ?? null;
}

export function shouldBadgeUpdate(
  status: InstanceUpdateStatus | null,
  ack: UpdateAck,
  isAdmin: boolean,
): boolean {
  if (!isAdmin) return false;
  const version = pendingUpdateVersion(status);
  return version !== null && ack.seenVersion !== version;
}

export function shouldToastUpdate(
  status: InstanceUpdateStatus | null,
  ack: UpdateAck,
  isAdmin: boolean,
): boolean {
  if (!isAdmin) return false;
  const version = pendingUpdateVersion(status);
  return version !== null && ack.toastShownFor !== version;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/utils/updateAck.test.ts`
Expected: PASS, 25 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/utils/updateAck.ts packages/web/src/utils/updateAck.test.ts
git commit -m "feat(web): add update acknowledgement record and badge derivation"
```

---

### Task 2: Store the update status in settingsStore

Moves ownership of the status off `UpdatesPanel`. The store carries loading and error state too, because the panel's existing error UI depends on both and Task 8 hands that UI the store's values.

**Files:**
- Modify: `packages/web/src/stores/settingsStore.ts`
- Test: `packages/web/src/stores/settingsStore.updates.test.ts`

**Interfaces:**
- Consumes: `readUpdateAck`, `writeUpdateAck`, `UpdateAck`, `EMPTY_ACK` from Task 1; `api.admin.updateStatus(refresh?: boolean)`.

**Do NOT import `authStore` into `settingsStore`.** It pulls in
`voiceStore -> audio/AudioManager -> @sapphi-red/web-noise-suppressor`, which
touches `AudioWorkletNode` at module scope; jsdom has none, so four existing
suites (`settingsStore.telemetry.test.ts`, `TelemetryPanel.test.tsx`, both
`FederationPanel` tests) and every new test here would die with
`ReferenceError: AudioWorkletNode is not defined`. The store carries the id it
needs instead, handed to it by the WebSocket `ready` handler in Task 3.
- Produces, added to `SettingsState`:
  - `updateStatus: InstanceUpdateStatus | null`
  - `updateStatusLoading: boolean`
  - `updateStatusError: string`
  - `updateAck: UpdateAck`
  - `fetchUpdateStatus: (refresh?: boolean) => Promise<void>`
  - `markUpdateSeen: () => void`
  - `markUpdateToastShown: () => void`
  - `stopUpdateStatusRefresh: () => void`
  - exported const `UPDATE_STATUS_REFRESH_MS = 6 * 60 * 60 * 1000`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/stores/settingsStore.updates.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InstanceUpdateStatus } from '@backspace/shared';
import { api } from '../api/client';
import { useSettingsStore, UPDATE_STATUS_REFRESH_MS } from './settingsStore';
import { EMPTY_ACK, ackStorageKey } from '../utils/updateAck';

function status(over: Partial<InstanceUpdateStatus> = {}): InstanceUpdateStatus {
  return {
    current: { version: '1.2.1', commit: 'abc1234' },
    latest: { version: '1.3.0', url: 'https://example.invalid', publishedAt: '2026-09-08T00:00:00Z' },
    state: 'update-available',
    checkedAt: 1_757_000_000_000,
    checkEnabled: true,
    reason: null,
    channel: 'prebuilt',
    ...over,
  };
}

describe('settingsStore update status', () => {
  beforeEach(() => {
    // Block body, not an expression body: a value returned from beforeEach is
    // treated by vitest as a teardown callback.
    localStorage.clear();
    useSettingsStore.getState().stopUpdateStatusRefresh();
    useSettingsStore.setState({
      updateStatus: null,
      updateStatusLoading: false,
      updateStatusError: '',
      updateAck: EMPTY_ACK,
      updateAckUserId: 'u1',
      isAdmin: true,
    });
  });

  afterEach(() => {
    useSettingsStore.getState().stopUpdateStatusRefresh();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('stores the fetched status and hydrates the ack from localStorage', async () => {
    localStorage.setItem(ackStorageKey('u1'), JSON.stringify({ seenVersion: '1.2.9', toastShownFor: null }));
    const spy = vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());

    await useSettingsStore.getState().fetchUpdateStatus();

    expect(spy).toHaveBeenCalledWith(false);
    expect(useSettingsStore.getState().updateStatus?.latest?.version).toBe('1.3.0');
    expect(useSettingsStore.getState().updateAck).toEqual({ seenVersion: '1.2.9', toastShownFor: null });
    expect(useSettingsStore.getState().updateStatusLoading).toBe(false);
    expect(useSettingsStore.getState().updateStatusError).toBe('');
  });

  it('passes refresh through', async () => {
    const spy = vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());
    await useSettingsStore.getState().fetchUpdateStatus(true);
    expect(spy).toHaveBeenCalledWith(true);
  });

  it('coalesces concurrent calls into one request', async () => {
    const spy = vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());
    await Promise.all([
      useSettingsStore.getState().fetchUpdateStatus(),
      useSettingsStore.getState().fetchUpdateStatus(),
      useSettingsStore.getState().fetchUpdateStatus(),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not let an explicit refresh join a cached fetch already in flight', async () => {
    const spy = vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());
    await Promise.all([
      useSettingsStore.getState().fetchUpdateStatus(false),
      useSettingsStore.getState().fetchUpdateStatus(true),
    ]);
    expect(spy).toHaveBeenCalledWith(false);
    expect(spy).toHaveBeenCalledWith(true);
  });

  it('hydrates the ack when the ack user is set', () => {
    localStorage.setItem(ackStorageKey('u2'), JSON.stringify({ seenVersion: '1.4.0', toastShownFor: null }));
    useSettingsStore.getState().setUpdateAckUser('u2');
    expect(useSettingsStore.getState().updateAck.seenVersion).toBe('1.4.0');
  });

  it('records the error and clears loading on failure', async () => {
    vi.spyOn(api.admin, 'updateStatus').mockRejectedValue(new Error('boom'));
    await useSettingsStore.getState().fetchUpdateStatus();
    expect(useSettingsStore.getState().updateStatusError).not.toBe('');
    expect(useSettingsStore.getState().updateStatusLoading).toBe(false);
    expect(useSettingsStore.getState().updateStatus).toBeNull();
  });

  it('re-fetches after the refresh interval', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());

    await useSettingsStore.getState().fetchUpdateStatus();
    expect(spy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(UPDATE_STATUS_REFRESH_MS + 10);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('stops re-fetching once the refresh is stopped', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());

    await useSettingsStore.getState().fetchUpdateStatus();
    useSettingsStore.getState().stopUpdateStatusRefresh();

    await vi.advanceTimersByTimeAsync(UPDATE_STATUS_REFRESH_MS * 2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('markUpdateSeen persists and exposes the seen version', async () => {
    vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());
    await useSettingsStore.getState().fetchUpdateStatus();

    useSettingsStore.getState().markUpdateSeen();

    expect(useSettingsStore.getState().updateAck.seenVersion).toBe('1.3.0');
    expect(JSON.parse(localStorage.getItem(ackStorageKey('u1')) ?? '{}').seenVersion).toBe('1.3.0');
  });

  it('markUpdateToastShown persists without touching seenVersion', async () => {
    vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());
    await useSettingsStore.getState().fetchUpdateStatus();

    useSettingsStore.getState().markUpdateToastShown();

    expect(useSettingsStore.getState().updateAck).toEqual({ seenVersion: null, toastShownFor: '1.3.0' });
  });

  it('marking is a no-op when no update is pending', async () => {
    vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status({ state: 'up-to-date' }));
    await useSettingsStore.getState().fetchUpdateStatus();

    useSettingsStore.getState().markUpdateSeen();

    expect(useSettingsStore.getState().updateAck).toEqual(EMPTY_ACK);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/stores/settingsStore.updates.test.ts`
Expected: FAIL — `UPDATE_STATUS_REFRESH_MS` is not exported and `fetchUpdateStatus` is not a function.

- [ ] **Step 3: Write the implementation**

In `packages/web/src/stores/settingsStore.ts`, extend the imports at the top:

```ts
import { create } from 'zustand';
import type { InstanceStreamingLimits, InstanceAdminSettings, TelemetryPayload, TelemetryStatus, InstanceUpdateStatus } from '@backspace/shared';
import { api } from '../api/client';
import { describeError } from '../i18n/errors';
import { EMPTY_ACK, readUpdateAck, writeUpdateAck, pendingUpdateVersion, type UpdateAck } from '../utils/updateAck';
```

`describeError` is safe to import here; `authStore` is not, for the reason in
the Interfaces block above.

Add to the `SettingsState` interface, after `setIsAdmin`:

```ts
  updateStatus: InstanceUpdateStatus | null;
  updateStatusLoading: boolean;
  updateStatusError: string;
  updateAck: UpdateAck;
  updateAckUserId: string | null;
  fetchUpdateStatus: (refresh?: boolean) => Promise<void>;
  markUpdateSeen: () => void;
  markUpdateToastShown: () => void;
  setUpdateAckUser: (userId: string | null) => void;
  stopUpdateStatusRefresh: () => void;
```

Above `export const useSettingsStore`, add the module-level refresh machinery:

```ts
/**
 * How often a live session re-asks for the update status.
 *
 * Matched to the server's own six-hour success cache, so a refresh that lands
 * inside the window costs nothing outbound. Without this, the admin the feature
 * exists for — the one who never opens settings and never reloads a long-lived
 * desktop window — would learn about a release only on their next sign-in.
 */
export const UPDATE_STATUS_REFRESH_MS = 6 * 60 * 60 * 1000;

let updateStatusTimer: ReturnType<typeof setTimeout> | null = null;
/** Coalesces concurrent callers (WS ready and a panel mount) into one request. */
let updateStatusInFlight: Promise<void> | null = null;
```

Add the implementations inside the store body, after `setIsAdmin`:

```ts
  updateStatus: null,
  updateStatusLoading: false,
  updateStatusError: '',
  updateAck: EMPTY_ACK,
  updateAckUserId: null,

  /**
   * Records whose acknowledgements to read and write, handed over by the
   * WebSocket `ready` handler. It lives here rather than being read from
   * `authStore` because importing that store into this one drags the audio
   * pipeline into every test that touches settings.
   */
  setUpdateAckUser: (userId) => {
    set({ updateAckUserId: userId, updateAck: readUpdateAck(localStorage, userId) });
  },

  /**
   * Asks the home instance whether a newer release exists.
   *
   * Admin-gated on the client as well as the server, so a non-admin session
   * never issues a request that could only 403. The reschedule happens on every
   * completed call, including an explicit panel refresh, which keeps exactly one
   * timer alive regardless of how many callers there are.
   */
  fetchUpdateStatus: async (refresh = false) => {
    // Deliberately NOT gated on `isAdmin` here. That flag is set only by the
    // WebSocket `ready` handler, so a panel rendered before `ready` lands (or
    // during a reconnect) would be permanently stuck on an empty error state
    // with a "Try again" button that also did nothing. Both call sites are
    // admin-only by construction: the `ready` handler checks the flag it just
    // received, and UpdatesPanel only renders inside the admin-gated Instance
    // settings tab.
    //
    // An explicit refresh never joins an in-flight cached fetch: doing so would
    // silently downgrade a "Check again" click to whatever the earlier call
    // asked for.
    if (!refresh && updateStatusInFlight !== null) return updateStatusInFlight;

    set({ updateStatusLoading: true, updateStatusError: '' });

    updateStatusInFlight = (async () => {
      try {
        const result = await api.admin.updateStatus(refresh);
        set({
          updateStatus: result,
          updateAck: readUpdateAck(localStorage, useSettingsStore.getState().updateAckUserId),
          updateStatusError: '',
        });
      } catch (err) {
        set({ updateStatusError: describeError(err) });
      } finally {
        set({ updateStatusLoading: false });
        updateStatusInFlight = null;
        if (updateStatusTimer !== null) clearTimeout(updateStatusTimer);
        updateStatusTimer = setTimeout(() => {
          void useSettingsStore.getState().fetchUpdateStatus();
        }, UPDATE_STATUS_REFRESH_MS);
      }
    })();

    return updateStatusInFlight;
  },

  markUpdateSeen: () => {
    const version = pendingUpdateVersion(useSettingsStore.getState().updateStatus);
    if (version === null) return;
    const userId = useSettingsStore.getState().updateAckUserId;
    const next: UpdateAck = { ...useSettingsStore.getState().updateAck, seenVersion: version };
    writeUpdateAck(localStorage, userId, next);
    set({ updateAck: next });
  },

  markUpdateToastShown: () => {
    const version = pendingUpdateVersion(useSettingsStore.getState().updateStatus);
    if (version === null) return;
    const userId = useSettingsStore.getState().updateAckUserId;
    const next: UpdateAck = { ...useSettingsStore.getState().updateAck, toastShownFor: version };
    writeUpdateAck(localStorage, userId, next);
    set({ updateAck: next });
  },

  /** Called on logout, and by tests, so a dead session leaves no timer behind. */
  stopUpdateStatusRefresh: () => {
    if (updateStatusTimer !== null) {
      clearTimeout(updateStatusTimer);
      updateStatusTimer = null;
    }
  },
```

Note: the store factory currently reads `create<SettingsState>((set) => ({ ... }))`. The new actions call `useSettingsStore.getState()` rather than the factory's `get`, matching how `fetchGifEnabled` and friends already reference the store; no signature change is needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/stores/settingsStore.updates.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Verify nothing else in the store regressed**

Run: `cd packages/web && npx vitest run src/stores/settingsStore.telemetry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/stores/settingsStore.ts packages/web/src/stores/settingsStore.updates.test.ts
git commit -m "feat(web): move instance update status into settingsStore"
```

---

### Task 3: Fetch on the home admin session, and correct the documented promise

The trigger moves from "an admin has the Updates panel open" to "an admin is signed in". `useWebSocket`'s `ready` handler is the correct hook: it is already gated on `isHome`, already sets `isAdmin`, already fires two sibling fetches, and runs once per WebSocket session. `AppLayout` is wrong for this — it is the element of two routes (`App.tsx:79-95`), so an Explore round-trip remounts it, and `useAuth` resolves the admin flag asynchronously so it is unknown at first mount.

**Files:**
- Modify: `packages/web/src/hooks/useWebSocket.ts` (the `case 'ready':` `isHome` block, ~line 177)
- Modify: `packages/server/src/utils/releaseCheck.ts` (header comment, property 1)
- Modify: `packages/web/src/components/modals/instanceSettingsPanels/UpdatesPanel.tsx` (the comment at ~line 85, which becomes false)
- Modify: `docs/systems/admin.md` (the "There is no background poller" paragraph, ~line 287)

**Interfaces:**
- Consumes: `fetchUpdateStatus` from Task 2.
- Produces: nothing new. This task only wires and re-documents.

- [ ] **Step 1: Wire the fetch into the ready handler**

In `packages/web/src/hooks/useWebSocket.ts`, extend the existing `isHome` block:

```ts
      if (isHome) {
        setUser(event.user);
        useSettingsStore.getState().setIsAdmin(event.user.isAdmin ?? false);
        useSettingsStore.getState().fetchStreamingLimits();
        useSettingsStore.getState().fetchGifEnabled();
        // Whose acknowledgements to read: the store cannot import authStore
        // without dragging the audio pipeline into every settings test.
        useSettingsStore.getState().setUpdateAckUser(event.user.id);
        // This is what moved the release lookup off the Updates panel: the dot
        // has to be able to appear before an admin ever navigates there. Gated
        // on the flag this event just delivered, not on store state.
        if (event.user.isAdmin === true) {
          void useSettingsStore.getState().fetchUpdateStatus();
        }
      }
```

- [ ] **Step 2: Correct the promise in releaseCheck.ts**

In `packages/server/src/utils/releaseCheck.ts`, replace property 1 of the header comment:

```ts
 *  1. **No background poller.** Nothing in the server calls this on a timer.
 *     It runs when a signed-in admin's client asks for the update status — on
 *     their sign-in, on a six-hourly refresh while their session lives, and on
 *     an explicit "Check again" — and only when the cache is cold. An instance
 *     nobody administers never contacts github.com. The lookup still carries
 *     nothing that identifies the instance, so this is a change to when the
 *     request is made, not to what it reveals.
 *
 *     Note on cost: the six-hour success cache bounds a healthy instance to
 *     roughly four outbound requests a day. A FAILED lookup is cached for a
 *     tenth of that, so an instance with blocked or rate-limited egress can
 *     attempt around forty a day. If that ever matters, lengthen the failure
 *     TTL rather than narrowing the trigger.
```

- [ ] **Step 3: Correct the now-false comment in UpdatesPanel.tsx**

Replace the comment above the mount effect (the three lines beginning "The lookup happens here"):

```tsx
  // The status is owned by settingsStore, which fetches it when an admin's home
  // WebSocket reports the session. This mount only covers the cases that fetch
  // could not: an admin promoted mid-session, or a sign-in fetch that failed.
```

(The effect body itself changes in Task 8; leave it alone here.)

- [ ] **Step 4: Correct docs/systems/admin.md**

Replace the paragraph beginning "**There is no background poller.**" (~line 287) with:

```markdown
**There is no background poller on the server.** The GitHub lookup runs only
when a signed-in admin's client asks for the update status: once when their home
WebSocket reports an admin session, on a six-hourly refresh while that session
lives, and on an explicit "Check again". An instance nobody administers never
contacts github.com, and the request still carries nothing that identifies the
instance. The trigger moved off the Updates panel when the update dot was added,
because a dot that only appears after you open the panel tells you nothing.

The six-hour success cache bounds a healthy instance to roughly four outbound
requests a day. Failures are cached for a tenth of that, so an instance with
blocked or rate-limited egress can attempt around forty a day; the fix, if it
ever matters, is a longer failure TTL rather than a narrower trigger.
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck` from the repo root.
Expected: PASS. No new strings were added, so the i18n check has nothing new to see.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/hooks/useWebSocket.ts packages/server/src/utils/releaseCheck.ts packages/web/src/components/modals/instanceSettingsPanels/UpdatesPanel.tsx docs/systems/admin.md
git commit -m "feat(web): check for instance updates when an admin signs in"
```

---

### Task 4: A dot badge on settings sections

`SettingsSection.badgeCount` is rendered only by `SettingsTabBar`. `SidebarSubLinks` renders labels and silently drops it, so the Federation approval count never appears in the desktop sidebar today. Fix that in passing rather than adding a second badge kind to a component that ignores the first.

**Files:**
- Modify: `packages/web/src/components/modals/SettingsSectionsContext.tsx`
- Modify: `packages/web/src/components/modals/SettingsTabBar.tsx`
- Modify: `packages/web/src/components/modals/UserSettings.tsx` (`SidebarSubLinks`, lines 23-44)
- Modify: `docs/systems/design-system.md`

**Interfaces:**
- Produces: `SettingsSection.badgeDot?: boolean`, rendered by both `SettingsTabBar` and `SidebarSubLinks`.

- [ ] **Step 1: Add the field**

In `packages/web/src/components/modals/SettingsSectionsContext.tsx`:

```ts
export interface SettingsSection {
  id: string;
  label: string;
  /** A count worth showing, e.g. pending federation approvals. */
  badgeCount?: number;
  /** A boolean "something is waiting here", e.g. an available instance update. */
  badgeDot?: boolean;
}
```

- [ ] **Step 2: Render the dot in SettingsTabBar**

In `packages/web/src/components/modals/SettingsTabBar.tsx`, after the existing `badgeCount` span:

```tsx
          {s.badgeCount !== undefined && s.badgeCount > 0 && (
            <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent-amber/15 text-accent-amber">
              {s.badgeCount}
            </span>
          )}
          {s.badgeDot === true && (
            <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-accent-amber align-middle" />
          )}
```

- [ ] **Step 3: Render both badges in SidebarSubLinks**

Replace the button body in `SidebarSubLinks` (`UserSettings.tsx`) so it renders the label alongside its badges:

```tsx
        <button
          key={section.id}
          onClick={() => ctx.scrollToSection(section.id)}
          className={`w-full flex items-center gap-1.5 text-left pl-6 pr-2 py-1 text-xs rounded-md transition-colors ${
            ctx.activeSection === section.id
              ? 'text-txt-primary'
              : 'text-txt-tertiary hover:text-txt-secondary'
          }`}
          aria-current={ctx.activeSection === section.id ? 'true' : undefined}
        >
          <span className="flex-1 min-w-0 truncate">{section.label}</span>
          {section.badgeCount !== undefined && section.badgeCount > 0 && (
            <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent-amber/15 text-accent-amber">
              {section.badgeCount}
            </span>
          )}
          {section.badgeDot === true && (
            <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent-amber" />
          )}
        </button>
```

- [ ] **Step 4: Record the convention in the design system doc**

`docs/systems/design-system.md` has no badges/indicators section today — the only
badge-adjacent content is the glass-tier row at line 116 and the avatar-stack
rows at lines 247-248. Add a NEW top-level section, placed after the surface and
input tier tables so it sits with the other "which token when" guidance:

```markdown
### Unread and attention indicators

| Colour | Meaning | Used by |
|--------|---------|---------|
| `accent-rose` / `bg-notification` | Someone is waiting on you: unread messages, mentions, pending friend requests | channel unread dots, mobile bottom-nav badges |
| `accent-amber` | Informational, no one is blocked: an available instance update, pending federation approvals | settings tab and sidebar badges |

A settings section carries a count (`SettingsSection.badgeCount`) when the number
matters, or a dot (`SettingsSection.badgeDot`) when only the existence does. Both
render in `SettingsTabBar` and in the desktop sidebar sub-links.
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck` from the repo root.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/modals/SettingsSectionsContext.tsx packages/web/src/components/modals/SettingsTabBar.tsx packages/web/src/components/modals/UserSettings.tsx docs/systems/design-system.md
git commit -m "feat(web): add a dot badge to settings sections and render counts in the sidebar"
```

---

### Task 5: The badge hook and the desktop surfaces

**Files:**
- Create: `packages/web/src/hooks/useInstanceUpdateBadge.ts`
- Test: `packages/web/src/hooks/useInstanceUpdateBadge.test.tsx`
- Modify: `packages/web/src/components/layout/ChannelSidebar.tsx` (the settings gear, lines 1205-1218)
- Modify: `packages/web/src/components/modals/UserSettings.tsx` (the `instance` nav button, ~line 156)
- Modify: `packages/web/src/components/modals/settingsPanels/InstancePanel.tsx` (the `updates` section entry)
- Modify: `packages/web/src/locales/{en,ru,de}/admin.json`

**Interfaces:**
- Consumes: `shouldBadgeUpdate` (Task 1); `settingsStore.updateStatus`, `updateAck`, `isAdmin` (Task 2); `SettingsSection.badgeDot` (Task 4).
- Produces: `useInstanceUpdateBadge(): boolean`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/hooks/useInstanceUpdateBadge.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { InstanceUpdateStatus } from '@backspace/shared';
import { useInstanceUpdateBadge } from './useInstanceUpdateBadge';
import { useSettingsStore } from '../stores/settingsStore';
import { EMPTY_ACK } from '../utils/updateAck';

const available: InstanceUpdateStatus = {
  current: { version: '1.2.1', commit: null },
  latest: { version: '1.3.0', url: 'https://example.invalid', publishedAt: '' },
  state: 'update-available',
  checkedAt: 1,
  checkEnabled: true,
  reason: null,
  channel: 'prebuilt',
};

describe('useInstanceUpdateBadge', () => {
  beforeEach(() => {
    useSettingsStore.setState({ isAdmin: true, updateStatus: null, updateAck: EMPTY_ACK });
  });

  it('is false before the status loads', () => {
    const { result } = renderHook(() => useInstanceUpdateBadge());
    expect(result.current).toBe(false);
  });

  it('is true for an admin with an unseen update', () => {
    useSettingsStore.setState({ updateStatus: available });
    const { result } = renderHook(() => useInstanceUpdateBadge());
    expect(result.current).toBe(true);
  });

  it('is false for a non-admin', () => {
    useSettingsStore.setState({ updateStatus: available, isAdmin: false });
    const { result } = renderHook(() => useInstanceUpdateBadge());
    expect(result.current).toBe(false);
  });

  it('clears once the version is marked seen', () => {
    useSettingsStore.setState({ updateStatus: available, updateAck: { seenVersion: '1.3.0', toastShownFor: null } });
    const { result } = renderHook(() => useInstanceUpdateBadge());
    expect(result.current).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/hooks/useInstanceUpdateBadge.test.tsx`
Expected: FAIL — cannot resolve `./useInstanceUpdateBadge`.

- [ ] **Step 3: Write the hook**

Create `packages/web/src/hooks/useInstanceUpdateBadge.ts`:

```ts
import { useSettingsStore } from '../stores/settingsStore';
import { shouldBadgeUpdate } from '../utils/updateAck';

/**
 * Whether to show the "an instance update is available" dot.
 *
 * Read-only: it starts no request and owns no timer. The fetch belongs to
 * `settingsStore`, driven by the home WebSocket's `ready` event, so mounting
 * this in several places costs nothing.
 *
 * Always the home instance. Connected remote instances are never consulted —
 * Instance settings administer the instance that served this client, the same
 * way the telemetry panel does.
 */
export function useInstanceUpdateBadge(): boolean {
  const status = useSettingsStore((s) => s.updateStatus);
  const ack = useSettingsStore((s) => s.updateAck);
  const isAdmin = useSettingsStore((s) => s.isAdmin);
  return shouldBadgeUpdate(status, ack, isAdmin);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/hooks/useInstanceUpdateBadge.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the aria-label string to all three catalogs**

In `packages/web/src/locales/en/admin.json`, inside the existing `"updates"` object, add:

```json
  "badge": {
    "settingsAriaLabel": "Settings, instance update available",
    "toast": "Backspace {{version}} is available for this instance",
    "toastAction": "View"
  },
```

In `packages/web/src/locales/de/admin.json`, same position:

```json
  "badge": {
    "settingsAriaLabel": "Einstellungen, Instanz-Update verfügbar",
    "toast": "Backspace {{version}} ist für diese Instanz verfügbar",
    "toastAction": "Ansehen"
  },
```

In `packages/web/src/locales/ru/admin.json`, same position:

```json
  "badge": {
    "settingsAriaLabel": "Настройки, доступно обновление сервера",
    "toast": "Backspace {{version}} доступен для этого сервера",
    "toastAction": "Открыть"
  },
```

(`toast` and `toastAction` are consumed in Task 7; adding all three keys now keeps each catalog edited once.)

- [ ] **Step 6: Badge the desktop settings gear**

`packages/web/src/components/layout/ChannelSidebar.tsx` defines THREE components:
`ChannelSidebar` (line 28), `UserAreaPanel` (line 828) and `ChannelItem`
(line 1224). The settings gear at lines 1205-1218 belongs to **`UserAreaPanel`**,
which `ChannelSidebar` renders at line 421. Every edit in this step goes in
`UserAreaPanel`, not in `ChannelSidebar`:

- add the hook call next to `UserAreaPanel`'s existing hooks, around line 849-855
- the `useTranslation` list to extend with `'admin'` is **`UserAreaPanel`'s, at
  line 849** — not the one at line 29, which belongs to `ChannelSidebar`

Putting either in `ChannelSidebar` yields `updateBadge is not defined` at the
gear and an `admin`-less `t` at line 1205.

The gear sits inside a flex row; the dot anchors to `relative` on the button so
it does not disturb the row's layout:

```tsx
          {/* Settings */}
          <button
            onClick={() => onSettingsClick()}
            className="w-8 h-8 flex items-center justify-center text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover rounded-[4px] transition-colors relative"
            title={t('common:labels.settings')}
            aria-label={updateBadge ? t('admin:updates.badge.settingsAriaLabel') : t('common:labels.settings')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
            </svg>
            {updateBadge && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-accent-amber" />
            )}
          </button>
```

Add to `UserAreaPanel` (near its hooks at ~line 849):

```tsx
  const updateBadge = useInstanceUpdateBadge();
```

extend `UserAreaPanel`'s translation namespaces at line 849 to
`useTranslation(['spaces', 'common', 'admin'])`, and add the file-level import:

```tsx
import { useInstanceUpdateBadge } from '../../hooks/useInstanceUpdateBadge';
```

- [ ] **Step 7: Badge the Instance nav button**

In `packages/web/src/components/modals/UserSettings.tsx`, in the admin block of the desktop sidebar, replace the plain button:

```tsx
                <button
                  onClick={() => handleTabClick('instance')}
                  className={`${tabClass('instance')} flex items-center gap-1.5`}
                >
                  <span className="flex-1 min-w-0 truncate">{t('settings:nav.tabs.instance')}</span>
                  {updateBadge && <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent-amber" />}
                </button>
```

Add `const updateBadge = useInstanceUpdateBadge();` inside `UserSettingsModal`, and the import.

- [ ] **Step 8: Badge the Updates sub-tab**

In `packages/web/src/components/modals/settingsPanels/InstancePanel.tsx`, take the hook and feed the section list:

```tsx
  const updateBadge = useInstanceUpdateBadge();

  const sections = useMemo<SettingsSection[]>(() => [
    { id: 'general', label: t('settings:instance.tabs.general') },
    { id: 'registration', label: t('settings:instance.tabs.registration') },
    { id: 'federation', label: t('settings:instance.tabs.federation'), badgeCount: approvalCount },
    { id: 'streaming', label: t('settings:instance.tabs.streaming') },
    { id: 'storage', label: t('settings:instance.tabs.storage') },
    { id: 'users', label: t('settings:instance.tabs.users') },
    { id: 'updates', label: t('settings:instance.tabs.updates'), badgeDot: updateBadge },
    { id: 'telemetry', label: t('settings:instance.tabs.telemetry') },
  ], [approvalCount, updateBadge, t]);
```

- [ ] **Step 9: Typecheck and test**

Run: `pnpm typecheck` from the repo root, then `cd packages/web && npx vitest run src/hooks/useInstanceUpdateBadge.test.tsx`
Expected: both PASS. The i18n check must report no findings; if it flags the new keys, they are missing from one of the three catalogs.

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/hooks/useInstanceUpdateBadge.ts packages/web/src/hooks/useInstanceUpdateBadge.test.tsx packages/web/src/components/layout/ChannelSidebar.tsx packages/web/src/components/modals/UserSettings.tsx packages/web/src/components/modals/settingsPanels/InstancePanel.tsx packages/web/src/locales/en/admin.json packages/web/src/locales/de/admin.json packages/web/src/locales/ru/admin.json
git commit -m "feat(web): show an update dot on the desktop settings surfaces"
```

---

### Task 6: The mobile surfaces

Four hops, and the bottom nav is the one that matters — it is the mobile equivalent of the desktop gear, and without it the dot is invisible from the mobile root. Do **not** badge `UserSettings.tsx`'s mobile tab list: `AppLayout.tsx:397-406` renders `MobileShell` and deliberately never mounts `UserSettingsModal`, so that list is unreachable on mobile.

**Files:**
- Modify: `packages/web/src/components/layout/MobileBottomNav.tsx`
- Modify: `packages/web/src/components/layout/MobileYouScreen.tsx`
- Modify: `packages/web/src/components/layout/MobileSettingsScreen.tsx`
- Modify: `packages/web/src/components/layout/MobileInstancePanel.tsx`

**Interfaces:**
- Consumes: `useInstanceUpdateBadge()` (Task 5).
- Produces: nothing new.

- [ ] **Step 1: Badge the "You" tab**

In `packages/web/src/components/layout/MobileBottomNav.tsx`, add the import and hook, then OR the dot into the existing badge, which already carries pending friend requests:

```tsx
import { useInstanceUpdateBadge } from '../../hooks/useInstanceUpdateBadge';
```

```tsx
  const updateBadge = useInstanceUpdateBadge();
```

```tsx
      badge: (pendingIncoming.length > 0 || updateBadge) ? ('dot' as const) : null,
```

The bottom nav's dot keeps its existing `bg-notification`: this tab already means "something of yours needs attention", and splitting one dot into two colours by cause would be worse than reusing it. The amber convention applies inside settings, where the cause is named.

Note the hook must be called before the `if (mobileStack.length > 0) return null;` early return, alongside the other hook calls, or React's hook order breaks.

- [ ] **Step 2: Badge the You-screen gear**

In `packages/web/src/components/layout/MobileYouScreen.tsx`, wrap the gear button:

```tsx
        <button
          onClick={() => pushMobileScreen('settings')}
          className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary relative"
          aria-label={updateBadge ? t('admin:updates.badge.settingsAriaLabel') : t('common:labels.settings')}
        >
```

and inside the button, after the `<svg>`:

```tsx
          {updateBadge && (
            <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-accent-amber" />
          )}
```

Add `const updateBadge = useInstanceUpdateBadge();` **with the other hooks at the
top of the component, above the `if (!user) return null;` early return at line
16** — below it, it becomes a conditional hook and React will throw on the
render where `user` is null. Also add the import and `admin` to this file's
`useTranslation([...])` list.

- [ ] **Step 3: Badge the Instance row in the settings list**

In `packages/web/src/components/layout/MobileSettingsScreen.tsx`, the section list is plain objects mapped into rows. Add the flag on the instance entry:

```tsx
    ...(isAdmin ? [{ id: 'instance', label: t('settings:nav.tabs.instance'), dot: updateBadge }] : []),
```

TypeScript normalizes the array literal by widening the entries that lack the
field to `dot?: undefined`, so `section.dot` types as `boolean | undefined` and
no change to the other entries is needed. Render it in the row, before the
chevron:

```tsx
            <span className="text-sm text-txt-primary flex-1">{section.label}</span>
            {section.dot && <span className="w-1.5 h-1.5 rounded-full bg-accent-amber" />}
```

Add `const updateBadge = useInstanceUpdateBadge();` **with the other hooks at
lines 83-85, above the early-return block at lines 87-91** (`if (initialPanel)
{ … return null; }`). The `sections` array this step edits sits at line 109,
*after* that block, so placing the hook beside it would be a conditional hook.
Add the import too.

- [ ] **Step 4: Badge the Updates row in the instance panel**

In `packages/web/src/components/layout/MobileInstancePanel.tsx`, the row body already branches on a federation count. Add the dot beside it:

```tsx
        {sections.map((section) => {
          const badge = section.id === 'federation' && approvalCount > 0 ? approvalCount : null;
          const dot = section.id === 'updates' && updateBadge;
          return (
```

and inside the button, after the count span:

```tsx
              {dot && <span className="w-1.5 h-1.5 rounded-full bg-accent-amber" />}
```

Add `const updateBadge = useInstanceUpdateBadge();` next to the existing `approvalCount` line, and the import.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck` from the repo root.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/layout/MobileBottomNav.tsx packages/web/src/components/layout/MobileYouScreen.tsx packages/web/src/components/layout/MobileSettingsScreen.tsx packages/web/src/components/layout/MobileInstancePanel.tsx
git commit -m "feat(web): show the update dot through the mobile settings chain"
```

---

### Task 7: An actionable toast, shown once per version

`Toast` is `{id, message, type}` and `ToastContainer` removes it on click with no callback, so a dismissal is today indistinguishable from the 5-second timeout. An update toast needs to survive long enough to be read and to route the admin to the panel — on mobile that destination is four hops deep — so the toast model grows an optional action and an optional sticky duration.

**Files:**
- Modify: `packages/web/src/stores/uiStore.ts`
- Modify: `packages/web/src/components/ui/ToastContainer.tsx`
- Create: `packages/web/src/components/ui/InstanceUpdateToast.tsx`
- Test: `packages/web/src/components/ui/InstanceUpdateToast.test.tsx`
- Modify: `packages/web/src/components/layout/AppLayout.tsx`

**Interfaces:**
- Consumes: `shouldToastUpdate` (Task 1); `markUpdateToastShown`, `updateStatus`, `updateAck` (Task 2); `admin:updates.badge.toast` / `toastAction` (Task 5).
- Produces:
  - `interface ToastAction { label: string; onClick: () => void }`
  - `addToast(message: string, type?: 'info' | 'warning' | 'success', duration?: number, action?: ToastAction)` — a `duration` of `0` means the toast never auto-removes.
  - `<InstanceUpdateToast />`, a render-nothing component that fires the toast as a side effect.

- [ ] **Step 1: Extend the toast model**

In `packages/web/src/stores/uiStore.ts`:

```ts
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: string;
  message: string;
  type: 'info' | 'warning' | 'success';
  action?: ToastAction;
}
```

Change the signature in `UIState`:

```ts
  addToast: (message: string, type?: 'info' | 'warning' | 'success', duration?: number, action?: ToastAction) => void;
```

and the implementation:

```ts
      addToast: (message, type = 'info', duration = 5000, action) => {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
        set((state) => ({ toasts: [...state.toasts, { id, message, type, action }] }));
        // A duration of 0 means the toast stays until the viewer dismisses it.
        // An actionable toast that vanishes on a timer is worse than none: the
        // action is the whole point, and five seconds is not enough to notice a
        // toast, read it, and decide to click it.
        if (duration > 0) {
          setTimeout(() => {
            set((state) => ({ toasts: state.toasts.filter(t => t.id !== id) }));
          }, duration);
        }
      },
```

- [ ] **Step 2: Render the action**

In `packages/web/src/components/ui/ToastContainer.tsx`, replace the toast body. The action button stops propagation so clicking it does not also trigger the container's dismiss-on-click:

```tsx
        <div
          key={toast.id}
          className={`glass-pill border-l-2 ${borderColors[toast.type]} rounded-[10px] px-4 py-2.5 max-w-[320px] animate-slide-up pointer-events-auto cursor-pointer flex items-center gap-3`}
          onClick={() => removeToast(toast.id)}
        >
          <span className="flex-1 text-sm text-txt-primary leading-snug">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toast.action?.onClick();
                removeToast(toast.id);
              }}
              className="shrink-0 px-2 py-1 text-xs font-medium rounded-md text-accent-primary hover:bg-white/[0.08] transition-colors"
            >
              {toast.action.label}
            </button>
          )}
        </div>
```

- [ ] **Step 3: Write the failing test**

Create `packages/web/src/components/ui/InstanceUpdateToast.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { InstanceUpdateStatus } from '@backspace/shared';
import { InstanceUpdateToast } from './InstanceUpdateToast';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { EMPTY_ACK } from '../../utils/updateAck';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => `${key}:${opts?.version ?? ''}` }),
}));

const available: InstanceUpdateStatus = {
  current: { version: '1.2.1', commit: null },
  latest: { version: '1.3.0', url: 'https://example.invalid', publishedAt: '' },
  state: 'update-available',
  checkedAt: 1,
  checkEnabled: true,
  reason: null,
  channel: 'prebuilt',
};

describe('InstanceUpdateToast', () => {
  beforeEach(() => {
    useSettingsStore.setState({ isAdmin: true, updateStatus: null, updateAck: EMPTY_ACK });
    useUIStore.setState({ toasts: [], isMobile: false });
  });

  it('renders nothing and raises no toast without an update', () => {
    const { container } = render(<InstanceUpdateToast />);
    expect(container.firstChild).toBeNull();
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });

  it('raises one actionable toast for an available update', () => {
    useSettingsStore.setState({ updateStatus: available });
    render(<InstanceUpdateToast />);
    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toContain('1.3.0');
    expect(toasts[0]?.action).toBeDefined();
  });

  it('marks the version as toasted so it does not repeat', () => {
    useSettingsStore.setState({ updateStatus: available });
    render(<InstanceUpdateToast />);
    expect(useSettingsStore.getState().updateAck.toastShownFor).toBe('1.3.0');
  });

  it('does not toast a version already toasted', () => {
    useSettingsStore.setState({ updateStatus: available, updateAck: { seenVersion: null, toastShownFor: '1.3.0' } });
    render(<InstanceUpdateToast />);
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });

  it('does not toast a non-admin', () => {
    useSettingsStore.setState({ updateStatus: available, isAdmin: false });
    render(<InstanceUpdateToast />);
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });

  it('opens instance settings when the action is taken on desktop', () => {
    useSettingsStore.setState({ updateStatus: available });
    render(<InstanceUpdateToast />);
    useUIStore.getState().toasts[0]?.action?.onClick();
    expect(useUIStore.getState().activeModal).toBe('userSettings');
    expect(useUIStore.getState().modalData.tab).toBe('instance');
  });

  it('pushes the mobile updates screen when the action is taken on mobile', () => {
    useUIStore.setState({ isMobile: true });
    useSettingsStore.setState({ updateStatus: available });
    render(<InstanceUpdateToast />);
    useUIStore.getState().toasts[0]?.action?.onClick();
    expect(useUIStore.getState().mobileStack.at(-1)?.screen).toBe('settings-instance-updates');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/ui/InstanceUpdateToast.test.tsx`
Expected: FAIL — cannot resolve `./InstanceUpdateToast`.

- [ ] **Step 5: Write the component**

Create `packages/web/src/components/ui/InstanceUpdateToast.tsx`:

```tsx
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { shouldToastUpdate, pendingUpdateVersion } from '../../utils/updateAck';

/**
 * Tells an admin, once per release, that their instance has an update waiting.
 *
 * Renders nothing: it exists to raise a toast as a side effect, so it can be
 * mounted once high in the tree and cover both the desktop and mobile shells.
 *
 * "Once per release" is enforced by recording the version when the toast is
 * SHOWN, not when it is dismissed — `ToastContainer` cannot tell a dismissal
 * from its own timeout. That record is persisted, so remounting this component
 * (AppLayout is the element of two routes and remounts on an Explore
 * round-trip) does not raise it again.
 *
 * The copy names the instance explicitly. On desktop this toast can appear
 * alongside `UpdateToast`, which is about the desktop CLIENT updating itself,
 * and an admin should never have to guess which of the two is which.
 */
export function InstanceUpdateToast() {
  const { t } = useTranslation(['admin']);
  const status = useSettingsStore((s) => s.updateStatus);
  const ack = useSettingsStore((s) => s.updateAck);
  const isAdmin = useSettingsStore((s) => s.isAdmin);
  const markUpdateToastShown = useSettingsStore((s) => s.markUpdateToastShown);

  useEffect(() => {
    if (!shouldToastUpdate(status, ack, isAdmin)) return;
    const version = pendingUpdateVersion(status);
    if (version === null) return;

    const { addToast, isMobile, openModal, pushMobileScreen } = useUIStore.getState();

    // Recorded before the toast is raised, so a re-render triggered by the
    // toast landing in the store cannot raise a second one.
    markUpdateToastShown();

    addToast(
      t('admin:updates.badge.toast', { version }),
      'info',
      0,
      {
        label: t('admin:updates.badge.toastAction'),
        onClick: () => {
          if (isMobile) {
            // The mobile Updates screen is reachable directly; the desktop modal
            // has no sub-tab deep link, so it opens on Instance and the dot on
            // the Updates sub-tab carries the last hop.
            pushMobileScreen('settings-instance-updates');
          } else {
            openModal('userSettings', { tab: 'instance' });
          }
        },
      },
    );
  }, [status, ack, isAdmin, markUpdateToastShown, t]);

  return null;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/components/ui/InstanceUpdateToast.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 7: Mount it — in BOTH return branches**

`AppLayout.tsx` has no shared render path. It mounts `<ToastContainer />` twice,
in two mutually exclusive returns:

- **line 428**, inside `if (isMobile) return (<> <MobileShell /> … </>)`
- **line 488**, the desktop return

Mount `<InstanceUpdateToast />` next to **both**, and import it from
`../ui/InstanceUpdateToast`. Adding it only to the desktop return is the likely
mistake and it silently removes the toast from mobile, which is the surface the
design cares about most.

(`AppLayout` returns a loading skeleton before both branches, so the toast does
not mount during initial load. That is fine — the status has not arrived yet
either — but keep it in mind when verifying by hand in Task 8.)

- [ ] **Step 8: Confirm no existing toast call is disturbed**

The signature change is additive: no existing `addToast` call site passes a
fourth argument, and none passes `0` as the duration, so none changes behaviour.
Confirm that still holds before continuing:

Run: `grep -rn "addToast(" packages/web/src | grep -v "\.test\."`
Expected: every call passes one to three arguments. If any passes four, or
passes `0` as the third, reconcile it before continuing.

Run: `cd packages/web && npx vitest run src/components/ui`
Expected: PASS, including the existing `UpdateToast.test.tsx`.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/stores/uiStore.ts packages/web/src/components/ui/ToastContainer.tsx packages/web/src/components/ui/InstanceUpdateToast.tsx packages/web/src/components/ui/InstanceUpdateToast.test.tsx packages/web/src/components/layout/AppLayout.tsx
git commit -m "feat(web): toast an admin once per available instance update"
```

---

### Task 8: Point UpdatesPanel at the store and clear the dot

The panel keeps its own error UI and its "Check again" button; it stops owning the data. Opening it is what marks the version seen.

**Files:**
- Modify: `packages/web/src/components/modals/instanceSettingsPanels/UpdatesPanel.tsx`
- Modify: `packages/web/src/components/modals/instanceSettingsPanels/UpdatesPanel.test.tsx`

**Interfaces:**
- Consumes: `updateStatus`, `updateStatusLoading`, `updateStatusError`, `fetchUpdateStatus`, `markUpdateSeen` (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Rewrite the panel's data wiring**

Replace the state block and the mount effect at the top of `UpdatesPanel` with store reads. Everything below `const updateAvailable = ...` is unchanged — it already reads from a local `status` binding, which now comes from the store:

```tsx
export function UpdatesPanel() {
  const { t } = useTranslation(['admin', 'common']);
  const f = useFormatters();
  const status = useSettingsStore((s) => s.updateStatus);
  const loading = useSettingsStore((s) => s.updateStatusLoading);
  const loadError = useSettingsStore((s) => s.updateStatusError);
  const fetchUpdateStatus = useSettingsStore((s) => s.fetchUpdateStatus);
  const markUpdateSeen = useSettingsStore((s) => s.markUpdateSeen);
  const [checking, setChecking] = useState(false);
  const [showManual, setShowManual] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setChecking(true);
    try {
      await fetchUpdateStatus(refresh);
    } finally {
      setChecking(false);
    }
  }, [fetchUpdateStatus]);

  // The status is owned by settingsStore, which fetches it when an admin's home
  // WebSocket reports the session. This mount only covers the cases that fetch
  // could not: an admin promoted mid-session, or a sign-in fetch that failed.
  useEffect(() => {
    if (status === null) void load(false);
  }, [status, load]);

  // Opening this panel is the acknowledgement that clears the dot everywhere
  // else. Keyed on the version so a later release re-arms it.
  useEffect(() => { markUpdateSeen(); }, [status, markUpdateSeen]);

  // Guarded on the absence of an error, not on `loading`. The store starts
  // `updateStatusLoading: false`, so keying the loading view on it would render
  // the error branch for one frame on every mount that precedes the sign-in
  // fetch.
  if (status === null && loadError === '') {
    return <div className="text-sm text-txt-tertiary">{t('admin:updates.loading')}</div>;
  }
```

Add the import:

```tsx
import { useSettingsStore } from '../../../stores/settingsStore';
```

and drop the now-unused `api` and `describeError` imports. Both are safe to
remove: the file's only `api` use is `api.admin.updateStatus` inside `load`, and
`CommandBlock` uses `useUIStore`'s `addToast` rather than `api`. (`describeError`
moved into the store in Task 2.)

The error branch keeps its shape, but "Try again" now goes through `load`:

```tsx
  if (loadError || status === null) {
```

is unchanged; its button already calls `void load(false)`.

- [ ] **Step 2: Re-point the existing tests**

`UpdatesPanel.test.tsx` currently drives every case through
`vi.spyOn(api.admin, 'updateStatus')`. That spy still works, because the store
calls the same API function — but each test must now reset the store between
cases, or state leaks from one case to the next.

**The file already has a top-level `beforeEach` at line 32** (it creates
`updateStatus = vi.fn()` and installs the spy) and a nested one at line 54.
EXTEND the one at line 32, keeping both of its existing statements. Do not
replace it — pasting a fresh block over it breaks all 18 existing cases.

Added statements (block body, never an expression body — a value returned from
`beforeEach` is treated by vitest as a teardown callback):

```ts
    useSettingsStore.setState({
      isAdmin: true,
      updateStatus: null,
      updateStatusLoading: false,
      updateStatusError: '',
      updateAck: EMPTY_ACK,
      updateAckUserId: 'admin-user',
    });
    useSettingsStore.getState().stopUpdateStatusRefresh();
    localStorage.clear();
```

Every completed fetch schedules a real six-hour `setTimeout`, so the file also
needs a teardown or the last case leaves a live timer and vitest reports that
something is keeping the process alive. Add alongside the `beforeEach`:

```ts
  afterEach(() => {
    useSettingsStore.getState().stopUpdateStatusRefresh();
  });
```

with imports for `useSettingsStore`, `EMPTY_ACK` and `afterEach`. Every existing
assertion about rendered output stays as it is.

- [ ] **Step 3: Add a test for the dot clearing**

Append to `UpdatesPanel.test.tsx`:

```tsx
  it('marks the available version seen when the panel renders it', async () => {
    vi.spyOn(api.admin, 'updateStatus').mockResolvedValue({
      current: { version: '1.2.1', commit: null },
      latest: { version: '1.3.0', url: 'https://example.invalid', publishedAt: '' },
      state: 'update-available',
      checkedAt: 1,
      checkEnabled: true,
      reason: null,
      channel: 'prebuilt',
    });

    render(<UpdatesPanel />);

    await waitFor(() => {
      expect(useSettingsStore.getState().updateAck.seenVersion).toBe('1.3.0');
    });
  });
```

- [ ] **Step 4: Run the panel tests**

Run: `cd packages/web && npx vitest run src/components/modals/instanceSettingsPanels/UpdatesPanel.test.tsx`
Expected: PASS, every pre-existing case plus the new one.

- [ ] **Step 5: Record the new entry points and the home-instance scope in admin.md**

`docs/systems/admin.md` describes the UpdatesPanel and enumerates where it is
reachable from. Both statements are now incomplete.

Lines 584-585 already read *"Registered as the `updates` sub-tab in
`InstancePanel.tsx`, and as `settings-instance-updates` in `MobileShell.tsx` /
`MobileInstancePanel.tsx`."* Leave that sentence exactly as it is and APPEND the
two paragraphs below after it — do not paste it again:

```markdown
**It always reads the home instance.** `api.admin.updateStatus()` goes through
the origin-relative client, so a client with remote instances connected still
reports only the instance that served it — the same rule the telemetry panel
follows. An operator running two instances gets no signal here that the second
one is behind; they see it when they sign in to that instance.

**The dot.** When a release is available, an amber dot appears on the settings
gear, on the Instance nav item, on the Updates sub-tab, and through the mobile
chain (bottom-nav "You" tab, the You-screen gear, the Instance row, the Updates
row). It is derived by `useInstanceUpdateBadge()` from the status the store
holds, and is cleared for that version when the admin opens this panel. An admin
is also toasted once per version, with an action that opens this panel. Both
acknowledgements live in `localStorage` per user id
(`packages/web/src/utils/updateAck.ts`), so they are per browser: a release
re-arms both, and clearing site data brings them back.
```

- [ ] **Step 6: Full gate**

Run from the repo root:
```bash
pnpm typecheck
cd packages/web && npx vitest run
```
Expected: typecheck clean (including the i18n check reporting no findings), and the whole web suite green.

- [ ] **Step 7: Verify in the running app**

Run `pnpm dev` from the repo root and confirm the server and Vite both start without errors (CLAUDE.md requires this before a change is considered done). Sign in as an admin and confirm: with `BACKSPACE_UPDATE_CHECK=false` no dot appears anywhere; with the check on and a `latest` newer than `config.version`, the dot appears on the gear, the Instance nav item and the Updates sub-tab, the toast appears once with a working action, and opening the Updates panel clears the dot while the toast does not return on reload.

- [ ] **Step 8: Commit**

```bash
git add docs/systems/admin.md packages/web/src/components/modals/instanceSettingsPanels/UpdatesPanel.tsx packages/web/src/components/modals/instanceSettingsPanels/UpdatesPanel.test.tsx
git commit -m "feat(web): read update status from the store and clear the dot on view"
```

---

## Notes for the implementer

- **Do not add a way to apply the update.** Every task here is about visibility.
- **The status is the home instance's, always.** If a task tempts you toward `getApiForOrigin` or `channelOriginMap`, stop: the Instance settings surface administers only the instance that served the client. An operator running two instances gets no signal about the second, and that is recorded as a deliberate limitation.
- **`docs/systems/admin.md` is the doc of record** for this surface. Task 3 corrects the trigger paragraph; if you change anything else about the panel's behaviour, the "UpdatesPanel" section at ~line 571 needs the same treatment.
