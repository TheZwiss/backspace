# Update Experience Implementation Plan

**Spec:** `docs/superpowers/specs/2026-09-03-update-experience-design.md`

**Goal:** Make the desktop update prompt tell the truth and stop nagging, give
operators a version/update surface in Instance Settings, and ship `update.sh`.

**Architecture:** The main process becomes the single authority on whether this
build can install its own updates (measured from its own code signature) and on
what update status the renderer should show. The renderer renders that status and
nothing else. The server gains a read-only, admin-only, lazily-cached release
check. `update.sh` is the operator-facing action the panel points at.

## Global Constraints

- TypeScript strict, no `any`, no placeholders, every function fully implemented.
- No em dashes or buzzword register in any user-facing copy, doc, or commit.
- Never `docker compose ... --remove-orphans`; always name the `backspace` service.
- Public repo: no real infra hostnames in tracked files (pre-commit hook enforces).
- `docs/systems/*` updated for every structural change.

---

## WS1 — Desktop

### Task 1: Update capability probe
- Create `packages/desktop/src/updateCapability.ts`
- Create `packages/desktop/src/updateCapability.test.ts`
- Produces: `classifyDesignatedRequirement(out: string): 'adhoc' | 'identified' | 'unknown'`,
  `getUpdateCapability(): 'auto' | 'manual'` (memoised)
- Gate: vitest covers ad-hoc cdhash, Developer ID anchor, empty, error text.

### Task 2: Persisted per-version dismissal
- Create `packages/desktop/src/updateDismissal.ts` + `.test.ts`
- Produces: `loadDismissedVersion(): string | null`, `setDismissedVersion(v: string): void`,
  `isDismissed(v: string): boolean`
- Storage: `{userData}/update-state.json`. Corrupt file yields null, never throws.

### Task 3: Update status model + main process rewiring
- Create `packages/desktop/src/updateStatus.ts` (the `UpdateStatus` union + store)
- Modify `packages/desktop/src/main.ts:initAutoUpdater()`
- Wire `download-progress`, `update-not-available`; branch `autoDownload` on capability;
  purge the stale updater cache in manual mode; branch the native notification;
  add the `quitAndInstall` watchdog.
- Keep `update-available` / `update-downloaded` / `update-error` channels intact
  (recovery.ts consumes them).

### Task 4: IPC surface
- Modify `packages/desktop/src/preload.ts`, `packages/web/src/platform/electron.d.ts`
- Add `getUpdateStatus`, `onUpdateStatusChanged`, `dismissUpdate`, `openReleasePage`.

### Task 5: Renderer store + toast
- Create `packages/web/src/stores/updateStore.ts` + `.test.ts`
- Rewrite `packages/web/src/components/ui/UpdateToast.tsx` + add `.test.tsx`
- `.glass-bubble`, no truncate, three visible phases, dismissal wired.

### Task 6: Settings Desktop panel
- Modify `packages/web/src/components/modals/settingsPanels/DesktopPanel.tsx`
- Real states from the store; delete the `setTimeout(5000)` fiction.

---

## WS3 — update.sh

### Task 7: The script
- Create `update.sh` (root, mode 755)
- Flags `--check`, `--yes`, `--no-backup`. Ten-step sequence per spec section 6.2.
- Gate: `bash -n`, `shellcheck`, `--check` against a live host, one forced-failure
  rollback rehearsal.

### Task 8: Install channel recording
- Modify `install.sh` to write `BACKSPACE_INSTALL_CHANNEL` at its existing
  `BACKSPACE_BUILD` branch. Modify `.env.example`.

---

## WS2 — Server + admin panel

### Task 9: Release check utility
- Create `packages/server/src/utils/releaseCheck.ts` + `.test.ts`
- Lazy, 6h cache, 5s timeout, fail-soft, `BACKSPACE_UPDATE_CHECK` kill switch.

### Task 10: Admin endpoint
- Create `packages/server/src/routes/adminUpdates.ts` + `.test.ts`
- Add `InstanceUpdateStatus` to `packages/shared/src/types.ts`, register in the app.

### Task 11: Updates panel
- Create `packages/web/src/components/modals/instanceSettingsPanels/UpdatesPanel.tsx`
- Register in `InstancePanel.tsx` and `MobileShell.tsx`.

### Task 12: Docs
- `docs/systems/desktop.md`, `desktop-security.md`, `admin.md`, `api.md`,
  `deployment.md`, `README.md`, `.env.example`.


---

## Status: complete, 2026-09-03

All twelve tasks landed. Verification performed:

- **Unit tests:** 1835 pass (136 desktop, 579 web, 1120 server). `tsc --noEmit`
  clean in all three packages. `pnpm -w build` succeeds.
- **`update.sh`:** `bash -n` and shellcheck 0.11.0 clean. Rehearsed end to end on
  a live throwaway instance: a real update, a no-op re-run that correctly
  declined to restart, and a deliberately broken update (image repinned at
  `alpine:3.20`) that failed the 180s health gate and rolled back to a healthy
  instance on the previous image. Co-hosted containers untouched throughout.
- **Capability probe:** the compiled module classifies the real ad-hoc signed
  `/Applications/Backspace.app` as `manual` and a real Developer ID signed app as
  `auto`, which is the evidence behind the claim that a Developer ID flips it
  with no code change.
- **Endpoint:** exercised against a live server and the real GitHub API. 401
  unauthenticated, 403 non-admin, correct `up-to-date` against the published
  1.0.4, cache hit proven by an identical `checkedAt`, `?refresh=true` proven by
  a changed one, and `BACKSPACE_UPDATE_CHECK=false` proven to open no socket even
  with `?refresh=true`.
- **UI:** rendered and screenshotted in a throwaway harness (since deleted).
  Two issues found and fixed that no unit test would have caught: the "I do not
  have update.sh" disclosure did not read as a control, and the chained manual
  command overflowed its block.
- **Electron:** boots clean with the new modules.
