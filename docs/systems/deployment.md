# Deployment & Operations

Operator- and contributor-facing reference for hosting Backspace: the Docker build pipeline, admin bootstrap, database backup/restore, image pinning, and the relevant environment variables.

Source files:
- `Dockerfile` -- multi-stage build (builder → runtime)
- `docker-compose.yml` -- `backspace` + `caddy` (+ optional `livekit`) services, healthcheck
- `Caddyfile` -- reverse proxy / auto-HTTPS config
- `install.sh` -- interactive first-time setup
- `deploy.sh` -- rsync + rebuild to Heidi's two boxes
- `backup.sh` / `restore.sh` -- manual snapshot + restore tooling (host side)
- `packages/server/src/config.ts` -- `config.backup.*` env parsing
- `packages/server/src/utils/backup.ts` -- `createSnapshot` (VACUUM INTO), `listSnapshots`, `pruneSnapshots`, off-box hook
- `packages/server/src/utils/backupWorker.ts` -- scheduled-snapshot interval worker
- `packages/server/src/db/index.ts` -- pre-migration snapshot trigger + WAL-checkpointing shutdown
- `packages/server/src/db/pendingMigrations.ts` -- `hasPendingMigrations` (gating predicate)
- `packages/server/src/db/migrate.ts` -- `ensureDefaults` (admin recovery net)
- `packages/server/src/routes/auth.ts` -- first-user-becomes-admin bootstrap
- `packages/server/src/scripts/snapshot.ts` -- manual snapshot CLI entrypoint
- `packages/server/src/scripts/remediate-seed-admin.ts` -- legacy seed-admin password rotation

**Out of scope:** voice/LiveKit operational tuning (see `docs/systems/voice.md`), upload/storage janitor (see `docs/systems/uploads.md`), and federation peering/replication (see `docs/systems/federation.md`).

---

## 1. Pipeline Overview

Backspace ships as a single application container fronted by Caddy. Everything is built and run via Docker Compose; there is no separate CI artifact — **the image is built on each target host** from source.

### Build: multi-stage Dockerfile

`Dockerfile` has two stages:

1. **`builder`** (`node:20-slim`) — enables pnpm via corepack, installs the full workspace with `pnpm install --frozen-lockfile`, copies `shared`/`server`/`web` source, and runs `pnpm --filter @backspace/web build` to produce the static frontend (`packages/web/dist`).
2. **`runtime`** (`node:20-slim`) — installs the native toolchain for `better-sqlite3` plus `ffmpeg` (`python3 make g++ ffmpeg`), installs production-only deps with `pnpm install --prod --frozen-lockfile` (`tsx` is a server runtime dependency), copies `shared` + `server` source and the prebuilt `web/dist`, creates `/app/data/uploads`, and starts the server with `node --import tsx/esm src/index.ts` from `/app/packages/server`.

The server is run through `tsx` (no separate transpile step); TypeScript is executed directly at runtime.

**AGPL § 13 commit injection.** The runtime stage declares `ARG BACKSPACE_COMMIT` + `ENV BACKSPACE_COMMIT=$BACKSPACE_COMMIT` so the running build's git commit is baked into the image and read by `config.commit` (exposed via `GET /api/instance/info`). `docker-compose.yml` forwards it through `build.args: { BACKSPACE_COMMIT: ${BACKSPACE_COMMIT:-} }`, and `deploy.sh` captures `git rev-parse --short HEAD` locally (the remote has no `.git` after rsync) and exports it inline before the remote `docker compose up -d --build`. Empty/unset → `config.commit` is `null` (local dev, or git unavailable). The source URL itself is `config.sourceCodeUrl` (env `BACKSPACE_SOURCE_URL`, default upstream) — operators running a modified build MUST set it to their fork.

### Run: `docker compose up -d --build`

`docker-compose.yml` defines:

| Service | Image / Build | Role |
|---------|---------------|------|
| `backspace` | `build: .` | The application server. Binds `./data:/app/data` (DB + uploads + backups), reads `.env`, sets `DB_PATH=/app/data/backspace.db` and `UPLOAD_DIR=/app/data/uploads`. `restart: unless-stopped`. |
| `caddy` | `caddy:2.11.1-alpine` | Reverse proxy with automatic HTTPS. Owns ports 80/443. `depends_on: backspace` with `condition: service_healthy`. |
| `livekit` | `livekit/livekit-server:v1.9.11` | Voice/video SFU. `network_mode: host`. Activated only when `COMPOSE_PROFILES=voice`. |

**Health-gated startup.** The `backspace` service declares a healthcheck that polls `/api/health` (a route registered in `packages/server/src/index.ts`) every 30 s with a 30 s `start_period`. Caddy does not start proxying until the app reports healthy, so a deploy never routes traffic to a half-initialized server. The same healthcheck is duplicated in the `Dockerfile` `HEALTHCHECK` directive so the container reports health even when run outside Compose.

### Caddy

`Caddyfile` reads `{$DOMAIN}` from the container environment (injected by Compose from `.env`) and:
- Strips a `/livekit/*` prefix and reverse-proxies LiveKit signaling to `host.docker.internal:7880` (LiveKit runs in host networking).
- Reverse-proxies everything else — API, WebSocket, and the static frontend — to `backspace:3000` over Docker's internal network.

Caddy provisions and renews TLS certificates automatically for `DOMAIN`; the persisted ACME state lives in the `caddy-data` / `caddy-config` named volumes.

### First-time setup: `install.sh`

`./install.sh` is the interactive installer for a fresh Linux host. It prompts for the domain (or reads `DOMAIN=… ./install.sh`), generates a `JWT_SECRET`, writes `.env`, optionally configures LiveKit (`livekit.yaml` + `COMPOSE_PROFILES=voice`), and brings the stack up with `docker compose up -d --build`.

### Redeploy: `deploy.sh [pi|vm|all]`

`./deploy.sh` is Heidi's redeploy helper for the two live instances — `nova.ddns.net` (Raspberry Pi) and `orbit.ddns.net` (VM). It does **not** build locally; it `rsync`s the working tree to the target (excluding `node_modules`, `.env`, `data/`, build output, and a list of local-only paths) and then runs `docker compose up -d --build` on the remote so the image is rebuilt in place. Targets:

| Arg | Target |
|-----|--------|
| `pi` / `--local` / `--remote` | Raspberry Pi (auto-detects LAN vs. public DNS, or forced) |
| `vm` / `beta` / `orbit` | Beta VM |
| `all` / `both` (default) | Both, in parallel |

The `data/` directory is excluded from the rsync, so application data on each box is never overwritten by a deploy.

---

## 2. Admin Bootstrap

**There is no default/seed admin account.** A fresh instance starts with zero users. Admin is granted by registration order, with a recovery net for the case where every admin is later deleted.

### First registered user becomes admin

In `packages/server/src/routes/auth.ts`, registration computes:

```ts
const userCount = db.select().from(schema.users).all().length;
const isFirstUser = userCount === 0 && !homeInstance;
// ...
isAdmin: isFirstUser ? 1 : 0,
```

The very first **locally-registered** user (`userCount === 0` **and** `!homeInstance`) is created with `isAdmin = 1`. The `!homeInstance` guard is a federation invariant: a replicated user (one whose identity is homed on another instance) is never an admin of *this* instance, even if they happen to be the first row written. This means the operator simply registers the first account after install to obtain admin rights — no credentials are printed, shipped, or stored anywhere.

### Recovery net: `ensureDefaults` re-promotes the earliest user

`ensureDefaults` (`packages/server/src/db/migrate.ts`) runs on **every boot**, after migrations. Among its idempotent invariants:

```ts
const anyAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
if (!anyAdmin) {
  const firstUser = db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get();
  if (firstUser) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(firstUser.id);
}
```

If the instance ever ends up with **no admins** (e.g. the sole admin deleted their account), the next restart promotes the earliest-registered remaining user back to admin. This guarantees an instance can never become permanently un-administerable. It does **not** run when an admin already exists, so it never overrides the operator's chosen admin set during normal operation.

### Seed-admin remediation (legacy instances only)

Instances installed **before** the no-seed-admin change still carry a local `admin` account whose password may be the old default `admin123`. That account cannot simply be deleted — the seeded admin **owns the default space**, so removing it would orphan the space. Instead, rotate its password with the remediation script:

```bash
docker exec -w /app/packages/server backspace \
  node --import tsx/esm src/scripts/remediate-seed-admin.ts
```

Behavior (`packages/server/src/scripts/remediate-seed-admin.ts`):

- **Targets only the local seed admin** — `username = 'admin'` with `home_instance IS NULL` and `is_admin = 1`. Replicated/federated users are never touched.
- **Rotates only `admin123`.** It verifies the current hash against `admin123`; if the password has already been changed, it is a **no-op** ("nothing to do"). It is fully idempotent — safe to run repeatedly.
- **Never deletes** the account (the default-space ownership constraint above).
- On rotation it generates a 24-character random password, updates the hash, prints the new password to stdout, **and** writes it to `data/seed-admin-rotated.txt` (mode `0600`, root-owned via the bind-mount). **Store the password somewhere safe, then delete `data/seed-admin-rotated.txt`.**

> **Note — sessions are not invalidated.** Rotation changes the stored password hash only; it does **not** revoke existing JWTs. An already-logged-in admin session survives until the token expires (`JWT_EXPIRES_IN`, default 30 days). Rotation closes off *future* logins with the old password; it does not eject a currently active session. If you must terminate live sessions immediately, rotate `JWT_SECRET` (which invalidates **all** tokens instance-wide) and restart.

Remediation applies only to pre-change instances; newly installed instances never have a seed admin and need none of this.

---

## 3. Database Backups

Backspace takes **DB-only** SQLite snapshots via `VACUUM INTO`, which produces a consistent, fully-checkpointed copy of the live database without locking it for the duration of a file copy. Snapshots live in `data/backups/` (configurable). Uploads and other files under `data/` are **not** included — see the same-disk limitation below.

### Triggers

| Trigger | Where | Reason tag | When |
|---------|-------|-----------|------|
| **Pre-migration** | `packages/server/src/db/index.ts` (`initDatabase`) | `pre-migration` | On startup, **only when a migration is actually pending** (see gating). |
| **Scheduled** | `packages/server/src/utils/backupWorker.ts` (`startBackupWorker`) | `scheduled` | Every `BACKUP_INTERVAL_HOURS`, via an `unref`'d `setInterval`. |
| **Manual** | `./backup.sh` → `src/scripts/snapshot.ts` | `manual` | On demand by the operator. |

Snapshot filenames encode a millisecond-precision UTC timestamp and the reason tag — `backspace-<ts>-<reason>.db` — so they sort chronologically and never collide (`createSnapshot` disambiguates with a counter on the rare same-millisecond collision, since `VACUUM INTO` refuses to overwrite an existing file).

### Pre-migration snapshot: gated and fail-closed

The pre-migration snapshot is deliberately conservative:

- **Gated on a pending migration.** `initDatabase` snapshots only when **(a)** the DB file already existed before this boot (captured *before* opening the handle, since opening creates the file — a post-open check would snapshot an empty 0-row DB on first boot) **and (b)** `hasPendingMigrations(sqlite, migrationsFolder)` returns true. `hasPendingMigrations` (`db/pendingMigrations.ts`) compares the applied-migration count in `__drizzle_migrations` against the journal's entry count; a missing table (pre-drizzle / empty DB) counts as pending. Because schema history is stable across most restarts, this avoids churning the pre-migration retention with identical copies on every reboot.
- **Fail-closed: a snapshot failure aborts startup by design.** If the snapshot throws (e.g. **disk full**), `initDatabase` logs and **re-throws — the migration does not run and the server does not start.** The box stays on the *old* code with its data intact until the operator frees space and restarts. **Backspace never migrates the schema without first securing a backup.** This is intentional: a failed-but-applied migration on an unbacked-up DB is the one unrecoverable scenario, so we refuse to enter it.

`BACKUP_DISABLED=true` turns off both the pre-migration snapshot **and** the scheduled worker (the gate at the top of `initDatabase` and the early return in `startBackupWorker`). Use it only when an external backup system owns `data/`.

### WAL checkpoint on shutdown

On `SIGINT`/`SIGTERM` the server calls `closeDatabase()` (`index.ts` shutdown handler), which checkpoints the WAL so the on-disk `backspace.db` is a complete, self-contained file. This keeps host-side copies of `data/backspace.db` consistent even without going through `VACUUM INTO` (e.g. an off-box host backup of the whole `data/` directory taken while the container is stopped).

### Configuration

All vars are parsed in `packages/server/src/config.ts` under `config.backup`. Defaults shown.

| Var | Default | Meaning |
|-----|---------|---------|
| `BACKUP_DIR` | `<dir(DB_PATH)>/backups` (i.e. `data/backups`) | Where snapshots are written. |
| `BACKUP_INTERVAL_HOURS` | `24` | Scheduled-snapshot cadence. |
| `BACKUP_KEEP_SCHEDULED` | `7` | Scheduled snapshots retained (newest-first). |
| `BACKUP_KEEP_PREMIGRATION` | `5` | Pre-migration snapshots retained. |
| `BACKUP_KEEP_MANUAL` | `10` | Manual snapshots retained. |
| `BACKUP_OFFSITE_CMD` | _(unset)_ | Off-box replication hook (see below). |
| `BACKUP_DISABLED` | `false` | Disable all automatic snapshots. |

### Retention / pruning

`pruneSnapshots()` enforces per-reason retention independently: it lists each reason's snapshots newest-first and unlinks everything past the keep count for that reason. Pruning runs after each **scheduled** and **manual** snapshot. (The pre-migration trigger does not prune inline — its own retention is enforced the next time a scheduled/manual snapshot prunes, and migrations are infrequent.) A failed prune is logged but never fatal.

### Off-box replication hook

After writing a snapshot, `createSnapshot` invokes `BACKUP_OFFSITE_CMD` (if set). The command is run as `sh -c '<cmd> "$1"'` with the new snapshot's absolute path passed as `$1`, so your command is **appended** the snapshot path as a trailing argument (and may also reference `"$1"` explicitly for full control over the destination). This is **best-effort**: failures are logged, never fatal, and run asynchronously. Examples:

```bash
# Each resolves to:  <cmd> "<absolute snapshot path>"
BACKUP_OFFSITE_CMD='rclone copy --quiet'        # → rclone copy --quiet "<snapshot>"  (dest must be in cmd, see below)
BACKUP_OFFSITE_CMD='aws s3 cp'                   # → aws s3 cp "<snapshot>"            (append the bucket, see below)

# When you need to control the destination, reference "$1" yourself:
BACKUP_OFFSITE_CMD='rclone copyto -- "$1" remote:backspace/$(basename "$1")'
BACKUP_OFFSITE_CMD='aws s3 cp -- "$1" s3://my-bucket/backspace/'
BACKUP_OFFSITE_CMD='rsync -a -- "$1" backup-host:/srv/backspace-backups/'
```

### Same-disk limitation (important)

Local snapshots live on the **same disk** as the live DB. They protect against:

- A bad migration (you can restore the pre-migration snapshot).
- Logical corruption or accidental data deletion.

They do **not** protect against **hardware loss** (disk failure, the box being destroyed). The snapshot dies with the disk that held the original.

> **To survive hardware loss you must replicate off the box.** Either set `BACKUP_OFFSITE_CMD` to push every snapshot to remote storage, **or** run a host-level backup of the `data/` directory (which also captures uploads, not just the DB). One of these is **required** for real durability; the built-in snapshots alone are not a disaster-recovery solution.

---

## 4. Restore

Restores are driven by `./restore.sh` from the host. Because `data/` (including `backspace.db` and `data/backups/`) is **container-owned (root)** via the bind-mount, the host user cannot rewrite those files directly — so the actual swap runs inside a throwaway root `alpine` container that mounts `data/`.

### List snapshots

```bash
./restore.sh
```

Lists every `*.db` in `data/backups/` newest-first with its size, and prints the restore command. (No arguments = list-and-exit; it never modifies anything.)

### Restore a snapshot

```bash
./restore.sh <snapshot-filename>
```

The argument is reduced to a basename — restore is always **from** `data/backups/`. After a `y/N` confirmation, the script performs:

1. **`[1/3]` Stop the `backspace` container** (`docker compose stop backspace`) so nothing is writing to the DB.
2. **`[2/3]` Swap inside a root `alpine` container** (`docker run --rm -v ./data:/data alpine sh -c …`):
   - **Pre-restore copy** — if `data/backspace.db` exists, copy it to `data/backups/backspace-<ts>-pre-restore.db` so the pre-restore state is recoverable.
   - **Clear WAL/SHM** — `rm -f data/backspace.db-wal data/backspace.db-shm` so stale sidecar files don't corrupt the restored DB.
   - **Install** — copy the chosen snapshot over `data/backspace.db`.
3. **`[3/3]` Start the container** (`docker compose start backspace`). On boot the server checkpoints/opens the restored DB and the healthcheck reports status (`docker compose logs -f backspace`).

The pre-restore copy means a mistaken restore is itself undoable: the previous DB is preserved as a `*-pre-restore.db` snapshot in `data/backups/`.

> The `pre-restore` reason tag is **not** in the auto-pruned reason set (`pre-migration` / `scheduled` / `manual`), so pre-restore copies are retained until manually cleaned up. Periodically prune old `*-pre-restore.db` files by hand if disk is tight.

---

## 5. Image Pinning & Upgrades

The two pulled images are **pinned to explicit tags** in `docker-compose.yml`, never `latest`:

| Service | Pinned image |
|---------|--------------|
| `caddy` | `caddy:2.11.1-alpine` |
| `livekit` | `livekit/livekit-server:v1.9.11` |

Pinning makes deploys reproducible — a rebuild pulls the exact same proxy/SFU version every time, so an upstream release can't silently change behavior under you. (The `backspace` image is built from source via the `Dockerfile`, which itself pins the `node:20-slim` base.)

**Upgrade procedure:** bump the tag in `docker-compose.yml` → test the new version (locally or on one box) → redeploy. Concretely:

1. Edit the image tag in `docker-compose.yml` (e.g. `caddy:2.11.1-alpine` → `caddy:2.12.0-alpine`).
2. Deploy to **one** box first (`./deploy.sh vm`) and verify `/api/health` is healthy and (for LiveKit) that voice still connects.
3. Once verified, roll it to the other box (`./deploy.sh pi`, or `./deploy.sh all` going forward).

Never pin to a floating tag like `latest` or a bare major — it defeats reproducibility and turns every rebuild into an uncontrolled upgrade.

---

## 6. Known Limitations (out of scope)

These are accepted constraints of the current deploy model, documented so operators aren't surprised:

- **The image is built on each target host, including the ARM Raspberry Pi.** There is no cross-built/registry-pushed artifact. The Pi build is slower and consumes build resources on the box (`deploy.sh` caps the build cache and prunes old images to compensate). A native-module or toolchain regression can surface on ARM but not x86, or vice-versa.
- **A deploy causes brief downtime + WebSocket reconnect.** `docker compose up -d --build` rebuilds and recreates the `backspace` container; while it restarts, the server is briefly unavailable and every connected client's WebSocket drops and must reconnect. There is no rolling/zero-downtime deploy. Clients reconnect automatically, but in-flight requests during the swap can fail.
- **`deploy.sh all` can mask one host failing.** The `all` target runs both deploys in parallel (`deploy … & deploy … & wait`). The visible "Deployment complete." is printed regardless of whether one host's build failed mid-stream; the failure scrolls by in the interleaved output. After an `all` deploy, **confirm `/api/health` on both boxes** rather than trusting the final line. For a high-stakes change, deploy to one box at a time.

---

## 7. Quick Operator Reference

| Task | Command |
|------|---------|
| First-time install | `./install.sh` (or `DOMAIN=chat.example.com ./install.sh`) |
| Redeploy both boxes | `./deploy.sh all` |
| Redeploy one box | `./deploy.sh pi` / `./deploy.sh vm` |
| Bring stack up manually | `docker compose up -d --build` |
| Check health | `curl -fsS https://<domain>/api/health` |
| Take a manual snapshot | `./backup.sh` |
| List snapshots | `./restore.sh` |
| Restore a snapshot | `./restore.sh <snapshot-filename>` |
| Rotate legacy seed admin | `docker exec -w /app/packages/server backspace node --import tsx/esm src/scripts/remediate-seed-admin.ts` |
| Grant first admin (fresh instance) | Register the first account; it becomes admin automatically. |
