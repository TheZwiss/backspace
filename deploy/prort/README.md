# PRoot/Android deployment kit

Everything in this directory is a **reproducible copy** of the changes that made
Backspace work on Debian 13 ARM64 under PRoot (Android 11), including voice,
video, screen share and the Electron client.

The primary, zero-CA URL is the Tailscale Serve endpoint:

```
https://backspace.<sua-tailnet>.ts.net
```

`/livekit` is proxied to LiveKit and `/` to the Backspace server. The Tailscale
node `backspace` must be shared (Machines → backspace → Share) with users from
another tailnet. On its own that share only gives them the TURN/TCP forward for
media, which is the worst path (TCP inside userspace WireGuard). For direct UDP
media, also share the Android node `mi-9t-pro`: LiveKit advertises only
`<TAILSCALE_IP>:7882/udp`, the Android node's address (see
`livekit/livekit.yaml.example` and `INSTALACAO-ANDROID-PROOT.md`, section 5).

## Contents

| Path | Purpose |
|---|---|
| `caddy/Caddyfile.example` | HTTPS/WSS edge for LAN/Tailscale IPs (optional if using Tailscale Serve) |
| `caddy/generate-cert.sh` | generates a Caddy-CA leaf certificate with LAN/WAN SANs |
| `livekit/livekit.yaml.example` | LiveKit SFU, TURN/UDP, TURN/TCP and relay settings |
| `livekit/*.patch` | exact LiveKit 1.13.11 patches for PRoot/netlink/port 443 |
| `livekit/PATCHES.md` | how to rebuild the patched LiveKit binary |
| `termux/backspace-autostart.sh` | starts the Debian/PRoot stack from Termux |
| `termux/30-backspace` | Termux:Boot entry |
| `../../start-stack.sh` | starts LiveKit, Tailscale userspace/serve, Caddy and Backspace |
| `../../stop-stack.sh` / `status-stack.sh` | stop/check |

## Secrets

Never commit:

- `.env`, `.env.*` (only `.env.example`)
- `livekit.yaml` (only `livekit.yaml.example`)
- `*.crt`, `*.key`, `*.pem`
- `data/` (SQLite and uploads)
- Tailscale auth keys and GitHub tokens

## Termux

Copy `termux/backspace-autostart.sh` to `$HOME` and
`termux/30-backspace` to `$HOME/.termux/boot/`, both mode 700. Opening Termux
also starts the stack through the `.profile` hook. Android boot needs the
**Termux:Boot** app installed and battery optimization disabled for Termux and
Termux:Boot.

Full operational notes: `../../INSTALACAO-ANDROID-PROOT.md`.

## Auto-update (`updater/auto-update.sh`)

The phone follows `private/main` on its own. Work lands on `Dev`; merging into
`main` (and pushing) is the release gesture.

Every 15 minutes (`INTERVAL`) the loop runs one cycle:

1. `git fetch private main`; nothing to do when `HEAD` already equals it.
2. Skips (and logs) when the checkout is on another branch, has local edits to
   tracked files, or is not an ancestor of `private/main`. Only `--ff-only`
   merges are ever made.
3. Takes a database snapshot (`src/scripts/snapshot.ts`) before touching code.
4. Runs `pnpm install --frozen-lockfile` only when a `package.json`, the lockfile
   or `patches/` changed, and builds the web bundle into `dist.new` only when
   `packages/web` or `packages/shared` changed, then swaps it in atomically.
5. Restarts only the Backspace server (never LiveKit/Caddy/Tailscale), and only
   when `packages/server` or `packages/shared` changed.
6. Waits up to 120 s for `/api/health`. On failure it resets to the previous
   commit, restores the previous `dist`, restarts, and records the bad commit in
   `/var/lib/backspace-update/bad-sha` so it is not retried until `main` moves.

Install on a phone (outside the repo, so merges never rewrite the running file):

```bash
mkdir -p /opt/backspace-update
cp /opt/backspace/deploy/prort/updater/auto-update.sh /opt/backspace-update/
chmod 755 /opt/backspace-update/auto-update.sh
/opt/backspace-update/auto-update.sh --ensure     # start the loop now
```

`start-stack.sh` and `termux/backspace-autostart.sh` call `--ensure`, so the loop
comes back after a reboot. After each successful update the installed copy is
refreshed from the repo. Other modes: `--check` (report only), no argument (one
cycle). Log: `/var/log/backspace/update.log`.

Limits: a failed rollback of a *database migration* is not automatic. The server
snapshots before migrating and the updater snapshots before every update; both
land in `data/backups/`. Restore with the repo's restore procedure if a release
migrated the schema and then had to be rolled back.
