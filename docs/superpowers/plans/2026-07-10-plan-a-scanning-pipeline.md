# Plan A — Scanning Pipeline & Supply-Chain Hardening (report-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the full automated security-scanning pipeline (Dependabot, CodeQL SAST, secret scanning, dependency CVEs, IaC/license scanning, OpenSSF Scorecard) plus supply-chain hardening (SHA-pinned actions, harden-runner, least-privilege permissions) on GitHub Actions — all **report-only/advisory**, so the PR that adds it stays green and mergeable.

**Architecture:** Four new files under `.github/` (one Dependabot config + three workflows) each with a single scan responsibility, plus a hardening sweep across the four existing workflows. Every scanner uploads SARIF to the GitHub Security tab and is non-blocking in this plan; enforcement (fail-the-build) is flipped on in a later plan (Plan E) after the remediation pass. This is the foundation the rest of the initiative builds on and, on its own, answers the "no security scanning" objection with visibly-running scanners.

**Tech Stack:** GitHub Actions (YAML), GitHub Dependabot, CodeQL (`javascript-typescript`, build-mode `none`), gitleaks, OSV-Scanner (reads `pnpm-lock.yaml` v9), Aqua Trivy (config + license), OpenSSF Scorecard, StepSecurity harden-runner. Local validators: `actionlint`, `pinact` (SHA-pinning).

## Global Constraints

- **Report-only in this plan.** Every scanner must be non-blocking (`continue-on-error: true` at step level, or advisory SARIF upload). Enforcement is flipped on in Plan E — do NOT make any scanner fail the build here. Each non-blocking step carries a comment: `# report-only; enforcement flipped on in Plan E`.
- **SHA-pin every action.** All `uses:` refs across ALL workflows (new and existing) pin to a full 40-char commit SHA with a trailing `# vX.Y.Z` version comment. No `@v5`/`@main` tag refs may remain after Task 5.
- **harden-runner is Linux-only.** `step-security/harden-runner` runs only on Ubuntu runners. In any matrix that includes macOS/Windows (i.e. `release.yml`), guard it with `if: runner.os == 'Linux'`.
- **`egress-policy: audit`** for every harden-runner step (never `block` in this plan — multi-arch buildx/QEMU/gha-cache make many egress calls).
- **Commit identity:** the repo's local git config already uses `Jannis Braun <151788261+TheZwiss@users.noreply.github.com>` — use a plain `git commit`. NEVER override author/committer email with `-c user.email=...`, and never commit as `alxtrading94@gmail.com`.
- **No new runtime dependencies.** This plan touches only `.github/` and docs; it must not modify `package.json` dependency lists or any application/runtime code.
- **Node 20 / pnpm 10.34.3** are the project's pinned toolchain — any workflow that installs deps mirrors `ci.yml` (`pnpm/action-setup` @ 10.34.3, `actions/setup-node` node 20).
- **Branch:** all work lands on `security-scanning-hardening` (already checked out).
- **Action versions:** the YAML below uses each action's current major tag. If an action's latest major differs at implementation time, check its README and adjust the tag — then Task 5 pins whatever tag you used to its SHA. A wrong tag surfaces as an `actionlint` error or a red PR check; fix and re-run.

---

### Task 1: Dependabot config + local validators

**Files:**
- Create: `.github/dependabot.yml`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `.github/dependabot.yml` — the Dependabot v2 config later documented by Task 6. No code symbols.

- [ ] **Step 1: Install the local validators**

`actionlint` validates workflow YAML; `pinact` will SHA-pin actions in Task 5. On the macOS dev host:

Run:
```bash
brew install actionlint pinact
actionlint --version && pinact --version
```
Expected: both print a version. (Fallbacks if Homebrew lacks them: `go install github.com/rhysd/actionlint/cmd/actionlint@latest` and `go install github.com/suzuki-shunsuke/pinact/cmd/pinact@latest`, or run actionlint via Docker `docker run --rm -v "$(pwd):/repo" --workdir /repo rhysd/actionlint:latest -color`.)

- [ ] **Step 2: Write `.github/dependabot.yml`**

```yaml
# Dependabot keeps dependencies and CI actions patched. Three ecosystems:
#   - npm      → the pnpm workspace (Dependabot reads pnpm-lock.yaml v9)
#   - github-actions → action version bumps (feeds the SHA-pin comments)
#   - docker   → the Dockerfile base image (FROM node:20-slim)
#
# NOTE (intentional): there is NO docker entry for docker-compose.yml. It sits
# at the same "/" directory (a second docker entry would collide on
# ecosystem+directory), and Dependabot's docker ecosystem parses Dockerfiles,
# not `image:` refs in compose. The pinned caddy / livekit-server compose images
# are updated MANUALLY — see the maintainer checklist in
# docs/systems/security-scanning.md.
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
    groups:
      # One grouped PR for routine minor/patch bumps to cut PR noise.
      npm-minor-patch:
        update-types:
          - minor
          - patch
    ignore:
      # uiohook-napi is pinned by an exact-version pnpm patch
      # (patches/uiohook-napi@1.5.5.patch). A bump makes the patch path stop
      # matching, breaking `pnpm install --frozen-lockfile` in CI and both
      # Docker stages until the patch is regenerated. Bump it by hand.
      - dependency-name: uiohook-napi

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    groups:
      github-actions:
        patterns:
          - "*"

  - package-ecosystem: docker
    directory: /
    schedule:
      interval: weekly
```

- [ ] **Step 3: Validate YAML syntax**

Run:
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/dependabot.yml')); print('dependabot.yml: valid YAML')"
```
Expected: `dependabot.yml: valid YAML` (no traceback). (The full schema is validated by GitHub after push — Task 7 confirms it in the repo's Insights → Dependency graph → Dependabot.)

- [ ] **Step 4: Commit**

```bash
git add .github/dependabot.yml
git commit -m "ci(security): add Dependabot config (npm + actions + docker)"
```

---

### Task 2: `security.yml` — secret, dependency, IaC & license scanning (report-only)

**Files:**
- Create: `.github/workflows/security.yml`

**Interfaces:**
- Consumes: `pnpm-lock.yaml` (OSV lockfile scan), repo tree (gitleaks history, Trivy config/license).
- Produces: workflow `Security` with jobs `gitleaks`, `osv-scanner`, `trivy-config`, `trivy-license`; each uploads a SARIF category (`gitleaks`, `osv-scanner`, `trivy-config`, `trivy-license`). Task 6 documents these; Task 5 pins their actions.

- [ ] **Step 1: Write `.github/workflows/security.yml`**

```yaml
name: Security

# Report-only in this plan: every scanner is non-blocking and uploads SARIF to
# the Security tab. Enforcement (fail on fixable HIGH/CRITICAL, block on secrets)
# is flipped on in Plan E after the remediation pass.

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '32 5 * * 1' # weekly Monday 05:32 UTC

permissions:
  contents: read

concurrency:
  group: security-${{ github.ref }}
  cancel-in-progress: true

jobs:
  gitleaks:
    name: Secret scan (gitleaks)
    runs-on: ubuntu-latest
    steps:
      - name: Harden the runner
        uses: step-security/harden-runner@v2
        with:
          egress-policy: audit
      - name: Checkout (full history)
        uses: actions/checkout@v5
        with:
          fetch-depth: 0 # gitleaks scans the whole git history, not just the diff
      - name: Run gitleaks
        uses: gitleaks/gitleaks-action@v2
        continue-on-error: true # report-only; enforcement flipped on in Plan E
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  osv-scanner:
    name: Dependency scan (OSV-Scanner)
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write # upload SARIF to code scanning
    steps:
      - name: Harden the runner
        uses: step-security/harden-runner@v2
        with:
          egress-policy: audit
      - name: Checkout
        uses: actions/checkout@v5
      - name: Run OSV-Scanner
        uses: google/osv-scanner-action@v2
        continue-on-error: true # report-only; enforcement flipped on in Plan E
        with:
          scan-args: |-
            --lockfile=./pnpm-lock.yaml
            --format=sarif
            --output=osv-results.sarif
      - name: Upload OSV SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: osv-results.sarif
          category: osv-scanner

  trivy-config:
    name: IaC/config scan (Trivy)
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - name: Harden the runner
        uses: step-security/harden-runner@v2
        with:
          egress-policy: audit
      - name: Checkout
        uses: actions/checkout@v5
      - name: Trivy config scan (Dockerfile + docker-compose)
        uses: aquasecurity/trivy-action@0.28.0
        continue-on-error: true # report-only; enforcement flipped on in Plan E
        with:
          scan-type: config
          scan-ref: .
          format: sarif
          output: trivy-config.sarif
      - name: Upload Trivy config SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: trivy-config.sarif
          category: trivy-config

  trivy-license:
    name: License compliance scan (Trivy)
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - name: Harden the runner
        uses: step-security/harden-runner@v2
        with:
          egress-policy: audit
      - name: Checkout
        uses: actions/checkout@v5
      - name: Trivy license scan
        uses: aquasecurity/trivy-action@0.28.0
        continue-on-error: true # report-only; enforcement flipped on in Plan E
        with:
          scan-type: fs
          scan-ref: .
          scanners: license
          format: sarif
          output: trivy-license.sarif
      - name: Upload Trivy license SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: trivy-license.sarif
          category: trivy-license
```

- [ ] **Step 2: Validate with actionlint**

Run:
```bash
actionlint .github/workflows/security.yml
```
Expected: no output (exit 0). If actionlint flags an unknown input for an action, check that action's README and correct it. (Note: actionlint does not fetch action inputs, so most such errors are shellcheck/expression issues — fix those.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/security.yml
git commit -m "ci(security): add report-only security scan workflow (gitleaks, OSV, Trivy)"
```

---

### Task 3: `codeql.yml` — CodeQL SAST (report-only)

**Files:**
- Create: `.github/workflows/codeql.yml`

**Interfaces:**
- Consumes: repo TypeScript/JavaScript source (analyzed with `build-mode: none`).
- Produces: workflow `CodeQL` with job `analyze`, category `/language:javascript-typescript`. Findings land in the Security tab. Task 6 documents it; Task 5 pins its actions.

- [ ] **Step 1: Write `.github/workflows/codeql.yml`**

```yaml
name: CodeQL

# Static application security testing for all TS/JS. Uses build-mode: none — no
# compile needed, which sidesteps the monorepo/native-module build entirely.
# Default (code-scanning) query suite; security-extended is deferred (triage tax).
# CodeQL uploads alerts to the Security tab but does NOT fail the PR by itself —
# blocking is a repo setting (code-scanning merge protection), documented in the
# maintainer checklist in docs/systems/security-scanning.md.

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '27 3 * * 1' # weekly Monday 03:27 UTC

permissions:
  contents: read

concurrency:
  group: codeql-${{ github.ref }}
  cancel-in-progress: true

jobs:
  analyze:
    name: Analyze (javascript-typescript)
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write # upload SARIF to code scanning
      actions: read
    steps:
      - name: Harden the runner
        uses: step-security/harden-runner@v2
        with:
          egress-policy: audit
      - name: Checkout
        uses: actions/checkout@v5
      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
          build-mode: none
      - name: Perform CodeQL analysis
        uses: github/codeql-action/analyze@v3
        with:
          category: "/language:javascript-typescript"
```

- [ ] **Step 2: Validate with actionlint**

Run:
```bash
actionlint .github/workflows/codeql.yml
```
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/codeql.yml
git commit -m "ci(security): add CodeQL SAST workflow (javascript-typescript)"
```

---

### Task 4: `scorecard.yml` — OpenSSF Scorecard (report-only)

**Files:**
- Create: `.github/workflows/scorecard.yml`

**Interfaces:**
- Consumes: the whole repo + workflow metadata (Scorecard evaluates repo posture).
- Produces: workflow `OpenSSF Scorecard` with job `analysis`; publishes results (feeds the public badge added in Plan E) and uploads SARIF. Task 5 pins its actions.

- [ ] **Step 1: Write `.github/workflows/scorecard.yml`**

```yaml
name: OpenSSF Scorecard

# Scores the repo's security posture (branch protection, pinned deps, token
# permissions, etc.) and publishes to the OpenSSF public API so a badge can be
# shown (badge is added in Plan E). REQUIRES the canonical repo to be PUBLIC —
# see the maintainer checklist in docs/systems/security-scanning.md.

on:
  branch_protection_rule:
  schedule:
    - cron: '18 4 * * 2' # weekly Tuesday 04:18 UTC
  push:
    branches: [main]

permissions: read-all

jobs:
  analysis:
    name: Scorecard analysis
    runs-on: ubuntu-latest
    permissions:
      security-events: write # upload SARIF
      id-token: write        # publish_results OIDC attestation
    steps:
      - name: Harden the runner
        uses: step-security/harden-runner@v2
        with:
          egress-policy: audit
      - name: Checkout
        uses: actions/checkout@v5
        with:
          persist-credentials: false
      - name: Run Scorecard
        uses: ossf/scorecard-action@v2
        with:
          results_file: results.sarif
          results_format: sarif
          publish_results: true
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: SARIF file
          path: results.sarif
          retention-days: 5
      - name: Upload SARIF to code scanning
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
```

- [ ] **Step 2: Validate with actionlint**

Run:
```bash
actionlint .github/workflows/scorecard.yml
```
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/scorecard.yml
git commit -m "ci(security): add OpenSSF Scorecard workflow"
```

---

### Task 5: Harden existing workflows + SHA-pin every action

**Files:**
- Modify: `.github/workflows/ci.yml` (add harden-runner step)
- Modify: `.github/workflows/release.yml` (add Linux-guarded harden-runner step)
- Modify: `.github/workflows/security.yml`, `codeql.yml`, `scorecard.yml`, `ci.yml`, `release.yml`, `cla.yml`, `deploy-pages.yml`, `docker-publish.yml` (SHA-pin all `uses:`)

**Interfaces:**
- Consumes: all workflow files from Tasks 2-4 plus the four pre-existing ones.
- Produces: every `uses:` pinned to `@<40-char-sha> # vX.Y.Z`; harden-runner (audit) on the two build workflows. No code symbols.

- [ ] **Step 1: Add harden-runner to `ci.yml`**

In `.github/workflows/ci.yml`, insert as the FIRST step of the `build-and-test` job (before `Checkout`):

```yaml
      - name: Harden the runner
        uses: step-security/harden-runner@v2
        with:
          egress-policy: audit
```

- [ ] **Step 2: Add Linux-guarded harden-runner to `release.yml`**

In `.github/workflows/release.yml`, insert as the FIRST step of the `build` matrix job (before `Checkout`). It MUST be guarded — the matrix includes macOS and Windows, where harden-runner does not run:

```yaml
      - name: Harden the runner
        if: runner.os == 'Linux'
        uses: step-security/harden-runner@v2
        with:
          egress-policy: audit
```

- [ ] **Step 3: SHA-pin every action across all workflows**

Run `pinact` from the repo root — it rewrites each `uses: owner/repo@vX` to `uses: owner/repo@<sha> # vX` in place:

```bash
pinact run
```

Manual fallback (if `pinact` is unavailable) — resolve each tag to its commit SHA with `gh` and edit by hand. `repos/{repo}/commits/{ref}` dereferences both lightweight and annotated tags to the commit:

```bash
# Example for one action; repeat for every distinct uses: ref.
gh api repos/actions/checkout/commits/v5 --jq '.sha'
# → paste as:  uses: actions/checkout@<sha> # v5
```

- [ ] **Step 4: Verify no unpinned action refs remain**

Run (flags any `uses:` ref NOT pinned to a 40-hex-char SHA — catches both `@v5` and non-`v` semver tags like Trivy's `@0.28.0`):
```bash
grep -rnE 'uses: +[^ ]+@' .github/workflows/ | grep -vE '@[0-9a-f]{40}' && echo "UNPINNED REFS FOUND (fix above)" || echo "All actions pinned to SHA"
```
Expected: `All actions pinned to SHA` (the second grep exits non-zero when nothing is unpinned, so the `||` branch prints). A properly pinned line contains `@<40-hex> # vX.Y.Z` and is filtered out; any surviving line is an unpinned ref to fix.

- [ ] **Step 5: Re-validate all workflows**

Run:
```bash
actionlint
```
Expected: no output (exit 0) — actionlint scans every file in `.github/workflows/`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/
git commit -m "ci(security): SHA-pin all actions and add harden-runner (audit)"
```

---

### Task 6: Document the pipeline

**Files:**
- Create: `docs/systems/security-scanning.md`
- Modify: `CLAUDE.md` (add a subsystem-table row)

**Interfaces:**
- Consumes: the workflows/config from Tasks 1-5 (documents them).
- Produces: the `security-scanning.md` spec + maintainer checklist referenced by every workflow comment; a CLAUDE.md table row. No code symbols.

- [ ] **Step 1: Write `docs/systems/security-scanning.md`**

```markdown
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
| `.github/workflows/scorecard.yml` | OpenSSF Scorecard (repo posture) | push main + weekly | Security tab + public badge |

## Tiered policy (target, enforced in a later change)

- **Always block:** gitleaks secret hit; OSV/Trivy fixable HIGH/CRITICAL; Trivy
  disallowed license.
- **Advisory (SARIF → Security tab):** CodeQL alerts; OSV/Trivy unfixable or
  medium/low; Scorecard.

Code-level gates (OSV, Trivy, gitleaks) block via workflow exit codes. CodeQL
merge-blocking, Dependabot alerts, and native secret-scanning are GitHub *settings*
— see the checklist below.

## Supply-chain hardening

- Every action is pinned to a full commit SHA (`# vX.Y.Z` comment) — resists
  tag-move attacks and satisfies Scorecard's Pinned-Dependencies check.
- `step-security/harden-runner` (egress-policy `audit`) on Linux jobs.
- Least-privilege `permissions:` per workflow/job.
- SBOM + SLSA provenance are attached to the published container image (added with
  the image-scan work).

## Maintainer checklist (one-time GitHub settings — NOT code)

- [ ] Repository must be **public** (required for the Scorecard badge/publish and
      the CodeQL free tier).
- [ ] Settings → Code security: enable **Dependabot alerts** and **Dependabot
      security updates**.
- [ ] Settings → Code security: enable **Secret scanning** + **Push protection**.
- [ ] Settings → Code security: enable **CodeQL / code-scanning merge protection**
      so high-severity alerts block PRs (the code-level gates do the rest).
- [ ] Branch protection on `main`: require the CI + security status checks to pass.
- [ ] **Manual image bumps:** Dependabot does not track `docker-compose.yml`
      `image:` pins — update `caddy` and `livekit/livekit-server` by hand when new
      releases ship. (Renovate, which parses compose, is an optional future
      alternative.)
```

- [ ] **Step 2: Add the CLAUDE.md subsystem-table row**

In `CLAUDE.md`, inside the "Subsystem Documentation" table (the block of `| File | Contents | Read when... |` rows), add:

```markdown
| [security-scanning.md](docs/systems/security-scanning.md) | CI security pipeline: Dependabot, CodeQL SAST, gitleaks, OSV-Scanner, Trivy (config/image/license), OpenSSF Scorecard, SHA-pinning, harden-runner, tiered enforcement policy, maintainer settings checklist | Any CI security work, adding/changing scanners, enabling enforcement, supply-chain hardening |
```

- [ ] **Step 3: Verify the doc links resolve**

Run:
```bash
test -f docs/systems/security-scanning.md && grep -q 'security-scanning.md' CLAUDE.md && echo "doc + CLAUDE.md row present"
```
Expected: `doc + CLAUDE.md row present`.

- [ ] **Step 4: Commit**

```bash
git add docs/systems/security-scanning.md CLAUDE.md
git commit -m "docs(security): document the scanning pipeline + maintainer checklist"
```

---

### Task 7: Open the PR and verify the pipeline runs

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1-6, pushed to GitHub.
- Produces: a PR with all scanners running green/advisory — the acceptance gate for Plan A.

- [ ] **Step 1: Push the branch**

Run:
```bash
git push -u origin security-scanning-hardening
```
Expected: branch pushed; GitHub prints a PR-create URL.

- [ ] **Step 2: Open a PR**

Run:
```bash
gh pr create --fill --base main --head security-scanning-hardening \
  --title "Security scanning pipeline (report-only)" \
  --body "Adds Dependabot, CodeQL, gitleaks, OSV-Scanner, Trivy (config/license), OpenSSF Scorecard, SHA-pinned actions, and harden-runner. All scanners are report-only; enforcement is flipped on in a later change. See docs/systems/security-scanning.md."
```
Expected: prints the PR URL.

- [ ] **Step 3: Watch the checks**

Run:
```bash
gh pr checks --watch
```
Expected: `CI / Build & test` passes; `CodeQL`, `Security` (gitleaks/osv/trivy jobs), and `OpenSSF Scorecard` all complete. Because every scanner is `continue-on-error`/advisory, **no scanner may report a failing (red) required check** — a scanner surfacing findings is fine, but the job itself should not fail the PR. If a job fails for a non-finding reason (bad action input, missing permission), fix the workflow and push.

- [ ] **Step 4: Confirm SARIF + Dependabot registration**

Verify in the GitHub UI (or note as maintainer follow-up if Actions/security features aren't enabled yet):
- Security → Code scanning: alerts appear under categories `codeql`, `osv-scanner`, `trivy-config`, `trivy-license`, and Scorecard.
- Insights → Dependency graph → Dependabot: the three ecosystems (npm, github-actions, docker) are listed as configured.

Run (CLI cross-check of code-scanning analyses, if the repo is public with Actions enabled):
```bash
gh api repos/:owner/:repo/code-scanning/analyses --jq '[.[].category] | unique' 2>/dev/null || echo "code-scanning API not available yet (enable in Settings)"
```
Expected: a list including the scanner categories, or the fallback message (then it's a maintainer-settings follow-up, not a plan defect).

- [ ] **Step 5: Record verification outcome**

No commit. Note in the PR description (or a comment) which checks passed and any settings follow-ups (from the Task 6 maintainer checklist) still pending. Plan A is complete when the PR is green with all four scanners running advisory.

---

## Self-Review Notes

- **Spec coverage (WS1 + supply-chain):** Dependabot (Task 1) ✓; CodeQL (Task 3) ✓; gitleaks + OSV + Trivy config + Trivy license (Task 2) ✓; Scorecard (Task 4) ✓; SHA-pinning + harden-runner (audit) + least-priv permissions across all workflows (Task 5) ✓; docs + maintainer checklist + CLAUDE.md row (Task 6) ✓; report-only sequencing honored throughout (Global Constraints + per-step comments) ✓.
- **Deferred by design (other plans, not gaps):** container image scan + SBOM/provenance + docker-publish restructure → Plan B; helmet/CSP/CORS + DAST → Plan C; Electron hardening → Plan D; remediation of findings + enforcement flip + README badges → Plan E. Task 5's SHA-pin sweep does include `docker-publish.yml` (harmless; Plan B re-pins as it restructures).
- **Enforcement stays OFF here** — every scanner is `continue-on-error`/advisory; no `fail-on`/severity gate is set in this plan. The maintainer-settings toggles (CodeQL merge protection, push protection, branch protection) are documented, not enabled in code.
