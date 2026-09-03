# Update Experience Design

**Date:** 2026-09-03
**Status:** Design, approved for planning
**Scope:** Desktop update UX, admin instance-version surface, operator update script

---

## 1. The reported problem

On macOS, every launch of the desktop app produces a bottom-left toast reading
"Update ready / Version 1.0.4 has been download…". Its **Restart** button does
nothing at all. Dismissing it reveals a second toast, "Update failed /
Auto-update failed — download manually", whose **Download** button works. The
user is never asked whether they want to see the message again, so the whole
cycle repeats on the next launch.

Separately, a server operator has no way to see what version their instance is
running, or to learn how to move it forward, without reading the README.

---

## 2. Root cause

### 2.1 What was measured

Evidence gathered from the reporting machine (running 1.0.3, offered 1.0.4):

```
$ codesign -d -r- /Applications/Backspace.app
Executable=/Applications/Backspace.app/Contents/MacOS/Backspace
# designated => cdhash H"4a9e49fe20f82802702a4e9d752748e990909659"

$ ls ~/Library/Caches/@backspacedesktop-updater/pending
Backspace-1.0.4-arm64.zip   (113,897,045 bytes)
current.blockmap
update-info.json

$ ls ~/Library/Caches/@backspacedesktop-updater
update.zip                  (113,897,045 bytes)   <- second copy
current.blockmap

$ ls ~/Library/Caches/com.backspace.desktop.ShipIt
(empty)
```

### 2.2 The mechanism

The app is ad-hoc signed by `packages/desktop/scripts/macSign.js` because CI has
no Developer ID certificate. An ad-hoc signature has no stable identity, so the
bundle's **designated requirement is a literal cdhash of that exact binary**.

Squirrel.Mac validates a staged update against the *running* app's designated
requirement. A 1.0.4 binary has a different cdhash, so it can never satisfy
`cdhash H"4a9e49fe…"`. This is not a flaky failure. It is arithmetically
impossible for every past and future release, as long as the build is ad-hoc
signed. A Developer ID signed app would instead carry a requirement of the form
`anchor apple generic and certificate leaf[subject.OU] = "TEAMID"`, which every
later build from the same team satisfies. That is the only thing that fixes it.

The empty `com.backspace.desktop.ShipIt` directory is Squirrel creating its state
directory, failing validation, and writing nothing.

### 2.3 Why the toast lies

`electron-updater`'s `MacUpdater.doDownloadUpdate()`
(`node_modules/electron-updater/out/MacUpdater.js:206-224`) fires
`dispatchUpdateDownloaded(event)` **inside the `server.listen` callback**, the
moment its local proxy server is up. It fires *before* Squirrel has been asked to
do anything:

```js
this.server.listen(0, "127.0.0.1", () => {
    this.nativeUpdater.setFeedURL({ ... });
    this.dispatchUpdateDownloaded(event);      // <- our "Update ready" toast
    if (this.autoInstallOnAppQuit) {
        this.nativeUpdater.once("error", reject);
        this.nativeUpdater.checkForUpdates();   // <- Squirrel now fails, later
    }
});
```

So `update-downloaded` means "the zip is on disk", not "the update can be
installed". Our main process treats it as the latter and shows a Restart button.

### 2.4 Why Restart does nothing

Squirrel never succeeds, so `squirrelDownloadedUpdate` stays `false`.
`MacUpdater.quitAndInstall()` (`MacUpdater.js:236-250`) then takes the else
branch:

```js
quitAndInstall() {
    if (this.squirrelDownloadedUpdate) { ... }
    else {
        this.nativeUpdater.on("update-downloaded", () => this.handleUpdateDownloaded());
        if (!this.autoInstallOnAppQuit) { this.nativeUpdater.checkForUpdates(); }
    }
}
```

We set `autoInstallOnAppQuit = true` (`main.ts:729`), so the guarded
`checkForUpdates()` is skipped. The method registers a listener for an event that
will never fire and returns. **No error, no feedback, no exception.** That is the
dead button, exactly.

### 2.5 Why the error toast hides behind the ready toast

`UpdateToast.tsx` holds two independent `useState` values and renders
`downloadedVersion` first (lines 33-36), returning early. The Squirrel error
arrives a second later and sets `failedUpdate`, but that branch is unreachable
until the user dismisses the ready toast. The user's exact observation.

### 2.6 Why it repeats every launch

Dismissal is component state. Nothing is persisted, so the 10-second post-launch
check re-runs the entire cycle on every start, re-downloading or re-validating
114 MB that can never be installed.

### 2.7 Summary of defects

| # | Defect | Root cause |
|---|--------|-----------|
| RC1 | Restart button is dead | `quitAndInstall()` no-ops when Squirrel never staged the update |
| RC2 | App claims an update is installable when it cannot be | `update-downloaded` is treated as "installable"; on macOS it only means "file on disk" |
| RC3 | 228 MB downloaded per machine for nothing | `autoDownload = true` unconditionally, on a platform that cannot install |
| RC4 | Error toast masked by the ready toast | Two independent states, render order decides, latest event does not win |
| RC5 | Nags on every launch | No persisted per-version dismissal |
| RC6 | "Checking…" in settings is a 5-second `setTimeout` fiction | `update-not-available` and `download-progress` are emitted by electron-updater and never wired |
| RC7 | Toast uses `.glass-pill` | Design system reserves `.glass-pill` for inline decorations; a persistent floating control is `.glass-bubble` |
| RC8 | Subtitle truncates mid-word | `truncate` on a `max-w-[340px]` container |
| RC9 | Native notification offers "Click to restart and install" on macOS | Same false premise as RC2; the click calls the dead `quitAndInstall()` |

---

## 3. Non-goals

- **Buying an Apple Developer ID is out of scope for this work.** It is the only
  real fix for macOS auto-update and it is a purchasing decision, tracked in
  `docs/systems/desktop-security.md`. This design is written so that the day a
  Developer ID lands in CI, macOS switches to real auto-update with no code
  change (see 4.1).
- **No in-app "update my server" button.** See 6.1 for why.
- Not changing the release pipeline, the image, or the CSP work.

---

## 4. Part A — Desktop update experience

### 4.1 Update capability is measured, not assumed

New module `packages/desktop/src/updateCapability.ts`.

```ts
export type UpdateCapability = 'auto' | 'manual';
```

`manual` means "this build cannot install its own updates; offer a download
instead". The value is computed once at startup and cached.

Detection, in order:

1. Not packaged (`!app.isPackaged`) -> `manual`. A dev build must never try.
2. `process.platform !== 'darwin'` -> `auto`. NSIS and AppImage update unsigned.
3. macOS: run `codesign -d -r- <app bundle path>` and parse the designated
   requirement.
   - The requirement is only a bare `cdhash H"…"` -> ad-hoc -> `manual`.
   - The requirement references `anchor apple generic`, `certificate leaf`, or
     `identifier` -> a real identity -> `auto`.
4. `codesign` missing, non-zero exit, or unparseable output -> `manual`.

Choosing `manual` on every uncertain path is deliberate: a Download button always
works, so the failure mode of guessing wrong is a slightly less convenient but
functional experience, never a dead button.

The parser is a pure function so it is testable without a Mac:

```ts
export function classifyDesignatedRequirement(codesignOutput: string): 'adhoc' | 'identified' | 'unknown';
```

This is the same pure-helper-plus-vitest shape already used by
`packages/desktop/src/autoLaunch.ts`.

**This is what makes the Developer ID a zero-code-change switch.** The probe
measures the property that actually determines whether Squirrel can work, rather
than hardcoding "macOS is broken", which would silently become a lie.

### 4.2 Do not download what cannot be installed

In `initAutoUpdater()`:

```ts
const capability = getUpdateCapability();
autoUpdater.autoDownload = capability === 'auto';
autoUpdater.autoInstallOnAppQuit = capability === 'auto';
```

In `manual` mode the flow stops at `update-available`. No 114 MB fetch, no proxy
server, no Squirrel invocation, therefore no spurious error either. RC3 and the
error-toast half of RC4 both disappear at the source.

### 4.3 Reclaim the dead cache

On startup, in `manual` mode only, delete the updater pending cache if present:

```
{app.getPath('cache')}/{sanitized-name}-updater/
```

Guarded to that exact path, only in `manual` mode, failures logged and ignored.
This recovers the 228 MB already stranded on every existing macOS install. It is
our own cache directory and holds nothing but a re-downloadable archive.

### 4.4 A single update state, latest event wins

Replace the two booleans with one discriminated union owned by the main process
and mirrored to the renderer.

```ts
export type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string; releaseUrl: string; canInstall: boolean }
  | { phase: 'downloading'; version: string; percent: number; bytesPerSecond: number }
  | { phase: 'ready'; version: string }
  | { phase: 'failed'; version: string | null; message: string; releaseUrl: string }
  | { phase: 'up-to-date'; checkedAt: number };
```

Rules:

- Every updater event replaces the whole status. There is no way for a stale
  `ready` to outrank a fresh `failed`, which is RC4 fixed structurally rather
  than by reordering JSX.
- `canInstall` is `capability === 'auto'`. The renderer never has to know about
  code signing; it renders a Restart button if and only if the main process says
  the build can install.
- `up-to-date` decays to `idle` after 5 seconds, matching the existing
  `lastCheckResult` convention in `recovery.ts`.

Existing IPC channels `update-available`, `update-downloaded` and `update-error`
are **kept** and keep their current payloads, because `recovery.html` and the
recovery state store consume the same events. One new channel carries the union:

| Channel | Direction | Payload |
|---|---|---|
| `update-status-changed` | M -> R | `UpdateStatus` |
| `get-update-status` | R -> M (invoke) | `UpdateStatus` |
| `dismiss-update` | R -> M | `{ version: string }` |
| `open-release-page` | R -> M | none, opens the releases URL externally |

`download-progress` is wired for the first time, feeding the `downloading` phase.
That closes RC6's second half.

### 4.5 Dismissal is persisted, and belongs to the app

New module `packages/desktop/src/updateDismissal.ts`, persisting to
`{userData}/update-state.json`:

```ts
interface UpdateDismissalState { dismissedVersion: string | null }
```

The dismissal lives in the main process, not `localStorage`, because an available
update is a property of **the installed app**, not of whichever instance the user
happens to be connected to. A user who switches instances must not be re-nagged.

`dismissedVersion` is compared against the offered version, so a *newer* release
always surfaces again. Dismissing 1.0.4 does not silence 1.0.5.

The main process applies the filter, so the renderer receives a status it should
act on and nothing else. `showNotification` respects it too.

### 4.6 The toast

Rewritten as `packages/web/src/components/ui/UpdateToast.tsx`, backed by a new
`packages/web/src/stores/updateStore.ts` (Zustand) so state survives remounts.

Surface: `.glass-bubble` (RC7). It is a persistent floating control, which is
exactly the tier's definition in `docs/systems/design-system.md`. Bottom-left,
`z-[300]`, `animate-slide-up`, `max-w-[400px]`. **No `truncate` on the body
copy** (RC8); it wraps to two lines, which is what the sentence needs.

Visible only when `phase` is `available`, `ready` or `failed`, and only when the
version is not dismissed. `checking`, `downloading` and `up-to-date` are settings
panel states, not interruptions.

`ready` (auto-capable builds):

> **Update ready**
> Backspace 1.0.4 is downloaded and ready to install.
> `[Restart now]`  `[Later]`  `×`

`available` with `canInstall: false` (ad-hoc macOS today):

> **Backspace 1.0.4 is available**
> You are on 1.0.3. This build cannot update itself, so download the new
> version from GitHub.
> `[Download]`  `[Release notes]`  `×`

The second sentence is the fix for "it feels broken": the app states plainly that
it will not self-install, instead of showing a Restart button that does nothing.

`failed`:

> **Update could not be installed**
> Backspace 1.0.4 downloaded, but installing it failed. You can install it
> manually.
> `[Download]`  `×`

`Later` and `×` both call `dismiss-update` for that version. Copy under the
buttons on first dismissal: "You can install this later from Settings, Desktop."
So nothing is lost and nothing nags.

### 4.7 Restart can no longer fail silently

`install-update` gets a watchdog. After calling `quitAndInstall()`, if the app is
still alive 4 seconds later, the main process transitions to
`{ phase: 'failed', message: 'Restarting to install did not start.' }`.

In `manual` mode the Restart button never renders, so this path is unreachable
there. The watchdog exists for the Windows and Linux cases where the same silent
no-op is possible, and it is defence in depth against RC1 recurring on a platform
we did not anticipate.

### 4.8 The native notification stops lying

`update-downloaded`'s notification currently reads "Click to restart and install
version X" and its click handler calls `quitAndInstall()` (RC9).

Branch on capability:

| Capability | Title | Body | Click |
|---|---|---|---|
| `auto` | Backspace update ready | Click to restart and install version X. | `quitAndInstall()` |
| `manual` | Backspace X is available | Click to open the download page. | `shell.openExternal(releasesUrl)` |

Fires on `update-available` in manual mode and `update-downloaded` in auto mode,
in both cases suppressed when the window is focused and when the version is
dismissed.

### 4.9 Settings, Desktop panel

`DesktopPanel.tsx`'s `UpdateSettings` is rewritten against the real event stream.
The `setTimeout(5000)` fiction goes away (RC6), along with its comment claiming
electron-updater has no "no update" callback, which is not true.

States rendered inline: `Up to date`, `Checking…`, `Downloading 43%`,
`1.0.4 ready to install [Restart]`, `1.0.4 available [Download]`,
`Check failed [Retry]`.

This panel ignores dismissal. It is the place a dismissed update remains
reachable, which is what makes dismissal safe.

---

## 5. Part B — Instance version and update for operators

### 5.1 New admin endpoint

`GET /api/admin/instance/update-status`, `preHandler: [authenticate, requireAdmin]`.

```ts
export interface InstanceUpdateStatus {
  current: { version: string; commit: string | null };
  latest: { version: string; url: string; publishedAt: string } | null;
  state: 'up-to-date' | 'update-available' | 'unknown';
  checkedAt: number | null;
  checkEnabled: boolean;
  reason: 'disabled' | 'unreachable' | 'rate-limited' | null;
  channel: 'prebuilt' | 'source' | 'unknown';
}
```

Lives in a new `packages/server/src/routes/adminUpdates.ts` rather than growing
`admin.ts`, whose 404 lines are already storage plus users plus settings.

Comparison uses a semver compare over the `\d+\.\d+\.\d+` triple. A tag that does
not parse yields `state: 'unknown'` rather than a wrong answer.

### 5.2 The instance never phones home on its own

**There is no background poller.** The GitHub call happens only while an
authenticated admin has the Updates panel open and the cache is cold.

This matters for a self-hosted, privacy-positioned product. An instance that
silently contacts a third party on a timer is a thing operators are entitled to
be annoyed about. Here, an admin opening the panel *is* the consent, and an
instance whose admin never opens the panel never contacts GitHub at all.

Implementation, in `packages/server/src/utils/releaseCheck.ts`:

- URL is the compile-time constant
  `https://api.github.com/repos/TheZwiss/backspace/releases/latest`. It is never
  derived from user input, so the SSRF policy in `docs/systems/embeds.md` does
  not apply; a comment records that reasoning at the call site.
- `User-Agent: Backspace`. GitHub requires a UA. The version is deliberately
  omitted so the request carries nothing that identifies the instance beyond the
  IP that any outbound request would expose.
- 5-second timeout, in-memory cache with a 6-hour TTL.
- Every failure is soft: `state: 'unknown'` with a `reason`. An operator with no
  outbound internet still gets a working panel showing their running version.
- `BACKSPACE_UPDATE_CHECK=false` disables it outright, for airgapped instances.
  The endpoint then returns `checkEnabled: false, reason: 'disabled'` without
  opening a socket.

### 5.3 Install channel

`install.sh` writes `BACKSPACE_INSTALL_CHANNEL=prebuilt|source` into `.env` at
the point it already branches on `BACKSPACE_BUILD`. Absent on pre-existing
installs, which map to `'unknown'` and simply show both sets of manual commands.
No guessing.

### 5.4 The Updates panel

New sub-tab **Instance -> Updates**, `packages/web/src/components/modals/instanceSettingsPanels/UpdatesPanel.tsx`,
registered in `InstancePanel.tsx` and in `MobileShell.tsx`'s `screenMap` as
`settings-instance-updates`, matching every existing sibling panel.

```
Updates

┌─ Running ─────────────────────────────────────────────┐
│  Backspace 1.0.3                                      │
│  commit 73cc4fd · prebuilt image                      │
└───────────────────────────────────────────────────────┘

┌─ 1.0.4 is available ──────────────────────────────────┐   accent-bordered
│  Released 3 September 2026 · Release notes ↗          │
│                                                       │
│  From your install directory:                         │
│  ┌──────────────────────────────────┐  [copy]         │
│  │ ./update.sh                      │                 │
│  └──────────────────────────────────┘                 │
│                                                       │
│  Takes a database backup, pulls the new image, and    │
│  restarts. If the new version does not come up        │
│  healthy it rolls back to the one you are on now.     │
│                                                       │
│  ▸ I don't have update.sh                             │
└───────────────────────────────────────────────────────┘

Last checked 2 minutes ago · [Check again]
```

- Up to date: the second card is replaced by a calm "You are on the latest
  release." with no call to action.
- `unknown`: "Could not reach GitHub to check for updates." plus the running
  version, still useful.
- `disabled`: "Update checks are turned off on this instance." with the env var
  named.
- The disclosure "I don't have update.sh" expands to `git pull` plus the raw
  `docker compose` commands for both channels. Necessary because an operator on
  1.0.4 does not yet have the script that ships in 1.0.5.

The command block is a `select-all`-friendly `<code>` with a copy button using
the existing clipboard pattern.

---

## 6. Part C — `update.sh`

### 6.1 Why there is no button

Triggering a container update from inside the container requires mounting
`/var/run/docker.sock`. That grants the container root on the host. Backspace
parses user-uploaded media, scrapes URLs for embeds, and accepts federation
payloads from remote instances, so any remote-code-execution bug in it would
become host root the moment that socket is mounted.

Trading that for a button that saves one `ssh` is not a trade worth making, and
it is the sort of thing that gets a CVE number. The panel therefore hands the
operator an exact, correct, copyable command instead, and the work goes into
making that command excellent.

### 6.2 What the script does

New `update.sh` at the repository root, alongside `install.sh`, `backup.sh`,
`restore.sh`, `deploy.sh`, following their conventions (`set -euo pipefail`,
`cd "$(dirname "$0")"`, coloured `info`/`warn`/`success` helpers).

```
./update.sh [--check] [--yes] [--no-backup]
```

Sequence:

1. **Preflight.** `docker` and `docker compose` present; `.env` exists;
   the `backspace` service is defined in the resolved compose files. Refuse
   early and clearly otherwise.
2. **Record the rollback point.** `docker inspect` the running container for its
   image digest. This exact digest is what a failed update returns to.
3. **Refresh the checkout, tolerantly.** If `.git` is absent, say so and carry on
   (an rsync-deployed host is a legitimate install). If the working tree is dirty
   or the branch has diverged, refuse to `git pull`, say why, and carry on with
   the image update. Never clobber an operator's local edits.
4. **Back up.** `./backup.sh` unless `--no-backup`. A failed backup aborts the
   update. This is the one step whose failure is fatal, because everything after
   it is only safe if it happened.
5. **Fetch.** `docker compose pull backspace` for `prebuilt`,
   `docker compose build backspace` for `source`. Channel from
   `BACKSPACE_INSTALL_CHANNEL`, falling back to detecting whether the resolved
   image ref is a GHCR ref.
6. **No-op detection.** If the pulled digest equals the recorded one, report
   "already on the newest image" and exit 0 without restarting. Restarting a chat
   server for nothing disconnects everyone in a voice call.
7. **Restart, narrowly.** `docker compose up -d backspace`. **The service is
   named explicitly and `--remove-orphans` is never passed**, because production
   hosts run other services behind the same compose project and the same Caddy.
   Recreating or reaping them is out of scope for a Backspace update and has
   caused outages before.
8. **Health gate.** Poll `docker inspect` for `Health.Status == healthy`, up to
   180 seconds. The compose healthcheck is `interval: 30s, retries: 5,
   start_period: 30s`, so anything under about 120 seconds would produce false
   failures.
9. **Verify the version actually moved.** Query `/api/instance/info` through the
   container and compare `version` against the pre-update value. A container that
   is healthy but still running the old code is a failed update, and only this
   check catches it.
10. **Roll back on failure.** Re-pin the recorded digest, `up -d backspace`, wait
    for healthy, and report both the failure and the restored version. Then point
    at `./restore.sh` for the database, and exit non-zero.

`--check` performs steps 1, 2, 3 (read-only), and 5's registry lookup via
`docker manifest inspect`, then reports whether an update is available and exits.
It writes nothing and restarts nothing.

`--yes` skips the single confirmation prompt, for cron and for `ssh host
'./update.sh --yes'`.

### 6.3 Why the version check in step 9

The Pi and VM updates performed on 2026-09-03 both had `git pull` fail (one host
is not a git checkout, the other has diverged) while `docker compose pull`
succeeded. The update was still correct, but nothing in the manual procedure
would have reported it if it had not been. Step 9 makes the script assert the
outcome rather than the steps.

---

## 7. Testing

| Area | Test | File |
|---|---|---|
| Capability parse, ad-hoc | bare `cdhash H"…"` -> `adhoc` | `packages/desktop/src/updateCapability.test.ts` |
| Capability parse, Developer ID | `anchor apple generic and certificate leaf…` -> `identified` | same |
| Capability parse, garbage | empty / error text -> `unknown` | same |
| Dismissal | dismissing 1.0.4 hides 1.0.4, still shows 1.0.5 | `packages/desktop/src/updateDismissal.test.ts` |
| Dismissal | corrupt JSON on disk yields a clean default, does not throw | same |
| Status reducer | `failed` after `ready` wins (RC4) | `packages/web/src/stores/updateStore.test.ts` |
| Status reducer | `available` with `canInstall: false` renders no Restart button | `packages/web/src/components/ui/UpdateToast.test.tsx` |
| Toast | dismissed version renders nothing | same |
| Release check | 200 with a newer tag -> `update-available` | `packages/server/src/utils/releaseCheck.test.ts` |
| Release check | 200 with the same tag -> `up-to-date` | same |
| Release check | timeout / 403 / unparseable tag -> `unknown` with a reason, never throws | same |
| Release check | second call inside the TTL performs no fetch | same |
| Release check | `BACKSPACE_UPDATE_CHECK=false` opens no socket | same |
| Endpoint | non-admin gets 403 | `packages/server/src/routes/adminUpdates.test.ts` |
| Endpoint | shape matches `InstanceUpdateStatus` | same |
| `update.sh` | `bash -n` and `shellcheck` clean | CI lint step |
| `update.sh` | `--check` on a live host reports without mutating | manual, recorded |

`update.sh` is verified end to end against the throwaway Kobold host before it
ships, including a deliberately failed update to exercise the rollback path.

---

## 8. Documentation to update

Per `CLAUDE.md`'s documentation rule, all of these are structural:

| Doc | Change |
|---|---|
| `docs/systems/desktop.md` | Auto-Update section rewritten: capability probe, manual mode, the `update-downloaded` semantics trap, new IPC channels, `update-state.json` in the persisted-files table, the notification branch |
| `docs/systems/desktop-security.md` | Record that the ad-hoc designated requirement is a cdhash literal and that this is the mechanism blocking auto-update, alongside the existing procurement note |
| `docs/systems/admin.md` | New `GET /api/admin/instance/update-status`, the Updates panel, `BACKSPACE_UPDATE_CHECK`, `BACKSPACE_INSTALL_CHANNEL` |
| `docs/systems/api.md` | The new endpoint |
| `docs/systems/deployment.md` | `update.sh`: sequence, rollback, `--check`, why the service is named explicitly |
| `docs/systems/design-system.md` | No change; the toast is being brought into compliance with it, not changing it |
| `README.md` | "Updating a running instance" points at `./update.sh` with the manual commands kept as the fallback |
| `.env.example` | `BACKSPACE_UPDATE_CHECK`, `BACKSPACE_INSTALL_CHANNEL` |

---

## 9. Sequencing

1. **WS1, desktop.** Fixes the reported bug. Independent of the rest.
2. **WS3, `update.sh`.** Must exist before the panel can point at it.
3. **WS2, server endpoint and Updates panel.** Depends on WS3.

WS1 and WS3 can proceed in parallel. All three ship in 1.0.5.
