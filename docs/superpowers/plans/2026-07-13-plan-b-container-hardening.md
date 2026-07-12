# Plan B — Container Hardening & Real Image Scanning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the published container image — run it as a non-root user, slim its runtime attack surface, and scan the actual amd64 image for OS/library CVEs before publishing — without breaking existing self-hosters or the multi-arch (amd64+arm64) GHCR publish.

**Architecture:** Two edits to the runtime layer (`Dockerfile` + a new `docker-entrypoint.sh`) plus a restructure of `docker-publish.yml` so a single-arch amd64 image is built and Trivy-scanned before the multi-arch push. The image scan is **report-only** here (matching Plan A's sequencing); Plan E flips it to blocking. SBOM + SLSA provenance are attached at push time.

**Tech Stack:** Docker multi-stage build (`node:20-slim`), Docker Buildx + QEMU, GitHub Actions, Aqua Trivy (image + SARIF), `gosu` for privilege drop, better-sqlite3 (prebuilt binary), tsx (runtime TS loader).

## Global Constraints

- **This plan builds on Plan A's branch** (`security/scanning-pipeline`); the workflows here are already SHA-pinned. Work branch: `security/container-hardening`.
- **Do not break existing self-hosters.** The `./data:/app/data` bind mount (`docker-compose.yml:31`) is host-owned; the container must still read/write it after `docker pull` + restart. The non-root switch is handled by an entrypoint that chowns `/app/data` **as root** then drops to the `node` user via `gosu` — so there is **no static `USER` line** (a static `USER` would run the entrypoint unprivileged and make the chown impossible).
- **Keep `ffmpeg`** (real runtime dependency) and **keep `tsx`** (the `CMD` runs TS via `tsx/esm`). Only `python3 make g++` may leave the runtime stage.
- **better-sqlite3 must still load.** It is expected to install via its prebuilt binary on `node:20-slim` (glibc) for both amd64 and arm64. If a task's build shows it compiling (needs the toolchain), use the documented fallback (keep the toolchain, OR copy the built module from the builder stage) and report it — do not ship a broken image.
- **Image scan is report-only in this plan** (`exit-code: '0'` + `continue-on-error: true`, comment `# report-only; enforcement flipped on in Plan E`). Do NOT make it fail the publish here.
- **trivy-action pinned to `ed142fd0673e97e23eac54620cfb913e5ce36c25` (# v0.36.0)** — v0.28.0's nested `setup-trivy@v0.2.1` ref is broken (see memory `ci-security-action-gotchas`). SHA-pin any other new action with a `# vX.Y.Z` comment.
- **Both build paths must keep working:** the GHCR prebuilt-image pull (`docker-compose.yml` `image:`) AND the from-source `docker compose up --build` fallback.
- **Commit identity:** plain `git commit` (local config = `Jannis Braun <151788261+TheZwiss@users.noreply.github.com>`). NEVER `-c user.email`; never the alxtrading94 email.
- **Node 20 / pnpm 10.34.3** are the pinned toolchain.
- **Docker daemon must be running** for Tasks 1 and 2 verification (`docker build` / `buildx --load`). If it is not up, STOP and report — do not mark a Dockerfile task done without a real build+boot.

---

### Task 1: Harden the runtime image (non-root via gosu, drop build toolchain)

**Files:**
- Create: `docker-entrypoint.sh`
- Modify: `Dockerfile` (runtime stage, lines 37-97)

**Interfaces:**
- Consumes: the existing builder stage output (`/app/packages/web/dist`).
- Produces: an image that runs `node --import tsx/esm src/index.ts` as the non-root `node` user (uid 1000) with a writable `/app/data`. No code symbols.

- [ ] **Step 1: Write the entrypoint script**

Create `docker-entrypoint.sh` at the repo root:

```sh
#!/bin/sh
# Runs as root: make the (bind-mounted, host-owned) data dir writable by the
# non-root `node` user, then drop privileges via gosu and exec the CMD. This
# lets the container run as uid 1000 while still owning ./data on hosts where
# the bind mount was created by a different uid.
#
# - Idempotent AND cheap: only chown entries not already node-owned, so after
#   the first boot this is near-instant. A plain `chown -R` over a large
#   uploads/ tree on slow Pi/SD storage would delay startup on EVERY restart.
# - Non-fatal: on a bind mount that rejects chown (some CIFS/NFS backings),
#   warn and continue rather than crash-looping under `restart: unless-stopped`
#   (the old root container booted fine on such mounts).
set -e
mkdir -p /app/data/uploads
chown node:node /app/data /app/data/uploads 2>/dev/null || true
find /app/data ! -user node -exec chown node:node {} + 2>/dev/null || \
  echo "docker-entrypoint: warning: could not chown /app/data; continuing (ensure it is writable by uid 1000)"
exec gosu node "$@"
```

- [ ] **Step 2: Modify the runtime stage's apt-get line**

In `Dockerfile`, replace the runtime-stage package install (currently line 42-44):

```dockerfile
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ ffmpeg && \
    rm -rf /var/lib/apt/lists/*
```

with (drop the C toolchain; keep ffmpeg; add gosu for the privilege drop):

```dockerfile
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg gosu && \
    rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 3: Wire the entrypoint + keep the CMD**

In `Dockerfile`, immediately AFTER the `RUN mkdir -p /app/data/uploads` line (currently line 73) add the entrypoint copy:

```dockerfile
# Non-root hardening: copy the privilege-dropping entrypoint. It chowns the
# data volume as root, then execs the CMD as the unprivileged `node` user.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
```

Then, at the END of the file, replace the final two lines (currently line 96-97):

```dockerfile
WORKDIR /app/packages/server
CMD ["node", "--import", "tsx/esm", "src/index.ts"]
```

with (add the ENTRYPOINT between WORKDIR and CMD; do NOT add a `USER` line):

```dockerfile
WORKDIR /app/packages/server
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "tsx/esm", "src/index.ts"]
```

- [ ] **Step 4: Build BOTH arches and confirm neither needs the toolchain**

The runtime stage runs its own `pnpm install --prod` (Dockerfile:61), so better-sqlite3 is installed **per arch** — and the arm64 install runs under QEMU at publish time, the one path that can hard-fail a release. Verify both arches locally before committing.

Run amd64 (loaded, for the boot test in Step 5):
```bash
docker buildx build --platform linux/amd64 --load -t backspace:hardening-test --build-arg BACKSPACE_COMMIT=test .
```
For arm64, do NOT do a full image build — the builder stage runs the Vite build under QEMU emulation, which is minutes-long and can exceed the shell timeout / OOM. The actual arm64 risk is narrow: whether `better-sqlite3` (and `sharp`) install from a **prebuilt binary** on the arm64 runtime base **without the toolchain**. Test exactly that, cheaply, by reproducing the runtime install on `node:20-slim` arm64 with NO toolchain present. First get the locked version so the test is faithful:
```bash
BSQL=$(grep -A1 'better-sqlite3@' pnpm-lock.yaml | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1); echo "testing better-sqlite3@$BSQL"
docker run --rm --platform linux/arm64 node:20-slim sh -c "
  cd /tmp && npm init -y >/dev/null 2>&1 &&
  npm install --no-audit --no-fund better-sqlite3@$BSQL sharp@0.33.5 2>&1 | grep -iE 'prebuild-install|prebuilt|node-gyp|gyp ERR|rebuild' | head -20;
  node -e \"require('better-sqlite3')(':memory:').close(); require('sharp'); console.log('arm64 native modules OK (no toolchain)')\"
"
```
Expected: BOTH the amd64 image build AND the arm64 native-module test succeed. **Watch the better-sqlite3/sharp output on each:** it should use a prebuilt binary (`prebuild-install` / prebuilt package), NOT `node-gyp`/compilation. The arm64 test prints `arm64 native modules OK (no toolchain)` — proving the modules load on arm64 glibc without the C toolchain (the arm64 `node:20-slim` used here has no `python3/make/g++`, exactly like the hardened runtime stage). If EITHER arch tries to compile, or the arm64 test errors, STOP — apply the fallback (re-add the toolchain to the runtime apt-get line, OR build the module in the builder stage and `COPY --from=builder`) and report which arch failed, which fallback you used, and why. Do not proceed on a one-arch pass.

Note: the amd64 `docker buildx ... --load` build runs pnpm install + the Vite build and may take a few minutes — run it with an ample timeout (or in the background) so it isn't killed mid-build.

- [ ] **Step 5: Boot the container and verify non-root + data volume + DB**

Run:
```bash
mkdir -p /tmp/bkspace-data
docker run -d --name bkspace-htest -e JWT_SECRET=testsecret_at_least_32_chars_long_xx -p 3999:3000 -v /tmp/bkspace-data:/app/data backspace:hardening-test
sleep 12
echo "--- health ---"; curl -fsS http://localhost:3999/api/health && echo " OK"
# IMPORTANT: check PID 1 (the actual server), NOT `docker exec ... id`. `docker exec`
# spawns a NEW process as the image's configured USER (root, since there is no USER
# line), so `exec ... id` prints uid=0 even when the gosu drop worked. /proc/1/status
# is the real server process's identity.
echo "--- server (PID 1) runs as node/uid 1000, not root ---"; docker exec bkspace-htest sh -c "grep '^Uid:' /proc/1/status"
echo "--- data dir written + owned by node ---"; docker exec bkspace-htest sh -c 'ls -ld /app/data /app/data/uploads'
echo "--- better-sqlite3 loaded (DB file exists) ---"; docker exec bkspace-htest sh -c 'ls -la /app/data/*.db 2>/dev/null || echo NO_DB'
echo "--- sharp (native, toolchain-sensitive) loads ---"; docker exec bkspace-htest node -e "require('sharp'); console.log('sharp OK')"
echo "--- boot logs clean (no EACCES / permission errors from running non-root) ---"; docker logs bkspace-htest 2>&1 | grep -iE 'EACCES|permission denied|EPERM' && echo "PERMISSION ERRORS FOUND" || echo "logs clean"
```
Expected: `/api/health` returns ok; `Uid:` line shows `1000 1000 1000 1000` (server runs non-root); `/app/data` + `/app/data/uploads` exist and are `node`-owned; a `.db` file was created (better-sqlite3 loaded and wrote); `sharp OK` prints (the OTHER native module survived the toolchain drop); logs show no permission errors. If any fails, fix before proceeding.

- [ ] **Step 6: Tear down the test container**

Run:
```bash
docker rm -f bkspace-htest; rm -rf /tmp/bkspace-data
docker rmi backspace:hardening-test 2>/dev/null || true
```

- [ ] **Step 7: Commit**

```bash
git add docker-entrypoint.sh Dockerfile
git commit -m "fix(docker): run container as non-root (gosu) and drop build toolchain from runtime"
```

---

### Task 2: Scan the image before publishing (restructure docker-publish.yml)

**Files:**
- Modify: `.github/workflows/docker-publish.yml`

**Interfaces:**
- Consumes: the hardened `Dockerfile` from Task 1.
- Produces: a publish workflow that builds amd64 → Trivy-scans it (report-only) → pushes multi-arch with SBOM + provenance. No code symbols.

- [ ] **Step 1: Restructure the build/scan/push steps**

In `.github/workflows/docker-publish.yml`, add `security-events: write` to the top-level `permissions` block (it currently has `contents: read` + `packages: write`):

```yaml
permissions:
  contents: read
  packages: write
  security-events: write
```

Then replace the single `Build and push (linux/amd64, linux/arm64)` step (currently lines 79-92) with the build → scan → push sequence:

```yaml
      # Build a single-arch amd64 image and LOAD it into the runner's docker
      # daemon so Trivy can scan the exact artifact before anything is published.
      # A multi-arch manifest cannot be --load'ed, so scanning must happen on a
      # single-arch build first; the multi-arch push below reuses these layers
      # from the buildx cache, so this is cheap.
      - name: Build amd64 image for scanning
        uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6.19.2
        with:
          context: .
          platforms: linux/amd64
          load: true
          push: false
          tags: backspace:scan
          build-args: |
            BACKSPACE_COMMIT=${{ steps.meta_commit.outputs.commit }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Trivy image scan (report-only)
        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        continue-on-error: true # report-only; enforcement flipped on in Plan E
        with:
          scan-type: image
          image-ref: backspace:scan
          ignore-unfixed: true
          format: sarif
          output: trivy-image.sarif
          severity: HIGH,CRITICAL

      - name: Upload Trivy image SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@02c5e83432fe5497fd85b873b6c9f16a8578e1d9 # v3.37.0
        with:
          sarif_file: trivy-image.sarif
          category: trivy-image

      # Publish the multi-arch image. Reuses the amd64 layers built above via the
      # gha cache. Attaches an SBOM and SLSA provenance attestation to the image.
      - name: Build and push (linux/amd64, linux/arm64)
        uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6.19.2
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.docker_meta.outputs.tags }}
          labels: ${{ steps.docker_meta.outputs.labels }}
          build-args: |
            BACKSPACE_COMMIT=${{ steps.meta_commit.outputs.commit }}
          sbom: true
          provenance: true
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Validate the workflow**

Run:
```bash
actionlint .github/workflows/docker-publish.yml
```
Expected: exit 0, no output.

- [ ] **Step 3: Confirm all actions still SHA-pinned**

Run:
```bash
grep -rnE 'uses: +[^ ]+@' .github/workflows/docker-publish.yml | grep -vE '@[0-9a-f]{40}' && echo "UNPINNED FOUND" || echo "All actions pinned to SHA"
```
Expected: `All actions pinned to SHA`.

- [ ] **Step 4: Locally reproduce the build→load→scan path**

This proves the new scan logic works without publishing anything (requires Docker daemon + local Trivy: `brew install trivy` if absent):
```bash
docker buildx build --platform linux/amd64 --load -t backspace:scan --build-arg BACKSPACE_COMMIT=test .
trivy image --severity HIGH,CRITICAL --ignore-unfixed backspace:scan | tail -25
docker rmi backspace:scan
```
Expected: the image builds + loads, and Trivy scans it and prints a summary (findings are fine — the scan is report-only; we just need it to RUN). Note accurately in the report: only the **amd64** image is Trivy-scanned; the published **arm64** image ships unscanned (acceptable for this plan). The multi-arch push + SBOM/provenance path cannot be exercised without publishing — it is verified by review + a maintainer `workflow_dispatch` run; the amd64 layers are gha-cache reused on the push, but the **arm64 layers build cold** there (so the push is not "free").

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/docker-publish.yml
git commit -m "ci(docker): scan the amd64 image before publish; attach SBOM + provenance"
```

---

### Task 3: Document the container hardening

**Files:**
- Modify: `docs/systems/deployment.md`
- Modify: `docs/systems/security-scanning.md`

**Interfaces:**
- Consumes: the changes from Tasks 1-2.
- Produces: an upgrade/migration note + an updated pipeline reference. No code symbols.

- [ ] **Step 1: Add a container-hardening + migration note to deployment.md AND correct now-false ownership statements**

Read `docs/systems/deployment.md` first to match its structure. Then:

(a) Add a subsection (place it near the Docker/image content) with this content:

```markdown
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
is expected and idempotent. If you previously accessed `./data` on the host as a
different user, adjust host-side access accordingly. `./restore.sh` continues to
work — it swaps files inside a throwaway root container, and root can rewrite the
now uid-1000-owned files.
```

(b) Correct the two statements that this change makes false (the data dir is no
longer root-owned):
- The seed-admin line (around `deployment.md:170`): change
  `writes it to `data/seed-admin-rotated.txt` (mode `0600`, root-owned via the bind-mount)`
  → `... (mode `0600`, owned by the container's runtime user uid 1000 via the bind-mount)`.
- The Restore intro (around `deployment.md:252`): change
  `Because `data/` (including `backspace.db` and `data/backups/`) is **container-owned (root)** via the bind-mount`
  → `... is **container-owned (uid 1000)** via the bind-mount`. (The throwaway
  root `alpine` container still performs the swap — root can rewrite uid-1000
  files — so the mechanism description after it stays correct.)

**Maintainer release-gate (record it, do not action it here):** before the first
`v*` tag that ships this image, do a real `docker compose pull && docker compose
up -d` on both an amd64 host and the arm64 Pi to confirm the attestation-bearing
image pulls on the actual deployment Docker versions.

- [ ] **Step 2: Reflect the image scan in security-scanning.md**

In `docs/systems/security-scanning.md`, update the supply-chain line about SBOM/provenance (currently "**will be** attached ... not yet live") to reflect that image scanning + SBOM + provenance now exist in `docker-publish.yml` (report-only image scan; SBOM + provenance attached at push). Add `docker-publish.yml` to the workflow table with trigger "tag push / manual" and result "image scan (report-only) + SBOM + provenance".

- [ ] **Step 3: Verify the docs reference reality**

Run:
```bash
grep -q 'non-root' docs/systems/deployment.md && grep -q 'provenance' docs/systems/security-scanning.md && echo "docs updated"
```
Expected: `docs updated`.

- [ ] **Step 4: Commit**

```bash
git add docs/systems/deployment.md docs/systems/security-scanning.md
git commit -m "docs(docker): document non-root runtime, data-volume migration, and image scan"
```

---

## Self-Review Notes

- **Spec coverage (WS2):** non-root USER via gosu (Task 1) ✓; slim runtime / drop toolchain with prebuilt-binary verification + fallback (Task 1) ✓; keep ffmpeg + tsx (Task 1 / constraints) ✓; bind-mount chown migration (Task 1 entrypoint + Task 3 doc) ✓; restructure to single-arch load → scan → multi-arch push (Task 2) ✓; SBOM + provenance (Task 2) ✓; image scan report-only, flips in Plan E (Task 2 + constraints) ✓.
- **Deferred by design:** flipping the image scan to blocking → Plan E. Desktop, web/CSP/CORS → Plans C/D.
- **Risk-managed:** the toolchain removal is verified by a real build that must show better-sqlite3 using a prebuilt binary; a fallback is defined if it compiles. The non-root switch is verified by asserting `uid=1000` at runtime and a successful `./data` write + DB creation. Multi-arch push + SBOM/provenance is review-plus-workflow_dispatch verified (cannot be exercised without publishing).
- **Enforcement stays OFF** — image scan is `continue-on-error` + `severity`-limited to HIGH/CRITICAL for the report; no build-failing gate added here.
- **Adversarial pre-execution review folded in:** the non-root verification now checks `/proc/1/status` (not `docker exec … id`, which spawns a new root process and would false-fail); BOTH arches are built to verify the toolchain drop (arm64 is the release-hard-fail path); the entrypoint chown is idempotent-cheap + non-fatal (Pi/CIFS safety); a `sharp` native-load smoke check + EACCES log scan were added; now-false `deployment.md` ownership statements are corrected; and an SBOM/provenance min-Docker floor + a maintainer pull-test release-gate are documented (attestation-bearing images can trip very old Docker on the `pull` path).
