# Security Scanning & Hardening Initiative — Design

**Date:** 2026-07-10
**Status:** Approved (design); pending implementation plan
**Author:** Lead Developer (Backspace)

---

## 1. Motivation

A prospective self-hoster declined to run Backspace with the objection:

> "Security testing: You've made a web app. I am not installing a new webapp that
> is expected to touch the internet without some level of security scanning."

The objection is valid. Investigation of the current state shows Backspace has
solid security **engineering** but no security **assurance infrastructure**:

**Already present (good):**
- `SECURITY.md` with a private vulnerability-disclosure policy.
- Real defensive code: SSRF protection (`packages/server/src/utils/ssrf.ts` — DNS
  resolution, private-IP blocking, per-redirect-hop re-validation), HMAC-signed
  federation with replay-nonce prevention, sliding-window rate limiters, JWT +
  bcrypt, input validation.
- Good secrets hygiene: `.deploy.local` untracked; thorough `.gitignore`
  (`.env*`, `*.pem`, `*.key`, `data/`, `*.db`).
- CI (`ci.yml`) running typecheck + build + full test suite.

**Absent (the gap):**
- No SAST, no dependency/CVE scanning, no secret scanning, no container image
  scanning, no supply-chain hardening, no Dependabot.
- No visible, verifiable evidence a stranger can audit before trusting the app.
- **No browser-facing hardening** the objection actually cares about: no security
  response headers (`@fastify/helmet` absent; bare `Caddyfile`), CORS reflects any
  origin with credentials, unsigned desktop autoupdate, no Electron fuses/asar
  integrity, no license compliance gate for a dual-licensed (AGPL + commercial)
  project.

**Root cause (per the No-Band-Aids principle):** the fix is not a one-off scan. It
is a permanent, automated, and *visible* scanning pipeline wired into CI/CD, plus
remediation of the browser/desktop hardening gaps that continuous scanning would
be embarrassing to leave open.

---

## 2. Goals & Non-Goals

### Goals
1. Continuous, automated scanning on every change: SAST, dependency CVEs, secrets,
   container image, license compliance, supply-chain posture.
2. Tiered enforcement: high-confidence, fixable issues **block merge**; the rest are
   advisory in the GitHub Security tab. Never wall off merges on unfixable upstream
   CVEs.
3. Close the browser-facing and desktop-facing hardening gaps (headers, CORS,
   Electron integrity).
4. Publish verifiable evidence: badges, an OpenSSF Scorecard, SBOM/provenance, and
   documentation a stranger can read without repo access.
5. Land the whole thing without leaving CI spuriously red: scanners report-only →
   remediate → flip enforcement.

### Non-Goals (explicitly out of scope for this initiative)
- **npm provenance / package signing** — every workspace is `"private": true`;
  nothing is published to npm. N/A.
- **Purchasing desktop code-signing certificates** — a procurement action (Apple
  Developer ~$99/yr, a Windows code-signing cert) that cannot be done in code. We
  implement the *code-level* Electron hardening and *document* the signing steps
  and certs to buy; we do not fake signing.
- **Full fuzzing harness for federation input** — valuable but multi-week; deferred.
  A handful of targeted negative/property tests on `validateExternalUrl` and S2S
  JSON parsing is in scope; a standing fuzz harness is not.
- **TLS/cipher configuration** — Caddy already auto-provisions HTTPS with modern
  defaults; we add security *headers*, not a TLS overhaul.

---

## 3. Tool Selection & Rationale

Where a "GitHub-native" option and a "committed-workflow" option overlap, we prefer
**committed workflow files** — a self-hoster auditing the repo can read a `.yml`
file; they cannot read repo settings. Settings-only toggles are documented as
required manual steps, never claimed as code.

| Scan class | Choice | Rationale |
|---|---|---|
| SAST | **CodeQL** (committed advanced workflow, default `security` suite to start) | Free for public repos, best TS/JS coverage, `none` build mode sidesteps monorepo/native-module build complexity. `security-extended` deferred to avoid a day-one triage tax. |
| Dependency CVEs | **OSV-Scanner** (blocking CI gate) **+ Dependabot** (auto-upgrade PRs) | OSV-Scanner parses `pnpm-lock.yaml` v9 directly and can fail the build; Dependabot alerts are advisory-only. Two distinct roles, no overlap. **Trivy is NOT used for dependency CVEs** (avoids double-noise). |
| Secrets | **gitleaks** (committed, full history + PR diff) **+** documented native push-protection | gitleaks is the verifiable, blocking, history-aware gate; native push-protection is the complementary pre-commit net for the future. |
| Container image | **Trivy** (image scan, blocking) | SARIF output, `ignore-unfixed: true` for tiered policy, scans the exact GHCR image users pull. |
| IaC/config | **Trivy config** (Dockerfile, docker-compose) | Note: Trivy does **not** lint the `Caddyfile`; the reverse-proxy hardening is done by hand (§6.3). |
| License compliance | **Trivy `--scanners license`** with an allowlist | Dual-licensed AGPL + commercial → a copyleft-incompatible transitive dep is a legal defect. Reuses the Trivy we already run. |
| Supply chain | **SHA-pinned actions + harden-runner (audit) + SBOM + SLSA provenance + OpenSSF Scorecard** | Answers "can I trust the build?" and produces a public Scorecard badge. |
| Dynamic (DAST) | **ZAP baseline** against an ephemeral `docker compose up` (advisory) | Catches missing headers + CORS reflection continuously; the one dynamic check for a "webapp exposed to the internet." |

---

## 4. Architecture — Component Layout

Each workflow file has one clear purpose (mirrors the codebase's module-boundary
principle).

```
.github/
  dependabot.yml            NEW  — pnpm(npm) + github-actions + docker(Dockerfile only)
  workflows/
    codeql.yml              NEW  — CodeQL SAST (PR + push main + weekly)
    security.yml            NEW  — gitleaks + OSV-Scanner + Trivy config + Trivy license
    scorecard.yml           NEW  — OpenSSF Scorecard (push main + weekly) → Security tab + badge
    dast.yml                NEW  — ZAP baseline vs ephemeral compose stack (advisory)
    docker-publish.yml      EDIT — restructure for real image scanning + SBOM + provenance
    ci.yml                  EDIT — harden-runner (audit), tighten permissions
    release.yml             EDIT — harden-runner (audit), tighten permissions
    cla.yml                 EDIT
    deploy-pages.yml        EDIT
```

**SHA-pinning applies to EVERY workflow** — the four edited above, `docker-publish.yml`,
and all four new ones (`codeql`/`security`/`scorecard`/`dast`). Pin every `uses:` to a
full commit SHA with a trailing `# vX.Y.Z` comment. (OpenSSF Scorecard's
Pinned-Dependencies check and tag-move attack resistance both require this repo-wide.)

```
Dockerfile                  EDIT — non-root USER, slim runtime, copy pruned node_modules
Caddyfile                   EDIT — security response headers
packages/server/src/index.ts      EDIT — @fastify/helmet + CSP; tighten CORS
packages/server/package.json      EDIT — add @fastify/helmet
packages/web/index.html           EDIT — CSP meta (defense in depth for static shell)
packages/desktop/src/main.ts      EDIT — will-navigate deny handler
packages/desktop/electron-builder.yml  EDIT — @electron/fuses / asar integrity
packages/desktop/package.json     EDIT — add @electron/fuses
README.md                   EDIT — badges + "Security & supply chain" section
SECURITY.md                 EDIT — "Security testing & assurance" section
docs/systems/security-scanning.md   NEW — full pipeline spec
docs/systems/desktop-security.md    NEW — Electron hardening + signing procurement
CLAUDE.md                   EDIT — add subsystem-table rows
```

---

## 5. Policy Engine (tiered enforcement)

| Finding | Action |
|---|---|
| gitleaks secret hit | **Block** (always) |
| OSV-Scanner — fixable HIGH/CRITICAL | **Block** |
| Trivy image — fixable HIGH/CRITICAL (`ignore-unfixed: true`) | **Block** |
| Trivy license — disallowed license | **Block** |
| CodeQL — any alert | Advisory (SARIF → Security tab) |
| OSV/Trivy — unfixable, or medium/low | Advisory (SARIF → Security tab) |
| ZAP baseline (DAST) | Advisory (report artifact) |
| Scorecard | Advisory (score badge + Security tab) |

**Enforcement honesty — two mechanisms, kept separate:**
- **Code-enforced (auditable in the `.yml`):** OSV-Scanner, Trivy, and gitleaks
  block via workflow exit codes.
- **Settings-enforced (documented one-time toggles, NOT claimed as code):** CodeQL
  merge-blocking (code-scanning merge protection), Dependabot alerts, native
  secret-scanning + push protection, and branch protection "require status checks."
  These live in `docs/systems/security-scanning.md` as a maintainer checklist.

---

## 6. Workstreams (bounded, independently reviewable)

Sequencing rule: **WS1 scanners land report-only → WS5 remediation → flip WS1/WS2
enforcement to blocking.** WS3/WS4 are otherwise independent and can land in
parallel. Two cross-workstream dependencies to respect: **(a)** WS3 (CSP/CORS
validation) and WS6's DAST job share the same **two-instance + LiveKit ephemeral
test rig** — build it once, reuse it; **(b)** WS6's badges + maintainer checklist
document state produced by WS1/WS2/WS5, so its final copy is written *last* (the
workflow files can be scaffolded earlier).

### WS1 — Scanning & supply-chain pipeline (report-only first)
- `.github/dependabot.yml`:
  - `package-ecosystem: npm` at `/` (Dependabot handles pnpm workspaces), weekly,
    grouped minor/patch.
  - **`ignore` `uiohook-napi`** — it is pinned by an exact-version patch
    (`patches/uiohook-napi@1.5.5.patch`); an unmatched bump breaks
    `pnpm install --frozen-lockfile` in CI and both Docker stages. Also treat
    `onlyBuiltDependencies` (`better-sqlite3`, `esbuild`, `electron`, `sharp`)
    bumps with care (grouped, expect native-rebuild churn).
  - `package-ecosystem: github-actions` at `/`.
  - `package-ecosystem: docker` at `/` — tracks the **Dockerfile `FROM`** only.
    **No compose entry:** `docker-compose.yml` sits at the same `/` directory (a
    second docker entry there would collide on ecosystem+directory), and Dependabot's
    docker ecosystem parses Dockerfiles, **not** `image:` refs in compose. The pinned
    `caddy:2.11.1-alpine` / `livekit/livekit-server:v1.9.11` compose images are
    therefore updated **manually** — added as a line item to the maintainer checklist
    in `docs/systems/security-scanning.md`. (Renovate, which does parse compose, is
    noted there as an optional future alternative.)
- `codeql.yml`: languages `javascript-typescript`, default `security` queries,
  triggers PR + push `main` + weekly cron. SARIF uploaded.
- `security.yml`:
  - **gitleaks** — full history + PR diff, SARIF, **block** on hit.
  - **OSV-Scanner** — reads `pnpm-lock.yaml`; report-only initially, then block on
    fixable HIGH/CRITICAL after WS5.
  - **Trivy config** — Dockerfile + docker-compose misconfig, SARIF, advisory.
  - **Trivy license** — `--scanners license` against the dependency tree with an
    allowlist (permissive + AGPL-compatible); block on disallowed.
- `scorecard.yml`: `ossf/scorecard-action`, push `main` + weekly, publish results +
  badge.
- Harden **all** workflows (new and existing, incl. `docker-publish.yml`): pin every
  `uses:` to a full commit SHA (retain a `# vX.Y.Z` comment); add
  `step-security/harden-runner` in **`egress-policy: audit`** (not block — multi-arch
  buildx + QEMU + gha cache make many egress calls); tighten job-level `permissions`
  to least privilege.

### WS2 — Container hardening & real image scanning
- **Restructure `docker-publish.yml`** (the current single multi-arch `build-push`
  cannot be scanned before publish):
  1. Build **single-arch `linux/amd64`** with `load: true`.
  2. **Trivy image scan** (`ignore-unfixed: true`, block on fixable HIGH/CRITICAL),
     SARIF uploaded.
  3. On pass, the multi-arch (`amd64,arm64`) `build-push` with `push: true`,
     `sbom: true`, `provenance: true`. (Buildx cache makes the second build cheap.)
  - Trivy authenticates to GHCR with the same `GITHUB_TOKEN` used for login (the
    package may be private until manually flipped public).
- **Dockerfile hardening:**
  - **Prune mechanics (precise):** the builder runs a *full* `pnpm install
    --frozen-lockfile` (Dockerfile:25) whose `node_modules` is a symlinked `.pnpm`
    virtual store — a plain `COPY --from=builder node_modules` is **not**
    self-contained. Use `pnpm --filter @backspace/server deploy --prod
    /app/deploy` in the builder to produce a dereferenced/hoisted prod tree, then
    `COPY --from=builder /app/deploy` into the runtime stage. This replaces the
    runtime stage's own `pnpm install --prod`, letting `python3 make g++` be dropped
    from runtime. **Keep `ffmpeg`** (real runtime dep) and **keep `tsx`** as a prod
    dependency (the CMD runs TS via `tsx/esm`). Verify `better-sqlite3`'s prebuilt
    binary and `tsx` are present in the copied tree for **both** target arches.
  - **Non-root + bind-mount chown (reconciled — the two are mutually exclusive if
    done naively):** `docker-compose.yml:31` bind-mounts host-owned `./data:/app/data`.
    Chowning it requires **root**, so we do **not** hard-set a `USER` line (that would
    run the entrypoint as non-root and make the chown impossible). Instead: install
    `gosu` (or `su-exec`), add an `ENTRYPOINT` that (a) idempotently `chown`s
    `/app/data` to a fixed non-root UID, then (b) `exec gosu <uid> "$@"` to drop
    privileges — so the process runs non-root while the volume stays writable. The
    `ENTRYPOINT` must `exec "$@"` to preserve the existing `WORKDIR
    /app/packages/server` + `CMD ["node","--import","tsx/esm","src/index.ts"]`
    (Dockerfile:96-97). Ship a documented upgrade note; must not break existing
    self-hosters on `docker pull` + restart.

### WS3 — Web/server hardening

**Reality check (from review):** this app renders *arbitrary user-supplied content*
and is *federated*, so a restrictive `img-src`/`media-src`/`connect-src` is
infeasible. A CSP here realistically constrains `script-src` / `object-src` /
`base-uri` / `frame-ancestors` / `form-action` (the XSS/clickjacking-relevant
directives) and stays permissive on content origins. Concretely:
- **`img-src` / `media-src` must be broad** (`https: data: blob:`): link-embed OG
  images (`VideoEmbed.tsx`, `RichEmbed.tsx`) come from *any* linked site, and GIF
  previews load directly from Klipy's CDN (`routes/gif.ts` returns `file.url`
  unproxied — the CDN host differs from `api.klipy.com`).
- **`connect-src` must include the LiveKit `wss://` origin, which is operator
  config** (`routes/livekit.ts` returns `config.livekit.url` = `LIVEKIT_URL`
  verbatim) — so the **CSP must be generated at runtime from config**, not a static
  string. Federation (`getApiForOrigin` in `exploreStore`/`socialStore`/`spaceStore`)
  fetches/opens WS to peers discovered at runtime → `connect-src` must also allow
  `https: wss:` (peers aren't enumerable at build time).
- **`frame-src` needs an explicit provider allowlist** — YouTube, Vimeo, Spotify
  embed origins — or the embed iframes break (default `frame-src 'self'` blocks them).

Steps:
- Add `@fastify/helmet`. Build the CSP **dynamically** from `config.livekit.url` +
  the embed-provider list; ship it **report-only first**, validate against real flows
  (chat, **cross-instance federation**, embed render, upload, and a **real voice
  join**) with zero violations, then flip to enforcing.
- `packages/web/index.html`: CSP `<meta>` (defense-in-depth) — script/object/base
  directives only; do not duplicate the dynamic connect/img rules there.
- `Caddyfile`: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy`, and clickjacking protection via CSP `frame-ancestors` (prefer
  over `X-Frame-Options`). **Ownership split (documented to avoid conflicts):** Caddy
  owns HSTS + nosniff + Referrer-Policy; the app (helmet) owns the CSP. Don't set CSP
  in two places.
- **CORS (`packages/server/src/index.ts:46-48`)** — replace `origin: true` with a
  **dynamic `origin` callback backed by the live federation-peer registry**, NOT a
  static `DOMAIN`-derived list. Two breakages a static list would cause, both must be
  handled:
  - **Federated browser uploads:** browsers make cross-origin tus POST/HEAD/PATCH/
    DELETE to peer `/api/files/*` (see the existing CORS-block comment at
    `index.ts:50-64`); peers are DB-backed and added after boot → the callback must
    consult the live registry, not a boot-time snapshot.
  - **Desktop instance picker:** `packages/desktop/resources/instance-picker.html`
    does a renderer `fetch('<url>/api/instance/info')` from a `file://` document
    (Origin `null`). Keep `/api/instance/info` **CORS-open** (or move that probe to a
    main-process fetch) so the picker doesn't report instances as unreachable.
  - **Federation note:** S2S endpoints authenticate by HMAC and receive no browser
    `Origin`; verify they are unaffected by the two-instance federation integration
    suite.
- **Rollout (phased, like the scanners):** CSP report-only → observe → enforce; CORS
  gets a **"log-and-allow" observation phase** (log rejected origins without blocking)
  before switching to reject. **Test-rig dependency:** validating CSP + CORS here
  needs the **two-instance + LiveKit** harness (shared with the DAST env, §WS6/G2),
  which is heavier than a single-instance boot — call this out when scheduling.

### WS4 — Desktop/Electron hardening
- **Fuses without breaking the existing hook:** `electron-builder.yml:20` already
  declares `afterPack: ./scripts/afterPack.js` (it strips host-compiled
  `uiohook-napi` artifacts + cross-platform prebuilds), and electron-builder allows
  **only one** `afterPack`. So do **not** add a second hook. Prefer electron-builder's
  top-level **`electronFuses:`** config key (cleanest, no collision); if a fuse isn't
  expressible there, call `@electron/fuses` `flipFuses()` **inside** the existing
  `scripts/afterPack.js`. Fuses: disable `RunAsNode` + `EnableNodeCliInspectArguments`,
  enable `OnlyLoadAppFromAsar`. **Asar-integrity caveat:** it interacts with the
  existing `asarUnpack: **/*.node` (lines 17-18) and the afterPack that mutates
  `app.asar.unpacked` — integrity hashes must be computed *after* those mutations, and
  because builds are unsigned (`release.yml:93`) macOS integrity **enforcement** is
  limited; document this in `desktop-security.md` rather than over-claiming.
- **`will-navigate` deny handler** in `main.ts`: block foreign top-level navigations
  while allowing the initial `https://` instance load and the `file://` picker.
  Clarification (mechanism): the app is client-routed (history API →
  `did-navigate-in-page`), cross-instance switching uses main-process `loadURL`, and
  `/join/*` deep-links are handled by `setWindowOpenHandler` (`main.ts:454`) — none of
  these are `will-navigate`, so the deny handler is safe and `setWindowOpenHandler`
  stays untouched.
- `docs/systems/desktop-security.md`: document the current webPreferences posture
  (contextIsolation on, nodeIntegration off, sandbox on — `main.ts:356-360`), the
  fuses/asar posture and its unsigned-macOS limits, and — because `release.yml:93`
  sets `CSC_IDENTITY_AUTO_DISCOVERY: false` (unsigned) — the exact signing +
  notarization steps and certificates to procure. Flag unsigned autoupdate as a known
  gap until signing is wired up.

### WS5 — Remediation (after WS1 lands report-only)
- Run OSV-Scanner + Trivy + CodeQL; triage. Fix real HIGH/CRITICAL: direct upgrades,
  `pnpm.overrides` for transitive pins where no direct upgrade exists, code fixes for
  true-positive SAST findings. Dismiss false positives **with written justification**
  (`.trivyignore` / inline).
- **SSRF hardening (fix, then test — not just test):** the string-prefix
  `isPrivateIp` (`utils/ssrf.ts:3-16`) is genuinely bypassable — `::ffff:127.0.0.1`
  matches no branch and returns `false` (SSRF to loopback via an attacker AAAA
  record), and there is no `100.64.0.0/10` (CGNAT) or `::` handling. **Harden
  `isPrivateIp`**: normalize IPv4-mapped IPv6, reject CGNAT and `::`/unspecified, and
  normalize decimal/octal/hex hostname encodings — *then* add the negative/property
  tests for `validateExternalUrl` covering those vectors. The residual DNS-rebind
  TOCTOU is already documented (`ssrf.ts:58-61`) and stays out of scope (noted, not
  fixed).
- **Then flip WS1/WS2 enforcement to blocking.**

### WS6 — Visible evidence, DAST & docs
- **`dast.yml` (ZAP baseline):** stands up an ephemeral instance and runs ZAP
  baseline (advisory). **CI env override required** — the production compose won't
  come up unmodified: Caddy uses `{$DOMAIN}` + ACME auto-HTTPS (hangs in CI without
  public DNS), `backspace` requires `JWT_SECRET`, livekit is profile-gated. Use a CI
  compose override that sets a test `JWT_SECRET`/`DOMAIN` and **points ZAP directly at
  the `backspace` container `:3000`, bypassing Caddy** (or Caddy `internal`/local
  TLS). This is the same two-instance-capable rig WS3 needs for CSP/CORS validation.
- README: CodeQL, OpenSSF Scorecard, and security-policy badges; a "Security &
  supply chain" section describing what runs on every change and where results are
  published.
- SECURITY.md: add a "Security testing & assurance" section enumerating the pipeline.
- `docs/systems/security-scanning.md`: full spec of every workflow, the tiered
  policy, and the maintainer settings checklist (§5) — including the **repo-must-be-
  public precondition** (Scorecard `publish_results` + badge and CodeQL free tier both
  require a public canonical repo) and the manual `caddy`/`livekit` compose-image
  update reminder (from WS1/F1).
- CLAUDE.md: add subsystem-table rows for `security-scanning.md` and
  `desktop-security.md` (required by the Documentation Rule — this is structural CI
  and architecture).
- **Finalize WS6 last:** badges + the maintainer checklist document state that only
  exists once WS1/WS2/WS5 land, so write the final copy after those are green (the
  workflow *files* can be scaffolded earlier).

---

## 7. Testing Strategy

- **`actionlint`** on every new/edited workflow.
- **Real PR-branch run** watching each check go green (or advisory) as intended.
- **Canary proof of blocking:** on a throwaway branch, introduce a fake secret and a
  known-vulnerable dependency; confirm gitleaks and OSV-Scanner actually **fail** the
  build; revert.
- **WS2:** `docker build` locally for amd64 + container boots + `/api/health`
  responds, before and after the Dockerfile changes; confirm the process runs
  **non-root** (via gosu step-down) yet still writes the host-owned `./data` bind
  mount; confirm `tsx` + `better-sqlite3` prebuilt are present in the pruned tree and
  the arm64 image still builds; confirm existing self-hosters survive `pull` + restart.
- **WS3 (needs the two-instance + LiveKit rig):** security headers present
  (curl/DevTools); **zero CSP violations** across chat, **cross-instance federation**,
  embed render (YouTube/Vimeo/Spotify + generic OG image), GIF, upload, and a **real
  voice join**; CORS callback permits the app origin **and dynamically-registered
  peers** (federated upload), keeps `/api/instance/info` open to the `file://` picker
  (Origin `null`), and rejects an unknown origin; two-instance federation S2S suite
  still green.
- **WS4:** desktop app boots with fuses/asar-integrity applied and the existing
  `afterPack` native-module cleanup intact; `will-navigate` blocks a foreign top-level
  URL while the initial instance load, the `file://` picker, and `/join/*` deep-links
  (via `setWindowOpenHandler`) still work.
- **DAST:** ZAP baseline runs against the CI compose override (bypassing Caddy) and
  produces a report artifact.
- **Full suite** (`pnpm -r test`) green throughout; existing federation/voice suites
  unaffected.

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Enforcement day-one paints CI permanently red (May-2024 lockfile has fixable highs) | Report-only → remediate (WS5) → flip blocking. |
| Multi-arch image "scan" is theater / arm64 unscanned | WS2 restructure: single-arch load+scan → then multi-arch push. |
| Non-root USER breaks `./data` bind-mount for existing self-hosters | Run entrypoint as root → chown → `exec gosu <uid>` step-down (no static `USER`); documented upgrade note; tested before/after. |
| Dependabot breaks CI via `uiohook-napi` patch / native rebuilds | `ignore` the patched dep; group `onlyBuiltDependencies`. |
| CSP too strict for a federated, arbitrary-content app | CSP built **dynamically** from `config.livekit.url` + peer registry; `img/media/connect` permissive; constrain only script/object/base/frame-ancestors; report-only → enforce. |
| CORS allowlist breaks federated uploads + desktop `file://` picker | Dynamic `origin` callback backed by the **live peer registry**; keep `/api/instance/info` CORS-open; "log-and-allow" phase before rejecting. |
| Electron fuses overwrite the existing `afterPack` (native-module cleanup) | Use top-level `electronFuses:` key or call `flipFuses()` inside the existing `scripts/afterPack.js`; compute asar-integrity hashes after afterPack mutations. |
| pnpm symlinked `.pnpm` store makes a plain `node_modules` copy non-self-contained | Use `pnpm --filter @backspace/server deploy --prod`; verify `tsx` + `better-sqlite3` prebuilt land per-arch; keep `ffmpeg`; boot test. |
| DAST/compose won't come up in CI (ACME/DOMAIN/JWT_SECRET) | CI compose override with test env; point ZAP at `backspace:3000`, bypass Caddy. |
| harden-runner block mode false-positives the Docker build | Start in `audit`; graduate to block only on lightweight jobs. |
| Scorecard badge / CodeQL free tier assume a public repo | Documented as an explicit precondition in the maintainer checklist. |

---

## 9. Definition of Done

- All new workflows present, `actionlint`-clean, and green on a real PR.
- Blocking gates proven by canary (secret + vuln), then reverted.
- Security tab populated (CodeQL, Scorecard, advisory Trivy/OSV) with no open
  fixable HIGH/CRITICAL after WS5.
- helmet + CSP + Caddyfile headers live with no CSP violations in normal use; CORS
  allowlisted; federation suite green.
- Electron fuses + `will-navigate` live; desktop boots and deep-links work; existing
  `afterPack` native-module cleanup intact.
- `isPrivateIp` hardened (IPv4-mapped IPv6 / CGNAT / `::` / alt-encodings) with
  passing negative tests.
- Container image scanned before publish; SBOM + provenance attached; Dockerfile
  runs non-root (gosu step-down) with a working data volume.
- README badges + Security section; SECURITY.md expanded;
  `docs/systems/security-scanning.md` + `docs/systems/desktop-security.md` written;
  CLAUDE.md subsystem table updated.
- Maintainer settings checklist documented (CodeQL merge protection, Dependabot
  alerts, push protection, branch protection).
