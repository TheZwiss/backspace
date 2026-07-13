# Deployment & Operations

Operator- and contributor-facing reference for hosting Backspace: the Docker build pipeline, admin bootstrap, database backup/restore, image pinning, and the relevant environment variables.

Source files:
- `Dockerfile` -- multi-stage build (builder → runtime)
- `docker-compose.yml` -- base stack: `backspace` + `caddy` (+ optional `livekit`) services, healthcheck
- `docker-compose.proxy.yml` -- proxy/tunnel overlay: publishes the app on `127.0.0.1:APP_PORT` and drops Caddy
- `.github/workflows/docker-publish.yml` -- multi-arch (amd64+arm64) GHCR image publish
- `Caddyfile` -- reverse proxy / auto-HTTPS config (All-in-One mode only)
- `install.sh` -- interactive first-time setup, mode-aware (allinone / proxy / tunnel)
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

Backspace ships as a single application container. In the default **All-in-One** deployment it is fronted by the bundled Caddy (automatic HTTPS); behind an operator's own reverse proxy or a tunnel, Caddy is dropped and the container is published on a host loopback port instead (see [Deployment modes](#deployment-modes) below). The application image is a **prebuilt multi-architecture image published to GHCR** — `docker compose pull` (install.sh's default path) fetches `ghcr.io/thezwiss/backspace` for `linux/amd64` or `linux/arm64`, so weak/ARM hosts skip the heavy local build; a from-source build is the fallback when the image can't be pulled.

### Prebuilt image (GHCR)

`.github/workflows/docker-publish.yml` builds and pushes the application image to `ghcr.io/thezwiss/backspace` on every `v*` tag (and on manual `workflow_dispatch`). It is deliberately **separate from** the desktop-installer workflow (`release.yml`): the two share the `v*` tag trigger but build entirely different artifacts and must not be entangled.

- **Multi-arch.** `docker/setup-qemu-action` + `buildx` build `linux/amd64,linux/arm64` in one push, so a Raspberry Pi pulls a native image instead of cross-building (the Vite build OOMs small ARM boxes).
- **Tags.** `docker/metadata-action` derives `{version}`, `{major}.{minor}`, `latest` (on `v*` tags), and `sha-<short>`. A `workflow_dispatch` with an extra `tag` input publishes that tag too (e.g. `latest` without cutting a release).
- **AGPL § 13 commit stamping is preserved.** The workflow resolves `git rev-parse --short HEAD` and passes it as `--build-arg BACKSPACE_COMMIT=…`, exactly like `install.sh`/`deploy.sh`, plus OCI labels (`source`, `licenses=AGPL-3.0-only`, `revision`). The pulled image therefore advertises its exact source version via `GET /api/instance/info`.
- **Auth.** The push authenticates with the built-in `GITHUB_TOKEN` (`permissions: packages: write`). The GHCR package must be set **public** once for unauthenticated `docker pull` to work.
- **Compose wiring.** `docker-compose.yml` declares **both** `image: ${BACKSPACE_IMAGE:-ghcr.io/thezwiss/backspace}:${BACKSPACE_IMAGE_TAG:-latest}` **and** `build: .`. `pull`/`up` uses the image; `up --build` (deploy.sh, or install.sh's fallback) builds from source and tags the result under the same ref. Operators pin a version or point at a fork's registry via `BACKSPACE_IMAGE` / `BACKSPACE_IMAGE_TAG`.

### Deployment modes

One installer, three modes, recorded as `DEPLOY_MODE` in `.env`. `install.sh` auto-detects (and, when ambiguous, prompts); a non-interactive run honors an explicit `DEPLOY_MODE`.

| Mode | Ports 80/443 | Topology | TLS | Voice |
|------|--------------|----------|-----|-------|
| `allinone` (default) | must be free | base `docker-compose.yml`: `backspace` + `caddy` (+ `livekit`) | bundled Caddy (Let's Encrypt) | ✅ with UDP media ports open |
| `proxy` | already taken | base **+** `docker-compose.proxy.yml`: `backspace` on `127.0.0.1:APP_PORT`, no Caddy | operator's reverse proxy | ✅ if operator proxies `/livekit` and opens media ports |
| `tunnel` | already taken | same overlay as `proxy` | tunnel provider (Cloudflare, Tailscale…) | ❌ WebRTC/UDP can't traverse a tunnel |

**The overlay (`docker-compose.proxy.yml`).** Layered on top of the base file it (1) publishes `backspace` on `127.0.0.1:${APP_PORT:-8080}:${PORT:-3000}` — loopback only, so nothing is exposed on a public interface — and (2) parks `caddy` in an inert profile (`_proxy_mode_no_caddy`) that is never activated, so Caddy does not start. The base file is unchanged, so All-in-One (`docker-compose.yml` alone) behaves exactly as before.

**`COMPOSE_FILE` wiring.** In proxy/tunnel mode install.sh writes `COMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml` into `.env`. Docker Compose reads `COMPOSE_FILE` from `.env`, so **every** later `docker compose …` command in the directory transparently uses both files — the operator (and the update commands) never need `-f` flags. All-in-One leaves `COMPOSE_FILE` unset (defaults to `docker-compose.yml`).

**Server proxy-awareness.** The server sets Fastify `trustProxy: true`, so it trusts `X-Forwarded-*` from the fronting proxy/tunnel. `getOurOrigin()` returns `https://${DOMAIN}` (federation/public identity) whenever `DOMAIN` is set and `PUBLIC_ORIGIN` is unset — correct in all three modes, since the public URL is `https://DOMAIN` regardless of which layer terminates TLS. No `PUBLIC_ORIGIN` is needed for a normal proxy/tunnel deployment.

**Voice per mode.** LiveKit media is WebRTC over UDP and never flows through the HTTP proxy/tunnel — the media ports (`3478/udp` TURN, `7881/tcp` fallback, `50000-60000/udp` media) must be reachable from clients directly. All-in-One proxies LiveKit *signaling* through Caddy (`/livekit` → `host.docker.internal:7880`); a reverse-proxy operator must replicate that route (`/livekit` → `127.0.0.1:7880`, prefix stripped) **and** open the media ports. Over a tunnel, voice is unavailable and install.sh force-disables it. See `docs/systems/voice.md` for LiveKit tuning.

### Build: multi-stage Dockerfile

`Dockerfile` has two stages:

1. **`builder`** (`node:20-slim`) — enables pnpm via corepack, installs the full workspace with `pnpm install --frozen-lockfile`, copies `shared`/`server`/`web` source, and runs `pnpm --filter @backspace/web build` to produce the static frontend (`packages/web/dist`).
2. **`runtime`** (`node:20-slim`) — installs `ffmpeg` (media) + `gosu` (privilege drop) only — **no C toolchain**, since `better-sqlite3`/`sharp` load prebuilt binaries — installs production-only deps with `pnpm install --prod --frozen-lockfile` (`tsx` is a server runtime dependency), copies `shared` + `server` source and the prebuilt `web/dist`, creates `/app/data/uploads`, and runs the server **as the non-root `node` user** via `docker-entrypoint.sh` (which chowns `/app/data` as root, then `exec gosu node`) with `node --import tsx/esm src/index.ts` from `/app/packages/server`.

The server is run through `tsx` (no separate transpile step); TypeScript is executed directly at runtime.

**AGPL § 13 commit injection.** The runtime stage declares `ARG BACKSPACE_COMMIT` + `ENV BACKSPACE_COMMIT=$BACKSPACE_COMMIT` so the running build's git commit is baked into the image and read by `config.commit` (exposed via `GET /api/instance/info`). `docker-compose.yml` also declares it under `build.args: { BACKSPACE_COMMIT: ${BACKSPACE_COMMIT:-} }` (so a bare `docker compose build` picks it up from the environment). Both first-party build paths capture `git rev-parse --short HEAD` and feed it to the build:

- **`install.sh`** (the public first-time path) reads the commit from the checkout the operator cloned and passes it explicitly as `docker compose build --build-arg BACKSPACE_COMMIT=<sha>`. `--build-arg` is used instead of an exported env var because it survives the sudo/non-sudo `$COMPOSE` split (an exported var would be stripped by `sudo`). A tarball install (no `.git`) yields an empty arg → `null`.
- **`deploy.sh`** captures the commit locally (the remote has no `.git` after rsync) and exports it inline before the remote `docker compose up -d --build`.

Empty/unset → `config.commit` is `null` (local dev, tarball install, or git unavailable). The source URL itself is `config.sourceCodeUrl` (env `BACKSPACE_SOURCE_URL`, default upstream) — operators running a modified build MUST set it to their fork.

### Container hardening (non-root)

The runtime image runs as the unprivileged `node` user (uid 1000), not root. On
container start, `docker-entrypoint.sh` runs as root only long enough to `chown`
the `./data` bind mount to `node` (only entries not already node-owned, so it is
near-instant after the first boot), then drops privileges via `gosu` and execs the
server. The build toolchain (`python3`/`make`/`g++`) is not installed in the
runtime stage — `better-sqlite3` and `sharp` load from prebuilt binaries — which
shrinks the runtime attack surface. `ffmpeg` remains (a real runtime dependency).

The published image carries an SBOM and SLSA provenance attestation, and the
amd64 image is scanned by Trivy before publish (report-only). Note: only the
amd64 image is scanned; the arm64 image is published unscanned.

**Minimum Docker version:** the attestation-bearing multi-arch image requires a
reasonably modern Docker to `pull` cleanly (Docker Engine 24+ recommended).
Very old daemons (≤ 20.10) may mishandle the `unknown/unknown` attestation
manifests. New installs via `install.sh` (get.docker.com) are fine.

**Upgrade note for existing self-hosters:** on the first start of the hardened
image, the contents of your host `./data` directory are chowned to uid 1000. This
is expected and idempotent. On an instance with a large `uploads/` tree on slow
storage (e.g. a Pi on SD), the **first** restart after upgrade may take noticeably
longer as this one-time chown runs before the server starts; subsequent boots only
touch not-yet-node-owned entries and are near-instant. If you previously accessed
`./data` on the host as a different user, adjust host-side access accordingly. `./restore.sh` continues to
work — it swaps files inside a throwaway root container, and root can rewrite the
now uid-1000-owned files.

**Release-gate (maintainer):** before the first `v*` tag that ships this image,
do a real `docker compose pull && docker compose up -d` on both an amd64 host and
the arm64 Pi to confirm the attestation-bearing image pulls cleanly on the actual
deployment Docker versions, and that the container boots non-root with a writable
`./data` on real Linux (the macOS Docker Desktop bind-mount ownership display is
not representative of Linux behaviour).

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

`./install.sh` is the interactive installer for a fresh Linux host. It prompts for the domain, whether to enable voice, and an instance name (each skippable via the `DOMAIN` / `ENABLE_VOICE` / `INSTANCE_NAME` env vars for a non-interactive run), generates a `JWT_SECRET`, writes `.env`, optionally configures LiveKit (`livekit.yaml` + `COMPOSE_PROFILES=voice`), and brings the stack up.

**Mode selection.** Before configuring, it determines the deployment mode (precedence: explicit `DEPLOY_MODE` env → existing `.env` → auto-detect + prompt). Auto-detection checks whether ports 80/443 are free — and does so **Docker-aware**: it consults both `ss` *and* `docker ps` published ports, because a host running Docker with the userland proxy disabled DNATs 80/443 via iptables with **no listening socket for `ss` to see** (a box whose Caddy already owns those ports would otherwise be misread as "ports free"). When 80/443 are free it offers All-in-One (default); when taken it never dead-ends — it explains what holds them and steers to `proxy`/`tunnel`. In proxy/tunnel mode it auto-picks a free loopback `APP_PORT` (scanning past commonly-taken 3000/8080), force-lowers `MAX_UPLOAD_SIZE` to 90 MB for `tunnel` (Cloudflare's 100 MB body cap), and force-disables voice for `tunnel`.

**Image acquisition.** By default it pulls the prebuilt image (`docker compose pull backspace`). If the pull fails but a usable image is already present on the host (a prior run, an air-gapped `docker load`, or a previous from-source build tagged under the ref) it uses that copy rather than forcing a needless rebuild; only if neither pull nor a local image is available does it fall back to `docker compose build` (or when `BACKSPACE_BUILD=true` forces a source build, e.g. a fork). The commit is captured from the checkout and passed as `--build-arg BACKSPACE_COMMIT=<sha>` on the build path.

**Reverse-proxy / tunnel output.** In proxy/tunnel mode the post-deploy check verifies the app answers on `127.0.0.1:APP_PORT` (TLS is the operator's edge's job, not ours to test), and the summary prints paste-ready nginx / Caddy / Traefik snippets (proxy) or a `cloudflared` ingress rule (tunnel), each with WebSocket upgrade, `X-Forwarded-*`, and a body-size cap matching `MAX_UPLOAD_SIZE` already correct — plus the `/livekit` route and media ports when voice is on.

**Post-install HTTPS reachability check.** The container healthcheck only proves the app is up *inside* Docker — not that `https://DOMAIN` actually works, which additionally requires Caddy to have obtained a publicly-trusted certificate (DNS pointing here **and** ports 80/443 reachable from the internet). After the stack is healthy, the installer verifies this and reports it honestly instead of always printing success:

- It polls `curl -fsS --resolve DOMAIN:443:127.0.0.1 https://DOMAIN/api/health` for ~30 s. Using `--resolve` connects to the **local** Caddy while presenting the real SNI/Host and performing full certificate verification, so a pass proves a valid public cert is installed *and* the app answers over TLS. This is deliberately **hairpin-safe**: many self-hosted boxes cannot reach their own public address (router NAT hairpin), so a plain external self-request would false-negative even when the site is fine for everyone else.
- **Live** → the summary shows `HTTPS: Live`. **Not live yet** → `HTTPS: Not live yet` plus guidance (point DNS here, open/forward ports 80/443, watch `docker compose logs -f caddy`); Caddy keeps retrying and HTTPS comes up automatically once both are in place.

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
- On rotation it generates a 24-character random password, updates the hash, prints the new password to stdout, **and** writes it to `data/seed-admin-rotated.txt` (mode `0600`, **root-owned** — the script runs via `docker exec`, which bypasses the entrypoint's gosu drop and runs as root, so this file is uid 0 until the next container restart re-chowns it). **Store the password somewhere safe, then delete `data/seed-admin-rotated.txt`** (a non-root host user may need `sudo`).

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

Restores are driven by `./restore.sh` from the host. Because `data/` (including `backspace.db` and `data/backups/`) is **container-owned (uid 1000)** via the bind-mount, the host user cannot rewrite those files directly — so the actual swap runs inside a throwaway root `alpine` container that mounts `data/`.

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

The third-party images are **pinned to explicit tags** in `docker-compose.yml`, never `latest`:

| Service | Pinned image |
|---------|--------------|
| `caddy` | `caddy:2.11.1-alpine` |
| `livekit` | `livekit/livekit-server:v1.9.11` |

Pinning makes deploys reproducible — a rebuild pulls the exact same proxy/SFU version every time, so an upstream release can't silently change behavior under you.

The `backspace` image itself defaults to `ghcr.io/thezwiss/backspace:latest` (`BACKSPACE_IMAGE` / `BACKSPACE_IMAGE_TAG`). `latest` is chosen for a frictionless first install, but it is a **moving** tag: operators who want reproducible upgrades should pin `BACKSPACE_IMAGE_TAG` to a released version (e.g. `1.0.0`) in `.env` and bump it deliberately. On the source-build paths (`deploy.sh`, `install.sh`'s fallback) the image is built from the `Dockerfile`, which pins the `node:20-slim` base.

**Upgrade procedure:** bump the tag in `docker-compose.yml` → test the new version (locally or on one box) → redeploy. Concretely:

1. Edit the image tag in `docker-compose.yml` (e.g. `caddy:2.11.1-alpine` → `caddy:2.12.0-alpine`).
2. Deploy to **one** box first (`./deploy.sh vm`) and verify `/api/health` is healthy and (for LiveKit) that voice still connects.
3. Once verified, roll it to the other box (`./deploy.sh pi`, or `./deploy.sh all` going forward).

Never pin to a floating tag like `latest` or a bare major — it defeats reproducibility and turns every rebuild into an uncontrolled upgrade.

---

## 6. Known Limitations (out of scope)

These are accepted constraints of the current deploy model, documented so operators aren't surprised:

- **`deploy.sh` still builds on each target host.** The public `install.sh` path now defaults to the prebuilt GHCR image (multi-arch, so a Pi pulls a native image), but `deploy.sh` — Heidi's rsync-then-`up -d --build` helper for `nova`/`orbit` — deliberately builds from the rsynced working tree on the box (it caps the build cache and prunes old images to compensate). A native-module or toolchain regression can still surface on ARM but not x86, or vice-versa, on that path; the CI multi-arch build catches most such regressions before release.
- **A deploy causes brief downtime + WebSocket reconnect.** `docker compose up -d --build` rebuilds and recreates the `backspace` container; while it restarts, the server is briefly unavailable and every connected client's WebSocket drops and must reconnect. There is no rolling/zero-downtime deploy. Clients reconnect automatically, but in-flight requests during the swap can fail.
- **`deploy.sh all` can mask one host failing.** The `all` target runs both deploys in parallel (`deploy … & deploy … & wait`). The visible "Deployment complete." is printed regardless of whether one host's build failed mid-stream; the failure scrolls by in the interleaved output. After an `all` deploy, **confirm `/api/health` on both boxes** rather than trusting the final line. For a high-stakes change, deploy to one box at a time.

---

## 7. Quick Operator Reference

| Task | Command |
|------|---------|
| First-time install | `./install.sh` (or `DOMAIN=chat.example.com DEPLOY_MODE=proxy ./install.sh`) |
| Update (prebuilt image — default) | `git pull && docker compose pull && docker compose up -d` |
| Update (from source / fork) | `git pull && docker compose up -d --build` |
| Redeploy both boxes | `./deploy.sh all` |
| Redeploy one box | `./deploy.sh pi` / `./deploy.sh vm` |
| Bring stack up manually | `docker compose up -d` (proxy/tunnel: `.env`'s `COMPOSE_FILE` auto-adds the overlay) |
| Check health | `curl -fsS https://<domain>/api/health` |
| Take a manual snapshot | `./backup.sh` |
| List snapshots | `./restore.sh` |
| Restore a snapshot | `./restore.sh <snapshot-filename>` |
| Rotate legacy seed admin | `docker exec -w /app/packages/server backspace node --import tsx/esm src/scripts/remediate-seed-admin.ts` |
| Grant first admin (fresh instance) | Register the first account; it becomes admin automatically. |
