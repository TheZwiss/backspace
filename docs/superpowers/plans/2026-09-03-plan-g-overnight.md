# Plan G: Overnight Autonomous Work

**Goal:** Finish the security pass tail and the two follow-on remediation tracks without the human present.

**Operating rule:** every task here is either fully reversible, or gated behind a
verification I can run myself. **Nothing in this plan publishes anything to users.**
If a task cannot be verified, it stops and records why rather than shipping.

---

## Hard stops. Do NOT do these overnight.

- **1.0.3 is PUBLISHED** (2026-09-03, tag `v1.0.3`, 22 assets, marked Latest).
  Do not edit, re-draft, or touch it.
- **Do not tag a new version or cut 1.0.4.**
- **Do not edit or delete any published release** (this includes fixing v1.0.0's
  body, which is outward-facing and stays for the human).
- **Do not deploy to `<pi-host>`.** It is live, hosts five other services, and has
  real users. The test VM is the only deploy target overnight.
- **Do not force-push, delete branches other than merged security ones, or move tags.**
- **Do not touch `adguard`, `livekit`, or `seelender` on any host.**
- **Do not run `docker system prune -a` or `--remove-orphans` anywhere.**

---

## Task 1: Fix the duplicate-draft race in `release.yml`

**DONE 2026-09-03 — PR #82, open, not merged.** Unverified until the next real tag,
stated in the PR. No throwaway tag was cut.

**This is the highest-value task here.** It cost a manual asset-consolidation on
1.0.3 and will recur on every release until fixed.

**Symptom, observed 2026-09-03:** four matrix jobs each called electron-builder
with `--publish`, all four found no existing draft for the tag, and two of them
created one. Result: two draft releases with the same tag, assets split 12/10
across them, and `gh release view` silently showing only one.

**Fix:** add a `create-release` job that runs before the matrix and creates the
draft once, with the matrix `needs:` it. electron-builder then finds an existing
draft and only uploads.

- [x] Read `.github/workflows/release.yml` fully before editing.
- [x] Add a job that creates the draft release for the tag if absent, using `gh
      release create --draft --notes ""`, guarded so a re-run does not fail on an
      existing draft.
- [x] Make the four `build` matrix jobs `needs: create-release`.
- [x] `actionlint` must pass.
- [x] **Verification without a tag:** this workflow only triggers on `v*`. Do not
      tag to test it. Instead confirm by reading that the job ordering is correct
      and that `gh release create` is idempotent under `|| true` on an existing
      draft. State plainly in the PR that it is unverified until the next real tag.
- [x] Open a PR. Do not merge without CI green.

## Task 2: Cut the container image scan backlog

**DONE 2026-09-03 - PR #83 merged as `29443c42`.** 20 fixable HIGH/CRITICAL down to 3,
measured before and after by rebuilding and rescanning, plus a boot check. Left
report-only: the remaining 3 are the Fastify 4 cluster with no fix in the 4.x line.

Measured 2026-09-03: **20 fixable HIGH/CRITICAL** in the published image. This is
why `docker-publish.yml`'s Trivy scan is still report-only.

- [x] Reproduce the count locally first:
      `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest image --ignore-unfixed --severity HIGH,CRITICAL --scanners vuln ghcr.io/thezwiss/backspace:latest`
      Do not trust the number in this plan; re-measure.
- [x] **Start with `pnpm`.** It is present in the runtime image and contributes
      several findings, even though the final Dockerfile stage never installs it
      and only copies `node_modules` from the deps stage. Find out how it gets
      there. Likely candidates: a `packageManager` field triggering corepack, or
      pnpm's own store landing inside a copied `node_modules`.
- [x] Also present and not reachable by `pnpm.overrides`: `brace-expansion`,
      `ip-address`. These arrive inside pnpm itself rather than through the
      lockfile, so overrides cannot fix them; removing pnpm from the runtime stage
      is what fixes them.
- [x] Any Dockerfile change must be verified by **building the image and
      re-running the scan**, and by `docker compose -p bstest up -d --build --wait backspace`
      plus a `/api/health` 200. A smaller image that does not boot is worse.
- [x] If the count reaches zero fixable HIGH/CRITICAL, flip the image scan to
      blocking in `docker-publish.yml` (`exit-code: '1'`) in the same PR and say so.
      If it does not reach zero, **leave it report-only** and record the remaining
      count with reasons. Do not add blanket `.trivyignore` entries to force it.
- [x] Open a PR per logical change. Do not merge without CI green.

## Task 3: Prepare the CSP enforcement flip, but do not ship it

**DONE 2026-09-03 - PR #84, open, NOT merged, as instructed.** Verified on the test
VM in two halves (report-only baseline then enforcing, same host, same fixtures).
The VM is left running the enforcing build so the flip can be tried live before
the merge decision. The Pi was not touched and still serves report-only 1.0.3.

The observation gate is discharged (three rounds, two deployments, recorded in
`docs/systems/web-security.md`). The flip itself is a real behaviour change.

- [x] Implement the flip on a branch: `Content-Security-Policy-Report-Only` becomes
      `Content-Security-Policy` in `packages/server/src/index.ts`, update
      `packages/server/test/http-security-headers.test.ts`, and update
      `docs/systems/web-security.md` section 7.
- [x] **Delete the `10038` line from `.zap/rules.tsv` in the same commit.** It
      exists only because the policy is report-only; leaving it after the flip
      hides a real regression. This instruction is also in the rule file itself.
- [x] **Verify on the test VM, not by reasoning.** Deploy the branch with
      `./deploy.sh vm`, then re-run the Playwright harness in
      `<scratch>/cspobs/` against it: `observe.mjs`, `observe6.mjs` (authenticated
      render plus upload) and `observe7.mjs` (voice, screen share, RNNoise wasm).
      All three must show zero violations **and** the positive-control run
      (`observe5.mjs`) must still catch its two injected violations, otherwise the
      detector is broken and the result means nothing.
- [x] Remember `page.evaluate` bypasses CSP via CDP. Probes must go through
      DOM-inserted scripts. This already produced one false pass.
- [x] **Open the PR but DO NOT MERGE.** Enforcing CSP ships to self-hosters; that
      is a human decision. Leave it as a reviewed, verified, ready-to-merge branch.

## Task 4: Close out the pass bookkeeping

**DONE 2026-09-03.** Issue #38 was already closed with a complete answer that already
names the Gatekeeper step, so no comment was added. `git branch -r --merged` misses
squash merges and would have stranded 3 of the 6 dead branches; each was verified by
PR state instead. Tip SHAs are recorded in the master plan handoff entry.

- [x] Comment on issue #38 that the signing fix shipped in 1.0.1 and has held
      through 1.0.2 and 1.0.3, naming the one-time Gatekeeper step. Close it.
      **Behavioural description only, no exploit detail.**
- [x] Delete merged remote security branches. Verify each is merged into `main`
      first with `git branch -r --merged origin/main`. Do not delete anything not
      in that list. The local `security-scanning-hardening` branch may also go.
- [x] Update `docs/superpowers/plans/2026-09-02-security-pass-master.md`: mark the
      release map row for 1.0.3, add a handoff entry per task completed here.
      That file is gitignored and stays untracked.

## Task 5: Scope the deferred dependency upgrades. Do not perform them.

**DONE 2026-09-03.** `docs/superpowers/plans/2026-09-03-deferred-dependency-upgrades.md`,
508 lines, untracked. No dependency, lockfile or branch touched.

The 13 deferred OSV findings expire **2026-12-01** and will turn `main` red.

- [x] For each of `fastify` 4 to 5, `@fastify/static` 7 to 10, `find-my-way` 8 to 9,
      `react-router` 6 to 7, `electron` 40 to 41: read the upstream migration guide
      and write down what breaks in **this** codebase, with file paths and counts
      (how many route registrations, how many `<Route>` usages, and so on).
- [x] Write the findings into a new plan document for the human to review.
- [x] **Do not start any of these upgrades.** They are high blast radius and want a
      human in the loop. This task produces a document, not a diff.

---

## Reporting

Leave a single summary at the end covering: what merged, what is open as a PR and
why it was not merged, what was attempted and abandoned with the reason, and any
new finding. Be explicit about anything unverified. Do not report a task as done
when its verification was skipped.
