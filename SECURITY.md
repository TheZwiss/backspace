# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately via a **GitHub security advisory** on this repository
(Security → **Report a vulnerability**).

For non-security questions, use **GitHub Issues** (bugs) or **GitHub Discussions**
(questions).

We will acknowledge your report, work with you on a fix, and coordinate
disclosure. Please include reproduction steps, affected version/commit, and your
environment (deployment method, browser/desktop, and whether federation or voice
is involved).

## Security testing and assurance

Backspace runs continuous automated security testing. None of it replaces a
report from a human researcher, which is why the section above exists.

- **Static analysis.** CodeQL analyses the TypeScript on every pull request,
  every push to `main`, and weekly.
- **Dependencies.** OSV-Scanner checks the lockfile against the OSV database on
  the same schedule. GitHub Dependabot raises update pull requests weekly and
  advisory alerts continuously.
- **Secrets.** gitleaks scans the full git history, not just the diff.
- **Configuration and containers.** Trivy checks infrastructure configuration
  and dependency licenses on every change, and scans the published container
  image on every publish.
- **Running instance.** An OWASP ZAP baseline scan runs against a freshly built
  ephemeral instance on every push to `main` and weekly. It is unauthenticated
  and reaches the web shell and its static assets, so it is a regression guard
  rather than an assessment of the application.
- **Repository posture.** OpenSSF Scorecard evaluates the repository itself and
  publishes the result publicly.
- **Supply chain.** Every GitHub Action is pinned to a full commit SHA, jobs run
  with per-job permissions on hardened runners, and published images carry a
  software bill of materials and build provenance.

Findings are triaged, not accumulated. Every dismissal carries a written reason.
The full policy, the workflow inventory, and the register of dismissed findings
are in
[`docs/systems/security-scanning.md`](docs/systems/security-scanning.md).

Automated scanning has known gaps, and they are worth stating plainly. The
dynamic scan does not authenticate, and because the web shell contains no links
for a crawler to follow it reaches the shell and its static assets rather than
the API. It does not exercise spaces, channels, uploads, federation, or voice.
There is no fuzzing. Reports covering those areas are especially welcome.

## Supported versions

Backspace 1.x receives security fixes. Always run the latest release.
