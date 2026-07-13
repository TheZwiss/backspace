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

## Supply-chain hardening

- Every action is pinned to a full commit SHA (`# vX.Y.Z` comment) — resists
  tag-move attacks and satisfies Scorecard's Pinned-Dependencies check.
- `step-security/harden-runner` (egress-policy `audit`) on Linux jobs.
- Least-privilege `permissions:` per workflow/job.
- SBOM + SLSA provenance **will be** attached to the published container image
  (added with the container-image-scan work in a later plan — not yet live).

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
