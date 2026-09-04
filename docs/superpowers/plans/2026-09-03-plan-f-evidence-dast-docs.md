# Plan F: Evidence, DAST and Docs (Track E, WS6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up an advisory DAST job against an ephemeral Backspace container, close the two remaining `harden-runner` gaps, and write the public-facing security evidence (README badges and section, SECURITY.md, `security-scanning.md`) that describes the pipeline as it actually exists.

**Architecture:** The rig is not new infrastructure. `docker compose up backspace` already produces a complete, healthchecked instance, and ZAP joins that compose network by name, so nothing needs a published port, a Caddy override, or a second compose file. ZAP runs as a plain `docker run` rather than through the marketplace action, because the target only resolves if we control the `--network` flag. Documentation tasks come last so the prose describes shipped behaviour.

**Tech Stack:** GitHub Actions, Docker Compose v2, OWASP ZAP (`ghcr.io/zaproxy/zaproxy`, baseline scan), `actionlint`, StepSecurity `harden-runner`.

**Spec:** `docs/superpowers/specs/2026-07-10-security-scanning-hardening-design.md` §WS6 (lines 336-360). Coordination spine and the Track E brief: `docs/superpowers/plans/2026-09-02-security-pass-master.md` (Track E section).

---

## Global Constraints

Every task's requirements implicitly include this section.

- **No vulnerability or exploit detail in any public artifact.** Commit messages, PR titles and bodies, release notes, README, SECURITY.md and every tracked file describe behaviour, never exploitation. This plan itself is safe to track: it contains CI wiring and posture statements that `docs/systems/security-scanning.md` already publishes.
- **No em dashes and no buzzword register** in anything this plan produces. That covers README copy, SECURITY.md, `docs/systems/*.md`, commit messages and the PR body. Use a colon, a comma, or two sentences.
- **Commit identity:** never commit as `alxtrading94@gmail.com`. Use `151788261+TheZwiss@users.noreply.github.com`.
- **Stage explicitly by path.** Never `git add -A` or `git add .`. Untracked working plans must stay untracked.
- **Do not pass `--subject` to `gh pr merge`.** GitHub appends `(#N)` to a squash subject itself.
- **Every action pinned to a full commit SHA** with a trailing `# vX.Y.Z` comment, matching the existing 15 pins. Every container image referenced from a workflow pinned by digest, for the same reason.
- **Resolve every SHA and digest yourself at execution time.** Do not copy one out of this plan or out of a Dependabot PR. Track D found Dependabot proposing pins that were already stale.
- **`actionlint` on every workflow file this plan creates or edits**, before commit.
- Advisory means advisory: the DAST job must not fail the build on a scan finding. It *should* fail on rig failure, because a container that will not come up is a real regression.

---

## What already exists (verified against the tree on 2026-09-03)

Read this before starting. Several items in the original WS6 brief are already discharged, and one assumption in it is wrong.

| Brief item | Actual state |
|---|---|
| "Depends on Track C for the ephemeral rig" | **False. No rig exists.** `grep -rl 'zap\|dast' .github/ docs/` returns nothing. Track C's Docker/Caddy/LiveKit rig was cancelled with evidence and must not be revived. Task 1 below builds the rig, and it is smaller than the cancelled one. |
| CLAUDE.md rows for `security-scanning.md` and `desktop-security.md` | **Already present**, `CLAUDE.md:166` and `CLAUDE.md:171`. Do not add them again. Task 8 only corrects a stale data path. |
| `security-scanning.md` maintainer checklist | **Already written and verified against the live repo on 2026-09-03**, including the repo-must-be-public precondition and the manual `caddy`/`livekit` bump reminder. Task 7 adds the DAST rows, it does not rewrite the checklist. |
| Triage policy and dismissal register | **Already written** (`security-scanning.md` §Triage policy, §Dismissal register), landed in Track D as `f912cd7c`. |
| Scorecard `publish_results` | **Already `true`** (`scorecard.yml:38`), so the public badge in Task 5 will resolve. |
| `harden-runner` coverage | Present in 9 of the 10 workflow files. **Missing from `cla.yml` and `docker-publish.yml`.** Task 4. (There are 10 files, not 11. `flatpak.yml` and `zz-temp-bundle-rehearsal.yml` still have stale Actions registrations but no longer exist on disk.) |

**Facts the rig design depends on, each verified by reading the file:**

- `docker-compose.yml` gives the `backspace` service **no `ports:` mapping**. It is reachable only from the `internal` bridge network. This is why ZAP must join that network instead of targeting `localhost`.
- The `backspace` service declares a `healthcheck` hitting `/api/health`, so `docker compose up --wait` is a real readiness gate and no sleep loop is needed.
- `Dockerfile` sets `ENV PORT=3000` and `EXPOSE 3000`, and `packages/server/src/index.ts:211` serves the SPA from a `setNotFoundHandler`, so a single container serves both the API and the web app.
- `config.ts:159` rejects a `JWT_SECRET` shorter than 32 characters.
- `docker-compose.yml` interpolates `${DOMAIN:?...}` inside the `caddy` service. Compose interpolates the whole file before it filters services, so **`DOMAIN` must be set even though `caddy` never starts.**
- The `caddy` service is in the default profile, so `docker compose up` with no service argument would start it and hang on ACME. Naming the `backspace` service explicitly is what avoids that. `livekit` is already profile-gated behind `voice`.
- Per `docs/systems/web-security.md` §5, the app itself sends every security header except `Strict-Transport-Security`, which Caddy owns.
- **CORRECTED 2026-09-03 by the Task 1 run.** An earlier draft of this plan said bypassing Caddy costs one header and that HSTS would be the main entry in the rule file. **Rule 10035 never fires at all.** ZAP only raises it over HTTPS, and the rig is plain HTTP by construction, so the header ZAP cannot see is also the header it never asks about. ZAP reported `PASS` for 10035. **Do not put a 10035 line in `rules.tsv`.**
- **The spider reaches the SPA shell and its static assets only.** Measured: 11 URLs, none of them under `/api/`. The shell contains no links, so ZAP finds `index.html`, the JS bundle, three icons, the web manifest, and its own probes for `robots.txt` and `sitemap.xml`. Any prose claiming this scan covers `/api/health`, `/api/instance/info` or the auth routes is false and must not be written.
- The CSP is still `Content-Security-Policy-Report-Only`. Plan C Task 8 gates the flip to enforcing. ZAP treats a report-only policy as no policy.

---

## File structure

| Path | State | Responsibility |
|---|---|---|
| `.github/workflows/dast.yml` | create | Stand up one ephemeral instance, run a ZAP baseline against it, publish the report as an artifact. Advisory. |
| `.zap/rules.tsv` | create | The only place a ZAP rule is downgraded, one line per rule with the reason inline. |
| `.github/workflows/cla.yml` | modify | Add `harden-runner`. |
| `.github/workflows/docker-publish.yml` | modify | Add `harden-runner`. |
| `README.md` | modify | Badges (lines 9-12) and a new "Security and supply chain" section next to the existing "Security" section at line 685. |
| `SECURITY.md` | modify | New "Security testing and assurance" section. |
| `docs/systems/security-scanning.md` | modify | `dast.yml` row in the workflow table, a DAST section explaining scope and the tuned rules, checklist additions. |
| `CLAUDE.md` | modify | Correct the stale `packages/server/data/` path. |

**Branch:** `security/evidence-dast-docs`, cut from `main`.

---

## Task 1: The rig, proven locally

Nothing is committed in this task. Its deliverable is a recorded, reproducible run plus the raw finding list that Task 3 turns into a rule file. Writing `rules.tsv` before seeing a real report would be guessing.

**Files:**
- Create: nothing tracked. Work under the session scratchpad.

**Interfaces:**
- Produces: the exact `docker compose` and `docker run` invocations Task 2 pastes into the workflow, and the list of ZAP rule IDs at WARN that Task 3 triages.

- [ ] **Step 1: Confirm Docker is usable**

```bash
docker version --format '{{.Server.Version}}' && docker compose version
```

If the daemon is not running or not installed, stop and say so in your report. Do not fake this task. The fallback is stated in Step 8: the evidence then comes from the first CI run instead, and Task 3 is deferred until that run exists.

- [ ] **Step 2: Write a throwaway env file**

The repo `.env` may exist with real values and must not be touched. Build the rig in a scratch copy of the working tree instead, so a stray `docker compose down -v` cannot reach `./data`.

```bash
SCRATCH=/private/tmp/claude-501/-Users-jbraun-backspace-public/*/scratchpad/dast-rig
mkdir -p "$SCRATCH" && cd "$(git rev-parse --show-toplevel)"
git archive HEAD | tar -x -C "$SCRATCH"
cd "$SCRATCH"
cat > .env <<'ENVEOF'
DOMAIN=dast.invalid
JWT_SECRET=0000000000000000000000000000000000000000000000000000000000000000
PORT=3000
NODE_ENV=production
REGISTRATION_OPEN=true
ENVEOF
```

`dast.invalid` is deliberate. `.invalid` is reserved by RFC 2606 and can never resolve, and the pre-commit hook that blocks real infrastructure hostnames will not see it because nothing here is committed.

- [ ] **Step 3: Bring up only the app service**

```bash
docker compose -p backspace-dast up -d --build --wait backspace
```

Expected: a build, then the service reported healthy. `--wait` blocks on the healthcheck.

If it exits non-zero, read `docker compose -p backspace-dast logs backspace` before changing anything. A `Missing required environment variable` or the `JWT_SECRET must be at least 32 characters` guard from `config.ts:159` means Step 2's env file is wrong, not that the rig is.

- [ ] **Step 4: Confirm the network name and reachability**

```bash
docker network ls --filter name=backspace-dast --format '{{.Name}}'
docker run --rm --network backspace-dast_internal \
  curlimages/curl:latest -sS -i http://backspace:3000/api/health | head -20
```

Expected: the network is `backspace-dast_internal`, and the health endpoint returns 200. The `-p backspace-dast` project flag is what makes that name deterministic instead of deriving from the checkout directory.

Record the response headers. They are the ground truth for which headers ZAP will and will not see.

- [ ] **Step 5: Run the ZAP baseline**

```bash
mkdir -p zapwrk
docker run --rm --network backspace-dast_internal \
  -v "$PWD/zapwrk:/zap/wrk/:rw" \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py -t http://backspace:3000 -I -r report.html -w report.md -J report.json
```

`-I` makes ZAP exit 0 when the only results are warnings, which is what "advisory" means. Without it the job fails on the first missing header.

The floating `:stable` tag is correct here and wrong in CI. Task 2 pins it by digest.

- [ ] **Step 6: Read the report and list every rule at WARN**

```bash
python3 - <<'PYEOF'
import json, pathlib
d = json.loads(pathlib.Path('zapwrk/report.json').read_text())
for site in d.get('site', []):
    for a in site.get('alerts', []):
        print(a.get('pluginid'), a.get('riskdesc'), '|', a.get('alert'), '| instances:', len(a.get('instances', [])))
PYEOF
```

Write the full list into your task report. Task 3 triages it. Do not pre-emptively silence anything here.

- [ ] **Step 7: Tear the rig down**

```bash
docker compose -p backspace-dast down -v
```

`-v` is safe only because this is the scratch copy. Never run it against the repo working tree, where `./data` is bind-mounted to the real database.

- [ ] **Step 8: Report, do not commit**

Report: the compose command that worked, the resolved network name, the health-check response headers, and the rule list. If Docker was unavailable at Step 1, say that plainly and mark Task 3 as blocked on the first CI run rather than inventing a rule file.

---

## Task 2: `dast.yml`

**Files:**
- Create: `.github/workflows/dast.yml`

**Interfaces:**
- Consumes: the invocations proven in Task 1.
- Produces: a workflow named `DAST` with a job id `zap-baseline`, uploading an artifact named `zap-baseline-report`.

- [ ] **Step 1: Resolve the pins**

Three pins are needed. Resolve all three now, do not copy them from here.

```bash
# harden-runner, checkout, upload-artifact: reuse the SHAs already in the repo
grep -h "step-security/harden-runner@\|actions/checkout@\|actions/upload-artifact@" .github/workflows/*.yml | sort -u
# ZAP image digest
docker buildx imagetools inspect ghcr.io/zaproxy/zaproxy:stable --format '{{.Manifest.Digest}}'
```

If `docker` is unavailable, resolve the digest over the registry API instead:

```bash
TOKEN=$(curl -sS "https://ghcr.io/token?scope=repository:zaproxy/zaproxy:pull&service=ghcr.io" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -sSI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://ghcr.io/v2/zaproxy/zaproxy/manifests/stable" | grep -i docker-content-digest
```

- [ ] **Step 2: Write the workflow**

Substitute the SHAs and the digest you just resolved for the `<...>` placeholders. Leaving a placeholder in the committed file is a plan failure.

```yaml
name: DAST

# Dynamic scan of a running instance, as opposed to the static analysis in
# codeql.yml and the dependency scanning in security.yml. It stands up one
# ephemeral container from the tree under test and runs an OWASP ZAP baseline
# against it: spider plus passive checks, no active attack traffic.
#
# Scope, stated honestly and measured rather than assumed: the scan is
# unauthenticated and the spider reaches the SPA shell and its static assets
# only. A measured run visited 11 URLs and none of them were under /api/,
# because the shell contains no links for a spider to follow. It does not
# exercise the API, spaces, channels, uploads, federation or voice. Its value is
# that it proves the image still builds and the container still becomes healthy,
# and it passively checks response headers on what it does reach. It is not an
# assessment of the application.
#
# Advisory by design. A finding never fails this workflow. A container that
# will not become healthy does, because that is a real regression.
#
# Not on every pull request: the job builds the full image, which is minutes of
# runner time, and an advisory result does not belong in the merge path. It runs
# on every push to main, weekly, on demand, and on pull requests that touch its
# own configuration so that it self-tests when changed.

on:
  push:
    branches: [main]
  pull_request:
    paths:
      - '.github/workflows/dast.yml'
      - '.zap/**'
  schedule:
    # Wednesday 04:17 UTC. Off the hour so it does not queue behind the
    # every-scanner-at-midnight crowd on the hosted runners.
    - cron: '17 4 * * 3'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  zap-baseline:
    name: ZAP baseline
    runs-on: ubuntu-latest
    # No write scope anywhere. The report leaves as an artifact rather than as
    # SARIF: ZAP's SARIF conversion is not part of the baseline image, and a
    # code-scanning upload would need security-events: write for results that
    # are advisory and mostly about deployment-time headers.
    permissions:
      contents: read

    steps:
      - name: Harden the runner
        uses: step-security/harden-runner@<sha> # v2.21.1
        with:
          egress-policy: audit

      - name: Checkout
        uses: actions/checkout@<sha> # v7.0.1

      # docker-compose.yml reads env_file: .env, and compose fails outright if
      # that file is absent. DOMAIN is required even though caddy never starts:
      # compose interpolates the whole file before it filters services, and the
      # caddy service declares ${DOMAIN:?...}. dast.invalid is an RFC 2606
      # reserved name that cannot resolve. The secret is a throwaway that only
      # has to clear the 32-character floor in config.ts.
      - name: Write the ephemeral env file
        run: |
          cat > .env <<'EOF'
          DOMAIN=dast.invalid
          JWT_SECRET=0000000000000000000000000000000000000000000000000000000000000000
          PORT=3000
          NODE_ENV=production
          REGISTRATION_OPEN=true
          EOF

      # Only the backspace service. caddy sits in the default profile and would
      # hang on ACME without public DNS; livekit is already gated behind the
      # voice profile. --wait blocks on the healthcheck declared in the compose
      # file, so no polling loop is needed. The -p flag fixes the project name,
      # which is what makes the network name below deterministic.
      - name: Start an ephemeral instance
        run: docker compose -p backspace-dast up -d --build --wait backspace

      # ZAP joins the compose network and addresses the container by service
      # name. The compose file publishes no ports, so there is nothing to reach
      # on the runner's localhost, and this avoids depending on how any
      # marketplace action wires up its own container networking.
      - name: Run the ZAP baseline
        run: |
          mkdir -p "$GITHUB_WORKSPACE/zap-out"
          docker run --rm \
            --network backspace-dast_internal \
            -v "$GITHUB_WORKSPACE/zap-out:/zap/wrk/:rw" \
            -v "$GITHUB_WORKSPACE/.zap:/zap/cfg/:ro" \
            ghcr.io/zaproxy/zaproxy@<digest> \
            zap-baseline.py \
              -t http://backspace:3000 \
              -c /zap/cfg/rules.tsv \
              -I \
              -r report.html -w report.md -J report.json

      - name: Summarise the findings
        if: always()
        run: |
          if [ -f zap-out/report.md ]; then
            {
              echo '## ZAP baseline'
              echo
              cat zap-out/report.md
            } >> "$GITHUB_STEP_SUMMARY"
          else
            echo 'ZAP produced no report. The scan step failed before writing one.' >> "$GITHUB_STEP_SUMMARY"
          fi

      - name: Upload the report
        if: always()
        uses: actions/upload-artifact@<sha> # v7.0.1
        with:
          name: zap-baseline-report
          path: zap-out/
          retention-days: 30

      - name: Tear down
        if: always()
        run: docker compose -p backspace-dast down -v
```

- [ ] **Step 3: Lint it**

```bash
actionlint .github/workflows/dast.yml
```

Expected: no output. `actionlint` catches the trailing-comment and quoting mistakes that otherwise only surface in a live run.

- [ ] **Step 4: Confirm no placeholder survived**

```bash
grep -n '<sha>\|<digest>' .github/workflows/dast.yml
```

Expected: no output. If anything matches, go back to Step 1.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/dast.yml
git commit -m "ci(security): add an advisory ZAP baseline against an ephemeral instance"
```

---

## Task 3: `.zap/rules.tsv`

**Files:**
- Create: `.zap/rules.tsv`

**Interfaces:**
- Consumes: the WARN list from Task 1 Step 6.
- Produces: the file `dast.yml` mounts at `/zap/cfg/rules.tsv`.

**CORRECTED 2026-09-03 against the pinned image's own parser.** An earlier draft of this plan described the third column as optional. It is required, and getting it wrong is a hard failure, not a silent one.

The format is `<rule id>\t<WARN|IGNORE|FAIL>\t<label>`, tab separated, with `#` comment lines allowed. `zap_common.py:148` raises `ValueError` if a line carries fewer than two tabs, and **ZAP then aborts the scan before it starts and writes no report at all**, leaving an empty output directory. A trailing empty tab does not satisfy it either, because the line is `rstrip()`ed first. The third column is only a label; use the alert name as ZAP prints it. A fourth tab-separated field, if present, becomes an optional user message. The URL regex applies only to the `OUTOFSCOPE` level, not to `IGNORE`/`WARN`/`FAIL`.

- [ ] **Step 1: Triage the Task 1 list**

For each rule ZAP reported, decide one of:

- **Leave at WARN.** The default. Anything genuinely worth seeing in the report.
- **`IGNORE` with a written reason.** Only for a finding that is an artefact of scanning the app container directly rather than a property of the deployed system.

The two known entries, from `docs/systems/web-security.md` §5 and the CSP rollout state:

**This table is measured, not predicted.** It is the triage of the actual Task 1 run against `8f9675ed`, which reported `WARN-NEW: 7, PASS: 60, FAIL: 0`, exit 0.

| Rule | Alert as ZAP actually names it | Disposition |
|---|---|---|
| 10038 | Content Security Policy (CSP) Report-Only Header Found (Informational) | **`IGNORE`, with an expiry note.** The policy ships as report-only by design today. **Delete this line when Plan C Task 8 flips the CSP to enforcing.** |
| 10109 | Modern Web Application (Informational) | **`IGNORE`.** Not a finding. ZAP reporting that the target is an SPA and that spider coverage is therefore limited is a statement about the scanner, not about the app. |
| 10055 | CSP: Wildcard Directive / Failure to Define Directive with No Fallback / style-src unsafe-inline (Medium, x3) | **WARN, do not ignore.** These evaluate the deliberately narrow `index.html` meta policy, not the report-only header, so today they are noise. The same rule evaluates the real policy the moment the CSP flips to enforcing. An `IGNORE` here would hide a genuine regression at exactly the point it starts to matter. `-I` means a WARN never fails the job, so the noise is free. |
| 10063 | Permissions Policy Header Not Set (Low) | **WARN. This is a real gap, not an artefact.** See the follow-up note below. |
| 90004 | Cross-Origin-Embedder-Policy Header Missing or Invalid (Low) | **WARN.** COEP is disabled deliberately (`crossOriginEmbedderPolicy: false`, with a written reason: embeds pull third-party images carrying no CORP). That is a property of the deployed system, not a scan artefact, so by this plan's own IGNORE rule it stays visible. |
| 10049 | Storable but Non-Cacheable Content (Informational) | **WARN.** Real `@fastify/static` behaviour (`cache-control: public, max-age=0`) on the shell and icons. |
| 10027 | Information Disclosure - Suspicious Comments (Informational) | **WARN.** False positive: the regex matched the word "from" inside an intentional explanatory comment. One regex hit is not worth a suppression line. |
| ~~10035~~ | ~~Strict-Transport-Security Header Not Set~~ | **Omit entirely.** It never fires. ZAP raises it only over HTTPS and this rig is plain HTTP. It reported `PASS`. |

**Net result: `rules.tsv` contains exactly two `IGNORE` lines, 10038 and 10109.** Everything else stays at WARN on purpose.

**Follow-up this run surfaced, out of scope here, record it in Task 7 rather than tuning it away:** the app sends **no `Permissions-Policy` header on any route**, and helmet adds none by default. Unlike HSTS, Caddy does not supply it either, so a real deployment has the same gap. It is deliberately NOT fixed in this plan: a wrong value silently breaks voice and screen sharing, because those need `camera`, `microphone` and `display-capture` granted to self. It therefore belongs with Plan C Task 8, which already carries the real-deployment observation phase that a change like this needs.

- [ ] **Step 2: Write the file**

Use a quoted heredoc and real tab characters. Verify them in Step 3 rather than trusting your editor.

```bash
mkdir -p .zap
printf '%s\n' \
'# ZAP baseline rule tuning. Consumed by .github/workflows/dast.yml.' \
'# Format: <rule id>\t<WARN|IGNORE|FAIL>\t<optional url regex>' \
'#' \
'# IGNORE is only for a finding that is an artefact of scanning the app' \
'# container directly instead of the deployed system. Everything else stays at' \
'# WARN so it shows up in the report. The reasoning lives in' \
'# docs/systems/security-scanning.md, section "Dynamic scanning (DAST)".' \
'' \
'# The CSP ships as Content-Security-Policy-Report-Only today, and this rule' \
'# fires as "Report-Only Header Found". DELETE THIS LINE when the policy flips' \
'# to enforcing (Plan C Task 8). Leaving it after the flip would hide a real' \
'# regression.' \
'10038	IGNORE' \
'' \
'# Not a finding. ZAP reporting that the target is a single-page app, and that' \
'# its spider coverage is therefore limited, is a statement about the scanner' \
'# rather than about the app.' \
'10109	IGNORE' \
> .zap/rules.tsv
```

**That is the whole file: two IGNORE lines.** Do not add a third. In particular do not add 10035; it never fires over plain HTTP and the measured run reported it as `PASS`. Every other rule from the Task 1 list stays at WARN on purpose, for the reasons in the Step 1 table.

- [ ] **Step 3: Verify the separators are tabs**

```bash
grep -Pn '^\d+\t(WARN|IGNORE|FAIL)\t' .zap/rules.tsv
```

Expected: one numbered line per rule, and note the **trailing** `\t` in the pattern, which is what proves the required third column is present. If a rule line does not match, ZAP will abort the whole scan rather than ignore the line.

- [ ] **Step 4: Re-run the scan against the rule file**

Only if Docker was available in Task 1. Repeat Task 1 Steps 2 through 5, adding `-c /zap/cfg/rules.tsv` and the `-v "$PWD/.zap:/zap/cfg/:ro"` mount, and confirm the ignored rules no longer appear as warnings while everything else still does.

If Docker was unavailable, say so and let the first CI run be the check.

- [ ] **Step 5: Commit**

```bash
git add .zap/rules.tsv
git commit -m "ci(security): tune the ZAP baseline for the headers Caddy owns"
```

---

## Task 4: `harden-runner` on the last two workflows

**Files:**
- Modify: `.github/workflows/cla.yml` (insert as the first step of the `cla-assistant` job)
- Modify: `.github/workflows/docker-publish.yml` (insert as the first step of the `build-and-push` job, before `Checkout` at line 41)

**Interfaces:**
- Consumes: the `harden-runner` SHA already pinned in the other nine workflows.
- Produces: `harden-runner` present in 10 of 10 workflow files, which Task 7 states as fact. **Say 10, not 11.**

**Mode is `audit`, not `block`.** All nine existing usages are `audit`. `cla.yml` in particular runs on `pull_request_target` and drives a third-party action whose egress set is not documented; a block-mode false positive there would break CLA signing for every external contributor, which is a worse outcome than an unaudited egress. Do not "improve" this to `block` as a drive-by.

- [ ] **Step 1: Read the current first steps**

```bash
sed -n '48,58p' .github/workflows/cla.yml
sed -n '38,44p' .github/workflows/docker-publish.yml
```

You are inserting above `- name: CLA Assistant` and above `- name: Checkout` respectively. `cla.yml` has a `steps:` key immediately followed by the action step, so the insertion point is directly under `steps:`.

- [ ] **Step 2: Get the pinned SHA**

```bash
grep -h -A1 "step-security/harden-runner@" .github/workflows/ci.yml
```

Use exactly that SHA and its `# vX.Y.Z` comment. Do not resolve a newer one here: this task is about coverage, and a version bump in the same commit makes the diff ambiguous.

- [ ] **Step 3: Edit `cla.yml`**

Insert as the first entry under `steps:`:

```yaml
      - name: Harden the runner
        uses: step-security/harden-runner@<sha> # v2.21.1
        with:
          egress-policy: audit
```

- [ ] **Step 4: Edit `docker-publish.yml`**

Insert the identical block as the first entry under `steps:`, above `- name: Checkout`.

- [ ] **Step 5: Lint both**

```bash
actionlint .github/workflows/cla.yml .github/workflows/docker-publish.yml
```

Expected: no output.

- [ ] **Step 6: Confirm full coverage**

```bash
for f in .github/workflows/*.yml; do printf '%-24s %s\n' "$(basename "$f")" "$(grep -c harden-runner "$f")"; done
```

Expected: every file at 1 or more. `security.yml` reports 4 because it has four jobs.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/cla.yml .github/workflows/docker-publish.yml
git commit -m "ci: run the CLA and image publish jobs on a hardened runner"
```

**Verification limit, state it in your report:** a workflow triggered by `pull_request_target` always runs the copy of itself on the base branch. The green `cla-assistant` check on this pull request therefore does **not** exercise the edited `cla.yml`. It is verified by `actionlint` here, and confirmed for real on the first CLA event after merge. `docker-publish.yml` triggers only on a tag push or manual dispatch, so it is likewise unexercised until the next release.

---

## Task 5: README badges and the security section

Sequenced after the workflow tasks on purpose. The prose describes what exists, and after Tasks 2 and 4 the DAST job exists.

**Files:**
- Modify: `README.md` lines 9-12 (badge block) and the `## Security` section at line 685.

- [ ] **Step 1: Replace the badge block**

Current lines 9-12 carry two stale claims: the Node badge says `20 LTS` when `.nvmrc` selects 24 and the image runs 24, and the version badge is hardcoded to `1.0.0` while `package.json` is at `1.0.2`.

Replace all four lines with:

```markdown
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-3da639.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node-24_LTS-339933.svg)](https://nodejs.org/)
[![Release](https://img.shields.io/github/v/release/TheZwiss/backspace?color=16a34a&label=release)](https://github.com/TheZwiss/backspace/releases)
[![CodeQL](https://github.com/TheZwiss/backspace/actions/workflows/codeql.yml/badge.svg)](https://github.com/TheZwiss/backspace/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/TheZwiss/backspace/badge)](https://scorecard.dev/viewer/?uri=github.com/TheZwiss/backspace)
[![Security policy](https://img.shields.io/badge/security-policy-blue.svg)](SECURITY.md)
```

The version badge becomes a live shields query against the releases API, so it stops needing a manual edit every release. That removes a step from the release checklist rather than adding one.

- [ ] **Step 2: Verify each badge actually resolves**

A badge that 404s is worse than no badge.

```bash
for u in \
  "https://img.shields.io/github/v/release/TheZwiss/backspace" \
  "https://github.com/TheZwiss/backspace/actions/workflows/codeql.yml/badge.svg" \
  "https://api.scorecard.dev/projects/github.com/TheZwiss/backspace/badge" ; do
  printf '%s -> %s\n' "$u" "$(curl -sS -o /dev/null -w '%{http_code}' "$u")"
done
```

Expected: `200` for all three. The Scorecard badge depends on `publish_results: true`, which `scorecard.yml:38` already sets and at least one run on `main` has already published. If it returns 404, the run has not published yet: do not delete the badge, note it and re-check after the merge run.

- [ ] **Step 3: Extend the `## Security` section**

Keep the existing reporting paragraph exactly as it is, and add below it. No em dashes.

```markdown
### Security and supply chain

Every change is scanned automatically before and after it lands. Results are
published to this repository's Security tab.

| What | Tool | When |
|------|------|------|
| Static analysis of the TypeScript | CodeQL | every pull request, every push to `main`, weekly |
| Known vulnerabilities in dependencies | OSV-Scanner | every pull request, every push to `main`, weekly |
| Secrets, across the full git history | gitleaks | every pull request, every push to `main`, weekly |
| Infrastructure and container config | Trivy | every pull request, every push to `main`, weekly |
| Dependency licenses | Trivy | every pull request, every push to `main`, weekly |
| Published container image | Trivy | on every image publish |
| Repository security posture | OpenSSF Scorecard | every push to `main`, weekly |
| A running instance | OWASP ZAP baseline | every push to `main`, weekly |
| Dependency and base image updates | Dependabot | weekly |

Supporting practice: every GitHub Action is pinned to a full commit SHA rather
than a tag, every job runs on a hardened runner with egress auditing, and
workflow permissions are granted per job instead of repository-wide. Release
artifacts are published with build provenance and an SBOM.

Findings are triaged rather than accumulated. Anything dismissed carries a
written reason, recorded in
[`docs/systems/security-scanning.md`](docs/systems/security-scanning.md), which
also documents the scan policy and the deployment-time settings a self-hoster
should check.
```

- [ ] **Step 4: Check the claims you just wrote**

Each row must match a real trigger. Do not trust the table, check it.

```bash
grep -n -A8 '^on:' .github/workflows/codeql.yml .github/workflows/security.yml .github/workflows/scorecard.yml .github/workflows/dast.yml
grep -n "schedule\|interval" .github/dependabot.yml | head
```

Correct any row that does not match. A README that overstates the pipeline is worse than one that omits a row.

- [ ] **Step 5: Check for em dashes**

```bash
grep -n '—' README.md
```

Any hit inside the lines you added must go. Pre-existing hits elsewhere in the file are out of scope for this task.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(readme): document the security pipeline and refresh the badges"
```

---

## Task 6: SECURITY.md

**Files:**
- Modify: `SECURITY.md` (add a section between "Reporting a vulnerability" and "Supported versions")

- [ ] **Step 1: Add the section**

```markdown
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
  with per-job permissions on hardened runners, and release artifacts carry
  build provenance and an SBOM.

Findings are triaged, not accumulated. Every dismissal carries a written reason.
The full policy, the workflow inventory, and the register of dismissed findings
are in
[`docs/systems/security-scanning.md`](docs/systems/security-scanning.md).

Automated scanning has known gaps, and they are worth stating plainly. The
dynamic scan does not authenticate, and because the web shell contains no links
for a crawler to follow it reaches the shell and its static assets rather than
the API. It does not exercise spaces, channels, uploads, federation, or voice.
There is no fuzzing. Reports covering those areas are especially welcome.
```

The closing paragraph is not modesty for its own sake. A security policy that implies full coverage discourages exactly the reports that are worth the most.

- [ ] **Step 2: Verify the claims match the workflows**

Same check as Task 5 Step 4. The two documents must not disagree with each other.

- [ ] **Step 3: Check for em dashes**

```bash
grep -n '—' SECURITY.md
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add SECURITY.md
git commit -m "docs(security): describe the automated testing pipeline and its gaps"
```

---

## Task 7: `docs/systems/security-scanning.md`

**Files:**
- Modify: `docs/systems/security-scanning.md` (workflow table at line 11, a new DAST section, checklist additions at line 332)

Do **not** rewrite the triage policy, the dismissal register, or the maintainer checklist. All three were written and verified in Track D. This task adds DAST and reconciles the harden-runner claim.

- [ ] **Step 1: Add the `dast.yml` row to the workflow table**

Insert after the `scorecard.yml` row:

```markdown
| `.github/workflows/dast.yml` | ZAP baseline against an ephemeral instance (spider + passive, unauthenticated) | push main + weekly + manual + PRs touching its own config | Job summary + artifact (advisory) |
```

- [ ] **Step 2: Add a DAST section**

Place it after the "Tiered policy" section and before "Triage policy", so the reader meets the workflow before the triage rules that reference it.

```markdown
## Dynamic scanning (DAST)

`dast.yml` builds the image from the tree under test, starts a single container,
and runs an OWASP ZAP baseline against it. Baseline means spider plus passive
checks: ZAP sends no attack traffic.

**The rig is the production compose file, not a separate one.** The workflow
runs `docker compose -p backspace-dast up -d --build --wait backspace`, naming
the one service it wants. That single detail is what makes the rig small:

- `caddy` sits in the default profile and would hang on ACME without public DNS,
  so it must not be started. Naming `backspace` explicitly is what excludes it.
- `livekit` is already gated behind the `voice` profile and never starts here.
- The compose file publishes no ports for `backspace`, so ZAP joins the compose
  network and addresses the container as `http://backspace:3000`. Nothing is
  reachable on the runner's localhost, and nothing needs to be.
- `--wait` blocks on the healthcheck already declared in the compose file, so
  the workflow needs no polling loop.
- A throwaway `.env` is written first, because the service declares
  `env_file: .env` and compose fails outright without it. `DOMAIN` has to be set
  even though `caddy` never starts: compose interpolates the entire file before
  it filters services, and the `caddy` service declares `${DOMAIN:?...}`.

ZAP runs as a plain `docker run` rather than through the marketplace action,
because the target only resolves if the scanner is on the compose network, and
`--network` is a `docker run` flag that the action does not expose.

**What it covers, measured rather than assumed.** The scan is unauthenticated,
and the spider reaches the SPA shell and its static assets only. The measured
run visited 11 URLs: `/`, the JS bundle, three icons, `manifest.webmanifest`,
and ZAP's own probes for `robots.txt` and `sitemap.xml`. **None were under
`/api/`**, because the shell contains no links for the spider to follow. Adding
explicit seed URLs would widen this; it has not been done, because the API
routes carry the identical security header set (verified in the same run) and
the passive checks would therefore find nothing new.

Treat the job as proof that the image still builds and the container still
becomes healthy, plus a passive header check on what it reaches. It is not an
assessment of the application. Note also that `/robots.txt` and `/sitemap.xml`
return the SPA shell with HTTP 200, because `setNotFoundHandler` serves
`index.html` for every non-`/api` path.

**Advisory, deliberately.** ZAP runs with `-I`, so a finding never fails the
job. A container that will not become healthy does fail it, because that is a
real regression and the reason the job is worth running on every push to `main`.

**Why not on every pull request.** It builds the whole image, which costs
minutes of runner time, and an advisory result does not belong in the merge
path. It does run on pull requests that touch `.github/workflows/dast.yml` or
`.zap/**`, so its own configuration is self-testing.

### Tuned rules

`.zap/rules.tsv` is the only place a rule is downgraded, one line per rule with
the reason inline. `IGNORE` is reserved for findings that are artefacts of
scanning the app container directly instead of the deployed system. Everything
else stays at `WARN`.

| Rule | Alert | Why it is ignored |
|---|---|---|
| 10038 | Content Security Policy (CSP) Report-Only Header Found | The policy ships as report-only by design today. **This line is deleted when the policy flips to enforcing.** Leaving it in place afterwards would hide a real regression. |
| 10109 | Modern Web Application | Not a finding. ZAP is reporting that the target is a single-page app and that spider coverage is therefore limited, which is a statement about the scanner rather than about the app. |

Two rules that look like candidates and deliberately stay at `WARN`:

- **10055 (CSP directive warnings)** evaluates the narrow enforcing policy in the
  `index.html` meta tag, not the report-only header, so today it is noise. It
  will evaluate the real policy the moment the CSP flips to enforcing, and
  silencing it now would hide a regression at exactly the point it starts to
  matter. `-I` means a warning never fails the job, so the noise costs nothing.
- **90004 (COEP missing)** is deliberate: `crossOriginEmbedderPolicy` is off
  because embeds pull third-party images that carry no CORP header. That is a
  property of the deployed system, not an artefact of scanning it, so it stays
  visible.

**`Strict-Transport-Security` (rule 10035) is deliberately absent from this
file.** It never fires. ZAP raises it only over HTTPS and this rig is plain HTTP,
so the one header Caddy owns is also the one header ZAP never asks about. It
reported `PASS`. An earlier draft of this document listed it as the main entry;
that was a prediction, and the measured run disproved it.

**Open finding this scan surfaced, not tuned away:** the app sends no
`Permissions-Policy` header on any route, and helmet adds none by default.
Unlike HSTS, Caddy does not supply it either, so a real deployment has the same
gap. It is not fixed here because a wrong value silently breaks voice and screen
sharing, which need `camera`, `microphone` and `display-capture` granted to
self. It belongs with the CSP enforcement flip, which already carries the
real-deployment observation phase a change like this needs.

The file is tab separated. A space separated line parses as garbage and the rule
silently keeps its default, so check the separators after any edit:

```bash
grep -Pn '^\d+\t(WARN|IGNORE|FAIL)' .zap/rules.tsv
```
```

- [ ] **Step 3: Reconcile the harden-runner claim**

The "Supply-chain hardening" section describes runner hardening. After Task 4 it applies to every workflow. Read the section and correct any wording that implies partial coverage.

```bash
sed -n '283,300p' docs/systems/security-scanning.md
```

- [ ] **Step 4: Add the checklist items this pass surfaced but did not fix**

Append to the `### Outstanding` list. `Secret scanning` and `push protection` are already there; add what is missing:

```markdown
- [ ] Settings → Code security: enable **Secret scanning validity checks**.
      Currently disabled. It asks the provider whether a detected credential is
      still live, which is the difference between an alert and an incident.
- [ ] The five Scorecard checks that are maintainer settings rather than code,
      and therefore cannot be fixed from a pull request: `Branch-Protection`,
      `CII-Best-Practices`, `Code-Review`, `Fuzzing`, `Security-Policy`.
      `Security-Policy` should resolve on its own now that `SECURITY.md`
      documents the testing pipeline; re-check it after the next Scorecard run.
      `Code-Review` reflects commits reaching `main` without a reviewed pull
      request, which is inherent to a single-maintainer repository.
```

- [ ] **Step 5: Check for em dashes in what you added**

```bash
grep -n '—' docs/systems/security-scanning.md
```

Pre-existing hits are out of scope. Any hit on a line you wrote must go.

- [ ] **Step 6: Commit**

```bash
git add docs/systems/security-scanning.md
git commit -m "docs(security): document the dynamic scan and its tuned rules"
```

---

## Task 8: CLAUDE.md correction

**Files:**
- Modify: `CLAUDE.md` (the `Data:` line under Monorepo Structure)

The subsystem-table rows the WS6 brief asks for already exist at `CLAUDE.md:166` and `CLAUDE.md:171`. **Do not add them again.** The only defect is a stale path.

- [ ] **Step 1: Verify the defect before fixing it**

```bash
grep -n "packages/server/data" CLAUDE.md
ls -d data packages/server/data 2>&1
grep -n "dbPath\|uploadDir" packages/server/src/config.ts | head -3
```

Expected: CLAUDE.md claims `packages/server/data/`; that directory does not exist; `config.ts:141` and `config.ts:145` resolve `../../../data/...` from `packages/server/src`, which is the repository root `data/`. `docker-compose.yml` mounts `./data:/app/data` and sets `DB_PATH=/app/data/backspace.db`, which agrees.

- [ ] **Step 2: Correct the line**

Replace:

```
Data: `packages/server/data/` (backspace.db + uploads/)
```

with:

```
Data: `data/` at the repository root (backspace.db + uploads/ + backups/), mounted into the container at `/app/data`
```

- [ ] **Step 3: Add the `dast.yml` mention to the security-scanning row**

The `security-scanning.md` row at line 171 lists the pipeline contents. Add DAST to that list so the routing table stays accurate, and drop the now-false parenthetical about the image scan being in a later plan if the image scan has shipped:

```bash
grep -n "image scan in a later plan" CLAUDE.md
grep -n "trivy\|Trivy" .github/workflows/docker-publish.yml | head -3
```

If `docker-publish.yml` runs the image scan today, the parenthetical is stale. Correct it in the same edit.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: correct the data directory path and the scanning row"
```

---

## Task 9: Pull request and merge

- [ ] **Step 1: Confirm the branch is clean and the untracked plans stayed untracked**

```bash
git status --short
```

Expected untracked, and they must stay that way: `docs/screenshots/additional/`, `docs/screenshots/unused/`, `docs/superpowers/plans/2026-07-13-plan-d-electron-hardening.md`, and the three gitignored security-pass plans. If any of them appears as staged or committed, remove it from the branch before opening the pull request.

- [ ] **Step 2: Check the whole diff for em dashes and for leaked detail**

```bash
git diff main...HEAD | grep -n '^+.*—'
git diff main...HEAD --stat
```

Expected: no em dash hits. Read the stat list and confirm no file outside the eight in the File structure table was touched.

- [ ] **Step 3: Open the pull request**

Title: `security: dynamic scanning, runner hardening, and the public evidence`

Body: what shipped and how each piece was verified. State the two verification limits plainly rather than burying them: `cla.yml` runs from the base branch under `pull_request_target` so its edit is unexercised until after merge, and `docker-publish.yml` is unexercised until the next tag. No vulnerability detail.

- [ ] **Step 4: Watch the DAST run on this pull request**

This is why `dast.yml` carries a `pull_request` trigger on its own paths. The run must appear and go green.

```bash
gh pr checks --watch
gh run download --name zap-baseline-report --dir /tmp/zap-pr && ls /tmp/zap-pr
```

**Do not expect the ignored rules to be absent from the report.** The `-c` rule file changes only the console classification and the exit-code arithmetic; `report.md`, `report.html` and `report.json` are written unfiltered and still contain full entries for 10038 and 10109. Verified 2026-09-03.

Check the **console classification line in the job log** instead, not the report body:

```
FAIL-NEW: 0  WARN-NEW: 5  IGNORE: 2  PASS: 60
```

Expected: `IGNORE: 2` covering 10038 and 10109, and `WARN-NEW: 5` covering 10027, 10049, 10055, 10063 and 90004. If a genuine new finding appears, it is a finding: fix it or record it in the dismissal register with a reason. Do not add it to `rules.tsv` to make the log quiet.

- [ ] **Step 5: Merge**

```bash
gh pr merge <N> --squash --delete-branch
```

No `--subject`. GitHub appends `(#N)` itself.

- [ ] **Step 6: Confirm the post-merge run on `main`**

The `push: branches: [main]` trigger fires a second run. Watch it. A pull request run and a `main` run differ in checkout ref, and this is the first time the `main` path is exercised.

- [ ] **Step 7: Verify the badges render on the rendered README**

Open the repository front page and confirm all seven badges paint, especially Scorecard, which depends on a published run rather than on anything in this branch.

- [ ] **Step 8: Update the master plan**

In `docs/superpowers/plans/2026-09-02-security-pass-master.md`: tick E.1, E.2 and E.3, set the Track E ledger row to merged with the squash SHA as evidence, and add a handoff log entry. That file is gitignored and stays untracked.

---

## Carried forward, deliberately not in this plan

Recorded so the next session does not have to rediscover them.

- **Plan C Task 8 (gated):** flip the CSP from report-only to enforcing. It requires an observation phase on at least two real deployments covering chat, embeds, uploads, federation, and a real voice join with screen share. **When it lands, delete the `10038` line from `.zap/rules.tsv` in the same change.**
- **Track F.2 (gate):** flip WS1 and WS2 scanner enforcement from report-only to blocking, only once nothing is in flight.
- **Repository settings only Jannis can change:** secret scanning, push protection, validity checks, code-scanning merge protection, and adding the security workflow contexts to the `main` ruleset. Task 7 records them; it cannot fix them.
- **`package.json` `engines` says `>=20.0.0`** while Vite 8 requires `^20.19.0`. Correcting it is a coordinated three-file change with the CI matrix leg and the README development section. Out of scope here, and the README section already describes the real requirement correctly.
- **Stale Actions registrations** for `flatpak.yml` and `zz-temp-bundle-rehearsal.yml`, from workflows that no longer exist.
- **Measure before quoting:** the post-merge CodeQL and OSV figures on `main` were predicted from branch measurements and have not been re-measured on `main`.

---

## Self-review

Run against the WS6 spec section (lines 336-360).

| Spec requirement | Task |
|---|---|
| `dast.yml`, ZAP baseline, advisory, ephemeral instance | 1, 2 |
| CI env override, `JWT_SECRET` and `DOMAIN` set, bypass Caddy | 2 (the env file step and naming a single service) |
| README badges plus a security and supply chain section | 5 |
| SECURITY.md security testing section | 6 |
| `security-scanning.md`: workflows, tiered policy, maintainer checklist, public-repo precondition, manual compose image reminder | 7 adds DAST. The rest already exists and was verified on 2026-09-03. |
| CLAUDE.md subsystem rows | Already present. Task 8 corrects a different, real defect instead. |
| Documentation written after the workflows | Tasks 5 through 8 follow Tasks 1 through 4. |

**Deviations from the brief, with reasons:**

1. **"Depends on Track C for the ephemeral rig" is void.** No rig exists and Track C's was cancelled with evidence. Task 1 builds a smaller one from the existing compose file.
2. **ZAP targets `http://backspace:3000` on the compose network, not a published port.** The brief said to point at the container's `:3000` bypassing Caddy, which is exactly what this does. The brief assumed that port would be reachable from the runner; the compose file publishes no ports, so joining the network is the way to reach it.
3. **The marketplace ZAP action is not used.** Its container networking is not controllable, and the target only resolves on the compose network.
4. **Not on every pull request.** Advisory results do not belong in the merge path, and the job builds a full image. Push to `main`, weekly, manual, plus self-testing on its own paths.
5. **Two items were added that the brief did not list:** `harden-runner` on the last two workflows, and the stale data path in CLAUDE.md. Both were surfaced by Track D and have no other home.
