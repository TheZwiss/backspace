# Federation and DM Security Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven confirmed security vulnerabilities surfaced by the Codex review on the `BadAtCaptchas/backspace` fork, verified against our current `security-scanning-hardening` branch.

**Architecture:** Each vulnerability is an independent fix landing as its own commit with a regression test. Four are direct ports of the fork's fix (re-ported to our modularized layout). Three need our own design work because the fork's fix either breaks a legitimate flow or misses the root cause. The two federation-attribution PRs (#6 and #8) are a single workstream.

**Tech Stack:** Fastify 4, Drizzle ORM, better-sqlite3, Vitest. Server package: `packages/server`. Web package: `packages/web`.

## Global Constraints

- Node pinned to `>=20 <21`. Local Node may be newer and break better-sqlite3 under vitest; use the project's Node 20 recipe when running server tests (see memory `running-server-tests-node`).
- Federation is a semi-trusted, HMAC-peered model. Peers are admin-approved but not fully trusted. Fixes must not assume peers are honest.
- Never assume a single global user ID. Resolve federated identity correctly (`resolveLocalUser` / `resolveOrCreateReplicatedUser` / `homeUserId`+`homeInstance`).
- The fork PR diffs are written against the pre-refactor monolithic `federation.ts`. Our tree is modular (`routes/federation/handlers/`, `routes/federation/identity.ts`, `routes/federation/events/`). Every change is re-ported, never merged.
- Update the relevant `docs/systems/*.md` when a fix changes documented behavior (auth, federation, dm-system).
- One vulnerability per commit. Each commit includes its regression test.
- Do not put vulnerability detail in public GitHub artifacts. The reporter has been routed to private advisories.

---

## Sequencing rationale

Order is by severity and by risk-reduction speed. The four clean ports (Tasks 1 to 4) land first because they are low-risk, high-value, and each removes a live exploit. The two design-heavy federation tasks (Task 5) and the migration-bearing password task (Task 6) come next. The conditional, non-default-only outbox issue (Task 7) is last.

- Task 1: PR #7  federated stub takeover (auth)            high to critical
- Task 2: PR #5  cross-DM reply IDOR (dm)                   high
- Task 3: PR #9  local-only DM plaintext relay (federation) high
- Task 4: PR #11 DM-call LiveKit token broadcast (voice)    high
- Task 5: PR #6 + #8 relay attribution and peer binding     high
- Task 6: PR #3  home password sent to remote (web + auth)  medium
- Task 7: PR #10 outbox-created pending peers (federation)  medium to low

Not in this plan: PR #4 (already fixed upstream in `85e1975f`), PR #12 (false positive, intended design). Both should be closed/declined on the fork, not implemented here.

---

### Task 1: PR #7 — remove the anonymous federated-stub upgrade path

**Vulnerability:** Public, unauthenticated `POST /api/auth/register` looks up an existing federation-replicated stub by caller-supplied `homeUserId` (matched on the column value alone, ignoring `homeInstance`), overwrites its credentials, and mints a JWT for the victim's replicated identity. No proof of control. Enabled by default (`federatedRegistrationOpen` defaults on). This is account takeover of any unclaimed federated stub.

**Files:**
- Modify: `packages/server/src/routes/auth.ts` (the stub-upgrade block, around lines 131-190; drop the now-unused `findFederatedUser` import, keep `extractDomain`)
- Modify: `docs/systems/auth.md` (remove the "federated stub upgrade" flow description, around lines 141, 196, 224, 234)
- Modify: `docs/systems/federation.md` (any reference to the register-time stub upgrade)
- Test: `packages/server/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: existing `resolveLocalUser`, the register handler request shape.
- Produces: no new exports. Register with a colliding `homeUserId` now creates a fresh row and leaves the stub untouched.

- [ ] **Step 1:** Write a failing test in `auth.test.ts`: seed a federation-replicated stub (`passwordHash = '!federation-replicated'`) with a known `homeUserId`, then POST `/api/auth/register` with a federated payload carrying the same `homeUserId`. Assert the response creates a NEW user id (not the stub id) and that the stub row is unchanged (same `passwordHash`, `username`).
- [ ] **Step 2:** Run it. Expected: FAIL (current code upgrades the stub and returns its id).
- [ ] **Step 3:** Delete the stub-upgrade block from the register handler so federated registrations fall through to the normal create-new-row path. Remove the unused `findFederatedUser` import.
- [ ] **Step 4:** Run the full `auth.test.ts` file. Expected: PASS, including the existing federated-registration tests (they should still create separate rows).
- [ ] **Step 5:** Update `auth.md` and `federation.md` to state that stub merges only happen through the authenticated, S2S-proof-gated reattach flow (`POST /api/users/@me/reattach`), never through public registration.
- [ ] **Step 6:** Commit: `fix(auth): remove anonymous federated stub upgrade path (account takeover)`

**Follow-up (out of scope, note in commit body):** legitimate users who already have a stub now get a duplicate row sharing a `homeUserId` until they reattach. Wiring fresh federated registration to the proof-gated reattach primitive for DM-history continuity is a separate enhancement.

---

### Task 2: PR #5 — validate DM reply targets belong to the same channel

**Vulnerability:** `replyToId` on a DM message is never checked to belong to the destination DM channel. An attacker in DM-A sets `replyToId` to a message id in a private DM-B they are not in; reply hydration returns that message's content and author to DM-A. Four unguarded paths: single-message hydration (`dm.ts:163`), batch hydration (`dm.ts:2283-2286`), REST create (`dm.ts:2455-2489`), WS create (`events.ts:836-892`, insert at 889).

**Files:**
- Modify: `packages/server/src/routes/dm.ts` (hydration filters at :163 and :2283-2286; create validation in `POST /api/dm/:id/messages`)
- Modify: `packages/server/src/ws/events.ts` (validate `replyToId` in `handleDmMessageCreate` before insert)
- Test: `packages/server/src/routes/dm.replyAuthorization.test.ts` (new)

**Interfaces:**
- Consumes: `and`, `eq` from drizzle (already imported in both files), existing `getDmMessageWithUser`.
- Produces: create paths return `400 Invalid reply target` when `replyToId` does not resolve to a message in the destination channel.

- [ ] **Step 1:** Write a failing test: seed attacker DM-A (attacker is a member) and a separate private DM-B (attacker is not). Create a message in DM-B. Then POST to DM-A with `replyToId` = DM-B message id. Assert `400 Invalid reply target` and that no message is persisted. Add a second case asserting cross-channel `replyToId` is not hydrated even if a poisoned row somehow exists (filter defense).
- [ ] **Step 2:** Run it. Expected: FAIL (current code accepts and hydrates cross-DM replies).
- [ ] **Step 3:** Add create-time validation on both REST and WS create paths: look up `replyToId` scoped to the destination `dmChannelId`; if absent, reject with `400` (REST) or WS error (WS), do not insert or broadcast.
- [ ] **Step 4:** Add `dmChannelId` equality to both hydration queries (single at :163, batch at :2283) as defense in depth for any historical poisoned rows.
- [ ] **Step 5:** Run the new test. Expected: PASS. Confirm the federation inbound DM path still hard-sets `replyToId: null` (`routes/federation/events/dmMessages.ts:134`) so no change is needed there.
- [ ] **Step 6:** Commit: `fix(dm): validate reply target belongs to same DM channel (cross-DM IDOR)`

---

### Task 3: PR #9 — stop broadcasting local-only DMs to all peers

**Vulnerability:** `getGroupDmTargetOrigins()` returns `undefined` when a DM has no remote participants (`federationOutbox.ts:430`). `queueOutboxEvent` treats `undefined` as broadcast-to-all-peers (`:168`). So a purely local DM between two same-instance users relays its plaintext content and participant profiles to every peered instance. Reachable unguarded on the main WS send path (`events.ts:911`) and edit/delete/reaction/read-state paths.

**Files:**
- Modify: `packages/server/src/utils/federationOutbox.ts` (return `[]` instead of `undefined` at :430; fix the doc comment)
- Test: `packages/server/src/utils/federationOutbox.state.test.ts`

**Interfaces:**
- Consumes: existing `queueOutboxEvent` semantics (`[]` is truthy, enters the targeted-filter branch, matches zero peers, no-ops at :265).
- Produces: `getGroupDmTargetOrigins` never returns `undefined`. The intentional `undefined == broadcast` callers (`federationPresence.ts:53`, `users.ts:560`) are unaffected because they pass `undefined` literally.

- [ ] **Step 1:** Write a failing test: with at least one active peer present, queue a DM `create` event for a group DM whose participants are all local. Assert `getGroupDmTargetOrigins` returns `[]` and that `queueOutboxEvent` writes zero outbox rows for the unrelated peer.
- [ ] **Step 2:** Run it. Expected: FAIL (currently returns `undefined`, broadcasts, writes rows).
- [ ] **Step 3:** Change the local-only early return from `return undefined` to `return []`. Update the comment to document that `[]` suppresses relay while `undefined` means broadcast.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(federation): suppress relay for local-only DMs instead of broadcasting to all peers`

**Optional cleanup (fold into this commit if trivial):** tighten the `getGroupDmTargetOrigins` return type to `string[]` since `undefined` is no longer produced.

---

### Task 4: PR #11 — scope DM-call LiveKit tokens to recipient peers

**Vulnerability:** On DM call start, `sendFederatedCallStart` mints LiveKit join tokens for all members (`events.ts:1888-1893`) and broadcasts the relay, including the full token map, to every active peer (`events.ts:1968-1977`), not just peers hosting a DM member. Also relays local-only calls. Tokens are bearer JWTs signed with our LiveKit secret granting `roomJoin`/`canPublish`, so a peered instance can join and eavesdrop or publish into a private call.

**Files:**
- Modify: `packages/server/src/ws/events.ts` (`sendFederatedCallStart`: early-return on no remote members; per-recipient-peer token minting; deliver only to targeted peers)
- Test: `packages/server/src/ws/events.callStartUndeliverable.test.ts`

**Interfaces:**
- Consumes: `generateFederatedCallToken`, `buildRelayEvent`.
- Produces: `buildRelayEvent(recipientMembers)` mints tokens only for that peer's members. `targetedPeers` carries member objects, not just ids. `affectedUserIds` maps from those member buckets.

- [ ] **Step 1:** Write two failing tests: (a) a local-only DM call emits zero federation relays; (b) in a two-remote-peer call, each peer's relay contains tokens only for its own members, not the other peer's members, and no relay goes to peers hosting no DM member.
- [ ] **Step 2:** Run them. Expected: FAIL (currently broadcasts all tokens to all peers, relays local-only calls).
- [ ] **Step 3:** Add `if (remoteMembers.length === 0) return;` after `federatedId` is computed and persisted. Change `targetedPeers` to `Map<origin, members[]>`. Build per-peer relay payloads with `buildRelayEvent(recipientMembers)` minting tokens only for that peer's members. Delete the all-peers broadcast loop. Keep the non-secret `participants` roster list going to all targeted peers. Update `affectedUserIds` to map from member buckets.
- [ ] **Step 4:** Run the tests. Expected: PASS. Confirm multi-peer group calls still work (each peer needs only its own member's token to join the shared room).
- [ ] **Step 5:** Commit: `fix(voice): scope federated DM-call tokens to recipient peers, suppress local-only relay`

---

### Task 5: PR #6 + #8 — bind relay source to authenticated peer and fix attribution

**Vulnerability (two layers):**
1. Inbound `/api/federation/relay` never checks that `body.sourceInstance` matches the HMAC-authenticated `peer.origin` (`handlers/relay.ts:163-169`). Any active peer can claim `sourceInstance = nova.ddns.net` and impersonate a third instance.
2. `verifyAttribution` (`identity.ts:50-57`) has a "homeward-relay" branch (`authorDomain === getOurOrigin()`) that accepts any event claiming a locally-homed author regardless of which peer signed it, letting a peer forge events attributed to our own local users. The 1-on-1 DM handler amplifies this by auto-creating channels on demand from the pair of home user ids without checking the signing peer is a party (`events/dmMessages.ts:91-94`).

**Why not a straight port:** The fork's fix for layer 2 (delete the homeward branch) breaks legitimate client-federation, where a user logged into `orbit` acting on their `nova` home identity produces a relay with `homeInstance=nova, sourceInstance=orbit` that the homeward branch is what accepts. So layer 1 is a clean adopt; layer 2 needs contextual authorization, not deletion.

**Files:**
- Modify: `packages/server/src/routes/federation/handlers/relay.ts` (add the source-to-peer binding check)
- Modify: `packages/server/src/routes/federation/identity.ts` (`verifyAttribution` and/or its callers)
- Modify: `packages/server/src/routes/federation/events/dmMessages.ts` (guard on-demand channel creation by peer involvement)
- Modify: `docs/systems/federation.md` (correct the attribution guarantee wording, section 3)
- Test: `packages/server/src/routes/federation.attribution.test.ts` and a relay-handler binding test

**Interfaces:**
- Consumes: `normalizeOriginForCompare` (`utils/federationAuth.ts:214`), `authenticateS2SPeer` result (`peer.origin`), `getOurOrigin`.
- Produces: `/relay` returns `403` when `normalizeOriginForCompare(body.sourceInstance) !== normalizeOriginForCompare(peer.origin)`. Attribution for locally-homed authors additionally requires the signing peer to be a genuine participant-instance of the target resource.

- [ ] **Step 1 (layer 1, the safe binding):** Write a failing test: an authenticated peer X POSTs `/api/federation/relay` with `body.sourceInstance` set to a different instance Y. Assert `403`.
- [ ] **Step 2:** Run it. Expected: FAIL (currently accepted).
- [ ] **Step 3:** In `handlers/relay.ts`, right after `sourceInstance` is validated as non-empty, reject with `403` when it does not normalize-equal the authenticated `peer.origin`. Pass through only on match.
- [ ] **Step 4:** Run it. Expected: PASS. Run the existing attribution and epoch tests to confirm no regression on honest same-origin relays.
- [ ] **Step 5:** Commit: `fix(federation): bind relay sourceInstance to authenticated peer (instance impersonation)`
- [ ] **Step 6 (layer 2, contextual attribution):** Write a failing test: an authenticated peer relays a `dm_message` whose author `homeInstance` equals our own origin, for a 1-on-1 DM the peer is not a party to. Assert the event is rejected and no channel is auto-created. Add a passing-case test: a genuine client-federation homeward relay (peer is a participant-instance) is accepted.
- [ ] **Step 7:** Run them. Expected: the forgery case FAILs to reject (currently accepted via the homeward branch); the legit case should pass.
- [ ] **Step 8:** Replace the blanket homeward branch with a contextual check: a locally-homed author is only accepted when the signing peer is an actual participant-instance of the resource. In `events/dmMessages.ts`, do not auto-create a 1-on-1 channel from a homeward relay when the signing peer is not a party. Reuse existing membership/participant lookups; resolve identity via `homeUserId`+`homeInstance`.
- [ ] **Step 9:** Run both tests plus the full federation suite. Expected: PASS. Manually verify the homeward flow against a live 3-instance client-federation DM before considering this done (see verification note).
- [ ] **Step 10:** Update `federation.md` section 3 to describe the source-to-peer binding and the participant-instance requirement.
- [ ] **Step 11:** Commit: `fix(federation): require peer involvement for locally-homed relay attribution (identity forgery)`

**Verification note:** Layer 2 is the highest-risk change in this plan because it sits on the client-federation homeward path. Do not merge on unit tests alone. Stand up two instances (or use the throwaway VM per memory `kobold-test-vm`), create a client-federated account, and confirm messages authored on the remote still deliver to the home instance.

---

### Task 6: PR #3 — stop sending the home password to remote instances

**Vulnerability:** The web client verifies the entered password against the home instance, then reuses that same plaintext password for the remote instance's `/auth/register` and `/auth/login` (`instanceStore.ts:312, 354, 373, 381`). A hostile remote operator captures the user's reusable home credential pre-hash.

**Why not a straight port:** The fork's fix (per-remote random secret, stored home-server-side via a new `user_federation_credentials` table and `GET/PUT /api/users/@me/federation-credential`) is the right architecture, but it bricks already-connected federated accounts: existing remotes were provisioned with `bcrypt(homePassword)`, so after the change their token expiry triggers a reauth that logs in with the new random secret and fails with no recovery path.

**Files:**
- Modify: `packages/web/src/stores/instanceStore.ts` (`connectToRemote`, `reauthenticateInstance`; add `generateRemoteSecret`, cached `remoteSecret`)
- Modify: `packages/web/src/stores/authStore.ts` (drop `changePasswordOnRemotes`)
- Create: server migration for `user_federation_credentials` (follow the fork's migration 0011 shape; verify next migration number in `packages/server/src/db/`)
- Modify: `packages/server/src/routes/users.ts` (add authenticated `GET/PUT /api/users/@me/federation-credential`, scoped to `request.userId`, PUT first-writer-wins via `onConflictDoNothing` + re-read)
- Modify: `packages/web/src/components/.../ConnectedInstances.tsx`, `JoinPage.tsx`, `JoinSpace.tsx` (copy clarifying that the entered password is verified locally only)
- Modify: `docs/systems/auth.md`, `docs/systems/client-federation.md`, `docs/systems/database.md` (new table)
- Test: server route test for the credential endpoints; web build

**Interfaces:**
- Consumes: existing `api.users.verifyPassword`, `authenticate` middleware.
- Produces: `generateRemoteSecret()` (32-byte CSPRNG). Per-remote secret persisted home-server-side and reused on reconnect. Home login path (`targetIsHome`) still uses the real entered password.

- [ ] **Step 1:** Write a failing server test for `PUT /api/users/@me/federation-credential`: authenticated write, then `GET` returns it; a concurrent second write does not overwrite (first-writer-wins); unauthenticated request is rejected.
- [ ] **Step 2:** Run it. Expected: FAIL (route does not exist).
- [ ] **Step 3:** Add the migration and the two authenticated routes scoped to `request.userId`.
- [ ] **Step 4:** Run the server test. Expected: PASS. Also run `tsc --noEmit` for the server package (the fork author skipped server typecheck).
- [ ] **Step 5:** In `instanceStore.ts`, add `generateRemoteSecret` and route non-home register/login through a cached-or-generated per-remote secret; persist it home-server-side before registration. Keep the home path on the real password. Update the three UI copy strings.
- [ ] **Step 6 (the migration gap the fork missed):** Add a recovery path so pre-existing remotes do not brick. On `DifferentPasswordError` during a federated reauth, prompt once for the old home password, log into the remote with it, rotate that account's password to the generated secret, then persist. Remove the now-dead `pendingPasswordSync` machinery.
- [ ] **Step 7:** Run `pnpm --filter @backspace/web build` and the server tests. Expected: PASS.
- [ ] **Step 8:** Update `auth.md`, `client-federation.md`, `database.md`.
- [ ] **Step 9:** Commit: `fix(federation): use per-remote generated secret instead of home password for remote auth`

---

### Task 7: PR #10 — make outbox peer creation gate-aware

**Vulnerability:** User-triggered `queueOutboxEvent` inserts a `federation_peers` row with `status: 'pending'` for any unknown target origin (`federationOutbox.ts:189-207`). Both the outbound worker (`resolvePendingPeers`) and the inbound `/peer/accept` gate (`peerHandshake.ts:315-355`) then treat that row as admin-initiated and activate it, defeating manual peering approval. Only exploitable when `auto_accept_peering = 0` (non-default; default is 1). The fork's blunt "skip unknown targets" fix regresses legitimate outbound-first peering bootstrap on the default config.

**Root cause:** user-created `pending` rows are indistinguishable from admin-initiated (`/peer/initiate`) ones.

**Files:**
- Modify: `packages/server/src/utils/federationOutbox.ts` (gate placeholder creation on `autoAcceptPeering`; tag provenance)
- Modify: `packages/server/src/routes/federation/.../peerHandshake.ts` (do not treat a user-origin `pending` row as proof of admin initiation)
- Possibly modify: `packages/server/src/db/schema.ts` (add a provenance column to `federation_peers`, e.g. `initiatedBy` 'admin' | 'outbox') plus migration
- Test: `packages/server/src/utils/federationOutbox.state.test.ts` and a peerHandshake test

**Interfaces:**
- Consumes: `config.autoAcceptPeering` (`schema.ts:331`, default 1), existing `ensurePeered`.
- Produces: placeholder peer rows are created only when `autoAcceptPeering = 1` or a matching admin-initiated row exists; the inbound accept gate distinguishes admin-initiated from outbox-created rows.

- [ ] **Step 1:** Write a failing test: with `autoAcceptPeering = 0`, queue an outbox event targeting an unknown attacker origin. Assert no `federation_peers` row is created and no outbox row is written. Add a second test: with `autoAcceptPeering = 1`, the placeholder is still created (legit outbound-first bootstrap preserved).
- [ ] **Step 2:** Run them. Expected: FAIL (current code creates the pending row regardless of config).
- [ ] **Step 3:** Add a provenance column to `federation_peers` and a migration. Gate placeholder creation in `queueOutboxEvent` on `autoAcceptPeering`; when `0`, skip creation (log and fall back to the mutation log for later replay). Tag outbox-created rows as `initiatedBy: 'outbox'`.
- [ ] **Step 4:** In `peerHandshake.ts`, change the inbound `/peer/accept` gate so a `pending` row only counts as admin approval when `initiatedBy = 'admin'`.
- [ ] **Step 5:** Run both tests plus the federation worker tests. Expected: PASS. Confirm default-config (`autoAcceptPeering = 1`) first-DM-to-new-origin peering still bootstraps.
- [ ] **Step 6:** Commit: `fix(federation): gate outbox peer creation on autoAcceptPeering and tag provenance`

---

## Self-Review

**Spec coverage:** All seven confirmed vulnerabilities have a task (Tasks 1 to 7). PR #4 and #12 are explicitly excluded with reasons. The two already-merged fork PRs (#1 SSRF, #2 invite bypass) are confirmed already present upstream and need no task.

**Placeholder scan:** Tasks 1 to 4 reference exact file:line targets and known-good fixes from the verified findings. Tasks 5 to 7 specify the design decision explicitly (contextual attribution, migration recovery path, config gate plus provenance) rather than deferring with "handle appropriately." Where full code is not inlined it is because the executing agent must read the current file and write the failing test first; each such step names the exact function and the exact condition to implement.

**Type/name consistency:** `normalizeOriginForCompare`, `getGroupDmTargetOrigins`, `queueOutboxEvent`, `sendFederatedCallStart`, `verifyAttribution`, `autoAcceptPeering`, `generateRemoteSecret` are used consistently across tasks and match the verified source locations.

**Highest-risk task:** Task 5 layer 2 (relay attribution) touches the client-federation homeward path and must be verified live, not on unit tests alone. Tasks 3 and 4 are the safest, fastest risk reductions and could ship first if a partial rollout is wanted.
