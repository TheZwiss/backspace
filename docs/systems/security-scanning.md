# Security Scanning & Supply-Chain Assurance

Automated, continuous scanning wired into GitHub Actions. This document is the
reference for what runs, where results go, and the one-time settings a maintainer
must enable. **Current state: report-only** — scanners surface findings in the
Security tab but do not block merges yet. Enforcement (blocking) is turned on in a
later change once the remediation pass has cleared the backlog.

## Workflows

| File | Purpose | Trigger | Result |
|------|---------|---------|--------|
| `.github/dependabot.yml` | Dependency + action + base-image update PRs | weekly | PRs |
| `.github/workflows/codeql.yml` | CodeQL SAST (`javascript-typescript`, build-mode none) | PR + push main + weekly | Security tab |
| `.github/workflows/security.yml` | gitleaks (secrets, full history), OSV-Scanner (deps), Trivy config (IaC), Trivy license | PR + push main + weekly | Security tab |
| `.github/workflows/scorecard.yml` | OpenSSF Scorecard (repo posture) | push main + weekly + on branch-protection change | Security tab + public badge |
| `.github/workflows/docker-publish.yml` | Image scan (Trivy) + SBOM + provenance for the published container | tag push / manual | image scan (report-only) + SBOM + provenance |

> **gitleaks findings** surface in the workflow's job log and PR summary — the
> `gitleaks` job does not upload SARIF, so secret hits do **not** appear under
> Security → Code scanning (unlike the OSV / Trivy / CodeQL / Scorecard jobs).

## Tiered policy (target, enforced in a later change)

- **Always block:** gitleaks secret hit; OSV/Trivy fixable HIGH/CRITICAL; Trivy
  disallowed license.
- **Advisory (SARIF → Security tab):** CodeQL alerts; OSV/Trivy unfixable or
  medium/low; Scorecard.

Code-level gates (OSV, Trivy, gitleaks) block via workflow exit codes. CodeQL
merge-blocking, Dependabot alerts, and native secret-scanning are GitHub *settings*
— see the checklist below.

## Triage policy

Every finding a scanner reports ends in one of three states: fixed, dismissed with
a written reason, or left open with the reason it is still open. **A dismissal with
no reason is not a dismissal.** The code-scanning API caps `dismissed_comment` at
280 characters, so the comment attached to an alert is a pointer and the register
below is where the argument lives.

### Reachability buckets

Urgency comes from where the affected package ends up, not from the severity string
in the advisory. Four buckets:

| Bucket | Meaning | What it implies |
|--------|---------|-----------------|
| **Server image** | Installed into the container self-hosters run (`fastify`, `find-my-way`, `@fastify/static`, `undici`, `drizzle-orm`, `sharp`, `ws`, `better-sqlite3`) | Fix by upgrade, or pin the transitive with `pnpm.overrides`. Highest urgency: reachable from a request. |
| **Web bundle** | Shipped in the JavaScript a browser loads (`react-router`, `nanoid`, PostCSS output) | Same treatment. Reachable from a page load. |
| **Desktop app** | Inside the packaged Electron artifact (`electron` itself, and every runtime `dependencies` entry of `@backspace/desktop`) | Patch within the current major. A major bump is its own decision with its own build evidence. |
| **Build-time only** | Present while building or testing and in no artifact a user receives (`vite`, `rollup`, `vitest`, `@babel/*`, `app-builder-lib`, `extract-zip`, `drizzle-kit`) | Record the reasoning once for the group rather than per finding. Upgrade when convenient, not on an advisory clock. |

**The bucket is measured, not inferred from what the package usually does.**
`pnpm why <package>` is how it is established, and a package is in the shipped
bucket whenever the path from a workspace package runs through a `dependencies`
entry rather than a `devDependencies` one. Three cases where the obvious guess was
wrong:

- **`@babel/preset-env` looks gone and is not.** `@vitejs/plugin-react` 6 dropped
  Babel, which removed `@babel/core` and the JSX transform plugins. Babel is still
  in the tree by another path: `@backspace/web` to `vite-plugin-pwa` to
  `workbox-build` to `@babel/preset-env`. Build-time, but present.
- **`js-yaml` looks like electron-builder tooling.** It arrives that way as well,
  but it also arrives through `electron-updater`, which is a runtime `dependencies`
  entry of `@backspace/desktop`. It ships inside the packaged desktop app.
- **`esbuild` looks build-time and is in two buckets at once.** Version 0.28.2
  arrives through `tsx`, a runtime `dependencies` entry of `@backspace/server`, so
  it is installed into the server image. The 0.18.20 copy, which is the one OSV
  flags, arrives through `drizzle-kit` and is build-time only.

### Measuring the backlog

Three plausible ways of measuring give a wrong answer.

- **`ref=refs/heads/main` reports main's state, not a branch's.** A branch that has
  not merged has changed nothing on main, so this query cannot measure what a pull
  request cleared. Querying `refs/heads/<branch>` returns nothing at all, because
  no analysis is recorded against a branch ref, and `refs/pull/N/merge` reports only
  findings that fall on the changed lines, so a clean PR run means "nothing on this
  diff" rather than "nothing in the repository".
- **A green scanner check is not a measurement.** While the policy is report-only
  every scan step carries `continue-on-error: true`. The check passing means the
  analysis ran and the SARIF uploaded.
- **`trivy config .` reports more locally than in CI.** Run locally after an install
  it walks `node_modules` and reports DS-0001, DS-0017 and DS-0026 against a
  Dockerfile vendored inside `@surma/rollup-plugin-off-main-thread`. The CI job
  checks out and scans without installing dependencies, so it never sees that file.
  A local reproduction showing extra findings is the expected difference, not a
  regression.

The measurement that does work for dependencies is a local `osv-scanner` run against
each lockfile, validated by reproducing main's count exactly before trusting the
branch's:

```bash
osv-scanner scan source --lockfile=pnpm-lock.yaml --format=json \
  | jq '[.results[].packages[].vulnerabilities[]?] | length'
```

| Lockfile | Findings |
|----------|----------|
| `main` | 151 |
| Dependency branch, after the version bumps, before the transitive pins | 110 |
| Dependency branch, after the transitive pins | 13 |

### The size of the backlog, corrected

The master plan for this security pass estimated 30 lockfile CVEs. The measured
figure on `main` was **189 open alerts** across all tools, of which **151 came from
OSV-Scanner** across **123 distinct advisory identifiers** (120 of which carry a
CVE alias). The rest were 18 CodeQL, 19 Scorecard and 1 Trivy. The estimate was low
by a factor of five, which is why the triage buckets above exist: 151 findings
cannot be worked one at a time.

### What is left open, and why

Thirteen OSV findings remain after the dependency pass. Every one needs a major
upgrade that is a separate decision with its own compatibility work, so none of them
is dismissed:

| Package | Findings | Bucket | Fixed in |
|---------|----------|--------|----------|
| `fastify` 4.29.1 | 4 | server image | 5.x |
| `@fastify/static` 7.0.4 | 2 | server image | 10.x |
| `find-my-way` 8.2.2 | 1 | server image | 9.7.0 |
| `react-router` 6.30.6 | 2 | web bundle | 7.18.0 |
| `electron` 40.10.6 | 1 | desktop app | 41.10.3 (no fix in the 40 line) |
| `lodash` 4.17.23 | 2 | build-time (`electron-builder` to `@malept/flatpak-bundler`) | 4.18.0 |
| `esbuild` 0.18.20 | 1 | build-time (`drizzle-kit` to `@esbuild-kit/core-utils`) | 0.25.0 |

## Dismissal register

`.trivyignore` and `.github/codeql/codeql-config.yml` are the machine-readable half
of this. What follows is the half a human reads.

### CodeQL alerts

Six alerts are dismissed. Two are in test files and are also excluded going forward
by the CodeQL config, so they will not recur; the other four are judgements about
shipped code.

**#123 `js/request-forgery`, `packages/server/src/utils/ssrf.ts:70`, dismissed as a
false positive.** This is the `fetch` inside `safeFetch`, one line after
`await validateExternalUrl(currentUrl)`. It carries seven converging dataflow paths,
which are its seven callers: the SSRF work collapsed seven separately-flagged sinks
into one choke point, and CodeQL flags the choke point because a validator living in
another module is not something it models as a sanitizer. Redirects are followed
manually and every hop is revalidated before it is fetched, so there is no path to
this line that skipped the check.

**This one names a residual risk rather than claiming the alert is pure noise.**
`validateExternalUrl` resolves the hostname and classifies the resulting address,
and then `fetch` resolves the hostname again when it connects. A name whose answer
changes between the two lookups is fetched on the second answer, which the validator
never saw. That is a DNS-rebind time-of-check-to-time-of-use window. Closing it
needs a custom undici dispatcher that pins the address resolved during validation
and connects to that address rather than re-resolving. That is out of scope for the
work that produced this dismissal and is not fixed. The window is narrow and the
dismissal is still the right call for this alert, because the alert is about taint
flow and not about rebinding, but the residual is real and is recorded in the
function comment at the call site as well as here.

**#217 `js/clear-text-storage-of-sensitive-data`, `packages/web/src/stores/authStore.ts:116`,
dismissed as won't fix.** The session token is in `localStorage` deliberately. That
choice is the premise the instance CORS posture and the security-header split rest
on, and it is written up with its cost in `docs/systems/web-security.md`. Moving the
token is a decision for that document and a change to how the origin is trusted, not
a defect in this line.

**#130 `js/shell-command-injection-from-environment`, `packages/server/src/utils/backup.ts:50`,
dismissed as won't fix.** The call is
`execFile('/bin/sh', ['-c', `${cmd} "$1"`, 'sh', snapshotPath])`, where `cmd` is
`config.backup.offsiteCmd`, a server environment variable. Anyone who can set it
already controls the process the server runs in, so it names an operator rather than
an attacker. The one value that is not operator-supplied, the snapshot path, is
passed positionally as `$1` and quoted at the use site rather than concatenated into
the command text. No request reaches this function.

**#124 `js/insecure-randomness`, `packages/web/src/components/ui/Avatar.tsx:57`,
dismissed as a false positive.** `getAvatarGradient` in `packages/web/src/utils/gradients.ts`
contains no randomness at all. It is a djb2 hash of the account id or name, taken
modulo the number of presets, so an account renders the same fallback colour on
every device and every reload. It selects one of seven decorative gradients and
feeds nothing with an identity or uniqueness requirement.

**#348 `js/shell-command-injection-from-environment`, `packages/server/test/cors-posture.test.ts:66`,
and #106 `js/missing-rate-limiting`, `packages/server/src/routes/federation/handlers/s2sAuth.test.ts:75`,
both dismissed as used in tests.** Each reports the test doing the thing the test
exists to prove. See the CodeQL config below.

### CodeQL config: test files are not analysed

`.github/codeql/codeql-config.yml` sets `paths-ignore` over `**/*.test.ts`,
`**/*.test.tsx`, `packages/server/test/**` and `packages/web/src/test/**`, and
`codeql.yml` passes it to the `init` step. Before that file existed there was no
CodeQL config at all, which is why test code was being analysed.

Test files model attacker behaviour on purpose. A suite that proves a route is rate
limited contains an unlimited-request loop, and one that boots a server from the
environment contains an exec built from the environment. Analysing them produces
findings about the tests rather than about what ships, and those findings crowd out
the ones that matter.

The exclusion is safe because every listed path holds test code only: no file under
`packages/*/src` that ships to a user is named `*.test.ts` or `*.test.tsx`,
`packages/server/test` holds the suite helpers and the vitest environment setup, and
`packages/web/src/test` holds the jsdom setup file. Verify that again before adding
a path to the list.

### Trivy config: DS-0002

`.trivyignore` suppresses one rule, DS-0002, "Specify at least 1 USER command in
Dockerfile with non-root user". The `trivy-config` job names the file explicitly
with `trivyignores: .trivyignore` rather than relying on the default working
directory.

The image has no `USER` line on purpose. `docker-entrypoint.sh` runs as root only
long enough to chown the mounted data volume, then execs the CMD as the
unprivileged `node` user. A `USER` directive would take effect before the entrypoint
runs and leave the volume unwritable on first start. The container does not run its
workload as root; the check reads the Dockerfile and cannot see the entrypoint.

This was re-verified against the current `node:24-slim` base rather than carried
over from the note written against the old Node 20 base. A container started from a
fresh build reports Uid 1000 for pid 1, and `trivy config Dockerfile` against the
current file reports DS-0002 and nothing else.

### Scorecard: the TokenPermissions findings that stay

Nine `TokenPermissionsID` findings were reported. Each write scope was either
removed or moved from workflow level onto the single job that makes the call needing
it, with a comment at each surviving grant saying which API call requires it.

**Moving a write down to the job level does not clear the finding in general.** This
is not a guess; it is what `ossf/scorecard` v5.4.0 does in
`checks/raw/permissions.go` and `checks/evaluation/permissions.go`:

- Only seven scopes are examined at all: `statuses`, `checks`, `security-events`,
  `deployments`, `contents`, `packages`, `actions`. `pages`, `id-token`,
  `pull-requests` and `issues` are never reported, at either level.
- **Top-level writes are reported unconditionally.** `validateTopLevelPermissions`
  passes an empty ignore map, so no matcher can excuse a workflow-level write.
- **Job-level writes are ignored only for three scopes, and only on a match.**
  `createIgnoredPermissions` can excuse `security-events` when a step uses
  `github/codeql-action/analyze`, `github/codeql-action/upload-sarif`,
  `ossf/scorecard-action`, `haskell-actions/hlint-scan` or
  `zizmorcore/zizmor-action`; `packages` when the workflow matches a packaging
  matcher, one of which is `docker/build-push-action`; and `contents` only for a
  fixed list of release tooling (`python-semantic-release`, an
  `npx|pnpm|yarn semantic-release` run, `setup-go` plus `goreleaser-action`, the two
  SLSA generator workflows, an `mvn release:prepare` run) or for a GitHub Pages
  deployment using `peaceiris/actions-gh-pages`.
- **`actions`, `statuses`, `checks` and `deployments` are never ignored at job
  level.** No matcher can excuse them.

Applying that rule to the workflows as they now stand, the findings expected to
survive are:

| Workflow | Scope | Why it stays granted |
|----------|-------|----------------------|
| `metrics.yml` | `contents: write` | The collector commits the day's traffic rows to the `metrics-data` branch. Not a release or a `peaceiris` deploy, so no matcher applies. |
| `metrics.yml` | `actions: write` | Required by the `gh workflow enable` step. GitHub disables a scheduled workflow after 60 days of repository inactivity, and that step is what resets the clock. Removing this scope loses data silently, months later. It is **not** for the reusable-workflow call, which needs no such scope. |
| `backfill.yml` | `contents: write` | Same data-branch write as the collector. |
| `cla.yml` | `contents: write` | `contributor-assistant/github-action` commits `signatures/cla.json` to the `cla-signatures` branch. |
| `cla.yml` | `actions: write` | The same action calls `actions.reRunWorkflow` to re-run the last failed CLA run once a signature comment arrives. |
| `release.yml` | `contents: write` | electron-builder runs with `--publish always`, which creates the release for the tag and uploads the installers. electron-builder is not on Scorecard's release-tooling list, so the matcher does not fire. |

`docker-publish.yml`'s `packages: write` and `security-events: write` and every
`security-events: write` in `codeql.yml`, `security.yml` and `scorecard.yml` do
clear, because those workflows match the packaging and SARIF matchers above.
`cla.yml`'s `statuses: write` was removed outright: the pinned revision of the
action calls no commit-status endpoint. Check that again before moving the pin.

These six are the correct trade. Each is load-bearing, each is commented at the
grant, and Scorecard reporting them is the tool working as designed rather than a
gap. Do not remove one to raise the score.

The Scorecard checks that no code change satisfies (`CIIBestPracticesID`,
`FuzzingID`, `CodeReviewID`, `BranchProtectionID`, `SecurityPolicyID`) are maintainer
settings or process. They belong to the checklist below, not to remediation.

## Supply-chain hardening

- Every action is pinned to a full commit SHA (`# vX.Y.Z` comment) — resists
  tag-move attacks and satisfies Scorecard's Pinned-Dependencies check.
  **One `uses:` is deliberately unpinned and cannot be pinned:**
  `metrics.yml`'s `uses: ./.github/workflows/deploy-pages.yml`. GitHub rejects
  `@ref` on a `./` path and resolves a local reusable workflow from the calling
  run's own commit, which is tighter than a SHA pin. Not a gap — do not "fix" it.
- `step-security/harden-runner` (egress-policy `audit`) on Linux jobs.
- Least-privilege `permissions:` per workflow/job.
- SBOM + SLSA provenance are attached to the published container image at push
  (`.github/workflows/docker-publish.yml`), alongside a report-only Trivy scan
  of the amd64 image (the arm64 image ships unscanned; enforcement is turned
  on in a later plan).

## Maintainer checklist (one-time GitHub settings — NOT code)

Status verified against the live repository on 2026-09-03 (`gh api`). These are
settings, not code, so nothing in this repository keeps the boxes honest — re-check
them when something in the Security tab looks wrong, and after any transfer or
rename.

### Done

- [x] Repository is **public** (required for the Scorecard badge/publish and the
      CodeQL free tier).
- [x] Fine-grained PAT scoped to this repository only, with **Administration:
      read** and **Contents: read**, stored as the `METRICS_TOKEN` repository
      secret. Traffic endpoints are unreachable without it — there is no
      `administration` key in the Actions `permissions:` vocabulary, so
      `GITHUB_TOKEN` cannot substitute. See `docs/systems/metrics.md` §7.
- [x] **Dependabot alerts** enabled (`PUT /repos/{owner}/{repo}/vulnerability-alerts`,
      confirmed by `GET` returning 204 where it previously returned 404). The
      repository had been running OSV-Scanner while GitHub's own advisory feed was
      switched off.
- [x] **Dependabot security updates left off**, deliberately.
      `GET /repos/{owner}/{repo}/automated-security-fixes` reports
      `{"enabled":false,"paused":false}`. Enabling it means Dependabot opens pull
      requests by itself for every new advisory. Clearing the backlog above took a
      dedicated pass, so advisories now surface as alerts while the pull-request
      queue stays under human control. Revisit once the remainder is down to
      packages that can be bumped without a compatibility review.
- [x] Ruleset on the `metrics-data` branch blocking **deletion** and
      **force-push**, with no bypass actors (`Protect metrics data store`,
      alongside the `Protect CLA signature store` precedent it copies). It
      deliberately does **not** require pull requests or status checks: the
      collector commits directly, and requiring a PR would break every run. This
      branch holds the only irreplaceable data in the repository.

### Outstanding

- [ ] Settings → Code security: enable **Secret scanning** + **Push protection**.
      Both currently disabled — note that `security.yml`'s gitleaks job scans full
      history on PR and push, but it is not push protection and cannot stop a
      secret from landing.
- [ ] Settings → Code security: enable **CodeQL / code-scanning merge protection**
      so high-severity alerts block PRs (the code-level gates do the rest). No
      code-scanning rule is present on any ruleset today.
- [ ] Branch protection on `main`: **partly done.** The `Require CI on main`
      ruleset is active and blocks deletion and force-push, requires a pull
      request, and requires the `Build & test` check. It does **not** require any
      check from `security.yml`, `codeql.yml`, or `scorecard.yml` — add those
      contexts when enforcement is turned on, or the tiered policy above has no
      gate on `main`.
- [ ] **Manual image bumps:** Dependabot does not track `docker-compose.yml`
      `image:` pins — update `caddy` and `livekit/livekit-server` by hand when new
      releases ship. (Renovate, which parses compose, is an optional future
      alternative.) Standing task, never "done".
