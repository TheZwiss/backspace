# Federation System (Server-to-Server)

> **Companion spec:** This document covers **S2S (server-to-server)** federation — the relay protocol, HMAC auth, identity resolution, and background workers. For the **client-side** multi-instance architecture (how the web/desktop app connects to multiple instances, federated account creation, origin-aware routing), see [`client-federation.md`](client-federation.md). Both systems work together.

Source files:
- `packages/server/src/routes/federation.ts` -- **Barrel** for the federation route subsystem. Re-exports the public API (identity resolution, event processors, reconciliation, `validateOrigin`) so `from '.../routes/federation.js'` imports resolve unchanged, and composes the HTTP registrars into `federationRoutes()`. The implementation lives in `routes/federation/` (split out of the former single 7.6k-line file; see `docs/superpowers/specs/2026-07-10-federation-ts-split-design.md`):
  - `routes/federation/rateLimits.ts` -- In-memory sliding-window rate limiters (accept/relay/lookup/ensure) + replay-nonce store + eviction timers
  - `routes/federation/origin.ts` -- `validateOrigin`, `resolveLocalOrigin`, `sanitizePeer` (+ `SanitizedPeer` shape)
  - `routes/federation/identity.ts` -- Federated identity resolution: `extractDomain`, `getOurIdentityDomain`, `attributionRefusal`, `localUserStandingOnPeer`, `resolveRelayActor`, `resolveLocalUser`, `findFederatedUser`, `resolveOrCreateReplicatedUser`, `backfillHomeUserId`
  - `routes/federation/dmChannels.ts` -- DM message payload builder, `resolveLocalDmMessage`, `isUrlFromPeer` (1-on-1 find-or-create is `findOrCreateOneOnOne` in `utils/dmConversation.ts`)
  - `routes/federation/profile.ts` -- Replicated-profile hydration + asset download, `processProfileUpdateEvent`, `backfillReplicatedProfileAssets`
  - `routes/federation/reconciliation.ts` -- DM federated-id reconciliation + dead-incarnation artifact sweeps (worker-facing maintenance)
  - `routes/federation/events/*.ts` -- Inbound relay event processors, grouped by domain: `dmMessages`, `membership`, `friends`, `calls`, `dmState` (presence/read-state/close/reopen/file-rejected), and `dispatch` (`processRelayEvents`, the fan-out entry point shared by the HTTP relay handler and the initial-sync worker)
  - `routes/federation/handlers/*.ts` -- Fastify route registrars, grouped by endpoint concern: `peerHandshake` (initiate/accept/ensure/rotate/denied), `peerAdmin` (peer list/CRUD/reset/recheck/rotate), `approvals` (approval queue + peering subscriptions/notifications + approve/deny helpers), `relay` (identity delete, relay, epoch, sync), `lookup` (user lookups), `attach` (verify-attach-proof, `/api/users/@me/reattach`)
    - `routes/federation/handlers/s2sAuth.ts` -- `authenticateS2SPeer(request, reply, opts?)`: the shared inbound S2S-HMAC auth preamble (parse headers → resolve active peer → optional per-peer rate limit **before** signature → verify HMAC signature → nonce replay). Adopted by the six endpoints whose preamble is byte-identical: `DELETE /identity`, `POST /relay`, `POST /sync` (`relay.ts`), `POST /users/lookup`, `POST /users/by-home-id` (`lookup.ts`), and `POST /verify-attach-proof` (`attach.ts`). Returns `{ ok: true, peer, nonce }` or, having already sent the rejection reply, `{ ok: false }` (caller must `return`). **Intentional non-adopters** (each keeps a load-bearing gate the helper would flatten, documented in its own docstring/comment): `POST /epoch` (revoked-only gate for peer recovery, 400 on missing headers, no nonce check), `POST /peer/rotate` (active-only, no nonce check), `POST /peer/denied` (`awaiting_approval` gate, synthetic no-grace secret verify).
- `packages/server/src/utils/federationAuth.ts` -- HMAC signing, verification, header parsing, `getOurOrigin()`
- `packages/server/src/utils/federationFetch.ts` -- The outbound path for peer-addressed requests: origin trust levels (`approved` / `asserted`), origin format checks, no redirect following. See §1b.
- `packages/server/src/utils/federationOutbox.ts` -- Event queuing (which peers), relay payload construction, mutation log, participant/target resolution
- `packages/server/src/utils/federationOutboxQueue.ts` -- Outbox queues: queue keys, fold rules, offered marking, queue heads, expiry by queue, boot key backfill
- `packages/server/src/utils/federationLookup.ts` -- HMAC-signed remote-user lookups: `lookupRemoteUser` (by username) and `lookupRemoteUserByHomeId` (reverse lookup, used by the stub backfill and `resolveRemoteIdentityForClient`)
- `packages/server/src/utils/federationPresence.ts` -- S2S presence relay: `queuePresenceRelay`, `snapshotPresenceForPeer` (relationship-scoped), `markPeerStubsOffline`
- `packages/server/src/utils/federationStubBackfill.ts` -- Asks a user's home about the rows homed there (`/users/by-home-id`) and applies the answer: `scheduleHomeRecordPull` when a row is created, `backfillStubUsernamesForPeer` on peer activation (placeholder names, pre-1.8 `_<n>` names, rows without a profile version)
- `packages/server/src/utils/federationClientIdentity.ts` -- `resolveRemoteIdentityForClient`: resolves a `homeUserId` + `homeInstance` pair a local client names in a DM route, asking the home for the username on first contact
- `packages/server/src/routes/federation/stubName.ts` -- How rows of users homed elsewhere are named: `isPlaceholderNamedStub` / `renamePlaceholderNamedStub` / `applyPlaceholderRename` / `announceUserUpdated` (the rename by relayed hints), `applyHomeHandle` (the rename by the home's answer), `claimHandleName` (a federated account's name, see "Account names"), `firstFreeUsername` (the suffix rule creation and rename share), `relayHandleOf` (the handle every relayed snapshot carries)
- `packages/server/src/utils/federationWorker.ts` -- Background workers: outbox delivery, file download, health check, janitor, initial sync
- `packages/server/src/utils/storageJanitor.ts` -- Federation GC: outbox expiry, mutation log retention, file queue cleanup, DM channel purge
- `packages/server/src/routes/social.ts` -- Friend request/accept/cancel/remove endpoints that queue federation events
- `packages/server/src/routes/dm.ts` -- DM REST endpoints that queue federation events (message relay, group lifecycle)
- `packages/server/src/ws/events.ts` -- WebSocket event handlers that queue DM message/reaction relay events
- `packages/web/src/utils/profileSync.ts` -- Client-side profile sync via LWW timestamps (not S2S relay)
- `packages/web/src/utils/identity.ts` -- Client-side federated identity resolution helpers

DB tables: `federation_peers`, `federation_outbox`, `federation_file_queue`, `federation_mutation_log`, plus `users` (identity), `dm_channels`/`dm_members`/`dm_messages` (DM federation), `friends`/`friend_requests` (friend federation), `attachments` (file replication).
See `docs/systems/database.md` for full schemas.

---

## Architecture Overview

Backspace federation is peer-to-peer with no central authority. Each instance maintains its own copy of all data. Peers exchange real-time events for DMs and friendships via a signed relay protocol.

**Canonical identity:** The `(homeUserId, homeInstance)` pair is globally unique. Local users have `homeInstance = NULL` and `homeUserId = NULL`. Federated users are represented as **replicated user stubs** -- minimal user records with `passwordHash = '!federation-replicated'` (bcrypt never produces this value, so login is impossible).

**Trust model:** Symmetric shared-secret HMAC. Both peers share the same 256-bit secret. Events are attributed to users by `homeUserId + homeInstance` in the payload, with authority checks verifying the source instance matches the claimed origin of the acting user.

---

## 1. Peer Handshake & Discovery

### 2-Phase Flow

**Phase 1 -- Initiate** (`POST /api/federation/peer/initiate`)
- Auth: JWT + admin role required
- Validates `remoteOrigin` is a well-formed HTTP(S) URL via `validateOrigin()`
- Prevents self-peering (`localOrigin === remoteOrigin`)
- Claims the origin (`claimAdminHandshake`) and prepares the row with `prepareAdminHandshakeRow`: an `active` or `unreachable` row returns 200 with the peer; a `pending` row local traffic created (`initiated_by = 'auto'`) is claimed for the admin, keeping its secret and queued entries; any other `pending` row or an `awaiting_approval` row answers 409; a `revoked`, `rejected` or `needs_attention` row is replaced by a fresh `pending` row with a new 256-bit secret (`generateHmacSecret()`)
- POSTs to `{remoteOrigin}/api/federation/peer/accept` with `{ sourceOrigin, hmacSecret, instanceName, instanceId }` (10-second timeout) and settles the row from the answer as every sender does: see [Sending a handshake](#peer-state). Replies: 200 `{ peer, verified: true }` when this handshake activated a verified peering; 200 `{ peer }` when the row was already active; 200 `{ peer, verified: false }` for `needs_attention` / `repeer_incomplete`; 202 `{ peer }` for `awaiting_approval`; 409 `{ code: 'PEER_EXISTS_RESET_REQUIRED', peer }` when the row is parked on the remote's older peering; 502 for a refusal or another failure; 504 on a timeout. On a failure a row this request created is removed unless entries were queued on it, and a claimed row goes back to local traffic with the attempt counted.

**Phase 2 -- Accept** (`POST /api/federation/peer/accept`)
- Auth: **none** (first contact -- no JWT, no HMAC)
- Rate-limited: 10 requests per minute per IP (in-memory sliding window, buckets cleaned every 60s)
- Validates `sourceOrigin`, `challenge`, `hmacSecret`, and (optional) `instanceName` from body
- Answers from our row's state, provenance and the auto-accept setting (`decideInboundHandshake`): see [Answering a handshake](#peer-state). An established peering (`active`, `unreachable`, `needs_attention`) is never re-keyed here; its answer is `409 PEER_EXISTS_RESET_REQUIRED`, and epoch-mismatch reset detection (`markPeerReset`) runs before it
- Returns `{ accepted: true, instanceName: <ourName | null>, instanceId: <ourEpoch> }` on activation; the refusal is 409 `{ accepted: false, code: 'PEER_EXISTS_RESET_REQUIRED', error, instanceName, instanceId }`. See "Instance name & epoch exchange" and "Trust re-establishment contract" below

### Instance name & epoch exchange

The handshake is bidirectional for two pieces of metadata: the `instance_name` label rendered in the federation panel and in DM-call toasts (`peerLabel`), and the **instance epoch** (`instance_id`, this instance's persistent incarnation UUID minted by `ensureDefaults`, accessed via `getInstanceId()`). The epoch is the authenticated baseline used by the instance-epoch self-healing feature to detect a wipe-and-reinstall on the same domain (design: `docs/superpowers/specs/2026-07-01-federation-instance-epoch-self-healing-design.md`).

- **Initiator → responder:** the request body to `/peer/accept` carries `{ sourceOrigin, hmacSecret, instanceName, instanceId }`. The responder reads `instanceName` → `federation_peers.instance_name` and `instanceId` → `federation_peers.peer_instance_id` on every state-mutating activation path: `pending → active`, `awaiting_approval → active` (token-valid and autoAccept-fallback), `rejected → active` (override), and new-peer create. The existing-peer refusal path for already-`active` and `needs_attention` peers (now an honest `409 PEER_EXISTS_RESET_REQUIRED`, see "Trust re-establishment contract") does NOT overwrite — same security posture that already refuses to overwrite `hmac_secret` on these paths from an unauthenticated request. (The idempotent guard's *detection* of a changed epoch on that path is a later part of the self-healing feature; the handshake itself only writes the epoch on true activation.)

- **Responder → initiator:** the `/peer/accept` response body is `{ accepted: true, instanceName: <ourName | null>, instanceId: <ourEpoch> }`. The initiator (`performHandshake` in `utils/federationPeering.ts`, `/peer/initiate`, and both `/approval-requests/:id/approve` handlers in `routes/federation.ts`) parses `instanceName` and `instanceId` and persists them alongside the `status='active'` write (`peer_instance_id`). Older peers that omit either field are tolerated — the respective column stays `null` (backstopped later by the deterministic epoch-refresh and relay-envelope population). Non-JSON bodies are tolerated defensively.

All four outbound `/peer/accept` senders (`performHandshake`, `/peer/initiate`, and the inbound + outbound `/approve` handlers) include `instanceId: getInstanceId()` in the request body, so a peer learns our epoch regardless of which path activated the relationship.

`instance_name` is cosmetic metadata, eventually-consistent. Anywhere `peerLabel` is rendered falls back to origin hostname when `instance_name IS NULL`. Instance renames do not currently re-broadcast — that's a separate, unimplemented feature. `peer_instance_id` is trust-consequential (only ever written from authenticated channels) — see the self-healing design spec for detection/heal semantics.

### Secret Storage & Rotation

Both instances store the **same** HMAC secret. The initiating instance generates it and sends it in the accept request.

**Rotation protocol:** Either peer (or automatically on a configurable interval, default 90 days) can trigger rotation:

1. Initiator generates a new secret, stores it as `pendingHmacSecret`, and POSTs to `{peer}/api/federation/peer/rotate` signed with the current secret
2. Acceptor verifies the HMAC, stores `pendingHmacSecret`, and returns `{ accepted: true }`
3. Both sides enter a 15-minute grace period where either secret is accepted for verification, while outbound requests are signed with the new secret
4. After the grace period, the health check worker promotes `pendingHmacSecret` → `hmacSecret` and clears the pending fields

**Conflict guard:** If `pendingHmacSecret` is already set, the rotate endpoint returns 409.

**Schema columns:** `pending_hmac_secret` (TEXT NULL), `secret_rotation_at` (INTEGER NULL), `secret_rotated_at` (INTEGER NULL), `auto_rotate_interval_days` (INTEGER NOT NULL DEFAULT 90).

### Peer state

A `federation_peers` row's state is its `status` plus `status_reason`. One module writes them: `utils/federationPeerState.ts` is the only writer of `status`, `status_reason`, `initiated_by`, `probe_attempts` and `last_probe_at`, and of peer-row inserts and deletes (the janitor's guarded delete of unused auto `pending` rows is the one exception). Other code calls it; nothing else writes these columns.

- **`transitionPeer(peerId, { from, to, reason?, cause, fields?, expectSecret? })`**: a compare-and-set. It applies only while the row is still in one of `from` (and, with `expectSecret`, still holds that secret). When it does not apply it returns the row as it is now, and that state is the caller's outcome. A write decided before an await can therefore never overwrite a row something else changed meanwhile (the remote's own handshake, an admin's revoke, a reset detection).
- **`status_reason`** is set for `needs_attention` and `rejected` and cleared on every other transition, so it never goes stale.
- **Pacing** (`probe_attempts`, `last_probe_at`) starts afresh on entering `pending`, `unreachable` or `active`. `recordPeerAttempt(peerId, { from, startedAt })` counts a failed attempt.
- **Side effects run once, after commit, from the old and new state**, never at call sites:

| Transition | Effect |
|---|---|
| any | `federation_peers_changed` to admins |
| into `active` | `federation_peer_active` to every online user; `onPeerActivated(peerId, cause)` |
| out of `active` | `onPeerDeactivated(peerId, cause)` |
| into `rejected` | outbox entries purged (the conversation replays from `federation_mutation_log` if the peering comes back); `federation_peer_rejected` with `reasonCode` to the local users who had something queued |
| into `revoked` | outbox entries purged |
| into `needs_attention` / `auth_failures` | `federation_peer_rejected` with `reasonCode: 'auth_failures'` to the users with queued entries; the entries stay (bounded by the outbox TTL) |

**States.**

| Status | Reason (`status_reason`) | Meaning | Outbox | `ensurePeered` answers | Relay (`authenticateS2SPeer`) |
|---|---|---|---|---|---|
| `pending` | none | No handshake of ours has completed yet | queued, not delivered | runs a handshake (or the outbound gate) | 403 |
| `awaiting_approval` | none | The remote queued our handshake for its admin (202) | dropped at enqueue | `pending` | 403 |
| `active` | none | Peered | delivered | `active` | accepted |
| `unreachable` | none | Was active; 10 consecutive delivery failures | queued, delivered after recovery | `active` | 403 |
| `needs_attention` | `auth_failures` | Was active; 5 consecutive 401/403 on delivery | kept until TTL | `rejected` | 403 |
| `needs_attention` | `peer_reset_detected` | The remote advertises a new instance epoch (reinstalled) | kept until TTL | `rejected` | 403 |
| `needs_attention` | `repeer_incomplete` | A 200 whose secret the signed `/epoch` round-trip did not verify | kept until TTL | `rejected` | 403 |
| `rejected` | `denied_by_local_admin` | Our admin denied the remote's request | purged | `rejected` | 403 |
| `rejected` | `denied_by_remote` | The remote's admin denied us (`403 PEERING_REQUIRES_APPROVAL`, or `/peer/denied`) | purged | `rejected` | 403 |
| `rejected` | `revoked_by_remote` | The remote's row for us is revoked (`403 PEER_REVOKED`) | purged | `rejected` | 403 |
| `rejected` | `expired_on_remote` | Our request expired unanswered on the remote (`/peer/denied`, reason `expired`) | purged | `rejected` | 403 |
| `rejected` | `stale_peering_on_remote` | The remote holds an older peering with us (`409 PEER_EXISTS_RESET_REQUIRED`); its admin has to reset it | purged | `rejected` | 403 |
| `rejected` | NULL | A row from before migration `0023`: which side refused is unknown | purged | `rejected` | 403 |
| `revoked` | none | Our admin revoked the peering | purged | `rejected` | 403 |

`/api/federation/epoch` answers any row that is not `revoked`, signed with that row's secret; `/peer/rotate` and the relay require `active`.

**Transitions.**

| From | To | Trigger |
|---|---|---|
| (none) | `pending` | `createAutoPlaceholderPeer` (outbox placeholder), `performHandshake`, `prepareAdminHandshakeRow` (`/peer/initiate`, approvals) |
| (none) | `active` | `/peer/accept` on a new origin with auto-accept on |
| (none) | `rejected` / `denied_by_local_admin` | inbound deny with no row |
| `pending` | `pending` (`initiated_by` changes) | an admin handshake claims a traffic row (`'auto'` → `'admin'`); a failed one hands it back |
| `pending` | `awaiting_approval` | our handshake answered 202 |
| `pending` | `active` | our handshake answered 200 and `/epoch` verified the secret we sent; or the remote's `/peer/accept` |
| `pending` | `needs_attention` / `repeer_incomplete` | our handshake answered 200 and `/epoch` did not verify |
| `pending` | `rejected` / `denied_by_remote`, `revoked_by_remote` | our handshake answered one of the remote's two 403 refusals |
| `pending` | `rejected` / `stale_peering_on_remote` | our handshake answered `409 PEER_EXISTS_RESET_REQUIRED` and `/epoch` did not verify our secret |
| `pending`, `awaiting_approval`, `rejected` | `rejected` / `denied_by_local_admin` | inbound deny |
| `awaiting_approval` | `active` | the remote's `/peer/accept` with the approval token (or auto-accept on) |
| `awaiting_approval` | `rejected` / `denied_by_remote`, `expired_on_remote` | `/peer/denied` |
| `active` | `unreachable` | 10 consecutive delivery failures (outbox worker, cause `network_threshold`) |
| `active` | `needs_attention` / `auth_failures` | 5 consecutive 401/403 on delivery (cause `auth_threshold`) |
| `active`, `unreachable`, `needs_attention` | `needs_attention` / `peer_reset_detected` | `markPeerReset` (a handshake or probe shows a new epoch) |
| `unreachable` | `active` | the reachability probe succeeds with an unchanged epoch (`markPeerRecovered`) |
| `rejected` (remote-side reason, or NULL with auto-accept on) | `active` | the remote's `/peer/accept` (see "Answering a handshake") |
| `rejected` / `stale_peering_on_remote` | `active` | the backstop's signed `/epoch` verifies our secret |
| `rejected` / `stale_peering_on_remote` | `pending` | the backstop's `/epoch` answers 403 (the remote dropped its row); one handshake follows, and a transient failure parks the row again |
| any but `revoked` | `revoked` | admin revoke |
| `needs_attention` | (deleted) | admin Reset |
| `revoked`, `rejected`, `needs_attention` | (deleted, then a fresh `pending` row) | `/peer/initiate`; an approval replaces `awaiting_approval`, `rejected` and `revoked` rows the same way |
| `pending` (auto, nothing queued) | (deleted) | the janitor after 1h, or a transient failure of the handshake that created it |

**Answering a handshake** (`POST /api/federation/peer/accept`). `decideInboundHandshake` (a pure function of our row, its provenance and the setting) decides; the route applies it.

| Our row | Auto-accept on | Auto-accept off |
|---|---|---|
| none | create `active` (`initiated_by = 'remote'`) | 202, queued for our admin |
| `pending` | activate with the caller's secret | activate if `initiated_by = 'admin'`, else 202 queued |
| `rejected` with a remote-side reason | activate | activate if `initiated_by = 'admin'`, else 202 queued |
| `awaiting_approval` | activate (token or not) | valid approval token and an admin row: activate; else 202 queued |
| `active`, `unreachable`, `needs_attention` | `409 PEER_EXISTS_RESET_REQUIRED`; reset detection on a changed epoch | same |
| `revoked` | `403 PEER_REVOKED` (error text unchanged for older initiators) | same |
| `rejected` / `denied_by_local_admin` | `403 PEERING_REQUIRES_APPROVAL` | same |
| `rejected`, NULL reason (legacy) | activate | `403 PEERING_REQUIRES_APPROVAL` |

An established peering (`active`, `unreachable`, `needs_attention`) is never re-keyed by this unauthenticated endpoint: an unreachable peer's handshake is answered like an active one's (409), and a changed epoch runs reset detection. Our admin's own refusals (`revoked`, `denied_by_local_admin`) hold whatever the auto-accept setting.

**Two handshakes at once.** When both instances start a handshake with each other at the same time, each would take the other's secret and end up holding a different one. The rule: on a `pending` (or remote-side `rejected`) row with our own handshake to that origin in flight, the handshake started by the lower origin (plain string order of the normalized origins) wins. The lower side answers the other's `/peer/accept` with `409 PEER_HANDSHAKE_IN_PROGRESS`; the higher side takes the lower side's handshake. Both sides apply the same rule, so one secret survives. A sender that gets `PEER_HANDSHAKE_IN_PROGRESS` leaves its row for the winning handshake to settle and counts the attempt. A release without the rule takes both handshakes; the sender then finds its row active under the other's secret after a 200, checks with the signed `/epoch` which secret the remote holds (the remote keeps ours), and adopts it.

**Sending a handshake.** The four senders (`performHandshake` for auto-peering, `/peer/initiate`, and both approval handlers) share `utils/federationHandshake.ts`: `prepareAdminHandshakeRow` for the admin paths (under `claimAdminHandshake`), `requestPeerAccept` and `interpretAcceptAnswer` for the request, and `runOutboundHandshake` to settle the row from the answer. Every settle is a compare-and-set on the row still being `pending` with the secret we sent; when the row changed in flight, its current state is the outcome (so a transient failure after the remote activated the row reports `active`).

| Answer | Row |
|---|---|
| 200 | activate only after a signed `/epoch` round-trip with the secret we sent verifies; the verified epoch is the baseline. Unverified: `needs_attention` / `repeer_incomplete` |
| 202 | `awaiting_approval`, storing the approval token |
| `403 PEERING_REQUIRES_APPROVAL` | `rejected` / `denied_by_remote` |
| `403 PEER_REVOKED`, or a 403 with the revoked error text | `rejected` / `revoked_by_remote` |
| `409 PEER_EXISTS_RESET_REQUIRED` | signed `/epoch` with our secret: verified → activate (an earlier attempt went through and its answer was lost); else `rejected` / `stale_peering_on_remote` |
| `409 PEER_HANDSHAKE_IN_PROGRESS` | left `pending` for the remote's handshake; attempt counted |
| other status, network error, timeout | attempt counted; a row this attempt created is removed unless entries were queued on it; a row an admin claimed goes back to `'auto'` |

Every released Backspace version serves `/api/federation/epoch` (it shipped on 2026-07-01, before v1.0.0), so verify-before-activate parks no released peer. Only a build from before that date, or a server that is not Backspace, answers the verification with 404 and parks in `needs_attention` / `repeer_incomplete`.

**A remote that holds an older peering with us (#309).** A `409 PEER_EXISTS_RESET_REQUIRED` means the remote keeps a row for us under another secret, which only its admin can clear. Retrying the handshake only repeated the refusal, and each retry re-ran reset detection on the remote. So the row is parked as `rejected` / `stale_peering_on_remote` and never retried by a handshake. The recovery keeps working:

1. **The remote admin's Re-peer (the one-click reset recovery).** Instance L was reinstalled; S still holds S's old row for L. L's traffic handshakes S; S detects the new epoch (`needs_attention` / `peer_reset_detected`) and answers 409. L probes `S/api/federation/epoch` with its secret, gets 401, and parks. S's admin clicks Re-peer: Reset deletes S's row, `/peer/initiate` sends `L/peer/accept`. L's parked row is "`rejected` with a remote-side reason", so L activates with S's secret and answers 200 with its epoch; S verifies through `/epoch`, activates, and heals. With auto-accept off on L, a row L's admin started (`initiated_by = 'admin'`) is taken the same way; a traffic row is queued for L's admin.
2. **The remote admin only resets.** The health-check tick sends one signed `/epoch` per parked row, no handshake: verified → the row activates; `403` (the remote holds no row for us now) → one handshake, which lands on the remote's fresh slot; `401` or anything else → the row stays parked.

A 1.7.0 remote sees, at step 1, one handshake and then only `/epoch` requests it answers 401 (no side effects: no reset detection, no approval request). A 1.7.0 instance in L's place keeps retrying its handshake as before; the survivor no longer re-arms the admin's dismissal on each retry, because `markPeerReset` treats the same observed epoch as the same detection (no new snapshot, journal update or `federation_peer_reset_detected`).

**Pacing.** Paced attempts use `RECOVERY_BACKOFF_MS = [30s, 1m, 5m, 15m]`: after n failed attempts the wait is entry n - 1 (clamped), so retries follow 30 s, 1 m, 5 m, then every 15 m. The first attempt is immediate (`last_probe_at IS NULL`). A failed handshake counts on the row whoever started it (worker, DM send, typing warm-up, friend add, `/peer/ensure`), so the worker does not retry right after a user-triggered failure.

### PEER_UNREACHABLE_THRESHOLD

Defined in `federationWorker.ts` as `10`. After 10 consecutive delivery failures for a peer, `handleOutboxDeliveryFailure` moves it to `unreachable`; entering `unreachable` starts the recovery pacing afresh (`probe_attempts = 0`, `last_probe_at = NULL`) so the first probe fires immediately.

**Demand-driven recovery (`processRecoveryTick`)** — A dedicated recovery loop runs on a 5-second tick (`RECOVERY_TICK_INTERVAL_MS`). On each tick it scans `unreachable` peers and, for each, decides whether a probe is due:

- If the peer has ≥1 queued outbox row, the probe interval follows `RECOVERY_BACKOFF_MS` (see [Pacing](#peer-state)): 30 s after the first failed probe, then 1 m, 5 m and every 15 m, fast while mail is actually waiting.
- If the peer has no queued mail, it falls back to the `HEALTH_CHECK_INTERVAL_MS` (15-minute) backstop — there is nothing to deliver, so there is no urgency.
- A probe is due when `last_probe_at IS NULL` (immediate first probe on the unreachable transition) or `now - last_probe_at >= interval`.

When due, it calls `probePeerReachable(origin)` (`utils/federationRecovery.ts`), an unauthenticated `GET /api/instance/info` with a 10-second timeout (no HMAC; reachability is not trust). On success it calls `markPeerRecovered(peerId)`, a transition from `unreachable` to `active` that zeroes `consecutive_failures` and refreshes `last_seen_at` (the transition resets the pacing and runs `onPeerActivated`). A row that left `unreachable` while the probe ran (revoked, reset detected) is left as it is. On failure `recordPeerAttempt` counts the probe.

`processHealthCheckTick` (15-minute interval, matching `ROTATION_GRACE_PERIOD_MS`) does not own recovery. It finalizes secret rotations, starts auto-rotations, refreshes missing epoch baselines, probes `needs_attention` peers for a reset, and checks rows parked on the remote's older peering (see [Peer state](#peer-state)).

### Auto-Peering

When the server needs to relay events to an instance it has not yet peered with, `ensurePeered()` in `federationPeering.ts` automatically initiates the handshake. This removes the requirement for an admin to manually initiate every peering relationship.

**Integration points:**
- **Outbox worker** (`federationWorker.ts:resolvePendingPeers`) — at the start of each outbox tick, starts an `ensurePeered()` handshake for every `pending` peer that has queued outbox entries and whose next attempt is due. The placeholders themselves are created by `createAutoPlaceholderPeer`, subject to the outbound gate — see [Peer-row provenance](#peer-row-provenance). See **Pending-peer handshake pacing** below.
- **Connection flow** (`POST /api/federation/peer/ensure`) — called by the client when establishing a cross-instance connection, ensuring the two instances are peered before any relay traffic is sent.

**Pending-peer handshake pacing.** The worker's handshake attempts for `pending` rows run detached from the outbox tick: the tick does not wait for them, so an origin that never answers (10-second handshake timeout) does not hold up delivery to active peers or the next tick. `pendingPeerHandshakes` (origin → attempt) keeps a second attempt for the same origin from starting while one is outstanding, and an origin whose handshake `ensurePeered` already has in flight for another caller (`isHandshakeInFlight`) is skipped without counting as an attempt. Attempts are paced by the same mechanism as [unreachable-peer recovery](#peer_unreachable_threshold): `isPeerAttemptDue` over `RECOVERY_BACKOFF_MS` and the row's `last_probe_at` / `probe_attempts` (schedule under [Pacing](#peer-state)). The handshake counts its own failed attempt on the row, whoever started it. A row whose origin has an inbound approval request waiting for our admin is skipped: that decision settles it. `active`, `rejected`, `pending` (now `awaiting_approval`) and `admin_required` (row removed by the outbound gate) leave nothing to pace. Before this, every pending row with entries was retried on every tick with each handshake awaited in turn, so one unreachable origin cost every tick up to 10 seconds.

**Transient handshake failure.** `performHandshake` inserts its `pending` row (`initiatedBy: 'auto'`) before the request goes out, so traffic queued while the request is in flight lands on that row. In the DM send path this is the usual order: the typing-stop relay's warm-up (`sendCallRelay` with `peeringTimeoutMs: 0`) starts the handshake, then `queueDmRelay` queues the message against the row it finds. On a network error, timeout or a non-2xx answer that is not one of the remote's settled answers (see [Sending a handshake](#peer-state)) the row is removed only when it is still `pending` and no `federation_outbox` entry references it (`removePeer` with `unlessQueued`, one `DELETE ... WHERE status = 'pending' AND NOT EXISTS`). The status term matters because the remote's own `/peer/accept` can promote the same row to `active` while our request is in flight; a failure of our request afterwards must not delete that peering, and `ensurePeered` then answers `active`. A row with entries stays `pending`, the same shape `createAutoPlaceholderPeer` produces, and `resolvePendingPeers` retries it on the pending-peer handshake pacing above. Before this, the delete cascaded the queued messages away and nothing retried the peering until some later event.

**`rejected` status.** Set when the remote refuses us or holds an older peering with us, and when our admin denies a remote's request; `status_reason` says which (see [Peer state](#peer-state)). Only the remote's own answers settle a row: `403 PEERING_REQUIRES_APPROVAL`, `403 PEER_REVOKED` (or, from releases before that code, a 403 with the exact error `Peering with this instance has been revoked`, `REMOTE_REVOKED_ERROR` in `federationHandshake.ts`), and `409 PEER_EXISTS_RESET_REQUIRED`. Any other `403` (HTML or foreign-shaped JSON from a WAF, an IP block, a proxy deny rule or a default vhost) is not the remote's answer and stays transient. A `rejected` row is never retried by a handshake. When the remote acts (its admin approves, re-initiates after a revoke, or resets its older row and re-peers), its handshake reaches our `/peer/accept`, which activates a row with a remote-side reason. Our admin can also re-initiate, which replaces the row.

**`autoAcceptPeering` instance setting.** Controls whether `POST /api/federation/peer/accept` accepts unsolicited peering requests. Default: `true`. When `false`, a handshake is taken only on a row our admin started (`initiated_by = 'admin'`); anything else is queued for review and answered `202` (see [Peer Approval Queue](#peer-approval-queue)). `403 PEERING_REQUIRES_APPROVAL` is reserved for an origin our admin denied (`rejected` / `denied_by_local_admin`), with either setting. The full table is under [Answering a handshake](#peer-state). The determination is made from the local peer table (the row's status *and* its `initiated_by` provenance), never from a client-provided flag.

### Peer Approval Queue

When `autoAcceptPeering` is `false` and an instance calls `POST /api/federation/peer/accept` without a matching admin-initiated local `pending` record, the endpoint returns `202 Accepted` and creates a row in `peer_approval_requests` instead of immediately peering. The requesting instance receives `202` (not an error), so it enters `awaiting_approval` status rather than `rejected`.

**`peer_approval_requests` table** — Holds incoming peering requests pending admin review:
- `id` — Snowflake PK
- `origin` — Requesting instance's origin URL (UNIQUE; only one pending request per origin)
- `instance_name` — Instance name sent by requester
- `hmac_secret` — Requester's HMAC secret; used to sign the denial notification
- `requested_at` / `expires_at` — Epoch ms; expiry is `requested_at + 30 days`
- `approval_token` — Single-use 64-hex-char random token issued in the 202 response and forwarded by `/approve`. See [Approval Token Verification](#approval-token-verification).

**Approval flow.** Admin approves via `POST /api/federation/approval-requests/:id/approve`. Both directions claim the origin (`claimAdminHandshake`; 409 while another handshake with it is in flight), prepare the row with `prepareAdminHandshakeRow` (an existing `active`/`unreachable` row is the result as it stands; a `needs_attention` row answers 409 until an admin resets it; `awaiting_approval`, `rejected` and `revoked` rows are replaced), and settle it with the shared outbound handshake ([Sending a handshake](#peer-state)), so a 200 activates only after the signed `/epoch` round-trip verifies. The handler then dispatches on `peer_approval_requests.direction`:

*Inbound* (remote asked to peer with us):
1. The prepared row is `pending` with `initiated_by = 'admin'`
2. A standard `peer/accept` handshake is sent to the requesting origin (forwarding the stored `approvalToken` per [Approval Token Verification](#approval-token-verification))
3. On 200 the local peer becomes `active`; on 202 the peer transitions to `awaiting_approval` (mutual-gate); the `peer_approval_requests` row is deleted in both cases. On a failure the request row stays so the admin can retry (502, or 504 on a timeout)

*Outbound* (local users asked us to peer with a remote — created by the gate in `ensurePeered`):
1. The prepared row is `pending` (a fresh row gets its secret at this moment; outbound queue rows store `hmac_secret = NULL`)
2. `peer/accept` is sent to the remote with no `approvalToken` (we are the initiator with no prior token from this remote)
3. On 200 the peer is promoted to `active`. `onPeerActivated` then fires `fanoutOutboundSubscribers` (see [Outbound peering gate](#outbound-peering-gate)) which writes `kind='approved'` notifications for each subscriber and cascade-deletes the parent `peer_approval_requests` row. The handler does NOT duplicate this cleanup.
4. On 202 the peer transitions to `awaiting_approval`, captures the returned `approvalToken`, and the queue row + subscribers are LEFT INTACT — they wait for the eventual remote-admin approval. `onPeerActivated` is NOT called on this path.
5. On a failure the peer row is removed unless entries were queued on it; the queue row is left intact so the admin can retry. Response status is `503` (unreachable), `504` (timeout) or `502` (the remote answered; `remoteStatus` carries its status).
6. Response body shape: `{ success, peerStatus: 'active' | 'awaiting_approval', peer? }`. The `peerStatus` field is the outbound-only signal.

**Denial flow** — Admin denies via `POST /api/federation/approval-requests/:id/deny`. The handler dispatches on direction:

*Inbound*:
1. Server sends `POST {origin}/api/federation/peer/denied` signed with the requester's `hmac_secret` (from the approval request row)
2. Receiving instance transitions its local peer record from `awaiting_approval` to `rejected` / `denied_by_remote` (or `expired_on_remote` for the janitor's `expired` notice)
3. Our row for the origin becomes `rejected` / `denied_by_local_admin` (inserted when there is none; an `active`, `unreachable`, `needs_attention` or `revoked` row is left as it is). That reason keeps the origin's handshakes refused with `403 PEERING_REQUIRES_APPROVAL` until an admin clears it, whatever the auto-accept setting
4. The `peer_approval_requests` row is deleted

*Outbound*:
1. For each row in `peer_approval_subscribers`, a `kind='denied'` notification is inserted into `peer_approval_notifications` and a `peering_notification_received` WS event is sent to the user
2. The parent `peer_approval_requests` row is deleted (cascade clears subscribers)
3. No remote network call — the remote never knew we were considering this peer
4. `federation_peers_changed` is broadcast to admins so the queue UI refreshes

**Expiry** — The janitor (`federationJanitor.ts`) runs on its scheduled interval and deletes rows where `expires_at < now`. Expired requests do NOT create a `rejected` peer — the requesting instance can re-submit. Admin denial, by contrast, does create a `rejected` peer record, blocking re-requests until an admin clears it.

**Pre-handshake guard (`ensurePeered`)** — Before any outbound handshake, `ensurePeered(origin)` in `federationPeering.ts` refuses with `{ status: 'rejected', error: 'Local admin must resolve…' }` if an **inbound** `peer_approval_requests` row exists for that origin. The guard query is narrowed to `direction='inbound'` (commit `0d3d087`) so the gate's own outbound queue rows do not falsely block their own approval path. This blocks the auto-reconnect trigger: without the guard, any code path calling `ensurePeered` (e.g., the silent reconnect in `stores/instanceStore.ts`) could initiate a fresh outbound handshake to a peer that has a pending inbound approval request. The legitimate approve flow (`POST /api/federation/approval-requests/:id/approve`) does NOT call `ensurePeered` — it deletes the approval-request row and does its own direct `fetch` to `/peer/accept` — so the guard does not block legitimate approvals.

### Approval Token Verification

The pre-handshake guard above closes the most reliable trigger but cannot prevent every adversarial code path on a remote side from sending an inbound `/peer/accept` against a row in `awaiting_approval`. To close that broader class, the protocol adds a cryptographic single-use **approval token** verified on the receiver before promoting `awaiting_approval → active`. Spec: `docs/superpowers/specs/2026-04-26-peer-approval-token.md`.

**Issuance.** When `/peer/accept` returns 202 (queue-as-approval-request, `autoAcceptPeering=0`), the server generates a 32-byte random hex token via `crypto.randomBytes(32).toString('hex')`, stores it on the new `peer_approval_requests.approval_token` column, and returns it in the 202 body as `{ queued: true, message, approvalToken }`.

**Storage on the initiator.** When the initiator's outbound `/peer/accept` (from `performHandshake`, `/peer/initiate`, or `/approve`) receives 202, it parses `approvalToken` from the response body and stores it on the local `federation_peers.approval_token` column alongside `status='awaiting_approval'`.

**Forwarding from `/approve`.** When the local admin approves an inbound queued request, the `/approve` endpoint reads `approvalToken` from the queued `peer_approval_requests` row and includes it in its outbound `/peer/accept` body. No other code path forwards a token — the security property is "only `/approve` reads the stored token from the DB."

**Verification on the initiator's `/peer/accept` handler.** When an inbound request matches an existing `awaiting_approval` peer row, the handler verifies `existing.approval_token === request.body.approvalToken` (length-checked, plain `===` — see spec §3.1 on why constant-time comparison isn't required). On match, the row is promoted to `active`, the stored token is cleared (`approval_token=NULL`), and any stale `peer_approval_requests` row for the origin is deleted. On mismatch (or missing token), behavior depends on the receiver's `autoAcceptPeering`:
- `autoAcceptPeering=0` → `queueApprovalRequest()` is invoked: a new `peer_approval_requests` row is upserted with a fresh token, returns 202. The existing `awaiting_approval` row is left untouched. **No bypass.**
- `autoAcceptPeering=1` → fallback promote to `active` (no security regression vs. prior behavior — `autoAccept=1` would accept any inbound `/peer/accept` regardless).

**Single-use lifecycle.** The token is consumed on first successful match: cleared from `federation_peers.approval_token` at the receiver's promote step, cleared from the initiator's `federation_peers.approval_token` when its own outbound returns 200, and deleted along with the approval-request row when `/approve` completes. This bounds replay of a leaked token (DB snapshot, log capture) to the period before the legitimate `/approve` runs.

**Backward compatibility.** Both schema columns are nullable. Older peers that don't include `approvalToken` in the request body or 202 response result in `null` storage; the receiver's verification then falls through the `autoAcceptPeering` gate. Existing `active` peers and existing `awaiting_approval` rows in production at upgrade time are unaffected — the verification only runs on the receiver's `awaiting_approval` branch. Stalled legacy `awaiting_approval` rows (no stored token) cannot complete via inbound `/peer/accept` from a legacy initiator unless the receiver is `autoAccept=1`; admins should re-initiate them through the standard flow if needed.

**What this does NOT defend against** — a remote operator running custom code with full DB access can read their stored token and forge `/peer/accept`. That is the inherent trust radius of federation peering. The threat model is bug-prone code paths (auto-reconnect, voice-call peering races, future `ensurePeered` callers) on otherwise-honest peers, not adversarial operators. Sender-side outbound gating for `autoAcceptPeering=0` was tracked as the "Direction C" follow-up and is now closed by the [Outbound Peering Gate](#outbound-peering-gate) below (spec `docs/superpowers/specs/2026-04-26-outbound-peering-gate-design.md`, commits `ac2565f..c795d72`).

### Outbound Peering Gate

The receiver-side trust class is closed by the approval-token mechanism above. The sender-side trust class — *bug-prone or incidental code paths on the initiator that drag the local instance into peering relationships without local admin consent* — is closed by a centralized gate inside `ensurePeered`. After this change, `autoAcceptPeering=0` is symmetric: BOTH inbound and outbound new-peer establishment require local admin approval. Existing active peers keep working unchanged.

Spec: `docs/superpowers/specs/2026-04-26-outbound-peering-gate-design.md`.

**Gate location.** `ensurePeered` (`utils/federationPeering.ts`) is the single chokepoint every outbound new-peer attempt funnels through (friend-add, `/peer/ensure`, `sendCallRelay`'s no-active-peer branch, future callers). The gate runs when **no `federation_peers` row exists for the origin**, and also for a `pending` row that carries no admin provenance (`initiated_by != 'admin'` — see [Peer-row provenance](#peer-row-provenance)). Every settled status (`active`, `awaiting_approval`, `rejected`, `revoked`, `unreachable`, `needs_attention`) returns from the branch switch above the gate and never reaches it, so the gate can never retroactively break an established peering. `pending` is the one status meaning "no handshake has ever completed": there is nothing yet to preserve, and the gate's question is still unanswered. When the gate fires on such a row it **deletes it first** — the row can no longer become a peering (both peering gates refuse it) and leaving it would collide with the fresh row `handleOutboundApprove` inserts on approval. Its `federation_outbox` entries cascade away; the conversation itself survives in `federation_mutation_log` and replays on activation, exactly as for a rejected peer.

**Required caller intent.** Every call site MUST pass an explicit `EnsurePeeredCallerIntent` (declared in `packages/shared/src/types.ts`). The argument is required at the type level so a future caller cannot silently fall through to system behavior:

```ts
export type PeeringTriggerReason = 'friend_add' | 'space_join' | 'direct_message' | 'instance_connect';

export type EnsurePeeredCallerIntent =
  | { kind: 'user_action'; userId: string; reason: PeeringTriggerReason; target: string }
  | { kind: 'system' };

export type EnsurePeeredResult =
  | { status: 'active'; peerId: string }
  | { status: 'rejected'; error: string }
  | { status: 'failed'; error: string }
  | { status: 'pending'; error: string }
  | { status: 'admin_required'; error: string };  // ← new variant
```

(Type was originally drafted as `TriggerReason` and renamed to `PeeringTriggerReason` in commit `f6487a2` to disambiguate from unrelated outbox/voice trigger enums.)

**Gate-but-don't-queue split.** When the gate fires (no peer row + `autoAcceptPeering=0`), behavior diverges on intent:

- **`intent.kind === 'user_action'`** — upsert an outbound `peer_approval_requests` row keyed on `(origin, direction='outbound')`, upsert a `peer_approval_subscribers` row keyed on `(request_id, user_id, trigger_reason, trigger_target)`, broadcast `federation_approval_request_received` to admins, broadcast `peering_subscription_changed` to the requesting user, return `{ status: 'admin_required', error: 'Awaiting your admin\'s approval to initiate peering' }`. The user's request is admin-approvable but no traffic reaches the wire yet.
- **`intent.kind === 'system'`** — no DB writes, no admin broadcast, no admin-visible queue clutter; return `{ status: 'admin_required', error: 'Outbound peering requires admin approval on this instance' }`. A stale outbox event or dead voice-call has no admin remedy worth surfacing.

**`'admin_required'` result semantics.** Each user-action caller maps the new variant to its own surface (e.g. friend-add returns `409 peer_pending_local_admin`; `sendCallRelay` returns `peer_admin_required` and threads through the existing exhaustive `CallRelayFailureReason` switch). See `social.md` §6 outbound flow for the friend-add error mapping.

**Lifecycle (centralized cleanup on `onPeerActivated`).** The most important correctness invariant: outbound subscriber cleanup hangs off **status transition to `active` (`onPeerActivated`)**, NOT off the local admin's approve-action handler. This holds across every activation path:

- queue approval (`/api/federation/approval-requests/:id/approve` 200 branch)
- admin-direct (`/peer/initiate`)
- autoAccept=1 remote (`/peer/accept` 200 from a remote that auto-accepts)
- mutual-token approval (the receiver's `/peer/accept` verifying `approvalToken` and promoting `awaiting_approval → active`)

When `federation_peers.status` transitions to `active`, `onPeerActivated` (`utils/federationPeerActivation.ts`) calls `fanoutOutboundSubscribers(origin)`: it queries the outbound `peer_approval_requests` row for the activated origin, inserts a `kind='approved'` row in `peer_approval_notifications` for each subscriber, broadcasts `peering_notification_received` per subscriber, then deletes the parent `peer_approval_requests` row (cascade clears subscribers). No per-action code knows about subscribers; the queue-approval handler does NOT duplicate this cleanup — it just performs the handshake and lets the resulting status transition trigger fanout.

The reason cleanup must NOT live in the approve-action handler: when the remote also has `autoAcceptPeering=0`, local admin approval transitions our peer row to `awaiting_approval`, not `active`. Subscribers must remain queued until full activation completes (which may be days later when the remote admin approves). Wiring cleanup to the approve-action handler instead would clear subscribers prematurely; users would retry against an `awaiting_approval` peer and hit `peer_pending_approval` 409, confused.

The other lifecycle exits write notifications and cascade-delete the parent at the trigger site:

- **Admin denies an outbound request** (`POST /api/federation/approval-requests/:id/deny`, `direction='outbound'` branch) — fans out `kind='denied'` notifications to subscribers, then deletes the parent (cascade clears subscribers). No remote network call — the remote never knew we were considering this peer. `federation_peers_changed` is broadcast to admins so the queue UI refreshes.
- **Last-subscriber cancel** (`DELETE /api/federation/peering-subscriptions/:id`) — deletes the subscriber row; if it was the last subscriber for the parent, cascade-deletes the parent. No notification created (the user took the action; they know).
- **Parent-row expiry** (`storageJanitor.ts` outbound branch) — fans out `kind='expired'` notifications to subscribers before deleting the parent. **Inbound expiry behavior is preserved unchanged** from pre-branch: the janitor still sends a signed `/peer/denied` to the inbound origin and only deletes the row on success (the Task 9 first-pass mistakenly removed this; commit `c4e7438` restored it).

**No status column on subscribers.** Existence = waiting; deletion = resolved (with the resolution mode encoded in the notification row created at deletion time, except for the canceller path).

**Gate composition with the trust-guard.** The pre-handshake trust-guard ("inbound `peer_approval_requests` exists → refuse outbound with `'rejected'`") is preserved unchanged and runs after the gate. The trust-guard query was narrowed to `direction='inbound'` so the gate's own outbound queue rows don't false-positive block their own approval path. The two layers compose cleanly: the gate fires earlier when there's no peer row at all; the trust-guard fires later when an inbound row exists.

**Caller summary** (intent each call site declares):

| Site | Intent | On `'admin_required'` |
|---|---|---|
| `routes/social.ts` (friend-add) | `user_action` reason `friend_add` target `name@domain` | 409 `peer_pending_local_admin` |
| `handlers/peerHandshake.ts` (`/peer/ensure`) | `user_action` with the request's `reason` (one of `PEER_ENSURE_REASONS`, default `instance_connect`) and a target the server derives for it | response `peeringStatus: 'admin_required'` |
| `utils/federationOutbox.ts` (`sendCallRelay` no-active-peer) | `system` | `CallRelayFailureReason.peer_admin_required` |
| `utils/federationWorker.ts` (`resolvePendingPeers`) | `system` | operates on already-existing pending rows; reaches the gate only for a row with non-admin provenance, which it refuses |

Admin-initiated paths (`/peer/initiate`, `/approve`) do NOT call `ensurePeered`. They issue their own `fetch` and run their own activation logic. The gate does not affect admin power; admins retain full ability to pre-peer or approve outbound regardless of the setting.

**`/peer/initiate` and an existing `pending` row.** A row with `initiated_by = 'auto'` is claimed for the admin instead of refused: `prepareAdminHandshakeRow` keeps the row, its `hmac_secret` and its queued outbox entries, sets `initiated_by = 'admin'`, and the handshake runs with that secret. It then settles like any other ([Sending a handshake](#peer-state)); on a transient failure the row goes back to `initiated_by = 'auto'` with the attempt counted, so the outbox worker resumes its paced retries. A `pending` row an admin or the remote created still answers `409`.

**One handshake per origin.** `/peer/initiate` and both approval handlers claim the origin with `claimAdminHandshake` (`utils/federationPeering.ts`) before it touches any row, and releases it when the request settles. The claim fails, and the route answers `409 "already in progress"`, while `ensurePeered` has a handshake with the origin in flight; while the claim is held, `ensurePeered` returns `failed` for the origin without sending anything, and the outbox worker and the janitor leave the row alone (`isHandshakeInFlight`). Without it, two `/peer/accept` requests for one origin raced on the remote, and the loser's `409 PEER_EXISTS_RESET_REQUIRED` made `/peer/initiate` delete the row the winner had just activated.

### Peer-row provenance

`federation_peers.initiated_by` records **who caused a peer row to exist**. It is the fact both peering gates consult when `autoAcceptPeering=0`, because a bare `pending` row is not evidence of anything on its own — several paths create one.

| Value | Written by | Meaning |
|-------|-----------|---------|
| `'admin'` | `prepareAdminHandshakeRow` for `POST /peer/initiate` and both approval handlers (a fresh row, or an `'auto'` pending row it claims; a claimed row whose handshake fails transiently goes back to `'auto'`); the inbound deny handler when it inserts the refusal row | A local admin explicitly authorized (or refused) peering with this origin. |
| `'auto'` | `createAutoPlaceholderPeer` (the outbox placeholder), `performHandshake` inside `ensurePeered` | Local traffic brought the origin up. No admin ruled on it. |
| `'remote'` | the new-peer branch of `POST /peer/accept` | The remote instance introduced itself and we accepted (only reachable with `autoAcceptPeering=1`). |

**Why it exists.** Relaying a DM to an unpeered origin used to insert a `pending` row directly from `queueOutboxEvent`. That row was indistinguishable from one `/peer/initiate` had created, so two separate gates read it as admin approval: the outbound worker resolved it into a real handshake (`ensurePeered` skips its gate once a row exists), and the remote's inbound `/peer/accept` matched it against the local-pending check below. Either way an origin a local user merely addressed could obtain the peering that `autoAcceptPeering=0` exists to withhold. Provenance separates "an admin decided" from "traffic happened".

**Where it is enforced.** Both checks are positive tests for `'admin'`, never denylists of the other values, so adding a provenance value cannot silently reopen either gate:

1. **Inbound** — the `autoAcceptPeering=0` branch of `POST /api/federation/peer/accept` matches a local `pending`/`awaiting_approval` row only when `initiated_by = 'admin'`. Anything else falls through to `queueApprovalRequest` (202) as if no row existed.
2. **Outbound** — the [Outbound Peering Gate](#outbound-peering-gate) fires for a `pending` row with non-admin provenance and discards it.

**Placeholder creation.** `queueOutboxEvent` no longer inserts peer rows itself; it calls `createAutoPlaceholderPeer` (`utils/federationPeering.ts`), which applies the same two guards `ensurePeered` applies — refuse while an inbound `peer_approval_requests` row for the origin is unresolved, and refuse when `autoAcceptPeering=0` — before inserting a `pending` row tagged `'auto'`. On refusal the origin is skipped and nothing is queued. That is not a lost message: `federation_mutation_log` is written independently of the outbox and replays through `onPeerActivated` if peering is approved later, the same mechanism that covers `awaiting_approval`, `needs_attention`, and `rejected` peers.

**Upgrade behavior.** Migration `0012_absurd_shiver_man` adds the column with `DEFAULT 'auto'`, so every pre-existing row reads as non-admin — the gates fail closed. This is only observable on an `autoAcceptPeering=0` instance that had a handshake in flight at the moment of upgrade: the remote's callback re-queues as an approval request and the admin approves it once. `active` peers are untouched (they never reach either gate), and default-configuration instances (`autoAcceptPeering=1`) see no behavior change at all.

### Admin Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/federation/peer/initiate` | POST | JWT + admin | Start peering handshake |
| `/api/federation/peer/accept` | POST | None (rate-limited) | Accept incoming handshake |
| `/api/federation/peer/ensure` | POST | JWT (any user), rate-limited 3/15min/user for calls that can start a handshake | Trigger auto-peering to a remote instance |
| `/api/federation/peers` | GET | JWT + admin | List all peers (secret excluded) |
| `/api/federation/peers/:id` | PATCH | JWT + admin | Update peer settings (auto-rotation interval) |
| `/api/federation/peers/:id` | DELETE | JWT + admin | Revoke peer, purge outbox |
| `/api/federation/peers/:id/permanent` | DELETE | JWT + admin | Hard-delete a revoked or rejected peer record (400 otherwise) |
| `/api/federation/peers/:id/reset` | POST | JWT + admin | Delete peer record (cascade-deletes outbox). Only admissible in `needs_attention` state. |
| `/api/federation/peers/:id/rotate` | POST | JWT + admin | Trigger immediate secret rotation |
| `/api/federation/peers/:id/recheck` | POST | JWT + admin | Run an immediate reachability probe on an unreachable peer; 400 unless status='unreachable'; 200 `{ recovered, status }` |
| `/api/federation/approval-requests` | GET | JWT + admin | List pending peering approval requests (inbound + outbound). Outbound rows include `subscribers: ApprovalRequestSubscriberSummary[]` (possibly empty). Inbound rows omit `subscribers`. Each row carries `direction: 'inbound' \| 'outbound'`. |
| `/api/federation/approval-requests/:id/approve` | POST | JWT + admin | Approve request — direction-branched (see Approval flow above) |
| `/api/federation/approval-requests/:id/deny` | POST | JWT + admin | Deny request — direction-branched (see Denial flow above) |

**`POST /api/federation/peer/ensure`** — Wraps `ensurePeered()`. Body is `PeerEnsureRequest`: `{ remoteOrigin: string; reason?: PeerEnsureReason }`.

`reason` is what the local admin's approval queue and the user's pending list show when the [outbound gate](#outbound-peering-gate) fires. It is checked against `PEER_ENSURE_REASONS` (`packages/shared/src/types.ts`), today `['instance_connect']`; anything else, including `friend_add`, is `400 validation_failed`. `friend_add` is excluded on purpose: friend-add peers server-side (`routes/social.ts`) with a target it has checked, so a client stating it could only queue a friend request the admin cannot verify. A missing `reason` reads as `instance_connect`, because clients that predate the field only called the endpoint when opening a session on a remote. The target is never read from the request: `peerEnsureTarget` derives it per reason (for `instance_connect`, the normalized remote origin), so the queue only shows what this instance can vouch for. Before this the handler recorded every call as `friend_add` with the origin as target, and a Connections click reached the admin as a friend add. Rows written that way are relabelled by migration `0018_peering_reason_instance_connect` (see [database.md](database.md#peer_approval_notifications)).

The response is `{ peeringStatus, peerId?, error? }` where `peeringStatus` is one of `active`, `pending`, `awaiting_approval`, `rejected`, `unreachable`, `revoked`, or `admin_required`.

The client calls it on every remote session it opens (see [client-federation.md](client-federation.md#home-instance-peering-on-every-session-peerhomewithremote)). The rate limit exists to bound the handshakes a user can make this instance start, so it is only charged when the call can start one: `settledPeeringResult(origin)` (`utils/federationPeering.ts`, the same settled-row switch `ensurePeered` uses) answers an `active`, `unreachable`, `awaiting_approval`, `rejected`, `revoked` or `needs_attention` row from the row alone, with no network and no writes, and such a call is not counted. A missing or `pending` row is counted.

### S2S Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/federation/peer/rotate` | POST | HMAC | Accept secret rotation from peer |
| `/api/federation/peer/denied` | POST | HMAC | Receive denial notification for awaiting_approval peer |
| `/api/federation/identity` | DELETE | HMAC | Delete federated user identity (soft/full mode) |
| `/api/federation/users/lookup` | POST | HMAC, rate-limited 60/min/peer | Resolve a username on this instance to (homeUserId, profile snapshot) for cross-instance friend-request originators |
| `/api/federation/epoch` | POST | HMAC (signed request **and** signed response) | Return this instance's persistent epoch `{ instanceId }`; populates a peer's trusted epoch baseline (`peer_instance_id`) |
| `/api/federation/verify-attach-proof` | POST | HMAC (signed request **and** signed response), rate-limited 60/min/peer | Verify a one-time detached-account re-attach proof token; single-use, bound to the calling peer's domain (re-attach spec §3.1) |

### S2S Detached-Account Re-Attach Proof (`POST /api/federation/verify-attach-proof`)

The home-instance verifier for the detached-account re-attach flow (re-attach spec §3.1). A user who was detached on peer R (its home domain was reset; see the Detached-account guards above) proves control of the still-native home account H, mints a one-time proof token on H via `POST /api/auth/attach-proof` (`randomBytes(32).toString('hex')`, stored in `federation_attach_proofs`, bound to R's domain), and hands it to R. R then calls this endpoint on H to redeem it.

- **Request:** HMAC-signed (same boilerplate as `/users/by-home-id`: missing headers → 401, unknown/inactive peer → 403, rate-limited 60/min/peer → 429, bad signature → 401, nonce replay → 409/401). Body `{ token: string }`.
- **Peer-domain binding is server-side (anti-replay):** the token's `target_domain` must equal the domain of the **authenticated calling peer** (`extractDomain(peer.origin)`), never a value from the request body. A compromised peer cannot redeem a token minted for a different peer.
- **Single-use is atomic:** the claim is a raw `UPDATE federation_attach_proofs SET used_at=? WHERE token=? AND used_at IS NULL AND expires_at>? AND lower(target_domain)=? RETURNING home_user_id`. Only the first concurrent verification can flip `used_at` from NULL, so a token can never be redeemed twice.
- **Re-confirms native identity:** after the claim, the home user must still be native and live (`isDeleted=0 AND home_instance IS NULL`) — a user tombstoned or turned into a replicated stub after mint fails closed.
- **Signed response (epoch pattern):** the body is HMAC-signed with the peer's shared secret (`X-Federation-Signature/Timestamp/Nonce` response headers) so the caller can trust the identity it carries. `{ valid: true, homeUserId, username }` on success; every failure mode (unknown/expired/used/wrong-domain/malformed token, deleted/non-native home user) fails closed to a **still-signed** `{ valid: false }`.

### Peer-Side Re-Attach (`POST /api/users/@me/reattach`)

The owner-initiated exception to the detach invariant (re-attach spec §3.2), on peer R. **JWT-authenticated as the detached account, not S2S** — but registered in `routes/federation.ts` (not `users.ts`) because it consumes federation-internal machinery (`verifyAttachProofWithPeer`, `fetchHomeProfileByHomeId`, `downloadProfileAsset`, the peer HMAC channel). It re-binds the sovereign detached row back to the owner's new home identity, restoring live sync while keeping history. It links **only** when BOTH proofs hold: the session IS the detached account (local password authority, via `authenticate`) AND the one-time token verifies with the home peer over signed S2S (`verifyAttachProofWithPeer`). Identity is never guessed and never username-matched — the latter is exactly the tier-2 hijack the detach branch closed.

**This is the only path that merges a `'!federation-replicated'` stub into a credentialed account.** Public registration never does: `POST /api/auth/register` carries no proof of control over the `homeInstance`/`homeUserId` it is handed, so it only ever INSERTs a new row (`auth.md` "Federated Registration Never Claims an Existing Row"). Any future flow that wants to hand a stub's history to a real account must go through this proof pair, not through a lookup.

- **Body:** `{ token: string }` (64-char hex; else 400). **Response:** `{ success: true, user: User }` (sanitized self-view; `ReattachResponse`).
- **Guards, in order:** (1) session user is a **live detached** federated account (`home_instance` set, `federation_home_orphaned = 1`, `is_deleted = 0`) → else 403; a missing/tombstoned row → 404 (a tombstoned session is already 401'd at `authenticate`, so the handler's 404 is defense-in-depth for a concurrent-delete race — detached tombstones are not re-attachable). (2) The home domain is an **active peer** → else 409 (the proof is only as trustworthy as the S2S channel it verifies over). (3) `verifyAttachProofWithPeer` returns `valid:true` → else 401 (fails closed). (4) If the verified new identity already has a live local row for that domain, it MUST be a replicated stub (`password_hash = '!federation-replicated'`) → a real account holding it is state corruption, aborted with **409 + a `console.error`** (impossible while the detached row holds the username).
- **Effect (one `rawDb.transaction`):** merges any pre-existing stub for the new identity into the detached row (below), sets `home_user_id = <new homeUserId>`, `federation_home_orphaned = 0`, takes exactly `<handle>@<domain>` as its username (`claimHandleName`, see "Account names" below), and **nulls `profile_updated_at`** so the home's next `profile_update` (any version) tier-1 matches and applies. Group-DM authority the old identity held is migrated by `owner_home_user_id` (the S2S authority key, home-domain-normalized). After the transaction, a best-effort `fetchHomeProfileByHomeId` pull applies the current home profile (avatar/banner via `downloadProfileAsset`, fail-open); then `user_updated` is broadcast to friends/DM/space co-members + all self connections (`collectProfileBroadcastTargetIds`).
- **Guard re-enablement:** clearing `federation_home_orphaned` automatically re-enables normal federated-account semantics — login self-heal resumes, and the S2S `profile_update`/`presence_update`/tier-2/identity-delete guards correctly stop firing for this account (they only fire on `federation_home_orphaned = 1`). This is intended, not a guard regression.

**Stub merge (spec §3.3).** By the time the owner re-attaches, R may already hold a replicated stub for the new home identity (from ordinary DM/friend relay, e.g. `youruser@<domain>` or `youruser~1@<domain>`). Two rows must not share `(homeUserId, homeInstance)`, so the stub is merged into the detached row inside the transaction: every `users.id` FK a replicated stub **can** populate is repointed, with collision rows deduped **before** repoint. Tables (audited against `schema.ts`): `dm_members` (dedupe on `dm_channel_id`), `dm_messages`, `messages`, `dm_reactions` (dedupe on `dm_message_id+emoji`), `reactions` (dedupe on `message_id+emoji`), `friends` (both columns + drop self-rows), `friend_requests` (both columns + drop self-rows), `read_states` (each stub pointer moved with `keepNewerReadPointer`, the newer kept), `dm_channels.owner_id` (plain-text column, no FK). Space-scoped FKs (`space_members`, `member_roles`, `*_overrides`, `bans`, `join_requests`, `voice_restrictions`, layouts/folders) and moderator/owner RESTRICT columns are **not** repointed — a DM/friend replica can never hold them. The stub row is then deleted. Only a `'!federation-replicated'` row is ever a merge source (guard 4).

**Account names.** A federated account signs in with its username, and the client signs in to (and, when no row has the name, registers on) another instance as `<handle>@<home>`. So an account's name is exactly its home handle, and one rule writes it: `claimHandleName(row, handle, domain, db)` in `routes/federation/stubName.ts`. The name is free, or held by a replica of another identity (a stale replica of an account deleted on its home whose handle was registered again), which moves to the first free `<handle>~<n>@<domain>` (`firstFreeUsername`) and is announced; a name another account signs in with, or a replica of the same identity holds, is `held`. Re-attach reads the handle from the home's signed answer (not handle-shaped: 401), claims it inside the transaction after the stub merge, and on `held` rolls the whole re-attach back and answers **409 `reattach_handle_taken`**. Versions up to 1.7.0 instead suffixed a held name with `_<n>` (`kai_1@<domain>`), which could be another person's real handle there; the peer-activation pass renames such accounts (see "Stub Username Backfill"), after which the owner signs in with the handle, not the suffixed name.

**1-on-1 DM `federatedId` reconciliation (reattach-dm-reconcile spec §3.1–§3.2).** A 1-on-1 DM's identity is `oneOnOneKey(a, b)` (`utils/dmConversation.ts`) — a deterministic SHA-256 of the two sorted home user IDs. The re-bind changes the account's `home_user_id`, so **every** 1-on-1 DM it participates in now derives a different `federatedId`: pre-reattach history stays under the OLD-identity channel while post-reattach messages compute the NEW id and land in a parallel channel — one conversation surfaced twice. So, still inside the re-attach transaction (after the re-bind UPDATE), the endpoint enumerates the account's 1-on-1 channels (exactly 2 members, 1-on-1-shaped `federated_id`) and calls `reconcileDmChannelFederatedId(rawDb, channelId)` on each. That helper recomputes the expected id from the members' **current** home identities and, when it differs from the stored id, either **re-keys in place** (no channel already carries the new id) or **merges the drifted channel INTO the existing new-identity channel and deletes it** (`idx_dm_federated` is UNIQUE, so two rows can never share a `federated_id`). Merge moves `dm_messages` (globally-unique snowflake ids; `attachments`/`dm_reactions` follow by `dm_message_id`), keeps one `dm_members` row per home identity (a member the target already holds, under any local id, is dropped from the source, reopening the target's row when the source's was open), moves each read pointer to the local id its person keeps, the newer kept where two meet (`keepNewerReadPointer`), re-points the source's `federation_mutation_log` and `federation_outbox` rows (`context_id` is the local channel id) to the target, then drops the source row. Re-attach enumerates its channels by 1-on-1-shaped `federated_id`; the helper itself also treats an ownerless row with a UUID key as a group and skips it. Group DMs (random-UUID `federatedId`) are **skipped** — their id is member-independent, so re-attach never drifts them. After commit, `announceDmReconcile` sends `dm_channel_closed` for a merged source to its affected local members and `dm_channel_created` (full surviving-channel payload) to the members who have the surviving row open, so the split collapses live without a reload and a conversation someone closed stays closed (`dm-system.md`, "Announcing a reconcile").

**Why R-local reconciliation is complete, not partial (spec §2).** A 1-on-1 DM is stored on an instance only if that instance is the home of at least one participant. The detached account is homed at the reset domain, i.e. **not native to R** (the peer where it now lives) — so the *other* participant of every 1-on-1 DM it holds on R is necessarily R-native, and R is that channel's authoritative home. Re-keying locally therefore produces the globally-correct id (the same value the R-native counterpart and the new home-identity compute); the reset home instance holds no old-identity channel. There is no cross-instance residual to relay: R-local reconciliation covers 100% of the account's 1-on-1 DMs.

### S2S Epoch Refresh (`POST /api/federation/epoch`)

HMAC-authenticated in **both directions**: the request is signed (only a peer holding the shared secret may call it — unknown/revoked peers → 403, bad signature → 401, missing headers → 400) **and the response body `{ instanceId }` is HMAC-signed** with the same secret (`X-Federation-Signature/Timestamp/Nonce` response headers). The caller (`fetchPeerEpoch(peer)` in `utils/federationEpoch.ts`) verifies that response signature with the same secret before trusting the value, then writes it to `federation_peers.peer_instance_id`. Response-signing (not TLS-only) is deliberate: a poisoned baseline could drive a spurious data-heal on a live peer, so the newly-trusted epoch is authenticated (design §9). `fetchPeerEpoch` **fails safe** — a `404` from a not-yet-upgraded peer, an absent/invalid response signature, or a network/timeout error all return `null` (10s timeout via `AbortSignal.timeout`); the caller treats `null` as "retry on the next tick," never as an error to surface. This is the deterministic populator of the epoch baseline (the bounded periodic epoch-refresh, design §3.2), independent of organic relay traffic.

**Deterministic epoch-refresh driver (`refreshPeerEpochs()` in `utils/federationEpoch.ts`).** Selects every `active` peer whose `peer_instance_id IS NULL`, calls `fetchPeerEpoch(peer)` once each, and on a non-null result writes the epoch via `UPDATE ... SET peer_instance_id WHERE id = ? AND peer_instance_id IS NULL`. The trailing `IS NULL` guard makes it **populate-if-null only** — it can never overwrite a baseline another path (relay envelope, handshake) already established — and makes it **self-terminating**: once a peer's `peer_instance_id` is set, the `IS NULL` filter excludes it, so it is never fetched again. A `null` from `fetchPeerEpoch` (404 / bad-sig / network) is a benign `continue` with no error log-spam, retried next tick. Wired into the federation worker in two places: once at `startFederationWorkers()` startup and once at the end of `processHealthCheckTick()` (the existing 15-minute health-check tick), both as `refreshPeerEpochs().catch(() => {})`. This guarantees the trusted baseline is populated within one refresh cycle of an upgrade, independent of user/relay activity — the load-bearing populator that relay-only population cannot cover for idle peers.

### Reset Detection (`markPeerReset` — `utils/federationReset.ts`)

The epoch is a **detection signal only, never an authorization signal.** When a peer behind a known origin advertises an epoch that differs from the trusted baseline (`peer_instance_id`), the instance was wiped and a new incarnation stood up on the same domain. `markPeerReset(peerId, origin, deadEpoch, observedEpoch)` routes the peer for admin attention and snapshots the dead incarnation — but performs **NO rekey, NO tombstone, NO handle change, NO content deletion.** The actual data heal fires only later, from `onPeerActivated` after an admin-authenticated re-peer (design §6). Because detection grants no capability and destroys nothing, it is safe to fire on an unauthenticated signal: the worst a spoofed detection can do is flag a peer for admin review (admin-reversible nuisance).

In a single transaction, `markPeerReset`:
1. Moves the peer from `active`, `unreachable` or `needs_attention` to `needs_attention` / `peer_reset_detected` (a `transitionPeer`, so a revoked or deleted row is left alone and nothing else in this list happens) and records `observed_peer_instance_id=observedEpoch`. **`peer_instance_id` (the trusted baseline) and `hmac_secret` are left untouched**: an unauthenticated observation never rekeys trust; the observed-but-untrusted epoch lives only in `observed_peer_instance_id`.
2. **Snapshots the dead incarnation:** sets `users.federation_heal_pending = 1` for every non-deleted user whose `home_instance` matches the origin. The match keys on `extractDomain(origin)` (bare domain, the canonical `home_instance` form) and defensively also matches the `https://`/`http://`-prefixed forms so any legacy full-URL straggler is caught (`homeInstanceMatch()`). Any stub created *after* detection (e.g. a friend-add reaching the new incarnation directly) is un-flagged and survives the heal.
3. **Journals the dead incarnation durably** by upserting a `federation_reset_events` row keyed by origin: `{ dead_epoch=deadEpoch, new_epoch=NULL, detected_at, resolved_at=NULL, stub_count, orphaned_account_count }`. `stub_count` counts flagged pure S2S stubs (`password_hash = '!federation-replicated'`); `orphaned_account_count` counts flagged real accounts. This row survives the peer-row deletion that Re-peer performs, preserving `dead_epoch` for the false-positive guard (design §6.1) and the admin surface.
4. After the transaction, runs the transition's effects (`federation_peers_changed`; `onPeerDeactivated` when the peer was active) and sends `federation_peer_reset_detected {origin}` to admins.

**Seeing the same incarnation again is not a new detection.** When the row is already `needs_attention` / `peer_reset_detected` with the same `observed_peer_instance_id` (the reset instance handshakes or is probed once more), `markPeerReset` does nothing: no new snapshot (which would flag stubs created since, which must survive the heal), no journal update (which would clear the admin's dismissal) and no new event.

**Idempotent / double-reset:** if an *unresolved* `federation_reset_events` row already exists for the origin (the peer reset again before an admin resolved the first), the original `dead_epoch` and `detected_at` are **preserved** (that is the incarnation whose users are already snapshotted) — only the summary counts are refreshed. `dead_epoch` is never overwritten on an unresolved row. A prior *resolved* reset starts a fresh journal entry.

**Detection sources (all three wired in this feature):**
- **Inbound handshake**: `/peer/accept` landing on an `active`, `unreachable` or `needs_attention` row (`routes/federation/handlers/peerHandshake.ts`): before the 409 refusal, `if (reqInstanceId && existing.peerInstanceId && reqInstanceId !== existing.peerInstanceId) markPeerReset(...)`. The refusal never re-keys; detection is layered on top.
- **Reachability probe (`unreachable` peers)** — `probePeerReachable()` (`utils/federationRecovery.ts`) now parses `instanceId` from the `/api/instance/info` response (returning `{ reachable, instanceId }`; a missing/unparseable epoch is `null`, never an error). The shared decision helper `recoverOrDetectReset(peer, result)` — used by both the background recovery tick (`processRecoveryTick`) and the manual recheck endpoint — routes to `markPeerReset` (returning `'reset_detected'`) when the peer has a non-null `peer_instance_id` and the probed epoch differs, and **does NOT call `markPeerRecovered`**. Rationale: a genuinely reset peer's HMAC secret is desynced, so flipping it back to `active` via a reachability probe would resume relay against a dead secret. Only when the probed epoch matches the baseline (or the baseline is null / epoch unknown) does the normal recovery-to-active path run. The manual recheck endpoint returns `{ recovered: false, status: 'needs_attention' }` on `'reset_detected'`.
- **`needs_attention`-peer reset probe** — closes design §4.1's remaining sub-case. A reset peer can reach `needs_attention` via the **auth-failure path** — its HTTP is up but returns 401/403 because the new incarnation has no peer row for us, so `consecutive_auth_failures` crosses `AUTH_FAILURE_THRESHOLD` — **without ever transitioning through `unreachable`**. The `unreachable`-only 5-second recovery probe therefore never observes its epoch change, so no journal is created; a later manual Re-peer would then run `healResetIncarnation` with no journal row → no heal → the split-brain persists. The shared per-peer unit is **`detectResetForPeer(peer)`** (`utils/federationRecovery.ts`): for a peer with a non-null baseline it runs one `probePeerReachable` (`/instance/info` GET) and calls `markPeerReset` on an observed epoch mismatch. It is invoked from **three** places, so detection latency is near-zero rather than up to a full health-check cycle:
  1. **Event-driven, at the transition** — the instant the outbox worker moves a peer to `needs_attention` on the auth-failure threshold (`federationWorker.ts`), it fires `detectResetForPeer` for that peer (fire-and-forget). This is the common live case: the moment the connection is declared broken, the epoch is checked and "Re-peer & heal" surfaces immediately.
  2. **Worker-startup sweep** — `startFederationWorkers()` runs `detectResetOnNeedsAttentionPeers()` once on boot, catching any peer already parked in `needs_attention` (reset while this instance was down, or transitioned before this probe shipped).
  3. **15-minute health-tick backstop**: `detectResetOnNeedsAttentionPeers()` also still runs at the end of `processHealthCheckTick` as the periodic safety net. It selects peers with `status='needs_attention'` AND `peer_instance_id IS NOT NULL` AND `status_reason` not already `peer_reset_detected` (those already carry a journal) and calls `detectResetForPeer` on each.
  **Detection only:** unlike `recoverOrDetectReset`, none of these ever flips a `needs_attention` peer to `active` (a match / unknown / unreachable result is a pure no-op) — that peer's secret is desynced and only an admin-authenticated re-peer restores trust. Neither `peer_instance_id` nor `hmac_secret` is touched.

Legacy peers advertise no epoch (`instanceId` null), so detection requires a non-null observed epoch differing from a non-null stored baseline — legacy peers never trigger it, and the existing `auth_failures → needs_attention → manual Reset` path continues unchanged for them.

### Limbo-window user error (`peer_reset_pending`)

Between reset detection (`markPeerReset`) and the admin's one-click Re-peer, the stale identity graph still exists and no heal has run (design §5.3). During this window a user re-adding a same-name friend, or creating a DM to that origin, would otherwise hit a confusing `already_friends` (stale friendship bound to the dead incarnation) or `peer_rejected` (the peer now sits in `needs_attention`, tripping `ensurePeered`). Both user-facing hot paths short-circuit with a clearer **409 `{ error: 'peer_reset_pending' }`**:

- **Friend-add** (`social.ts` `POST /api/social/requests`, federated branch): after `resolveOriginFromHostname` yields `peerOrigin` and **before** the peering/lookup/`already_friends` checks.
- **DM-create** (`dm.ts` `POST /api/dm`, `homeUserId + homeInstance` branch): before stub creation, so no un-flagged stub is left behind. The target origin is resolved with `resolveOriginFromHostname(new URL(canonicalizeHomeInstance(homeInstance)).host)`.

Both perform an **O(1) point lookup** on the `federation_reset_events` origin PRIMARY KEY (`origin = peerOrigin AND resolved_at IS NULL`). `peerOrigin` (from `resolveOriginFromHostname`, which returns the stored `federation_peers.origin` verbatim) is exactly the string `markPeerReset` journals, so the query is a single indexed hit/miss. The guard **only** short-circuits when an unresolved row exists; the common case — no reset in progress — is one indexed miss and the normal path proceeds byte-for-byte unchanged. Once the admin re-peers and `healResetIncarnation` resolves the journal (`resolved_at` set), the guard stops firing and the freshly-clean graph accepts the re-add.

### Data Self-Heal (`healResetIncarnation` — `utils/federationReset.ts`)

Detection (`markPeerReset`) only snapshots + journals + notifies; it destroys nothing. The actual heal is `healResetIncarnation(origin, newEpoch, reason)`, fired from `onPeerActivated` (`utils/federationPeerActivation.ts`) **after an admin-authenticated re-peer**, keyed to the confirmed epoch change (design §6). It runs **before** the mutation-log re-sync in `onPeerActivated` so re-sync repopulates onto a clean slate, and it runs **outside any transaction** (`tombstoneUser` opens its own; better-sqlite3 throws on a nested `BEGIN`).

**Two mandatory guards, in order:**

1. **Reason gate.** `onPeerActivated` fires on non-handshake paths too. Only genuine re-handshake reasons carry a freshly-exchanged, trustworthy epoch. `healResetIncarnation` returns immediately unless `reason` is in the allow-list `HANDSHAKE_ACTIVATION_REASONS` (typed `ReadonlySet<PeerActivationReason>`): `initiate_accepted`, `accept_new`, `accept_pending`, `accept_rejected_override`, `accept_awaiting_approval`, `accept_awaiting_approval_fallback`, `approval_handshake`, `ensure_peered`, `stale_peering_verified` (a parked row activated by a signed `/epoch` round-trip, whose epoch is authenticated). The two EXCLUDED reasons — `health_check_recovery` (reachability flip in `markPeerRecovered`) and `startup_bootstrap` (boot re-scan) — flip a peer to `active` **without** a handshake, so their baseline is stale (still equals the journaled `dead_epoch`). Without the gate they would hit the `deadEpoch === newEpoch` false-alarm branch and silently resolve the journal + clear the flags WITHOUT healing, permanently burying the bug. Gated out, they leave the journal fully intact for a later genuine re-handshake to heal.

2. **Epoch comparison (false-positive guard).** For a gated-in reason, look up the UNRESOLVED `federation_reset_events` row for the origin (none → return):
   - **`journal.dead_epoch === newEpoch`** — the re-peer confirmed the SAME incarnation (spurious/spoofed detection, or an admin re-peer to a never-reset live peer). **NO tombstone** — the user-level snapshot flags alone must never authorize destruction; only a confirmed epoch change does. Clears `federation_heal_pending` for the origin and resolves the journal (`new_epoch`, `resolved_at`).
   - **`journal.dead_epoch !== newEpoch`** — a GENUINE new incarnation. Soft-tombstones the flagged **pure stubs** only, then clears their flags and resolves the journal.

**Soft-tombstone (pure stubs only).** For every user that is `federation_heal_pending = 1` AND `password_hash = '!federation-replicated'` (pure S2S stub sentinel) AND matches the origin (`homeInstanceMatch`), calls `tombstoneUser(uid, { purgeContent: false })`. The `purgeContent: false` is **non-negotiable** — the default (`true`) irreversibly deletes this box's reactions and authored space messages, violating the invariant that a remote's reset never destroys our non-re-syncable content. The soft tombstone clears exactly the relationship rows that cause the bug (`friends`, `friend_requests`, group `dm_members`, …) so stale friendships/DMs clear and re-adds work. A **1-on-1** `dm_members` row is now KEPT and anonymized so the survivor retains a read-only "Deleted User" thread — see `dm-system.md` § "DM Tombstone Semantics". Flags are then cleared **keyed by the stub id list** (not by re-querying the sentinel — `tombstoneUser` has already randomized `password_hash`).

**Live co-member update.** Around each stub, the heal loop now broadcasts a sanitized `user_updated` so survivors' clients flip the partner to "Deleted User" without a reload — aligning this path with the other three deletion callers (admin/self/identity-delete). For each stub it captures `collectDeletionBroadcastTargets(stub.id).targetUserIds` **before** `tombstoneUser` (which deletes the DM/friend/space rows that set is derived from), then re-reads the tombstoned row and calls `connectionManager.sendToUser(targetId, { type: 'user_updated', user: sanitizeUser(deletedRow) })` for each target.

**Real federated accounts — detach (design §6.3b, revised by the 2026-07-02 orphaned-account-detach spec).** A flagged user that is NOT a stub (`password_hash != '!federation-replicated'`) carries real, non-re-syncable local content and is **never** auto-tombstoned. In the genuine-reset branch, after the stub soft-tombstone loop, `healResetIncarnation` calls `quarantineOrphanedAccounts(origin)`:

- For every flagged real account (`federation_heal_pending = 1`, non-stub, `isDeleted = 0`, `homeInstanceMatch`): set `federation_home_orphaned = 1` and clear `federation_heal_pending`. **That is all** — this is a flag-only **detach**, not a freeze.
- **`federation_home_orphaned = 1` means "DETACHED / sovereign local account,"** not "frozen." The account was cut loose from its (now-reset) home instance and operates as a purely local account from here on: it logs in with its **local password** (`auth.ts` no longer blocks a detached account before password verify — only the self-heal branch is permanently disabled for it, see `auth.md` §4), and it gains local profile edit + local change-password (`users.ts`). There is **no login freeze**.
- **No rename.** The username is preserved — first-come-first-served on this instance. There is **no `!orphaned:{uid}@{domain}` handle-freeing** and **no space-owner special case**: all real accounts are treated uniformly and owners simply keep managing their spaces.
- **What closes the post-re-peer hijack** is NOT a login freeze. It is the combination of (a) the login self-heal being **permanently disabled** for detached accounts (`auth.ts` returns 401 in the failed-local-password branch without contacting the home domain — a new incarnation can never re-hash its way in) and (b) the S2S identity-binding guards, which **exclude detached rows** on every domain-keyed surface: `findFederatedUser` tier-2 (`federation_home_orphaned = 0` predicate, ~line 3522), the S2S `profile_update` handler (accept-and-skip, ~line 6162), the S2S `presence_update` handler (accept-and-skip, after the domain-collision check), the `hydrateReplicatedUserProfile` fill-empty path (no-op early return alongside the native-user skip), and the S2S `DELETE /api/federation/identity` guard (idempotent 200, no deletion, ~line 2357). Every domain-keyed **mutation** that a tier-1 (`homeUserId`) hit can reach is guarded at its own site — a tier-1 hit on a detached row is a legitimate historical read, but no write is applied. See "S2S Identity Deletion" above and design §4.3.
- Content (space messages, memberships, reactions) and usernames are preserved in all cases. No `user_updated` broadcast is emitted (nothing visible changes). The returned count refreshes the journal's `orphaned_account_count`.

**Login self-heal epoch guard (design §6.3a).** The federated password self-heal (`auth.ts` §4) gates re-hashing on the home instance's current epoch, read via the authenticated `fetchPeerEpoch(peer)` (HMAC-signed both ways): no baseline on record → allow (legacy); baseline differs from the fetched epoch → refuse; epoch can't be determined (`fetchPeerEpoch` null — 404/unreachable/bad-sig/desynced secret) → **fail closed/refuse**; match → allow. This closes the *pre*-re-peer hijack (a reset home accepting a new same-name user's password during the undetected-reset window). The *post*-re-peer window is closed by detach: once an account is detached, its self-heal path is permanently disabled and the S2S binding guards exclude it (above), so the new incarnation has zero influence over it. Full three-way in `auth.md` §4.

**Reset-events admin surface (`GET /api/federation/reset-events`).** Admin-only. Returns the durable `federation_reset_events` journal (each event carrying a nullable `acknowledgedAt`) joined with each origin's current detached real accounts (`federation_home_orphaned = 1`, `homeInstanceMatch`), each with `ownedSpaces`, `spaceMemberCount`, and authored-`messageCount` for disposition. Response type `FederationResetEventsResponse` (`{ events: FederationResetEvent[] }`, each event carrying `orphanedAccounts: FederationOrphanedAccount[]`). The endpoint returns **all** events (including acknowledged ones, for audit); the client filters to `acknowledgedAt === null`. Disposition actions — one-click Re-peer (`/peers/:id/reset` → `/peer/initiate`), full-purge Remove (`DELETE /api/admin/users/:id`, owns-spaces → transfer first) for genuinely-abandoned detached accounts, and a non-destructive **Dismiss** (`POST /api/federation/reset-events/acknowledge` with `{ origin }`, idempotent — sets `acknowledged_at`) that hides the card without touching the accounts (detached accounts keep working locally). See `admin.md` "FederationPanel" and `client-federation.md` §8.

**`statusReason` on the peer API.** `GET /api/federation/peers` returns `statusReason` per peer (`FederationPeerStatusReason | null`, see [Peer state](#peer-state)), so the admin UI tells a reset-detected peer (persistent Reset-cleanup banner and one-click Re-peer) from a generic auth-failure peer (plain "Reset Peering"), from a peer whose Re-peer could not be verified (`repeer_incomplete`), and each kind of rejected peer apart. The panel shows the reason on the peer row.

### Trust re-establishment contract

The peering handshake must never report success when trust was not actually re-established: a false success re-creates the permanent HMAC desync ("split-brain") the epoch feature exists to prevent. Two rules make it honest end to end, and an unauthenticated `/peer/accept` never adopts a caller's secret over an established (`active`, `unreachable` or `needs_attention`) row; no path re-keys one automatically.

**1. Responder honest refusal (`POST /api/federation/peer/accept`).** When a peer row already exists in `active`, `unreachable` or `needs_attention`, the endpoint returns `409 { accepted: false, code: 'PEER_EXISTS_RESET_REQUIRED', error, instanceName, instanceId }` instead of the old false `200 { accepted: true }`. It still does not adopt the caller's `hmac_secret` (identical guard behavior — only the reported status/body changed), and the epoch-mismatch `markPeerReset` detection still fires before the return. Legacy initiators that only read `response.ok` now fail loudly instead of silently desyncing; new initiators special-case the code.

**2. Initiator verify-before-activate (every sender).** All four senders of `/peer/accept` (auto-peering, `/peer/initiate`, both approval handlers) settle through `runOutboundHandshake` ([Sending a handshake](#peer-state)). On a 200 the sender runs a signed `/epoch` round-trip with the secret it sent before activating; the verified epoch becomes `peer_instance_id` (the 200 body's epoch is not signed and is not used as the baseline). Unverified: `needs_attention` / `repeer_incomplete` (`/peer/initiate` answers `200 { peer, verified: false }`). On `409 PEER_EXISTS_RESET_REQUIRED` the row is parked as `rejected` / `stale_peering_on_remote` rather than retried or deleted; the remote's own Re-peer is accepted on it ([Peer state](#peer-state), "A remote that holds an older peering with us").

**Recovery flows.**
- **Common reset case (one click from the survivor).** When the reset box makes contact, the survivor's detection (`markPeerReset`) moves the survivor's row to `needs_attention`. The survivor's **Re-peer** (reset local row → `/peer/initiate`) then lands on the reset box's clean responder slot → both sides re-key and the initiator verifies via `fetchPeerEpoch` → both active with a matching secret. If the reset box initiated first, the survivor's 409 refusal (rule 1) parks the reset box's row as `rejected` / `stale_peering_on_remote` rather than activating it, and the survivor's later Re-peer is accepted on that row. The exact sequence on both instances is under [Peer state](#peer-state).
- **Bidirectional-stale case.** If both sides still hold a conflicting row, each side that holds one must reset once — the honest `409` / `verified:false` reporting tells the admin exactly that ("the remote still holds stale peering for you; its admin must reset their side, then Re-peer again"), instead of falsely reporting success on a dead peering.

**Backward compatibility.** A server whose `/api/federation/epoch` answers 404 cannot be verified, so any sender parks it in `needs_attention` (`repeer_incomplete`) rather than activating: a responder that returns 200 without adopting the secret is otherwise indistinguishable from a healthy fresh peering. `/epoch` shipped on 2026-07-01, before v1.0.0, so no released Backspace version is affected; only a build from before that date or a server that is not Backspace is.

**Handshake `sourceOrigin` honors `PUBLIC_ORIGIN`.** `resolveLocalOrigin()` (`routes/federation.ts`) now delegates to `getOurOrigin()`, so the origin advertised in the handshake `sourceOrigin` is byte-identical to the `X-Federation-Origin` used for all authenticated S2S requests. Previously it used `https://${DOMAIN}` and ignored `PUBLIC_ORIGIN`, which silently desynced the responder's peer-row key from the auth origin on any instance where `PUBLIC_ORIGIN != https://DOMAIN` — producing permanent `403 Not peered`. See "Public Origin Override" below.

**Verification harness.** The self-contained two-instance integration harness (`packages/server/test/helpers/realHandshake.ts` + `packages/server/test/federation-handshake-desync.test.ts`) exercises the REAL cross-instance handshake — actual `/peer/initiate`→`/peer/accept`, the signed `/epoch` health probe (`s2sHealthy`), and `simulateReset`. Each instance is a real server **spawned as a child process** (`tsx src/index.ts`) on an ephemeral loopback port with its own temp DB and generated secrets — not an in-process Fastify app: `config`, `getDb()`, the snowflake worker id, `connectionManager` and the replay-nonce store are all process-global singletons, so two instances cannot share one process. Here every instance also sets `PUBLIC_ORIGIN` to its `http://127.0.0.1:<port>` transport URL. Case #1 is the clean-handshake control; #2 gates the responder-refusal fix (BUG-1); #4 gates one-click Re-peer recovery (BUG-2).

**Two-instance e2e suites (`packages/server/test/federation-e2e-*.test.ts`).** Built on the same spawned-process harness plus `test/helpers/federationE2E.ts`, these gate the relay security fixes end to end — two peered instances, real HMAC-signed HTTP, no Docker/Caddy/LiveKit. They peer exclusively through the real handshake; no suite seeds a `federation_peers` row.

Two harness profiles exist because production collapses three origins into one string (`https://${DOMAIN}`: federated identity, transport URL, and `federation_peers.origin`) and loopback cannot:

| Profile | `PUBLIC_ORIGIN` | What it makes real | Suites |
|---------|-----------------|--------------------|--------|
| `bootIdentityPeered` | unset → `https://<DOMAIN>` | Distinct identity domains, so `extractDomain` can tell three instances apart. The handshake leaves the initiator a transport-keyed peer row and the responder an identity-keyed one, so **inbound** relay is fully real. | attribution, stub-claiming, reply-confinement |
| `bootTransportPeered` | `http://127.0.0.1:<port>` | Identity == transport == peer key, so **outbound** routing (`getGroupDmTargetOrigins`, `sendCallRelay`) resolves to a live peer and the outbox worker really delivers. Federation workers and synthetic LiveKit credentials are enabled. | relay-scoping, call-addressing, outbox-delivery |

`test/helpers/relayTap.ts` is a transparent recording reverse proxy placed in front of a peer: it records every S2S request and forwards it verbatim (same bytes, so the HMAC still verifies), so peering and delivery behave normally while the wire stays readable. It exists because two claims are only observable in transit — which instances a `dm_call_start` was addressed to and which room tokens each payload carried, and whether an all-local DM's create *and* its delete were both broadcast (a leaked pair leaves the receiver's DB looking exactly like a conversation that was never relayed).

Two more tap controls exist for delivery tests: `holdRelayResponses()` forwards relay POSTs but holds the receiver's answers until released (the receiver has applied the batch, the sender has not heard back: the on-the-wire window), and `failNextRelays(n)` answers the next `n` relay POSTs 503 without forwarding them.

**Relay waits and their failure report.** A suite waits for a worker-delivered relay with `waitForRelay(check, { sender, receiver, peerOrigin?, what, timeoutMs? })` from `federationE2E.ts`, not a bare `waitUntil`. On timeout it throws with `describeRelayState`: the sender's peer rows (status, failure counters, last seen/failed, probe pacing), the sender's outbox entries for the receiver's peer row (event type, entity, attempts, next retry, age; the outbox has no delivered flag, so no entry means nothing is waiting), and the last 40 lines of both instances' logs, where the worker writes every failed attempt and rejection. The logs are quoted because `cleanup()` deletes the run directory. `waitForOutboxDrained` waits until the sender has nothing queued or on the wire for a peer.

`packages/server/tsconfig.e2e.json` type-checks these suites and the shared helpers; the main server `tsconfig.json` includes only `src/**/*`, so nothing under `test/` is otherwise compiled. CI runs both (`typecheck:e2e`, then `pnpm -r test`) inside the required "Build & test" job.

### S2S Identity Deletion (`DELETE /api/federation/identity`)

Allows a home instance to remove a user's replicated identity from a remote instance.

**Request body:**
```json
{ "homeUserId": "<string>", "homeInstance": "<string>", "mode": "soft" | "full" }
```

**Behavior:**

- **Attribution guard:** Rejects with `403` if the user's `homeInstance` doesn't match the `X-Federation-Origin` of the signing peer. Prevents one instance from deleting another instance's users.
- **Detached-account guard:** After the attribution guard, if the resolved user has `federation_home_orphaned = 1` (detached — its home domain was reset and it is now a sovereign local account, see §4.2/§4.3 of the orphaned-account-detach design), returns an idempotent `200 { success: true }` **without deleting**. A new incarnation on the reset domain must never delete an established account by replaying its old `homeUserId`.
- **Idempotent:** Returns `{ success: true }` for already-deleted or nonexistent users (no error).
- **Owned spaces check:** Returns `409` with `{ ownedSpaces: string[] }` if the user owns any spaces on the remote. The user must transfer or delete those spaces before identity removal proceeds.
- **Mode `"soft"`:** Calls `tombstoneUser(uid, { purgeContent: false })` — anonymizes the user row and removes the user from spaces, friends, DM membership (`dm_members`), and read-states. The `purgeContent: false` flag skips only `reactions`, `dm_reactions`, and the user's space `messages` (with attachments + embeds); DM membership cleanup and orphaned-DM purge always run in both modes (per `userDeletion.ts:121-126, 169-202`) because zero-member DM channels are unreachable garbage regardless of authorship retention.
- **Mode `"full"`:** Calls `tombstoneUser(uid, { purgeContent: true })` — full tombstone including reactions and orphaned DM cleanup.
- **Post-deletion:** Broadcasts `member_left` WS events for all spaces the user belonged to before removal.

### S2S User Lookup (`POST /api/federation/users/lookup`)

HMAC-authenticated. Rate-limited to 60 requests/minute per peer. Used by the cross-instance friend-add flow to resolve a username on this instance before the sender's home server queues a `friend_request_create` event (see `social.md` §6 outbound flow).

**Request body:** `{ username: string }` — server trims and lowercases before lookup.

**Response 200:** `{ found: true, user: { homeUserId, username, profile: { displayName, avatar, avatarColor, banner, bio } } }` — returned for native, non-deleted users regardless of their `discoverable` setting.

**Response 404:** `{ found: false, code: 'user_not_found' }` — returned for tombstoned users (`isDeleted=1`), replicated stubs (`homeInstance IS NOT NULL`), or unknown usernames.

**Response 400:** Malformed input (missing, non-string, or empty-after-trim `username`).

**Response 429:** Per-peer rate limit (60/min) exceeded; `Retry-After` header set.

**Filter invariant:** `discoverable` is NOT consulted — exact-handle resolution must work for opted-out users. This mirrors the Direct-Add invariant from social.md commits 69d430b/c60ecc5/189cac4: discovery surfaces only opted-in users, but once you have a handle you can always send a request.

### WebSocket Events (Peering)

These S→C events are pushed to the acting user's connected clients by the federation subsystem.

| Event | Pushed when | Payload |
|-------|-------------|---------|
| `federation_peer_rejected` | A peer enters `rejected` (any reason) or `needs_attention` / `auth_failures`, sent to the local users who had something queued for it | `{ peerOrigin, peerLabel?, reason, reasonCode?: FederationPeerStatusReason, affectedContexts }`. `reason` is English fallback text; clients show localized text for `reasonCode` |
| `federation_peer_active` | A peer enters `active`, from any state, sent to every online user | `{ peerOrigin: string }` |
| `federation_peer_reset_detected` | A peer's advertised instance epoch differs from the trusted baseline (wipe-and-reinstall on the same domain) — emitted by `markPeerReset` after routing the peer to `needs_attention` | `{ origin: string }` (admin-only, via `sendToAdmins`) |

---

## 1b. Outbound Requests

Requests this instance addresses to a peer's federation endpoints go through
`federationFetch` (`utils/federationFetch.ts`). It takes the peer origin, the
federation path, the fetch init, and one more argument: how this instance came
to know the origin.

```ts
export type OriginTrust = 'approved' | 'asserted';
export async function assertPeerOriginAllowed(origin: string, trust: OriginTrust): Promise<void>;
export async function federationFetch(origin: string, path: string, init: RequestInit, trust: OriginTrust): Promise<Response>;
```

### Origin trust

| Trust | Where the origin came from | Address rule |
|-------|---------------------------|--------------|
| `approved` | a `federation_peers` row, or the body of an admin-authenticated request | any address |
| `asserted` | a party with no settled peering relationship: a peering-request row a remote wrote, a handle a local user typed, a callback to a request that was never accepted | must resolve to a publicly routable address |

Both levels run the same format checks first. The origin must parse, must be
`http:` or `https:`, and must carry no path, query or fragment, because an
origin is scheme plus host plus port and nothing else. A value that fails those
checks is a bug in whatever wrote it, wherever it came from, so it is refused at
both levels rather than joined to a federation path.

`approved` allows a private address deliberately. Peering across a LAN is a
supported deployment shape, and the two-instance test harness peers on
loopback. A rule of the form "peer origins must be public" would break both.
What makes this level safe is not the address, it is that an admin named the
origin or that the origin is already a row in the peer table.

`asserted` is the level for an origin nobody on this instance has ruled on. It
must resolve to a public address, so the party that supplied it does not get to
choose which hosts this instance opens a connection to. The gate resolves the
hostname once and classifies the result with `classifyAddress`
(`utils/ipClass.ts`); anything the classifier does not read as `public` is
refused, and an origin that does not resolve at all is refused too.

The two levels do not circle back on each other. A `federation_peers` row only
exists because the outbound path that created it was itself gated: either an
admin typed the origin into `/peer/initiate`, or the handshake that created the
row ran as `asserted`.

### Call sites

18 outbound sites carry a peer origin: 13 `approved`, 5 `asserted`.

| Trust | Sites |
|-------|-------|
| `approved` | `federationEpoch` (`/epoch`), `federationLookup` (`/users/lookup`, `/users/by-home-id`), `federationAttach` (`/verify-attach-proof`, `/users/by-home-id`), `federationOutbox` (`/relay`), `federationWorker` (`/relay`, `/peer/rotate`), `federationSync` (`/sync`), `federationRecovery` (`/api/instance/info` reachability probe), `routes/users.ts` (`/identity`), `handlers/peerAdmin.ts` (`/peer/rotate`), `handlers/peerHandshake.ts` (`/peer/accept`) |
| `asserted` | `handlers/approvals.ts` (`/peer/accept` from the inbound and outbound approve branches, `/peer/denied` from the deny branch), `federationPeering.ts:performHandshake` (`/peer/accept`), `storageJanitor.ts` (`/peer/denied` on request expiry) |

**Trust is a property of the caller, not of the function.** `performHandshake`
is the clearest case: it runs only when no settled peer row exists, and its
origin reaches it from a handle a user typed (friend-add) or from
`POST /api/federation/peer/ensure`, which carries `authenticate` and nothing
more, so any logged-in user can call it. It is `asserted` wherever it runs.

Two sites read as asserted from the outside and are not:

- `handlers/peerHandshake.ts` issues `/peer/accept` from `/peer/initiate`,
  which carries `preHandler: [authenticate, requireAdmin]`. The origin is the
  admin's own request body, already through `validateOrigin`. Classifying it
  `asserted` would break admin-initiated LAN peering, which `validateOrigin`
  deliberately supports.
- `federationRecovery.ts:probePeerReachable` has two callers and both iterate
  `federation_peers` rows with `status='unreachable'`: the recovery tick in
  `federationWorker.ts` and the admin-only recheck route in `peerAdmin.ts`. No
  unapproved origin reaches it, and a private peer stays probeable.

### `FEDERATION_ALLOW_PRIVATE_PEERS`

Default `false`, read as `config.federation.allowPrivatePeers`. While it is off,
the `asserted` address rule above applies. Turning it on skips that rule, so an
asserted origin may resolve to a private address. `approved` is unaffected
either way, which is why admin-driven peering with a peer on a private address
works the same in both settings.

Two situations call for it:

1. **A LAN-only deployment**, where every instance sits on a private address and
   users add each other by handle. The asserted path has to be allowed to reach
   a private address there, or handle-driven peering cannot work at all.
2. **The two-instance test harness** (`test/helpers/twoInstanceHarness.ts`),
   which spawns every instance on `127.0.0.1` and sets the flag for exactly the
   same reason. It is set there and only there.

Off is the shipped default so that an instance reachable from the public
internet gets the narrower behaviour without configuring anything, and the
operator opts in knowingly. Documented in `.env.example`.

### Redirects

`federationFetch` sends with `redirect: 'manual'` and does not follow. Every
federation endpoint answers directly, so a 3xx from a peer means the peer is
misconfigured or the response is pointing the request somewhere else. Callers
see the 3xx and handle it through the non-2xx branch they already have.

### Other outbound paths

Not every outbound request is addressed to a federation endpoint. The rest of
the map, so the inventory stays complete:

| Path | Helper | Notes |
|------|--------|-------|
| Replicated profile assets (`routes/federation/profile.ts`) | `safeFetch` (`utils/ssrf.ts`) | Fetches a file URL rather than a federation endpoint. Redirects are followed, with every hop's destination re-validated first, and the body is capped at `MAX_PROFILE_ASSET_BYTES` (8 MiB). See [Profile Image File Replication](#profile-image-file-replication). |
| Federated file replication (`federationWorker.ts`) | `safeFetch` | Same helper, same per-hop re-validation. See [File Download Worker](#file-download-worker-federationworkertsprocessfilequeueentry). |
| Link embeds, metadata scraping, invite snapshots | `safeFetch` | Not federation traffic at all. See `docs/systems/embeds.md` §3. |
| Federated login self-heal (`routes/auth.ts`) | its own request | Posts to `https://${user.homeInstance}`, a value stored on the user row, over a fixed path. Scheme is forced to `https`. See `docs/systems/auth.md` §4. |
| GIF search proxy (`routes/gif.ts`) | its own request | A fixed provider host, no caller-supplied origin. |

---

## 2. HMAC Request Authentication

### Signing Format

```
HMAC-SHA256(secret, "${timestamp}.${requestBody}")
```

Where `timestamp` is `Date.now()` (Unix milliseconds) and `requestBody` is the JSON string.

### HTTP Headers

| Header | Format | Example |
|--------|--------|---------|
| `X-Federation-Signature` | `sha256=<hex>` | `sha256=a1b2c3...` |
| `X-Federation-Origin` | Full URL | `https://nova.ddns.net` |
| `X-Federation-Timestamp` | Unix ms string | `1711619400000` |
| `Content-Type` | `application/json` | -- |

### Verification (`federationAuth.ts:verifySignature`)

1. Validate inputs: reject empty/missing body, signature, or secret
2. **Timestamp window:** `Math.abs(Date.now() - timestamp) <= maxAgeMs` (default 15 minutes)
3. Recompute: `HMAC-SHA256(secret, "${timestamp}.${body}")`
4. **Constant-time comparison:** `crypto.timingSafeEqual` on hex-decoded buffers
5. Length check: mismatched buffer lengths are rejected before `timingSafeEqual`

### Replay Attack Prevention

Two layers of replay protection:

1. **Timestamp window:** Requests older than 15 minutes are rejected (`DEFAULT_MAX_AGE_MS`).
2. **Nonce:** Each request includes a `X-Federation-Nonce` header (UUID v4). The nonce is included in the HMAC payload (`${timestamp}.${nonce}.${body}`) so it cannot be stripped. The receiver stores seen nonces in memory (keyed by peer origin, evicted after 15 min) and rejects duplicates with `409 Conflict`.

**Auto-ratchet:** The `nonceSupported` column on `federation_peers` tracks whether a peer has ever sent a nonce. Once set to `1`, nonce-less requests from that peer are permanently rejected (`401`). This allows graceful rollout — new peers get nonce enforcement automatically, legacy peers are warned in logs until they upgrade.

### Inbound Verification Flow (`POST /api/federation/relay`)

1. `parseFederationHeaders()` extracts origin, timestamp, signature, and nonce from headers
2. Look up peer by `origin` in `federation_peers` -- must exist and be `status = 'active'`
3. Re-serialize request body to JSON: `JSON.stringify(request.body)`
4. `verifySignature(bodyString, signature, peer.hmacSecret, timestamp, nonce)` -- reject if false
5. Nonce enforcement: duplicate nonce → 409, missing nonce from ratcheted peer → 401, legacy peer → warn
6. **Source-to-peer binding:** `normalizeOriginForCompare(body.sourceInstance)` must equal `normalizeOriginForCompare(peer.origin)` -- otherwise `403`

**Source-to-peer binding.** The HMAC proves *who sent* the request; `body.sourceInstance` is only what the body *claims*, and every per-event attribution check downstream reads it. Step 6 collapses the two: a batch is only processed when its claimed origin is the peer that actually signed it. An honest sender always stamps its own `getOurOrigin()` there (`federationWorker.ts`), so a mismatch is never a legitimate configuration -- it is one peer speaking as another. `processRelayEvents` re-asserts the same equality as a structural invariant and rejects every event in the batch with `source_peer_mismatch` if it does not hold, so no caller -- HTTP or in-process (`federationPeerActivation.ts` initial sync) -- can feed the pipeline a source the peer did not prove.

**Important:** The body is re-serialized server-side. This means Fastify's JSON parsing and re-stringification must produce identical output to the sender's `JSON.stringify`. In practice this works because both sides use standard `JSON.stringify` with no custom replacers.

**Relay-envelope epoch (fast-path baseline population, design §3.2).** `FederationRelayRequest` carries `sourceInstanceId?: string` — the sender stamps its current epoch (`getInstanceId()`) when building the request in `federationWorker.ts`. Because the whole body is HMAC-verified above (step 4), a valid relay authentically carries the sender's current incarnation id. Immediately after the signature check passes (and only there — the authenticated boundary), the receiver runs **populate-if-null**: `if (sourceInstanceId && peer.peerInstanceId IS NULL) UPDATE federation_peers SET peer_instance_id = <claimed> WHERE id = ? AND peer_instance_id IS NULL`. This is the *fast-path* baseline populator — it fills the trusted epoch the instant organic traffic flows, usually before the deterministic 15-minute `refreshPeerEpochs` backstop fires. It **never overwrites** a non-null baseline: a differing incarnation implies a different HMAC secret that would have failed verification, so a valid relay can never carry an epoch differing from an established baseline. Runs independent of per-event processing and does not affect relay accept/reject. Backward-compatible: older peers omit `sourceInstanceId` → the update is skipped (no-op).

---

## 3. Identity Resolution

### Functions

**`extractDomain(homeInstance)`** -- `federation.ts`
- Extracts bare domain from a homeInstance value (full URL or bare domain)
- `"https://nova.ddns.net"` → `"nova.ddns.net"`, `"nova.ddns.net"` → `"nova.ddns.net"`
- **Use when:** Normalizing homeInstance for comparison or storage

**`findFederatedUser(homeUserId, homeInstance, db, hints?)`** -- `federation.ts`
- Three-tier lookup: homeUserId match → domain + username hint match → not found
- Tier 1: the identity itself, via `resolveRelayActor(homeUserId + homeInstance)`. When it reports `mismatch` (the `homeUserId` belongs only to local rows of another identity) the lookup stops: nothing is returned and tier 2 is not tried, so the id can neither reach those rows nor bind a stub by username
- Tier 2: uses `extractDomain(homeInstance)` + `hints.username` to match rows created by the auth registration path without a home id. **A username match binds only a row that has no `homeUserId` yet** (`home_user_id IS NULL`); `backfillHomeUserId` then records the id on it. A row that carries a home id is already one identity: tier 1 finds it by that id, and a name must never make it stand for a different one
- **Tier 2 excludes detached accounts** (`federation_home_orphaned = 1`): a detached account is sovereign and must never be re-bound to the reset domain's new incarnation via username heuristics — that is exactly how a new same-name user would capture the established account. **Tier 1 (`homeUserId` match) is deliberately NOT excluded:** the new incarnation mints fresh `homeUserId`s, so a tier-1 hit on a detached row is a legitimate historical reference (e.g. an old group-DM attribution relayed by a third instance), not the new incarnation. Mutations are blocked at their own sites (profile_update handler, presence_update handler, `hydrateReplicatedUserProfile` fill-empty, S2S identity delete), and `attributionRefusal` never accepts a detached identity as the actor of a relayed event from its old home domain (see "Attribution verification", case 1).
- Side-effect-free — does not modify any records
- When multiple candidates match in tier 2, prefers real accounts over stubs, then most profile data
- **S2S-only.** Neither tier is proof of control over the named identity: tier 1 matches the `homeUserId` + `homeInstance` pair a caller names, and tier 2 matches a domain plus a username hint. Both are safe behind the HMAC-authenticated S2S channel, where the caller is an admin-approved peer and attribution is separately verified. **Never call this from an unauthenticated route.** In particular `POST /api/auth/register` does not — see `auth.md` "Federated Registration Never Claims an Existing Row".
- **Use when:** Read-only lookup, on an authenticated S2S path, that needs to find users created by either auth or relay path

**`resolveLocalUser(homeUserId, db)`** -- `federation.ts`
- Read-only lookup. Returns `undefined` if not found.
- Matches: `(users.homeUserId = homeUserId)` OR `(users.id = homeUserId AND homeInstance IS NULL)`
- Excludes deleted users (`isDeleted = 0`)
- When multiple candidates exist: prefers the one with `homeUserId` set (replicated stub) over a local ID match
- Ignores `homeInstance`, so it is **not** an identity lookup: never use it to resolve the acting identity of an inbound relay event (use `resolveRelayActor`)
- **Use when:** Optional lookups where null is acceptable and the id is not a relayed actor or party to one (a relayed `friend_request_update` resolves its requester by pair, with `resolveRelayActor`)

**`resolveRelayActor(actor, db)`** -- `routes/federation/identity.ts`
- Read-only. Resolves a federated identity (`RelayActor`, a `homeUserId` + `homeInstance` pair) to the local user that IS that identity: same candidate rows as `resolveLocalUser`; a native row is kept when its own id is the `homeUserId` and the `homeInstance` is one of this instance's own names (the host of `getOurOrigin()` or `DOMAIN`, which differ only under `PUBLIC_ORIGIN`); any other row when `sameRelayActor(relayActorOfUser(row), actor)` holds (equal home user id, same home domain)
- Returns `{ kind: 'found', user }`, `{ kind: 'unknown' }` (no live row carries the `homeUserId`; each handler keeps its own not-found answer), or `{ kind: 'mismatch' }` (the `homeUserId` belongs to local rows of a different identity). A detached row (`federation_home_orphaned = 1`) is returned as `found`: a participant or a historical reference may name one
- Also tier 1 of `findFederatedUser`, so every `resolveOrCreateReplicatedUser` caller (relay handlers and the client routes that take a `homeUserId` + `homeInstance` pair) resolves by the same rule
- Called after `attributionRefusal` accepted the same pair. `attributionRefusal` refuses a `mismatch`, and a detached identity, as `attribution_mismatch` (terminal) before any handler runs, so a handler resolving its attributed actor only ever meets `found` or `unknown`; the `mismatch` checks some handlers keep on that actor are a backstop that cannot fire. Together they hold the invariant: the user an inbound event is applied as is a live, attached user homed on the signing peer, or is one of our users with proven standing on it (homeward)
- **Use when:** Any inbound relay handler that acts as the event's actor without creating a stub: `reaction_add`/`reaction_remove` (reactor), `dm_typing_start`/`dm_typing_stop`, `read_state_update`, `dm_close`/`dm_reopen`, `friend_request_create` (the local recipient), `friend_request_cancel` (sender; recipient also resolved by pair), `friend_remove` (both sides), `friend_request_update` and `friend_add` (both sides; a pair that does not resolve holds no pending request, so nothing is created), `member_remove` (leaving or kicked user), `ownership_transfer` (previous owner, resolved before anything changes), `create` (the author is the resolved participant that IS `message`'s pair), `profile_update`/`presence_update` (the replicated row updated; anything but a `found` row homed elsewhere is acked without effect)

**`resolveOrCreateReplicatedUser(homeUserId, homeInstance, db, hints?)`** -- `federation.ts`
- Calls `findFederatedUser` first. If found, backfills `homeUserId` for future fast-path lookups and returns. On a tier-1 `mismatch` it returns `null` and creates nothing: a stub would give one id two identities here.
- Accepts optional `hints: { username?: string | null }` for tier-2 matching
- If found and `hints.username` is set, renames a row that still carries a placeholder name (`renamePlaceholderNamedStub`, see "Stub Username Backfill")
- If not found, creates a stub with `homeInstance` normalized to bare domain via `extractDomain`, then asks the home for its name and profile in the background (`scheduleHomeRecordPull`, see "Home profile pull"), unless `hints.homeAsked` says the caller just did
- Collision-safe (`firstFreeUsername`): appends `~1`, `~2`, ..., `~10` if the username exists; after 10 attempts, uses `~<random hex>`. `~` is not a handle character, so a suffixed name never takes a handle a real user of that instance can have (see "Stub Username Backfill")
- **Self-homed guard:** an instance never creates a replicated stub homed at its own identity domain (`getOurIdentityDomain()`, DOMAIN-derived). A live self-reference resolves at tier 1; a self-domain identity reaching the create path is a dead incarnation and resolves to `null`. Wire snapshots may carry `deleted: true` — such identities also resolve to `null` at the create path (existing rows still resolve for historical attribution).
- **Use when:** You MUST have a valid user ID. Always pass `{ username: profile?.username }` when profile data is available.

**`hydrateReplicatedUserProfile(user, profile, db)`** -- `routes/federation/profile.ts`
- Updates replicated stubs only (`homeInstance` must be set)
- Fills profile columns only as "S2S Profile Hydration" states: empty columns of a row the home has not answered with a version, never a stored value
- Resolves bare filenames to `{homeInstance}/api/uploads/{filename}` absolute URLs
- Sets an empty `displayName` from `profile.displayName || handleFromHint(profile.username)`: the handle a snapshot carries, never a row name such as `user@instance` an older sender sent
- Renames a row that still carries a placeholder name to `<profile.username>@<domain>` (`applyPlaceholderRename`, see "Stub Username Backfill")
- Returns the row as stored. When it changed the row (renamed, or a field filled), sends one `user_updated` with that row to `collectProfileBroadcastTargetIds` after every field is written (`announceUserUpdated`). A rename by `resolveOrCreateReplicatedUser` just before announced the row without the display name hydration fills; this is the event that carries it. A snapshot that fills nothing announces nothing

### Critical Rule

Any code path that sets `ownerId`, creates a `dm_members` row, or inserts a message MUST use `resolveOrCreateReplicatedUser`. Using `resolveLocalUser` with a `?? null` fallback can cause data corruption (e.g., `ownerId` set to null for group DMs).

### Credentials are per-instance, not per-identity

A federated identity spans instances; its **credentials do not**. Since 2026-09-02 a client-created federated account authenticates with a per-remote secret issued by the identity's home instance (`user_federation_credentials`, `POST /api/users/@me/federation-credential`), not with the account's home password — so `password_hash` on a peer is a credential for that peer alone and carries no authority anywhere else. Nothing in the S2S protocol transports it: peering is HMAC-secret based, relay attribution is `(homeUserId, homeInstance)` bound to the authenticated peer, and re-attach proves identity with a one-time home-minted token (§"S2S Detached-Account Re-Attach Proof"). Full contract in `auth.md` §5b and `client-federation.md` §1.

One coupling remains, and it predates this: the login self-heal in `auth.ts` §4 forwards a password submitted to a peer to the identity's home instance, so a password typed directly into a peer's login form is still meaningful on the home. That is the human login path, not an S2S one — see the residual-exposure note in `auth.md` §5b.

### Origin Normalization

**Two formats exist in the database:**

| Location | Format | Example |
|----------|--------|---------|
| `users.home_instance` | Bare domain (normalized) | `nova.ddns.net` |
| `federation_peers.origin` | Full URL | `https://nova.ddns.net` |
| `getOurOrigin()` return | Full URL | `https://orbit.ddns.net` |
| `resolveOrCreateReplicatedUser` stores | Bare domain (normalized via `extractDomain`) | `nova.ddns.net` |
| Auth registration stores | Bare domain | `nova.ddns.net` |

Both user creation paths now store bare domain. A self-healing migration in `migrate.ts` normalizes any existing full-URL `homeInstance` values to bare domain on startup.

**Normalization pattern used in code:**
```typescript
const normalized = homeInstance.startsWith('http') ? homeInstance : `https://${homeInstance}`;
```

Locations where normalization is applied:
- `getGroupDmTargetOrigins()` (`federationOutbox.ts`) -- normalizes before comparing to `ourOrigin`
- `dm.ts:655` -- `isLocalMember` broadcast filter checks both formats
- `dm.ts:743` -- normalizes target homeInstance before peer origin comparison

**Attribution verification (`attributionRefusal`):**

```typescript
attributionRefusal(actor: RelayActor | null | undefined, sourceInstance: string, db): AttributionRefusal | null
// RelayActor = { homeUserId: string; homeInstance: string }
// AttributionRefusal = 'attribution_mismatch' | 'attribution_unproven'
```

Returns `null` when the signing peer may speak for the actor, otherwise the reason the handler pushes into `rejected`. Handlers never write a reason of their own for this check.

The actor is passed as a **pair**. A `homeUserId` on its own is not an identity — the column is only unique within one instance — so the signature makes it impossible to attribute an event from an id alone. `sourceInstance` is the HMAC-authenticated peer (bound at the relay boundary, §2), so this is a check against *who actually signed the batch*, never against a self-declared origin.

Two valid cases:

1. **Direct**: `authorDomain === sourceDomain`. A peer is the identity authority for its own users, but not for an id that is already a different identity here: when `resolveRelayActor` reports `mismatch` for the pair, the result is `attribution_mismatch`, before any handler resolves or creates a user. The same holds when the pair resolves to a detached account (`federation_home_orphaned = 1`): its home domain was reset and no longer speaks for it.
2. **Homeward relay**: `authorDomain === extractDomain(getOurOrigin())` — a client-federation user (e.g. `erin@nova` logged into `orbit`) acted on the remote and the relay carries the event back to their home instance. Accepted **only** when `localUserStandingOnPeer(homeUserId, sourceInstance, db)` returns `proven`.

An actor homed on a third instance is always rejected: the signing peer is neither that instance's identity authority nor delegated by it.

**The two refusal reasons.**

| Reason | When | Sender |
|---|---|---|
| `attribution_mismatch` | Malformed actor; actor homed on a third instance; homeward claim for a user id with no live native row (`no_such_user`: never existed, deleted, or only a replicated stub); direct claim whose `homeUserId` belongs only to local rows of a different identity (`resolveRelayActor` reports `mismatch`) or that names a detached account | Terminal. Nothing that arrives later can make the claim true. |
| `attribution_unproven` | Homeward claim for a live native user with no registry row and no `replicated_instances` entry for the signing peer yet (`unproven`) | Retryable on the normal backoff, until the outbox TTL |

`unproven` exists because the proof is written by the user's own client, after the remote session is open (`syncRegistry` in `instanceStore.ts` runs at the end of the connect flow, and not at all until `autoConnectAll` has read the server registry once). A DM the user writes on the remote in that window reaches home before the proof does. From the receiver's side that is indistinguishable from a peer forging a claim for one of its users, so the event is refused either way and nothing is written; the reason only tells the sender whether a retry can succeed. A peer that really is forging gains nothing from the retry: its own outbox carries the cost (about 36 attempts over the 30-day TTL), and a retry is only accepted once the user has connected to that peer, which is exactly the standing that would let it speak for the user anyway.

`attribution_unproven` is a wire addition and is negotiated per request, see [Relay capabilities](#relay-capabilities). A sender that does not list it receives `attribution_mismatch` for the unproven case too.

**`localUserStandingOnPeer(homeUserId, peerOrigin, db)`** returns `'proven' | 'unproven' | 'no_such_user'`: does the natively-homed local user hold a federated account on the signing peer? This is the whole content of a legitimate homeward relay: such an event can only genuinely exist if the user connected to that peer and acted there. Two records are consulted, both written *exclusively by the user themselves* over an authenticated session on this instance:

| Record | Written by | Notes |
|---|---|---|
| `user_federation_registry` row `(user_id, origin)` | `PUT /api/users/@me/federation-registry`, scoped to `request.userId` | Any lifecycle status counts — a connection that is `disconnected` / `auth_expired` today was still real |
| `users.replicated_instances` JSON entry | `PATCH /api/users/@me`, same scoping | Client-federation topology list |

The actor must resolve to a **native** row (`home_instance IS NULL`, `is_deleted = 0`). A replicated stub that merely carries the same `home_user_id` never satisfies a homeward claim. Origins are compared with `normalizeOriginForCompare` (port-preserving), and malformed `replicated_instances` JSON fails closed.

A peer cannot forge either record, so it cannot manufacture standing to speak for a user who never connected to it. Without this binding, any admin-approved peer could relay events attributed to any local user — including auto-creating a 1-on-1 DM channel between two local users from a forged author pair.

**Residual, in-model exposure:** an instance the user *has* connected to can act as them there — that is what holding an account on it means. Connecting to a remote is therefore a trust decision about that operator, and disconnecting does not revoke it (registry rows persist by design, so history keeps resolving). This is a property of the federation model, not a gap in the check.

**Coverage.** Applied as the FIRST check in every relay event processor, before user resolution or any DB write:

| Handler file | Events guarded | Actor field |
|---|---|---|
| `events/dmMessages.ts` | `create`, `update`, `delete`, `reaction_add`, `reaction_remove` | `message`, `target.actor` (`update`/`delete` with a target; an old-shape `delete` has no actor and is scoped by its lookup instead, see `dm-system.md` "Relayed edits and deletes"), `reaction` |
| `events/membership.ts` | `member_add` (bootstrap + add), `member_remove` (self-leave), `ownership_transfer` | `group.owner`, `membership.addedBy`, `membership.user`, `ownership.previousOwner` |
| `events/friends.ts` | `friend_request_create/update/cancel`, `friend_add`, `friend_remove` | `friendship.from` / `.to` (`friend_remove` accepts either side; when both are refused, the reason is `attribution_unproven` if either side was unproven) |
| `events/calls.ts` | `dm_call_start/accept/reject/end`, `dm_typing_start/stop` | `call.caller` / `.acceptor` / `.rejector` / `.endedBy`, `typing` |
| `events/dmState.ts` | `read_state_update`, `dm_close`, `dm_reopen` | `readState.user`, `dmCloseReopen` |

`read_state_update`, `dm_close`, `dm_reopen` and the two typing events were previously unguarded — they resolved an actor from a bare `home_user_id` with no verification at all, which let any peer ack, close or reopen a DM as any user. They now run the same check as the rest.

**Transitive relays are not accepted.** An event whose actor is homed on neither the signing peer nor this instance is rejected, even when all three are peered. In a 3-instance group DM where a client-federation user acts on a remote, the remote's relay reaches the user's home instance (homeward) but not the *third* instance. This limitation is not new — it has always applied to `create`, `member_add`, reactions and the friend events — and the newly-guarded events now share it rather than diverging from it. Making that case work needs a signed origin-attestation the relaying peer can forward, which is a protocol change, not an attribution relaxation.

`profile_update` and `presence_update` (`profile.ts`, `events/dmState.ts`) use a **stricter** rule that predates this and is deliberately kept: the payload's `homeInstance` must equal the source domain outright, with no homeward branch — only a user's own home instance may mutate their profile or presence here. `group_metadata_update` gates on `dm_channels.owner_home_instance` instead. `file_rejected` carries no user attribution (it is a system event from the rejecting peer).

All origin comparisons use `extractDomain()` or `getOurOrigin()` with normalization, handling both bare domains and full URLs consistently.

---

## 4. DM Message Relay

### 1-on-1 DMs

**Outbound (origin instance):**
1. Message created via REST (`POST /api/dm/:id/messages`) or WS (`dm_message_create`)
2. `queueDmRelay(message, channelId, 'create')` called from `dm.ts` / `events.ts`
3. `buildRelayPayload()` constructs the message portion with `homeUserId`, `homeInstance`, `content`, `replyToId` (sender-local, never adopted by a receiver), `replyTo` (the replied-to message as a `FederationMessageRef`, replies only), `mentions` (the federated identities behind the content's `<@id>` tokens, only when it has any; see "Optional `message.mentions` field"), `editedAt`, `createdAt`
4. `getDmParticipants(channelId)` resolves all members to `(homeUserId, homeInstance)` pairs with profile snapshots
5. `getGroupDmTargetOrigins(channelId)` returns the participants' instances minus our own -- `[]` when both participants are local
6. `queueOutboxEvent(messageId, channelId, 'create', payload, targetOrigins)` -> queued only to those peers; a `[]` target list matches no peer, so a conversation between two local users is never relayed

**Channel creation (1-on-1):**
- `POST /api/dm` finds or creates the row with `findOrCreateOneOnOne` (`utils/dmConversation.ts`), which stores `oneOnOneKey(a, b) = SHA256(sorted([homeIdentityA, homeIdentityB]).join(':')).slice(0, 32)` on every 1-on-1 from insert, relay on or off and native pairs included; rows from before that get it from the startup backfill (`backfillOneOnOneKeys`, run by `initDatabase`)
- The receiving instance computes the same key from the relayed participants, so its `findOrCreateOneOnOne` finds the existing copy when the S2S reply arrives, preventing duplicate channels
- Nothing is relayed at creation. The recipient's membership on the creating instance is inserted closed and opened by the first message (dm-system.md "1-on-1 DM Creation")

**Inbound (receiving instance -- `processCreateEvent`):**
1. Validate: `event.message` and `event.participants` (>= 2) required
2. Dedup: check `(sourceInstance, sourceMessageId)` -- reject if exists
3. Resolve ALL participants via `resolveOrCreateReplicatedUser`, hydrate profiles
4. No `event.federatedId` -> 1-on-1 path. The author must be one of the first two participants and the signing peer one of their home origins, else `invalid_target` (see `dm-system.md` "Relayed message creates")
5. `findOrCreateOneOnOne(db, localUserA, localUserB, { open: 'both' })` (`utils/dmConversation.ts`), keyed `oneOnOneKey` over the two local rows' home identities:
   - The row holding the key, its members made the pair (missing ones added, a same-identity row under another local id re-pointed; never a third member)
   - Else an unkeyed row whose members are exactly the pair, keyed
   - Else a new row with the key, both members open
6. `lateBindFederatedCall(key, channelId)` binds a call that rang before this copy existed
7. Insert `dm_messages` with `sourceInstance` and `sourceMessageId`; `replyToId` is `resolveRelayedReplyTarget(message.replyTo)`, which resolves the reference with `resolveLocalDmMessage` and keeps it only when the target is in the same local channel (else `null`); `content` is `rewriteRelayedMentions(message.content, message.mentions)` for a user message, the stored content naming this instance's rows in its mention tokens
8. Process attachments (see File Replication)
9. Broadcast `dm_message_created` to every local member, members homed on the source instance included; a closed member is reopened and gets `dm_channel_created` (built by `loadDmChannelWire` with this message) first

### Group DMs

**Outbound (origin instance):**
Same as 1-on-1 except:
- Normalizes `homeInstance` to full URL before comparison
- `queueOutboxEvent` receives `targetPeerOrigins` and only queues to those peers
- Payload includes `federatedId` (random UUID assigned at channel creation)

**Inbound (receiving instance -- `processCreateEvent`):**
1. `event.federatedId` present -> group DM path
2. Find channel by `federatedId` -- must already exist (bootstrapped by prior `member_add`)
3. If not found -> reject with `channel_not_found`
4. The author must be a member of the channel and the signing peer one of its relay target origins, else `unauthorized_source` (retried; `invalid_target` if the channel is a 1-on-1). See `dm-system.md` "Relayed message creates"
5. Insert message, broadcast to local members

### Federated ID Generation (`utils/dmConversation.ts`)

```typescript
// 1-on-1: oneOnOneKey(a, b), deterministic 32-char hex hash over homeUserId || id
const sorted = [homeIdentityOf(a), homeIdentityOf(b)].sort();
return sha256(sorted.join(':')).slice(0, 32);

// Group: mintGroupKey(), random 36-char UUID with dashes, minted once
return crypto.randomUUID();
```

No other code computes or mints a key (ADR 0002). See dm-system.md "Federated ID Algorithm" for when each is stored.

The format difference (32-char hash vs 36-char UUID) is used by the self-healing migration to detect channel type independently of `owner_id`.

### Message Deduplication

Every relayed message is stored with:
- `source_instance`: the relay request's `sourceInstance` header value
- `source_message_id`: the `event.messageId` (original message ID on source instance)

The `(source_instance, source_message_id)` pair is checked before insertion. Duplicates are rejected with reason `'duplicate'`. A unique partial index enforces this at the DB level: `idx_dm_messages_source_unique ON dm_messages(source_instance, source_message_id) WHERE source_instance IS NOT NULL`.

### Optional `message.type` field (added 2026-04-29)

`FederationRelayEvent.message.type?: 'user' | 'system'` is optional. When present and set to `'system'`, `processCreateEvent` writes the inserted `dm_messages.type` column accordingly, after checking the content is a relayable system event (`invalid_system_message` otherwise; `dm-system.md`, "System messages"); when absent, the receiving instance defaults to `'user'`.

This is a **forward- and backward-compatible** addition because the inbound relay endpoint (`/api/federation/relay`) validates only structural fields (`version`, `events` array shape, `sourceInstance`); unknown fields are passed through. Old peers that don't emit `type` produce relay events that get inserted as user messages on receiving peers (the existing default), and old peers receiving relay events from new peers ignore the field entirely. No protocol-version bump is required.

This permissiveness is **intentional** — the relay envelope is designed for additive evolution. Future optional fields should follow this same pattern (no schema bump, document the field here, defaults preserve old-peer behavior).

### Optional `message.mentions` field (#347)

`FederationRelayEvent.message.mentions?: FederationMentionRef[]`, each `{ id, homeUserId, homeInstance }`: an id as it appears in a `<@id>` token of the relayed `content`, and the federated identity of the user it names on the sender. It rides every path that carries content: live `create` and `update` and the sync endpoint's replay of both, which all build the message part with `buildRelayPayload` (the replay on the current content). The receiver (`processCreateEvent`, `processUpdateEvent`) rewrites each listed token to its own row for that identity before storing the content. Sender and receiver rules, validation and limits are in `dm-system.md` "Mentions in relayed messages"; the code is `utils/federationMentions.ts`.

Additive like `message.type`: an older sender omits the list and its content is stored as sent, which leaves foreign ids in the tokens as before; an older receiver ignores the field and does the same.

### Typing Indicator Relay

**Event types:** `dm_typing_start`, `dm_typing_stop`

**Model:** Fire-and-forget, same as call signaling. No outbox, no retry, no mutation log. Typing is ephemeral — lost packets are acceptable.

**Channel identification:** Uses `federatedId` (not instance-local `dmChannelId`) for cross-instance channel lookup, plus `participants` for resolution context.

**Outbound (`events.ts` / `dm.ts`):**
- `handleDmTypingStart()` → after local broadcast, calls `sendTypingRelay(dmChannelId, 'dm_typing_start', userId)`
- `broadcastDmMessage()` → after local `dm_typing_stop` broadcast, calls `sendTypingRelay(dmChannelId, 'dm_typing_stop', message.userId)`

**`sendTypingRelay()` (`federationOutbox.ts`):**
- Fetches channel's `federatedId` and `getDmParticipants()` for target resolution
- Builds `FederationRelayEvent` with `typing: { homeUserId, homeInstance, username }`
- Calls `sendCallRelay(origin, [event], { peeringTimeoutMs: 0 })` for each remote peer origin — non-active peers are skipped and a background `ensurePeered` warm-up is kicked off instead

**Inbound (`federation.ts`):**
- `processDmTypingStartEvent` → look up channel by `federatedId`, resolve user via `resolveRelayActor()` (no stub creation for ephemeral events; unknown → accept silently), broadcast `dm_typing` to local members
- `processDmTypingStopEvent` → same, broadcast `dm_typing_stop` to local members
- **Implicit clear:** `processCreateEvent()` also emits `dm_typing_stop` for the message author after processing an inbound relay — primary typing clear mechanism for relayed messages

---

## 5. Outbox & Relay Pipeline

### Event Queuing (`federationOutbox.ts:queueOutboxEvent`)

```
Trigger (API/WS handler)
  -> isFederationRelayEnabled()? No -> return silently
  -> contextType 'dm' with no targetPeerOrigins? -> refuse, log, return
       (DM traffic is participant-scoped and must never fan out to every peer;
        an omitted list means broadcast, which only profile/presence may use)
  -> Fetch peers from federation_peers:
       broadcast (no targets): status active or unreachable
       targeted:               status active, pending or unreachable
  -> Filter to targetPeerOrigins (if specified) -- EXACT string match against peer.origin
       (an empty array is a target list, not an absence of one: it matches
        nothing, which is how a local-only DM is suppressed)
  -> Targeted origin with no peer row -> createAutoPlaceholderPeer (see Peer-row provenance)
  -> For each peer, in a transaction: writeOutboxEvent (federationOutboxQueue.ts)
       -> file the event into the queue of its entity, by the rules below
       -> TTL: now + (relayTtlDays * 86400000)
```

**Who gets a broadcast.** An untargeted event goes to `active` and `unreachable` peers, never to `pending` ones. An `unreachable` peer is an established peering with a backlog: it may still consider us active and never pull our log, and our recovery does not re-send profiles, so its queue is how a change made during the outage reaches it. A `pending` peer is not sent broadcasts: its activation already delivers what they carry (it pulls our `profile` mutation log, and our `onPeerActivated` pushes a presence snapshot). Before #321 the broadcast used the targeted status list, which had been widened for placeholders, so every profile edit landed on every auto-created pending row and kept it from being swept.

### Outbox queues (`federationOutboxQueue.ts`)

The outbox holds, per peer, one **queue per entity**: `federation_outbox.queue_key`, derived from the event by `outboxQueueKey` from one rule table over every outbox event type (`OUTBOX_EVENT_RULES`; a new event type without a rule fails typecheck). `entity_id` stays the id the peer knows the event by (the relay event's `messageId`); the two are separate because one wire id can name several entities and one entity can travel under several wire ids.

| Queue | Key | Family |
|-------|-----|--------|
| A DM message: `create`, `update`, `delete` | `message:<entity_id>` | message |
| One user's reaction with one emoji on one message: `reaction_add` (wire id: the reaction id), `reaction_remove` (wire id: `msg:user:emoji`) | `reaction:<messageHomeInstance>:<messageId>:<userId>:<emoji>` | state |
| A user's presence | `presence:<userId>` | state |
| A user's profile | `profile:<userId>` | state |
| A user's read position in a conversation | `read_state:<federatedId>:<homeInstance>:<homeUserId>` | state |
| Whether a user has a conversation closed: `dm_close`, `dm_reopen` | `dm_open:<federatedId>:<homeInstance>:<homeUserId>` | state |
| One rejected attachment: `file_rejected` (wire id: the message's id) | `file_rejected:<entity_id>:<attachmentId>` | event |
| A friendship: every `friend_*` event of the pair | `friendship:<contextId>` | event |
| A group DM: `member_add`, `member_remove`, `ownership_transfer`, `group_metadata_update` | `group:<federatedId>` | event |

**Delivery order.** The worker only sends a queue's head (its oldest row), so a peer applies an entity's events in the order they happened, and a row backing off holds back only its own queue.

**Offered.** `offered_at` records when some path first possibly handed a row to the peer: the worker sets it before the POST leaves (in the same synchronous step that reads the batch), and the `/sync` handler sets it on the pulling peer's rows of the pulled context (`markOutboxOfferedForPeer`), since the mutation log it serves can carry the same event. It is never cleared: a send whose outcome is unknown (timeout, abort, an HTTP error, an unreadable answer, a stopped process) may have reached the peer. A row that has been offered is never changed again; it is only deleted (settled, replaced or expired) or has its backoff moved. A replacement is a new row, so settling the offered row by id can never touch it.

**Folding a newer event into its queue** (`writeOutboxEvent`). A fold is only made where it is right whatever the peer already holds:

| Family | Newer event | Result |
|--------|-------------|--------|
| state | any | Every queued row of the entity is deleted and the event inserted as a new row: it sets the whole state on its own |
| message | `update`, tail is a `create` not yet offered | The create carries the new payload and keeps its place (the peer cannot have the message) |
| message | `update`, tail is an `update` | The queued update is replaced by a new row |
| message | `update`, tail is an offered `create` | Appended behind it: the create is sent again (the peer answers `duplicate` if it has it), then the update |
| message | `delete`, the queue holds a `create` not yet offered | Everything queued for the message goes and nothing is sent: the peer never had it |
| message | `delete`, otherwise | Everything queued for the message is replaced by the delete (a delete for a message the peer does not hold is settled there) |
| event | any | Appended: each event is its own fact, sent in turn |

A new row is due now and gets `createdAt = max(now, newest row of its queue + 1)`. The worker stamps each event's `timestamp` with its row's `createdAt`, so a receiver that keeps only a strictly newer timestamp (read state) applies it. A reaction add not yet offered is not cancelled by a remove: the peer may hold the reaction from before the add.

Before #372 the outbox kept one row per (peer, entity id) and merged newer events into it on the assumption that the peer had not received it. A presence change and a profile change for one user overwrote each other; two size rejections of one message's attachments kept one; after a timeout or a 5xx, a create and a later delete cancelled out and an edit was resent as a create the peer answered `duplicate`, so the peer kept the message or the old text. A merge also kept the older row's position, so remove, add, remove of one reaction reached the peer as add, remove, add. #371 had tracked rows on the wire in memory, which a restart lost and which ended when any answer came.

### Outbox Delivery Worker (`federationWorker.ts:processOutboxTick`)

**Interval:** 1 second (`OUTBOX_INTERVAL_MS`; an idle poll is a no-op)
**Batch size:** 50 (`OUTBOX_BATCH_LIMIT`)
**Timeout:** 30 seconds per request (`OUTBOX_FETCH_TIMEOUT_MS`)

1. Query rows where `nextRetryAt <= now`, joined with active peers, that head their queue (`isOutboxQueueHead`: no older row of the same peer and key; a row without a key is its own queue), ordered by `createdAt, id`, limit 50
2. Group by peer
3. For each peer, `takeOutboxBatch`: read its rows again (an earlier peer's POST in the same tick may have taken up to the timeout; a row replaced meanwhile is gone and its replacement goes on a later tick), keep one row per wire id (the answer names events by it), and mark them offered. Then reconstruct `FederationRelayEvent[]` from the stored payloads (`buildRelayEvents`)
4. Build `FederationRelayRequest` with `version: 1`, `sourceInstance: ourOrigin`, sign it, POST to `{peerOrigin}/api/federation/relay` (`sendOutboxBatch`, which never throws and reports one of four outcomes)
5. **Answered** (a 2xx with a readable body): `settleAnsweredBatch`, one transaction:
   - accepted, or rejected as `taken` (`classifyRejection`, see [Rejection reasons](#rejection-reasons)): the row is deleted
   - rejected as `refused`: the row is deleted; for a `create`, the rest of its queue too (`refusalEndsOutboxQueue`), since the peer will never hold the message
   - any other rejection, or a row the answer does not mention: next backoff step (`attempts + 1`, `nextRetryAt = now + backoff`)

   After the transaction, and unable to change the rows: rollback callbacks for the refusals, logging, and the peer's bookkeeping (`lastSeenAt`, `consecutiveFailures = 0`, `consecutiveAuthFailures = 0`, `remoteMaxUploadSize`). A failure there is logged and the batch stays settled
6. **Auth refused** (401/403): every row moves to its next backoff step, and `handleRelayAuthRefusal` counts the failure (see [Authentication-failure handling](#authentication-failure-handling-401--403))
7. **Failed** (network error, timeout, a non-2xx, an unreadable answer): the peer may have applied the batch. `handleOutboxDeliveryFailure` moves every row to its next backoff step, increments the peer's `consecutiveFailures` and sets `lastFailureAt`; at `PEER_UNREACHABLE_THRESHOLD (10)` `markPeerUnreachable` moves an `active` peer to `unreachable` through `transitionPeer` (cause `network_threshold`), which resets recovery pacing and runs the deactivation hook
8. **Aborted** (the worker is stopping): nothing changes; the rows stay offered and due

**Expiry.** The janitor's TTL sweep (`expireOutboxQueues`) expires each row by its own `expiresAt`. In a DM message's queue an expired row also takes the rows behind it, since an edit or delete of a message the peer may never have got means nothing on its own. Behind an expired state or event row nothing else goes: a state row carries its entity's whole state, and an event (a group's ownership transfer behind a `member_add` the peer kept refusing) is a fact of its own, released when the row ahead of it expires. Rows ahead of an expired row stay.

**Rows queued before queue keys.** Migration 0021 rebuilds `federation_outbox` (create, copy, drop, rename) to remove the old `(peer_id, entity_id)` uniqueness, which exists in two forms: the named index `federation_outbox_peer_id_entity_id_unique` on installs from the squashed history, and an inline `UNIQUE(peer_id, entity_id)` constraint (an `sqlite_autoindex` no `DROP INDEX` can remove) on databases created before the squash. The copy marks every row offered (whether it had reached the peer was never recorded) and leaves out rows whose peer no longer exists, which could never be delivered and would fail the foreign key check; the migration then drops `presence_update` rows on auto-created pending peers. `backfillOutboxQueueKeys` (run at boot from `db/index.ts`) gives each row without a key the key its event gets today.

#### Rejection reasons

Every rejection is classified in `utils/federationRejections.ts`, from the one set of lists the outbox worker (reading a peer's answer, `classifyRejection`) and the pull (reading this instance's own answer to a pulled event, `classifyPulledRejection`, see [Pull sync](#pull-sync)) both use. Every reason this build's processors give is listed as `refused` or `retry` (a test reads the processors' source and fails on an unlisted one). An unlisted reason is a newer receiver's when the outbox reads it, and `retry`: waiting until the row expires is safe, rolling back on a guess is not. When the pull reads it, it is this build's own reason that was never classified, and `refused` with a warning, so it cannot park events for days. Three outcomes:

| Outcome | Reasons | Outbox worker | Pull |
|---|---|---|---|
| `taken` | `duplicate`; `unknown_message` answering a `delete` or `reaction_remove` | Row deleted, no rollback | Counted as applied |
| `refused` | `recipient_not_found`, `attribution_mismatch`, `unknown_event_type`, `self_target_invalid`, `not_message_author`, `system_message_immutable`, `invalid_system_message`, `invalid_target`, `source_peer_mismatch`; a malformed payload (`invalid_payload`, `invalid_status`, `missing_participants`, `missing_federated_id`, every `missing_*_payload`); a `file_rejected` whose message or attachment is gone (`message_not_found`, `attachment_not_found`) | Row deleted, rollback callback runs | Dropped with a warning |
| `retry` | reasons that wait for something that can still arrive: `attribution_unproven`, `channel_not_found`, `participant_not_found`, `author_not_found`, `user_not_found`, `sender_not_found`, `actor_not_found`, `unauthorized_source`, `max_members_exceeded`, `processing_error`, `unknown_message` for any other event type; for the outbox, also any reason this build does not know | Row stays on the [retry backoff schedule](#retry-backoff-schedule) until its `expiresAt` (relay TTL, 30 days by default), when the janitor deletes it; no rollback at TTL expiry | Kept in `federation_sync_retry`, except an `unknown_message` whose message can no longer arrive ([Pull sync](#pull-sync), "Outcomes"), which is dropped |

- `duplicate`: the receiver already has the event. `unknown_message` for a `delete` or `reaction_remove` is the same answer from an older receiver: the effect is already in place (a receiver of this build accepts those outright, see [Receiver guarantees](#receiver-guarantees-applying-an-event-twice)).
- `recipient_not_found`, `attribution_mismatch`, `unknown_event_type`, `source_peer_mismatch` and the malformed-payload reasons: structural mismatches that sending the same payload again cannot resolve.
- `not_message_author`, `invalid_target`: a relayed `update`/`delete` whose `target` names a message the actor did not write, is malformed, or comes from a peer that is neither a relay target of the message's conversation nor the instance the message came from. See `dm-system.md` "Relayed edits and deletes" for the rule. `invalid_target` is also a relayed 1-on-1 `create` whose author is not one of the pair or whose sender is not a relay target of it (`dm-system.md` "Relayed message creates"; the group case is the retried `unauthorized_source`), a `member_add` into a 1-on-1 or a bootstrap without an owner, with the owner outside the roster, or from a sender none of the roster lives on (`dm-system.md` "Relayed member adds"), a kick or `ownership_transfer` aimed at a 1-on-1, a `reaction_add`/`reaction_remove` on a message in a conversation the sender is not a peer of, or by a reactor outside a 1-on-1 (`dm-system.md` "Inbound: Reaction Add/Remove"), and a `friend_add` refused by the rule in `social.md` "End-to-End Relay Flow: Friend Add".
- `system_message_immutable`, `invalid_system_message`: a relayed `update` naming a system message, and a relayed system message that is not a well-formed relayable event (`dm-system.md` "System messages"). Terminal for senders from 1.7.1; a 1.7.0 sender does not list them, so it retries such an entry on the backoff until the relay TTL.
- `attribution_unproven` is `retry`: the receiver lacks the proof that one of its users holds an account here, and that proof arrives from the user's client. See [the two refusal reasons](#3-identity-resolution).
- `self_target_invalid`: emitted by `processFriendRequestCreateEvent` when an inbound `friend_request_create`'s `from`-identity equals its `to`-identity (after origin normalization). Defense-in-depth: the sender's local `cannot_friend_self` check should catch this, but the receiver does not trust upstream validation. The friend-create rollback callback maps this to client-facing `peer_rejected`.

For `refused` rejections, the worker invokes a registered permanent-failure callback via `invokePermanentFailureCallback(eventType, messageId, reason)` from `utils/federationRollback.ts`. Currently registered: `friend_request_create` → `rollbackFriendRequestCreate` (deletes the local `friend_requests` row by `relay_message_id` and emits WS `friend_request_relay_failed` to the sender). Other event types may register their own callbacks. After a callback runs, the event's mutation-log row (`entity_id` = the event's `messageId`, same `mutation_type`) is deleted too, so `/sync` never serves a peer an event this instance rolled back. See `social.md` §6 "Failure Handling" for the friend-specific rollback contract.

**Ghost-row failure mode.** Rollback callbacks are best-effort: the registry catches and logs callback errors but does NOT re-throw. A botched rollback (e.g., DB write fails mid-rollback due to disk full or FK violation) can leave a ghost row that no longer corresponds to any in-flight relay. Acceptable vs. retry-forever blocking the outbox, but worth knowing when debugging stuck pending states.

**5xx and network failures are NOT terminal** — those use the existing exponential-backoff retry path. Pending operations stay pending indefinitely under sustained connectivity loss, matching the pre-existing DM relay behavior.

Logged at `console.log` ("outbox entry removed (terminal)") to distinguish from retained-for-retry `console.warn` messages.

### Retry Backoff Schedule

| Attempt | Delay |
|---------|-------|
| 1 | 30 seconds |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 15 minutes |
| 5 | 1 hour |
| 6 | 6 hours |
| 7+ | 24 hours (cap) |

Test instances divide these waits, see [Retry backoff divisor (test only)](#retry-backoff-divisor-test-only).

The schedule above (`BACKOFF_SCHEDULE_MS`) paces per-entry retries. Peer-level recovery from `unreachable` is separate and demand-driven: see [PEER_UNREACHABLE_THRESHOLD](#peer_unreachable_threshold) and [Pacing](#peer-state).

### Authentication-failure handling (401 / 403)

When a relay response is 401 (HMAC rejected) or 403 (remote's peer row is non-active or missing), the worker increments `consecutive_auth_failures` on the peer row, applies backoff to the queued outbox entries via the existing `BACKOFF_SCHEDULE_MS`, and preserves `hmac_secret`. After `AUTH_FAILURE_THRESHOLD = 5` consecutive auth failures (~21.5 min with the existing schedule), the peer transitions to `needs_attention`:

- Outbox delivery halts (the existing `status = 'active'` filter on the delivery query excludes `needs_attention`).
- `hmac_secret` is preserved (admin can inspect; no silent rotation).
- The transition is a compare-and-set from `active` with `status_reason = 'auth_failures'`: a peer an admin revoked or reset while the delivery was in flight is left as it is.
- Affected local users receive `federation_peer_rejected` with `reasonCode: 'auth_failures'`.
- Admins receive `federation_peers_changed`.

The worker NEVER re-handshakes via unauthenticated `/peer/accept` in response to a 401/403. The safeguard at `/peer/accept` (idempotent-200-no-update on `active` OR `needs_attention` peers) is what prevents silent HMAC rotation; the worker's job is to respect that signal and surface it to admins rather than loop. Recovery is via the admin "Reset peering" action, which deletes the local peer row and requires out-of-band re-peering.

Network failures (timeouts, non-401/403 non-2xx responses) are tracked separately via `consecutive_failures` and lead to `unreachable` at `PEER_UNREACHABLE_THRESHOLD = 10`. A successful delivery resets both counters.

### Relay Request/Response Format

**Request:**
```typescript
interface FederationRelayRequest {
  version: 1;
  sourceInstance: string;          // Full URL, e.g., "https://nova.ddns.net"
  sourceInstanceId?: string;       // Sender's epoch, see reset detection
  capabilities?: FederationRelayCapability[];  // Optional, see below
  events: FederationRelayEvent[];  // Max 50 per batch
}
```

#### Relay capabilities

`capabilities` lists relay behaviours the sender implements beyond plain v1. Each capability gates something the receiver would otherwise not send, so an instance that predates it is never handed an answer it was not built for. The receiver reads the field from an untrusted body: anything other than an array counts as empty.

| Capability | Receiver behaviour when listed | When not listed |
|---|---|---|
| `attribution_unproven` | May reject a homeward claim whose proof it does not hold yet with `attribution_unproven` | Answers the same case with `attribution_mismatch` |

The outbox worker (`RELAY_CAPABILITIES` in `federationWorker.ts`) sends `['attribution_unproven']`. `sendCallRelay` sends none: call signalling is not retried from the outbox, so it keeps the v1 answer. The mapping happens once, at the HTTP boundary (`rejectionsForSender` in `handlers/relay.ts`); `processRelayEvents` always reports the precise reason, which the sync-pull path discards anyway.

Mixed versions:

| Sender | Receiver | Unproven homeward claim |
|---|---|---|
| new | new | `attribution_unproven`, retried on backoff, accepted once the proof lands |
| new | old | `attribution_mismatch`, terminal (unchanged from before) |
| old | new | `attribution_mismatch`, terminal (unchanged: the old sender does not list the capability) |
| old | old | `attribution_mismatch`, terminal |

The capability is needed for the old-sender case: an older worker keeps a rejection it does not recognise in the outbox without backoff, so an unsolicited `attribution_unproven` would be resent every tick until the TTL.

**Response:**
```typescript
interface FederationRelayResponse {
  accepted: string[];              // messageIds successfully processed
  rejected: Array<{
    messageId: string;
    reason: string;                // e.g., 'duplicate', 'unknown_message', 'missing_participants'
  }>;
  undeliverable?: Array<{          // optional — omitted when empty; call-signaling only
    messageId: string;
    reason: string;                // e.g., 'no_recipient'
  }>;
  maxUploadSize: number;           // This instance's max upload size in bytes
}
```

#### `undeliverable` bucket (call-signaling only)

In addition to `accepted` and `rejected`, the relay response may include an
optional `undeliverable: Array<{messageId, reason}>`. Three-way classification,
non-overlapping: each messageId appears in exactly one of the three arrays.

| Bucket | Meaning | Retry? |
|---|---|---|
| `accepted` | Processed cleanly, ≥1 recipient reached. | No |
| `rejected` | Refused at data/protocol layer (schema, attribution, channel-not-found, etc.). | Per reason: `taken` and `refused` are dropped, `retry` is retried on backoff (see [Rejection reasons](#rejection-reasons)). |
| `undeliverable` | Processed cleanly, zero recipients reachable. | No — call-signaling specific. |

Currently used only for `dm_call_start`:
- **Path A** (local DM exists): if no local non-caller member has an active WS
  connection, the event is pushed to `undeliverable` with reason `no_recipient`
  instead of being silently accepted. No `FederatedCallEntry` is created.
- **Path B** (no local DM): the zero-participant-match early return pushes to
  `undeliverable` rather than `accepted`.

Other event types (messages, reactions, friend events, profile updates, etc.)
keep existing semantics — a message to an offline user is still `accepted`, since
messages persist and re-deliver on reconnect.

The field is optional on the wire. Old peers omit it; new peers include it only
when non-empty. Caller-side `sendCallRelay` parses the field (defaulting to an
empty array when missing), so upgrade skew is a no-op until both sides are on
new code.

### Inbound Relay Dispatch (`POST /api/federation/relay`)

Body limit: 10 MB. Max 50 events per batch. Rate-limited to 90 requests/min per peer (sliding window, keyed by `peer.origin`). Returns 429 when exceeded. Raised from 30 after FED-009 reduced the outbox worker interval from 10s to 1s — a busy sender can now hit 60 req/min during sustained traffic.

| eventType | Processor | contextType |
|-----------|-----------|-------------|
| `create` | `processCreateEvent` | dm |
| `update` | `processUpdateEvent` (message resolution and authorship: `dm-system.md` "Relayed edits and deletes") | dm |
| `delete` | `processDeleteEvent` (same) | dm |
| `reaction_add` | `processReactionAddEvent` | dm |
| `reaction_remove` | `processReactionRemoveEvent` | dm |
| `member_add` | `processMemberAddEvent` | dm |
| `member_remove` | `processMemberRemoveEvent` | dm |
| `ownership_transfer` | `processOwnershipTransferEvent` | dm |
| `read_state_update` | `processReadStateUpdateEvent` | dm |
| `friend_request_create` | `processFriendRequestCreateEvent` | friend |
| `friend_request_update` | `processFriendRequestUpdateEvent` | friend |
| `friend_request_cancel` | `processFriendRequestCancelEvent` | friend |
| `friend_add` | `processFriendAddEvent` | friend |
| `friend_remove` | `processFriendRemoveEvent` | friend |
| `file_rejected` | `processFileRejectedEvent` | dm |
| `dm_typing_start` | `processDmTypingStartEvent` | dm (fire-and-forget, no outbox) |
| `dm_typing_stop` | `processDmTypingStopEvent` | dm (fire-and-forget, no outbox) |
| `dm_close` | `processDmCloseEvent` | dm |
| `dm_reopen` | `processDmReopenEvent` | dm |
| `group_metadata_update` | `processGroupMetadataUpdateEvent` | dm |

After processing all events, the relay endpoint updates the peer's `lastSeenAt` and resets `consecutiveFailures`, then returns accepted/rejected arrays plus `maxUploadSize`.

---

## 6. Group DM Lifecycle over Federation

### member_add (`processMemberAddEvent` -- `routes/federation/events/membership.ts`)

**Required fields:** `event.federatedId`, `event.membership.user`

**Two paths:**

Before either path: `attributionRefusal` on `membership.addedBy`, then the member's clock: an add older than it is accepted and changes nothing ([Subject clocks](#subject-clocks-member-and-friend-events-are-last-writer-wins)). The clock is claimed where the member row is written.

**Bootstrap path** (channel does not exist locally by `federatedId`):
1. Requires `event.group` metadata (owner + full member roster + group metadata snapshot). The owner is required, must pass `attributionRefusal`, must be in the resolved roster, and the signing peer must be one of the roster's instances (`mayRelayInto`); else `invalid_target` and nothing is created. See `dm-system.md` "Relayed member adds"
2. Creates `dm_channels` row with `federatedId`, `ownerId` (resolved via `resolveOrCreateReplicatedUser`), `ownerHomeUserId`, `ownerHomeInstance`, plus the bootstrap `name`, `icon`, and `metadataUpdatedAt` from `event.group`
3. When `event.group.icon` is non-null, mirrors `processGroupMetadataUpdateEvent` and calls `downloadProfileAsset(icon, sourceInstance)` — stores the local bare filename on success or the absolute URL on failure
4. Adds the roster members from `event.group.members` (each resolved via `resolveOrCreateReplicatedUser`), except one whose clock is newer than the add
5. Sends `dm_channel_created` to **local-only members** (home instance matches `getOurOrigin()`, with normalization for bare domain)
6. Sets `bootstrapped = true` to skip redundant system messages and member_add broadcasts below

#### `FederationGroupPayload` (extended)

The `event.group` payload that bootstraps a brand-new replica carries the current metadata snapshot, so a peer that has never seen the channel materializes it with the right name and icon — no separate `group_metadata_update` round-trip needed:

```typescript
interface FederationGroupPayload {
  owner: FederationRelayParticipant;
  members: FederationRelayParticipant[];
  // Extended for the polish pass:
  name: string | null;            // explicit null = no custom name
  icon: string | null;            // absolute URL on the wire; null = no custom icon
  metadataUpdatedAt: number;      // 0 for legacy/unset rows
}
```

Older peers that omit these fields fall back to safe defaults (null name/icon, `metadataUpdatedAt = 0`). Receivers never re-relay these fields — only the owner's home instance authors `group_metadata_update` events.

**Incremental path** (channel already exists):
1. Validates authority: the channel must be a group (`ownerId` set; else `invalid_target`), and the adder must be a current member of this instance's copy with the signing peer one of its relay target origins before the add (`mayRelayInto`); else `unauthorized_source`. Any member may add, from any instance the group is relayed to; the owner's instance is not required. See `dm-system.md` "Relayed member adds".
2. Cancels soft-delete if channel was pending GC
3. Resolves added user via `resolveOrCreateReplicatedUser`
4. Enforces max 10 members
5. Inserts `dm_members` row (idempotent -- skip if exists)
6. Inserts system message, broadcasts `dm_member_added` to local WebSocket clients

### member_remove (`processMemberRemoveEvent` -- `routes/federation/events/membership.ts`)

1. Find channel by `federatedId` -- if not found, accept idempotently (a leave still moves the member's clock, a kick does not). A kick (`reason !== 'leave'`) on a 1-on-1 (no `ownerId`) is refused `invalid_target`
2. Validate authority: owner's instance for kicks (`reason !== 'leave'`), any instance for self-leave
3. Claim the member's clock: a remove older than it is accepted and changes nothing ([Subject clocks](#subject-clocks-member-and-friend-events-are-last-writer-wins))
4. Resolve user via `resolveRelayActor` -- if not found, accept idempotently
5. Insert system message (before deletion, so broadcast includes the leaving user)
6. Delete `dm_members` row, clean up `read_states`
7. Broadcast `dm_member_removed` to remaining local members
8. If zero members remain -> soft-delete channel (`deletedAt = now`)

### ownership_transfer (`processOwnershipTransferEvent` -- `routes/federation/events/membership.ts`)

1. Find channel by `federatedId` -- if not found, accept idempotently. A 1-on-1 (no `ownerId`) is refused `invalid_target`: it has no owner to transfer
2. Validate authority: `normalizeOriginForCompare(sourceInstance) === normalizeOriginForCompare(channel.ownerHomeInstance)`. Both sides are normalized to handle the bare-vs-full storage convention (see `dm-system.md` historical bugs for why this matters).
3. Resolve the previous owner (the attributed actor) via `resolveRelayActor` before any change: unknown → the system message falls back to the channel's recorded owner
4. Resolve new owner via `resolveOrCreateReplicatedUser` (**never** `resolveLocalUser` -- must guarantee valid ID)
5. Update `dm_channels`: `ownerId`, `ownerHomeUserId`, `ownerHomeInstance` (canonicalized to full URL on storage via `canonicalizeHomeInstance` so future authority checks stay stable)
6. Broadcast `dm_owner_updated` WebSocket event with `newOwnerHomeUserId` + `newOwnerHomeInstance` so local clients can refresh their owner-routing cache without reconnecting
7. Insert system message with previous owner as actor

Triggered by both auto-transfer-on-leave and the manual `POST /api/dm/:id/transfer` endpoint — the receiver path is the same.

### group_metadata_update (`processGroupMetadataUpdateEvent`)

Owner-authored update of a group DM's `name` and/or `icon`. Mirrors the `profile_update` shape — every payload carries both fields (`null` is unambiguously "cleared"), and a server-side version vector handles dedup; there is no partial-update wire form.

**Payload:** `FederationGroupMetadataPayload`:
- `name: string | null` — trimmed, length-checked at the owner instance and re-checked by the receiver
- `icon: string | null` — absolute http(s) URL on the wire (the owner instance normalizes its bare-filename storage via `normalizeIconForWire`); receivers download and store a bare filename, or fall back to the absolute URL on download failure
- `metadataUpdatedAt: number` — captured at the moment of the owner-instance DB write
- `actor: FederationRelayParticipant` — owner by authority invariant; used only for system-message rendering

**Authority:** `extractDomain(sourceInstance) === extractDomain(channel.ownerHomeInstance)`. Otherwise rejected as `attribution_mismatch`. Receivers never re-relay this event — the owner instance is the only emitter.

**Targeting:** `getGroupDmTargetOrigins(channelId)` — every peer that hosts a member of the channel.

**Queueing:** queued via `queueGroupMetadataRelay` into the group's queue (`group:<federatedId>`), after the group's earlier membership events; see [Outbox queues](#outbox-queues-federationoutboxqueuets).

**Receiver flow (`processGroupMetadataUpdateEvent`):**
1. Lookup channel by `event.federatedId`. If missing → accepted (idempotent — no replica to update).
2. Authority: domain match against `channel.ownerHomeInstance`. Mismatch → rejected as `attribution_mismatch`.
3. Receiver hardening (don't trust remote peers):
   - missing `event.metadata` → rejected as `missing_metadata_payload`
   - `payload.name` non-null with trimmed length outside `[GROUP_DM_NAME_MIN_LENGTH, GROUP_DM_NAME_MAX_LENGTH]` → rejected as `invalid_payload`
   - `payload.icon` non-null without `http://` or `https://` prefix → rejected as `invalid_payload`
4. Version check: `payload.metadataUpdatedAt > channel.metadataUpdatedAt`. Stale or duplicate → accepted silently (no side effects).
5. Diff against the stored row. If neither `name` nor `icon` actually changed → accepted; no system message; no broadcast.
6. Idempotency dedup pre-check on `(sourceInstance, sourceMessageId)` for both suffixes (see below). If every changed field already has its corresponding system row → accepted silently (outbox retry / initial-sync replay path).
7. Resolve icon: when `iconChanged` and `payload.icon !== null`, `downloadProfileAsset(payload.icon, sourceInstance)`. Local filename on success; absolute URL fallback on failure (mirrors `processProfileUpdateEvent`).
8. Resolve actor → local user id via `resolveOrCreateReplicatedUser`. On failure (e.g. tombstoned identity), fall back to `channel.ownerId`. If both are null → rejected as `actor_not_found`.
9. Single transaction: update `dm_channels.{name, icon, metadataUpdatedAt}`; insert one or two system messages tagged with `(sourceInstance, sourceMessageId)` using the suffix scheme `${event.messageId}:name` / `${event.messageId}:icon` so two changes in a single event yield two distinct dedup keys.
10. Broadcast `dm_channel_updated` to local members via `sendToDmMembers`.
11. Broadcast each new system message via `dm_message_created`.
12. Cleanup old local icon file when the icon changed away from a bare filename (matches the avatar precedent at `users.ts:463-466`).

**Wire dump (illustrative):**

```json
{
  "messageId": "1840000000000000123",
  "eventType": "group_metadata_update",
  "federatedId": "9b8c2f4e-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
  "metadata": {
    "name": "weekend plans",
    "icon": "https://nova.ddns.net/api/uploads/abc123.png",
    "metadataUpdatedAt": 1746864000000,
    "actor": {
      "userId": "...",
      "homeUserId": "...",
      "homeInstance": "https://nova.ddns.net",
      "profile": { "username": "heidi" }
    }
  }
}
```

### Local-Only Broadcast Principle

Users connected to multiple instances must see each DM channel exactly once (from their home instance). All structural broadcasts (`dm_channel_created`, system messages) filter to **local members only**:

```typescript
const isLocalMember = (u: { homeInstance?: string | null }) =>
  !u.homeInstance || !domainOrigin ||
  u.homeInstance === domainOrigin ||
  `https://${u.homeInstance}` === domainOrigin;
```

**Does NOT apply to:** Regular DM messages (`dm_message_created` for user messages). These broadcast to all local `dm_members` regardless of home instance.

### System Messages

Membership and metadata system messages (`type = 'system'` in `dm_messages`) are **instance-local** -- they are NOT relayed via federation. Each instance creates its own when processing events, so the user ids in their content are its own. The one system message relayed as a message is `space_invite`; a receiver stores it only when it parses, and never lets an update change a system message. The rules are in `dm-system.md`, "System messages".

| Event | Content JSON | Actor (`userId`) |
|-------|-------------|-----------------|
| `member_added` | `{event, targetUserId, targetDisplayName}` | User who added them |
| `member_removed` | `{event, targetUserId, targetDisplayName, reason}` | User who left/was removed |
| `owner_changed` | `{event, newOwnerId, newOwnerDisplayName}` | Previous owner |
| `name_changed` | `{event, oldName, newName}` | Owner who renamed |
| `icon_changed` | `{event}` | Owner who set/cleared the icon |

The `name_changed` and `icon_changed` rows are created by both `PATCH /api/dm/:id` (origin instance) and `processGroupMetadataUpdateEvent` (receivers). On receivers they are dedup-tagged with `(sourceInstance, ${event.messageId}:name)` and `(sourceInstance, ${event.messageId}:icon)` so retries and initial-sync replay don't double-insert.

### Outbound Queuing (Origin Instance -- `dm.ts`)

When a group DM is created or modified locally, the origin instance queues federation events:

**Group DM creation** (`POST /api/dm/group`):
- Iterates each remote target user (those with `homeInstance !== domainOrigin`)
- Builds a `member_add` event per remote user, carrying the full roster in `event.group`
- Computes `finalTargets` by starting from `getGroupDmTargetOrigins()` and adding the new member's normalized homeInstance
- Calls `appendMutationLog` + `queueOutboxEvent` per event

**Add member to existing group** (`POST /api/dm/:id/members`):
- Same structure as creation -- builds `member_add` with full group metadata
- Normalizes new member's homeInstance to full URL before including in targets

**Leave group** (`DELETE /api/dm/:id/members`):
- Computes `fedTargetOrigins` **before** deleting the member (so the leaving user's peer is still included)
- Queues `member_remove` event with `reason: 'leave'`

**Ownership transfer** (auto-on-leave; manual via `POST /api/dm/:id/transfer`):
- Queues `ownership_transfer` event with `previousOwner` and `newOwner`

**Group metadata update** (`PATCH /api/dm/:id`):
- Owner-only. Queues `group_metadata_update` via `queueGroupMetadataRelay(channelId, { name, icon, metadataUpdatedAt, actor })` after the local DB write
- `targetOrigins = getGroupDmTargetOrigins(channelId)` — every peer hosting a member
- Receivers re-validate name length / icon URL scheme on inbound (see `processGroupMetadataUpdateEvent` above)

---

## 7. File Replication

### Outbound (origin instance)

When `queueDmRelay` constructs the relay payload, each attachment gets a `sourceUrl`:
```
sourceUrl: `${getOurOrigin()}/api/uploads/${attachment.filename}`
```
The payload also carries `playable` (video web-playability, computed by the origin from the probed codec — see uploads.md §3) so the receiving instance need not re-probe the file's codec.

### Inbound (receiving instance -- `processCreateEvent`)

1. For each attachment in `event.message.attachments`:
   - SSRF check: `isUrlFromPeer(sourceUrl, peerOrigin)` -- hostname of sourceUrl must match peer origin hostname
   - Create `attachments` row with `filename = sourceUrl` (remote URL as interim filename), carrying through `playable` from the relay payload
   - Queue `federation_file_queue` entry with `status = 'pending'`, `expiresAt = now + 30 days`
2. Initial WebSocket broadcast uses sourceUrl directly (frontend's `AttachmentRenderer` detects `http` prefix)

### File Download Worker (`federationWorker.ts:processFileQueueEntry`)

**Interval:** 30 seconds. **Batch:** 5 files. **Timeout:** 60 seconds per download.

1. SSRF protection: validate sourceUrl hostname matches peerOrigin hostname
2. Pre-download size check against `maxUploadSizeBytes` from instance settings
3. Download via `fetch` with streaming pipeline to disk (`Readable.fromWeb` -> `fs.createWriteStream`)
4. Post-download size verification (defense in depth)
5. Generate thumbnail via `sharp` (same as local upload flow)
6. Update `attachments` row: `filename = localFilename`, `size`, `thumbnailFilename`
7. Fallback: if no existing attachment row was found (legacy queue entry), insert a new one
8. Mark file queue entry as `completed` with `targetFilename`
9. Broadcast `dm_message_updated` to refresh client-side attachment display

### Size Rejection Flow (`handleSizeRejection`)

When a file exceeds the local instance's size limit:

1. Mark file queue entry as `rejected` with `reason = 'size_limit_exceeded'`
2. Update local attachment: `federationStatus = 'remote'`, `federationMeta` = source info JSON
3. Determine affected local users (native to this instance -- `!user.homeInstance || user.homeInstance === ourOrigin`)
4. Queue `file_rejected` reverse relay event to the sender's instance (`sourceInstance`). It names the affected users twice: `affectedUserIds` (bare home user ids, for older receivers) and `affectedUsers` (each `{ homeUserId, homeInstance }`, `homeInstance` being this instance's origin)
5. Broadcast `dm_message_updated` locally so clients see the 'remote' badge

### Inbound file_rejected (`processFileRejectedEvent` -- `routes/federation/events/dmState.ts`)

When the origin instance receives a `file_rejected` event:

1. Find local message by `event.messageId` (the original local message ID)
2. Match attachment by `sourceFilename` or fallback to single attachment
3. Resolve the affected users (`resolveFileRejectedUsers`). The rejecting instance speaks only for its own users, so each name is an identity homed on the sender: with `affectedUsers`, an identity homed on any other instance is skipped; from an older sender with only `affectedUserIds`, each bare id is taken as `{ homeUserId, homeInstance: <sender> }` (the sender only ever listed its own users there). Each is then the user that IS that identity (`resolveRelayActor`, homeUserId + homeInstance)
4. Merge rejection info into `federationMeta` (accumulates from multiple peers). When no affected user is new (the same rejection delivered again), nothing changes and nothing is sent
5. Set `federationStatus = 'remote_partial'`
6. Broadcast `dm_message_updated` + targeted `federation_file_rejected` toast to message author

### Federation Status on Attachments

| Status | Meaning |
|--------|---------|
| `null` | Local upload, no federation involvement |
| `'local'` | Successfully downloaded from peer |
| `'remote'` | Rejected (size limit), `federationMeta` has source instance info |
| `'remote_partial'` | Rejected by some peers, `federationMeta` has per-user rejection array |

### File Download Retry

Uses the same backoff schedule as outbox delivery. Max attempts: 10 (`MAX_FILE_ATTEMPTS`). After exceeding max attempts: `status = 'failed'`, `rejectionReason = 'max_attempts_exceeded'`.

### Boundary vs. tus Upload Migration (2026-04)

The `federation_file_queue` worker downloads files from peer instances via plain `fetch` + `Readable.fromWeb` to disk, post-completion. It consumes finished files at `${uploadDir}/${filename}`. Whether a file got there via the legacy multipart endpoint, the current tus endpoint at `/api/files/*`, or any future protocol is invisible to this worker -- its contract is purely with the on-disk filename. No changes were required when the upload protocol changed.

---

## 8. Read State Relay

### `read_state_update` Event

When a user marks a DM channel as read (`channel_ack`) or marks it unread (`mark_unread`), the read state is relayed to all peer instances so cross-instance sessions stay in sync.

**Outbound (`events.ts:handleChannelAck` / `handleMarkUnread`):**
- Fires after writing `read_states` locally
- Only triggers for DM channels with a `federatedId` (cross-instance DMs)
- Calls `queueReadStateRelay(channelId, messageId, userId)` in `federationOutbox.ts`
- Queued via the standard outbox pipeline — durable, retried by the background worker
- Entity key `read_state:{federatedId}:{userId}` enables coalescing (rapid acks collapse to latest)
- `mark_unread` with the `'0'` sentinel (delete read state entirely) is NOT relayed — it cannot be mapped to a message

**Event payload:**
```typescript
{
  eventType: 'read_state_update',
  dmChannelId: string,
  messageId: string,            // unique event ID: 'read_state:{userId}:{timestamp}'
  federatedId: string,          // DM channel's federatedId (cross-instance channel lookup)
  encryptionVersion: 0,
  timestamp: number,            // LWW tiebreaker
  readState: {
    user: { homeUserId: string; homeInstance: string },
    messageRef: { sourceInstance: string; sourceMessageId: string }
  }
}
```

`messageRef` identifies the acked message in federation coordinates. If the message originated on this instance, `sourceInstance` is our own origin and `sourceMessageId` is the local message ID. If the message was relayed here, `sourceInstance` and `sourceMessageId` come from the `dm_messages` row's `source_instance`/`source_message_id` columns.

**Inbound (`processReadStateUpdateEvent`):**
1. Resolve channel by `federatedId` — reject if not found
2. Resolve user via `resolveRelayActor`: reject `user_not_found` if unknown
3. Translate `messageRef` to local message ID:
   - If `sourceInstance` matches our origin: `sourceMessageId` IS our local ID
   - Otherwise: look up `dm_messages` by `source_instance + source_message_id`
4. If no local message found (relay hasn't arrived yet): silently accept (no-op)
5. Upsert `read_states` using timestamp-only LWW (`event.timestamp > existing.updatedAt`)
6. Echo `channel_ack` to the user's local WebSocket connections (multi-tab sync)

---

## 8b. DM Close/Reopen Relay

### Overview

When a user closes or reopens a DM on their home instance, the action is relayed to all peer instances that hold a copy of the channel. This keeps the visibility state of a DM consistent across all instances that participate in it.

Only DMs with a `federatedId` are eligible. Legacy local-only DMs (created before federation was added, with no `federatedId`) are silently skipped.

### Event Types

| Event | Trigger |
|-------|---------|
| `dm_close` | User calls `DELETE /api/dm/:id` (soft-close) |
| `dm_reopen` | User calls `POST /api/dm` and reopens a closed 1-on-1 DM |

### Payload

```typescript
{
  eventType: 'dm_close' | 'dm_reopen',
  dmChannelId: string,          // local channel ID (context only)
  federatedId: string,          // cross-instance channel lookup key
  messageId: string,            // unique event ID: 'dm_close:{federatedId}:{userId}:{ts}'
  encryptionVersion: 0,
  timestamp: number,
  dmCloseReopen: {
    homeUserId: string,         // acting user's home user ID
    homeInstance: string,       // acting user's home instance (full URL)
  }
}
```

### Outbound (`federationOutbox.ts:queueDmCloseRelay`)

Called from `dm.ts` after the local close or reopen is committed.

1. Fetch the channel's `federatedId` — if null (local-only DM), return silently
2. Fetch the acting user's `(homeUserId, homeInstance)` federation identity
3. Build `FederationRelayEvent` with `eventType` and `dmCloseReopen` payload
4. `getGroupDmTargetOrigins(dmChannelId)` resolves the delivery targets — the set of
   peer origins that host at least one participant, for both 1-on-1 and group DMs
5. Enqueue via `appendMutationLog` + `queueOutboxEvent`

### Inbound

The member's `closed` flag is last-writer-wins on `dm_members.closed_changed_at`, written only through `utils/dmMemberClosed.ts` (the rule is in `dm-system.md` "Closed state is last-writer-wins"). A pull replays a peer's close and reopen events, usually after the member's state here moved on, so a replayed or late event must not undo a newer state.

**`processDmCloseEvent` / `processDmReopenEvent` (`routes/federation/events/dmState.ts`):**
1. Look up channel by `federatedId` — if not found, accept silently (idempotent)
2. Resolve acting user via `resolveRelayActor` (lookup-only; no stub creation for close/reopen): if unknown, accept silently
3. `applyRelayedDmMemberClosed(channel, user, closed, event.timestamp)`: no member row, or a row whose state is newer than the event, changes nothing; otherwise the row takes the event's state and timestamp
4. Only when the state actually changed: `dm_channel_closed` (close), or the full `DmChannel` as `dm_channel_created` (reopen, mirroring the automatic reopen in `broadcastDmMessage`), to the user's local WebSocket connections. Accepted in every case

### Closed-State Reopen on Message Relay

`processCreateEvent` (inbound message relay) mirrors the local `broadcastDmMessage` logic: a member who closed the conversation before the message was written (`closed_changed_at < message.createdAt`) gets it back (`reopenClosedDmMembers`) and a `dm_channel_created` that resurfaces it; a close made after the message was written stands, because a pull can deliver an old message long after it was sent. A live create then broadcasts `dm_message_created`; a pulled one does not (see [Pull sync](#pull-sync)).

---

## 9. Friend Relay

### Event Flow (social.ts)

| User Action | Federation Event | Authority Check |
|-------------|-----------------|-----------------|
| Send friend request | `friend_request_create` | `from.homeInstance === sourceInstance` |
| Accept/decline request | `friend_request_update` | `to.homeInstance === sourceInstance` |
| Cancel outgoing request | `friend_request_cancel` | `from.homeInstance === sourceInstance` |
| Accept creates friendship | `friend_add` | `to.homeInstance === sourceInstance` |
| Remove friend | `friend_remove` | Either side's instance |

When a relayed friendship forms on the requester's instance, and when a `friend_add` is refused: see `social.md` §6, "End-to-End Relay Flow: Friend Add".

### Target Resolution (`getFriendEventTargets`)

Computes which peer origins need the event. Compares `fromHomeInstance` and `toHomeInstance` against `getOurOrigin()` with normalization applied, correctly handling both bare domain and full URL formats.

### Context ID

Friend events use a deterministic context ID: `friend:${sorted[homeUserIdA, homeUserIdB].join(':')}`.

### Outbound Payload Construction

Each friend endpoint builds a `FederationRelayEvent` with:
- `contextType: 'friend'`
- `friendship` payload containing `from` and `to` as `FederationRelayParticipant` objects
- `fromProfile` and/or `toProfile` snapshots (`FederationRelayProfileSnapshot`)
- `entityId` formatted as `friend_req:${sorted_ids}:${timestamp}` (for requests) or `friend_remove:${sorted_ids}:${timestamp}`

The full event payload is stored in both `appendMutationLog` (for sync) and `queueOutboxEvent` (for delivery).

### Inbound Processing

**`processFriendRequestCreateEvent` (`routes/federation/events/friends.ts`):**
- Authority check: `from.homeInstance !== sourceInstance` -> reject
- Resolve sender via `resolveOrCreateReplicatedUser` + hydrate profile
- Resolve recipient via `resolveLocalUser` (must be native to this instance)
- Idempotency: if already friends or pending request exists, accept as no-op
- Create `friend_requests` row, broadcast `friend_request_received` to recipient

**`processFriendRequestUpdateEvent` (`routes/federation/events/friends.ts`):**
- Authority check: `to.homeInstance !== sourceInstance` -> reject
- Resolve sender (original requester) via `resolveLocalUser` (must exist locally)
- Resolve recipient (acceptor/decliner) via `resolveOrCreateReplicatedUser`
- Find pending request, update status
- Broadcast `friend_request_accepted` or `friend_request_declined` to the original sender

**`processFriendRequestCancelEvent` (`routes/federation/events/friends.ts`):**
- Authority check: `from.homeInstance !== sourceInstance` -> reject
- Both users resolved via `resolveRelayActor`: both must exist locally, else accept idempotently.
- Delete the pending friend request. Broadcast `friend_request_cancelled` to recipient.

**`processFriendAddEvent` (`routes/federation/events/friends.ts`):**
- Authority check: `to.homeInstance !== sourceInstance` -> reject
- Resolve both users via `resolveOrCreateReplicatedUser` + hydrate profiles
- Insert `friends` row (idempotent)
- Auto-resolve any pending `friend_requests` to `'accepted'` (handles out-of-order delivery)
- Determine which user is local (`isOwnDomain` on `from`'s home domain, so a bare domain and a full origin both match) and broadcast `friend_request_accepted`

**`processFriendRemoveEvent` (`routes/federation/events/friends.ts`):**
- Authority check: either `from.homeInstance` or `to.homeInstance` must be `sourceInstance`
- Both users resolved via `resolveRelayActor`. If either is not found, accept idempotently.
- Delete `friends` row in both directions
- Determine local user (the side whose home domain is ours, `isOwnDomain`) and broadcast `friend_removed`

---

## 10. Profile Sync

Profile sync uses **two mechanisms** that operate independently:

### S2S Profile Hydration (Server-side)

When relay events carry `FederationRelayProfileSnapshot` data:
- `processCreateEvent`: hydrates participant profiles on message relay
- `processFriendRequestCreateEvent` / `processFriendAddEvent`: hydrates friend profiles
- `social.ts` federated friend-request handler: hydrates the looked-up stub

Snapshots for tombstoned users carry `deleted: true` and no profile fields — the internal `!deleted:<id>` username marker never leaves the instance (`getDmParticipants`, `buildProfileSnapshot`).

A snapshot's `username` is the user's **handle**, never the sender's row name: every builder (`getDmParticipants`, the group-metadata actor in `queueGroupMetadataRelay`, `buildProfileSnapshot`) sends `relayHandleOf(row)` (`stubName.ts`): a native user's username; for a row homed elsewhere the local part of `<local>@<homeInstance>`, the handle a `~<n>` name was given for, and null for a placeholder name. Senders up to 1.7.0 sent the row name (`kai@host`, `kai~1@host`); receivers read the field through `handleFromHint`, so such a value neither names a row nor becomes a display name.

`hydrateReplicatedUserProfile` is **best-effort fill-empty only**, under one rule: it writes a profile column (`displayName`, `avatar`, `avatarColor`, `banner`, `bio`) only when the column is empty and the row has no home version (`profile_updated_at IS NULL`). An empty display name is filled with `displayName`, else the snapshot's handle. A relayed snapshot carries no version, and a DM relayed by one instance carries snapshots of participants homed on other instances, built from its own replicas, which can be stale. Taking such a snapshot over a stored value let a stale third-party replica flip a field (it did so for `avatarColor`) and announce each flip. Once `applyHomeProfile` has written a home version, the home's profile stands as written, empty columns included: an avatar or bio the user removed at home is not brought back by a snapshot from elsewhere. A row the home has never answered with a version (not yet asked, home unreachable, or a home up to 1.7.0, whose answers carry none) is still filled. Both conditions are checked in the `UPDATE` itself (`WHERE profile_updated_at IS NULL`, `COALESCE(NULLIF(col, ''), ?)` per column), not on the row passed in: that row is read before the images download, and the home's answer to the creation pull (`scheduleHomeRecordPull`) can land meanwhile. A row that already has a version downloads nothing; a downloaded image that is not written is removed. Fill-empty also protects locally-downloaded bare filenames produced by `applyHomeProfile` from being clobbered back to absolute URLs on the next DM/friend relay. Authoritative updates flow exclusively through the home's version-checked `profile_update` and by-home-id answers. The username is not a profile column: hydration renames only a row with a placeholder name or a `~<n>` name for the same handle (`applyPlaceholderRename`, "Stub Username Backfill").

**Detached-account guard:** Alongside the native-user skip (`!user.homeInstance → return`), the function also **no-ops on detached rows** (`federation_home_orphaned = 1 → return user`). A detached account retains its `homeInstance` for provenance (design §7), so the native-user skip alone would not catch it; without this guard a DM/friend relay from the reset domain's new incarnation, resolved via an old `homeUserId` tier-1 hit, could fill the sovereign account's empty fields. This is the same domain-keyed mutation class as `profile_update`/`presence_update`, guarded at its own site (design §4.3).

When the function does fill an empty avatar/banner, it calls `downloadProfileAsset` against the user's home instance and stores the resulting **local bare filename**. Only on download failure does it fall back to the absolute URL — matching the behavior of `processProfileUpdateEvent`.

#### Profile Sync (S2S)

Profile data is synced server-to-server. The home instance is authoritative — when a user updates their profile, the home server broadcasts a `profile_update` relay event via the outbox; see [Who gets a broadcast](#event-queuing-federationoutboxtsqueueoutboxevent) for which peers that reaches.

**Event:** `profile_update` (contextType: `profile`)

**Payload:** `FederationProfileUpdatePayload`:
- `homeUserId`, `homeInstance`, `profileUpdatedAt` (monotonic version)
- `username` — the home user's canonical handle (without `@domain`). Receivers apply `displayName ?? username` when writing the stub's displayName, so stubs whose home user has no displayName show the real handle instead of getting clobbered to null. Username itself is immutable on the home instance, so the receiver does NOT rewrite the stub's username column on profile_update.
- `displayName`, `avatar` (absolute URL or null), `banner` (absolute URL or null)
- `accentColor`, `avatarColor`, `bio`

**Targeting:** Broadcast; see [Who gets a broadcast](#event-queuing-federationoutboxtsqueueoutboxevent). Peers silently accept if they have no replica.

**Queueing:** `entityId = homeUserId`, queue `profile:<homeUserId>`; a newer edit replaces a queued one. See [Outbox queues](#outbox-queues-federationoutboxqueuets).

**Processing:** The row updated is the one that IS the payload's `homeUserId` + `homeInstance` (`resolveRelayActor`) and is homed elsewhere; a native user of this instance is never one, and anything else is acked without effect (no replica here; a row created later pulls the current profile, see "Home profile pull"). The payload is applied by `applyHomeProfile` (`routes/federation/profile.ts`), the one writer of a remote user's profile from the home:
- **Version rule:** a version replaces no version and any older one; no version (an older home's by-home-id answer) replaces only no version. The check is repeated inside the `UPDATE` (`profile_updated_at IS NULL OR profile_updated_at < ?`), so an apply that lost a race while its images downloaded writes nothing and removes its downloads.
- **Fields:** overwrites `displayName` (`displayName ?? handleFromHint(username)`), `avatar`, `banner` (downloaded, see below), `accentColor` (kept when the source does not carry it), `avatarColor`, `bio` and `profile_updated_at`. Never renames the row.
- Removes replaced local image files, and sends one `user_updated` to `collectProfileBroadcastTargetIds(row)` plus the row's own sessions.
- Native and detached rows are returned unchanged.

**Detached-account guard:** After the identity lookup and before `applyHomeProfile`, if the resolved `localUser` has `federation_home_orphaned = 1` (detached — home domain was reset, now a sovereign local account), the event is **acked (messageId pushed to `accepted`) and skipped without applying**. The reset domain's new incarnation must never overwrite an established account's profile by replaying its old `homeUserId`. Ack rather than reject because the sender legitimately considers the identity theirs to update; from this side the update simply no-ops.

#### Home profile pull

A `profile_update` is pushed only when the user edits their profile, and snapshots only fill empty fields of a row without a home version ("S2S Profile Hydration"), so a row's profile becomes the home's only through a push or an answer from the home. The answer is `POST /api/federation/users/by-home-id` (see below), which carries the profile's version (`profileUpdatedAt`; a never-edited profile is at its account's `createdAt`, before every later edit) and `accentColor`. Every by-home-id answer is applied with `applyHomeProfile` (`homeProfileFromAnswer`), exactly like a push:
- **On creation.** `resolveOrCreateReplicatedUser` calls `scheduleHomeRecordPull(row)` (`utils/federationStubBackfill.ts`) for every row it creates, unless the caller has just asked the home (`hints.homeAsked`, the client DM routes). In the background, only when the home is an active peer (`activePeerOriginForHome` in `utils/federationOriginResolve.ts`), at most one lookup per identity at a time; the row is read again once the home answered, so a creation that rolled back changes nothing. This covers a row created from a third instance's stale snapshot, and a `profile_update` that arrived before the row existed (dropped, not queued).
- **On activation** (`backfillStubUsernamesForPeer`, "Stub Username Backfill" below): every row still without a version (filled before 1.8 or while the home was unreachable), unless its home already answered without a version in this process.
- **Client DM routes** (`resolveRemoteIdentityForClient`) and **re-attach** apply the answer they already asked for.

**Mixed versions:** a home up to 1.7.0 sends neither field; its answer is applied only while the row has no version, and never replaces an accent colour. Such an answer leaves the row without a version, so the row is remembered in memory (`answeredUnversioned`, per row id and `homeUserId`) and the activation pass does not ask about it again until the next start; otherwise every activation would download its images again and announce it. After the home upgrades, the first pass after a restart gets a versioned answer. A receiver up to 1.7.0 ignores both fields.

**Known limit:** a row whose home is not an active peer of this instance (the user is met only through a third instance) cannot be asked. It keeps what snapshots filled until the home and this instance peer; the next activation then applies the home's profile.

#### Profile Image File Replication

When a `profile_update` relay carries avatar or banner absolute URLs, the receiving instance downloads the image files locally rather than storing remote URLs. This eliminates cross-origin dependencies — avatars render from the local `/api/uploads/` endpoint.

**Flow:** `processProfileUpdateEvent` calls `downloadProfileAsset(url, sourceInstance)` for each of avatar/banner:
1. Origin check (URL hostname must match authenticated source instance). This constrains the first request only, which is why step 2 does not use bare `fetch`.
2. `safeFetch` with 10s timeout. It validates the target and re-validates the destination of every redirect hop before following it, so the origin check cannot be sidestepped by a peer answering with a 30x.
3. Content-type validation (`image/*` only)
4. Size cap (`MAX_PROFILE_ASSET_BYTES`, 8 MiB). A declared `content-length` over the cap is refused before the file is opened; the body is then counted as it streams and the transfer is aborted the moment it exceeds the cap, so a peer cannot answer with an unbounded body.
5. Stream to temp file (`temp_{snowflake}{ext}`), atomic rename to `{snowflake}{ext}`
6. Store local bare filename in user row

**Fallback:** On any download failure (timeout, HTTP error, non-image content, origin mismatch, refused redirect target, over-cap body), the absolute URL is stored instead. The temp file is unlinked on every failure path. This degrades to the pre-replication behavior — the avatar loads cross-origin from the home instance.

**File cleanup:** When avatar/banner changes, the old local file is deleted via `deleteUploadFile()`. The check `!oldValue.startsWith('http')` ensures only locally-downloaded files are deleted, not absolute URL strings.

**Migration / backfill:** `backfillReplicatedProfileAssets` runs on server start (kicked off by `startFederationWorkers`, non-blocking). It scans `users` rows where `home_instance` is set and `avatar`/`banner` start with `http`, calls `downloadProfileAsset` against the home instance for each, and rewrites successful downloads to local filenames. Idempotent: rows whose home is unreachable are left as URLs (they still render while the peer is up) and retried on the next start. This handles both legacy data from before file replication shipped and any rows whose home was offline during a previous attempt.

**Write protection:** Remote instances reject PATCH /users/@me profile field updates for replicated users (homeInstance set). Profile data is read-only on remote — only updated via S2S relay.

**Bootstrap:** When a new origin appears in a user's `replicatedInstances`, the home server queues a targeted `profile_update` to that peer.

**File handling:** Profile images are downloaded locally on relay receipt (see "Profile Image File Replication" above).

**Replaces:** Client-driven `profileSync.ts` (deleted). `hydrateReplicatedUserProfile` still bootstraps null fields during DM/friend relay (rules in "S2S Profile Hydration"); it now also runs the same local-download path so newly-created stubs end up with bare filenames, not URLs.

#### Presence Sync (S2S)

Native users' status (and optional rich activities) is projected to peers via the `presence_update` relay event. Closes the doc/code gap previously documented in `activity-presence.md` — replicated stubs now have their status maintained by the home instance over S2S, not derived from absent local WS state.

**Event:** `presence_update` (contextType: `profile`)

**Payload:** `FederationPresenceUpdatePayload`:
- `homeUserId`, `homeInstance`
- `status: 'online' | 'idle' | 'dnd' | 'offline'`
- `activities?: Activity[]`. Current senders always include it (`[]` for none). The receiver reads a list as the full set and an absent field as "unchanged": peers that predate this send status-only relays on every connect and in their activation snapshot, also while the user is playing.
- `ts: number` — emitter clock (last-write-wins per stub if needed)

**Outbox-only — never written to mutation log.** Presence is ephemeral. Replaying old presence on peer activation would be wrong (stale state). The outbox queues directly without `appendMutationLog`. Stale entries that fail delivery beyond retry budget are dropped.

**Sender call sites** (all in `utils/federationPresence.ts:queuePresenceRelay`):
- `ws/handler.ts` (auth path) — the user's chosen status (`users.chosen_status`)
- `ws/handler.ts` (`finalizeDisconnect`) — `offline` (native rows; a replicated row returns to its home's projection and relays nothing, `activity-presence.md` "DB Persistence")
- `ws/presence.ts` (`applyChosenStatus`) — manual `online`/`idle`/`dnd`, from REST `PATCH /api/users/@me` and the WS `presence_update` client event
- `ws/events.ts` (`handleActivityUpdate`) — when activities change
- `routes/users.ts` (showActivity-toggle clear) — cleared activities

The auth-path relay carries the activities another session of the user already reported (none on a first connection), so a second device connecting does not clear the user's activity on peers.

No-op for replicated users (we don't own their presence).

**Friendship snapshot** (`snapshotPresenceForFriend`, called by `exchangeFriendPresence` in `ws/presence.ts` once, at the step that created the friendship row: local accept, or whichever of the relayed `friend_request_update` (accepted) and `friend_add` formed it): for a native side whose new friend is a replicated row, one `presence_update` with the native's current status and activities, targeted at the friend's home (`getFriendEventTargets`). Skipped when the native is offline. The friend's home usually had no row for the native when the native's current activity began, so it dropped that relay; without this, the friend saw no activity until it changed (#340).

**Detached accounts have no status on other instances.** `queuePresenceRelay` and `snapshotPresenceForPeer` skip every row with `home_instance` set, detached ones included, although a detached account owns its chosen status locally (`ownsChosenStatus`). This is deliberate: a detached account's outbound identity is still its old home identity (`relayActorOfUser`, the DM message builder and client registration on other instances all send `homeUserId` + the reset `homeInstance`), and the receiver below only accepts a `presence_update` from the identity's home instance. A relay under the old identity would be rejected by every peer as `attribution_mismatch`; one under this instance's own id would match no row anywhere. Changing that means giving detached accounts a new outbound identity or a new attribution rule (#310).

**Targeting:** broadcast, as `profile_update`; see [Who gets a broadcast](#event-queuing-federationoutboxtsqueueoutboxevent). Peers without a stub silently no-op. Privacy: status is already public to anyone authorized to see the user via friend/DM/space relationships, so broadcast-fanout adds no new disclosure surface.

**Queueing:** `entityId = userId`, `contextId = userId`, queue `presence:<userId>` (separate from the user's profile queue); a newer status replaces a queued one. See [Outbox queues](#outbox-queues-federationoutboxqueuets).

**Receiver:** `processPresenceUpdateEvent` (`routes/federation.ts`). Strict attribution — `payload.homeInstance` domain MUST equal source peer's domain. Resolves the local stub that IS the payload's `homeUserId` + `homeInstance` (`resolveRelayActor`; a native user of this instance is never one, and anything but a `found` row homed elsewhere is acked without effect), applies the status as the stub's projection (`projectReplicaStatus`; the rule is `activity-presence.md`, "Replica presence"), keeps the activities for the stub in `ConnectionManager.userActivities` (a list replaces them after `validateActivities`, the local `activity_update` limits; `[]` or `offline` clears them; an absent field or a list that fails validation leaves them unchanged), and broadcasts a WS `presence_update` to local users via `collectProfileBroadcastTargetIds(stub.id)` — friends, DM members, and space co-members — with `activities` when they changed (empty clears on clients), without it otherwise, and with the stub's `homeUserId`/`homeInstance`. The kept activities are what the ready payload and the friendship snapshot report for the remote user.

**Detached-account guard:** After the identity lookup and before the status write, if the resolved stub has `federation_home_orphaned = 1` (detached — home domain was reset, now a sovereign local account), the event is **acked (messageId pushed to `accepted`) and skipped without applying**. The reset domain's new incarnation must never flip an established account's presence by replaying its old `homeUserId`. Ack (not reject) mirrors the `profile_update` guard rationale — the sender considers the identity theirs, so we no-op rather than trigger a retry loop.

**Peer lifecycle hooks** (`utils/federationPresence.ts`):
- **`onPeerActivated`** awaits `snapshotPresenceForPeer(origin)` — emits a `presence_update` (status and current activities) only for online natives that have an S2S relationship with the peer (friend/DM with a peer-stub, or `replicatedInstances` opt-in for the peer origin). Snapshot work scales with relationship count, not native count.
- **`onPeerDeactivated`** invokes `markPeerStubsOffline(origin)` — projects `offline` for every replicated row homed on that peer (`activity-presence.md`, "Replica presence"; detached rows are skipped), drops the activities kept for it, and broadcasts a local `presence_update` with the status each row now shows.
- **Flap recovery semantics:** `onPeerActivated` re-runs on every transition into `active`, including the 15-minute health-check `unreachable → active` recovery. This is load-bearing for correctness: `markPeerStubsOffline` ran on the prior deactivation, presence is not in the mutation log, so a fresh snapshot is the only signal that re-establishes truth. The relationship-scoped query bounds the cost.

#### Stub Username Backfill

A replicated stub is named `<realname>@<domain>` when a username for the identity is known at creation (`hints.username` in `resolveOrCreateReplicatedUser`), and `<homeUserId>@<domain>` when it is not. Creation and the rename below read the hint through one function, `handleFromHint` (`stubName.ts`): only a handle-shaped hint (`[a-z0-9_]` after trimming and lowercasing) is a username, so a hint such as a display name leaves the row id-named. The id name is still minted today, not only by rows from before the realname scheme: a client route whose home lookup got no answer, a `dm_call_start` caller (the call payload carries only a display name, which is never used as a username), and any relay whose snapshot lacks a username. Before the call relay stopped passing it, an incoming call from an unknown caller named the row after the caller's display name (`<display name>@<domain>`). Both are placeholder names, and such a row is renamed once, the first time a username for it arrives. Home usernames never change, so the rename is one-way.

**Placeholder names:** `isPlaceholderNamedStub(user)` in `routes/federation/stubName.ts` holds for a replicated row (`password_hash = '!federation-replicated'`, so a federated account's login name is never touched), with a `homeUserId`, not detached (`federation_home_orphaned = 0`), whose username ends with `@<homeInstance>` and whose local part is either the `homeUserId` or not shaped like a handle (`[a-z0-9_]+`; registration has accepted only `[a-zA-Z0-9_]` since the first release, so a space, dot, dash, non-ASCII letter or `@` proves it is not the home username). A display-name placeholder that happens to be handle-shaped (display name "kai" for the user `kai_dev`) cannot be told apart from a real handle and is not renamed. A suffixed name (`<handle>~<n>`) is not a placeholder either: the row's handle is known, so the client DM routes and the backfill do not ask its home about it (see "Suffixed names").

**The rename:** `applyPlaceholderRename(user, username, db, seed?)` writes it; `renamePlaceholderNamedStub` (same arguments) writes it and then announces it. Only a handle-shaped `username` renames a row, so a display name never does. When another row already holds `<username>@<domain>` (a stale replica of an account deleted on its home whose username was registered again, while the deletion never reached this instance), the stub takes the first free `<username>~<n>@<domain>` (`firstFreeUsername`, the rule creation uses), and is then no longer a placeholder. With a `seed` (the backfill passes the lookup answer) an empty `displayName` is filled with `displayName ?? username` and a differing `status` is taken over. The announcement is `announceUserUpdated`: `user_updated` to `collectProfileBroadcastTargetIds(user.id)`, as `processProfileUpdateEvent` does. Hydration renames with `applyPlaceholderRename` and announces once, after it has filled the profile.

**Suffixed names.** The suffix separator `~` is outside the handle alphabet (`[a-z0-9_]`), so a suffixed name can never be the real handle of another user of that instance. Earlier versions used `_`: `kai_1` given to a second `kai` shadowed a later real `kai_1`, who became `kai_1_1`, and the first kept `kai_1` for good. A row named `<handle>~<n>@<domain>` is re-checked by every hint that reports that same handle (identity resolution and hydration, `applyPlaceholderRename`): it moves to the first free name for the handle when that is earlier than its own (`<handle>@<domain>` once the stale holder is tombstoned or renamed), announces the move, and otherwise keeps its name without a write. A random suffix is kept, not redrawn. A hint with another handle, and a hint that is not handle-shaped, leaves it alone. A row only ever moves to an earlier name for its own handle and never renames another row, so two rows cannot trade names. Rows suffixed with `_<n>` by earlier versions look like handles, so hints do not re-check them; the activation pass asks their home (below).

**Where it runs:**
- **Identity resolution.** `resolveOrCreateReplicatedUser` renames the row it finds whenever the caller passes `hints.username`. That covers every relay handler that passes the snapshot's username (DM `create`, membership, friend events), the friend-add route (the hint is the home's lookup answer) and the client DM routes below, without a rename call at each site. The hint carries the same trust as at creation: a stub minted from the same event would have taken that name.
- **Hydration.** `hydrateReplicatedUserProfile` renames the row when the snapshot carries `username`, after its native-row and detached-row guards, and announces the row once its fields are filled.
- **Client DM routes.** `resolveRemoteIdentityForClient` (`utils/federationClientIdentity.ts`), used by every `routes/dm.ts` route that takes a `homeUserId` + `homeInstance` pair, asks the home (`lookupRemoteUserByHomeId`) for an unknown identity or a placeholder-named row, then resolves with the answer's username and hydrates the answer's profile. A row with its real name costs no network call. The client never supplies a username. A new row is created only for a snowflake-shaped `homeUserId`, and not when the home answers that the user does not exist. The lookup is made only when the domain is an active peer (the identity's bare host maps to the peer's stored origin through `resolveOriginFromHostname`, including a peer whose origin carries a port) and waits at most `CLIENT_HOME_LOOKUP_TIMEOUT_MS` (2 s), since the client's request is open meanwhile. Without an answer (no active peer yet, unreachable, rate limited, timeout) the row gets the id name, as before, and the same home is not asked about the same id again for 60 s (in-memory, per process); the peer-activation backfill or the first relayed username renames it. See api.md "Naming a remote user".
- **Activation pass.** `utils/federationStubBackfill.ts:backfillStubUsernamesForPeer(peerOrigin)` enumerates the live, attached rows homed on the peer's domain and asks the peer (`lookupRemoteUserByHomeId`, one lookup per row) about each row that has a placeholder name, has no profile version, or may carry a pre-1.8 `_<n>` name (`mayCarryLegacySuffix`: `<handle>_<1..10>` or `<handle>_<8 hex>`, replicas and accounts alike) not yet confirmed in this process. The answer names the row (`applyHomeHandle`, below) and its profile is applied (`applyHomeProfile`, "Home profile pull"). An answer about a different id is ignored; a failed answer for one row leaves it for the next pass without stopping the others; the first rate-limited answer (the home allows 60 lookups a minute per peer) ends the pass, and the next activation carries on. A `_<n>`-looking name the home confirms (a real `kai_1`) is remembered in memory and not asked about again until the next start. Rows whose home is being asked by a creation pull are skipped. A row whose home answered without a version (a home up to 1.7.0) is not asked again in this process ("Mixed versions" under "Home profile pull"). A call while a pass for the same peer runs joins that pass instead of starting a second one. Hook points:
  - `onPeerActivated`: runs per-peer on every transition to `active` (catches stubs whose home was unreachable on a prior pass). Started in the background, not awaited: the presence snapshot to the peer does not wait for a round of lookups. A failed pass is logged and does not affect the activation.
  - `startupBootstrapSync` — one-shot pass at boot for ALL currently-active peers (not just `lastSyncedAt = 0` first-time peers).

**Names from the home's answer (`applyHomeHandle`).** Only an answer to a by-home-id lookup of the row's own id renames a row this way; relayed hints never do, since a `_<n>` name is also a valid handle. A replica takes the first free name for the reported handle (`firstFreeUsername`: a placeholder, `_<n>` or other stale name is replaced, a `~<n>` name moves earlier when it can). A federated account takes exactly `<handle>@<domain>` through `claimHandleName` ("Account names" under "Peer-Side Re-Attach"); when another account signs in with that name, or a replica of the same identity holds it, it keeps its name and the conflict is logged. Each rename is logged and announced (`user_updated`), a replica that moved aside too. **Upgrade note:** a person whose account an older re-attach named `kai_1@<domain>` signs in with `kai@<domain>` after the first activation of their home's peering.

**New endpoint: `POST /api/federation/users/by-home-id`** (HMAC-authenticated, rate-limited 60/min/peer). Body: `{ homeUserId: string }`. Response: `{ found: false }` or `{ found: true, user: { homeUserId, username, profile: { displayName, avatar, avatarColor, banner, bio, status, accentColor, profileUpdatedAt } } }`. `profileUpdatedAt` is `profile_updated_at ?? created_at`; `accentColor` and `profileUpdatedAt` are optional on the wire (homes up to 1.7.0 omit them; `lookupRemoteUserByHomeId` reads a non-number version as none). Native non-deleted users only. `lookupRemoteUserByHomeId` reads only an explicit `{ found: false }` as `not_found`; 429 is `rate_limited`, and every other answer (network error, timeout, any other status such as 404 from a peer without the route, a body that is not JSON or not either shape) is `unreachable`. It throws only when the peer row is missing.

---

## 11. Reaction Relay

### Outbound

Reactions are queued by WS event handlers in `events.ts`:
- `dm_reaction_add` -> `queueOutboxEvent(reactionId, channelId, 'reaction_add', payload, targetOrigins)`
- `dm_reaction_remove` -> `queueOutboxEvent(messageId, channelId, 'reaction_remove', payload, targetOrigins)`

Payload includes `userId`, `homeUserId`, `emoji`, `createdAt`, plus `messageId` and `messageHomeInstance` for cross-instance message resolution: the reacted-to message as a `FederationMessageRef`, built by `dmMessageFederationRef` (see `dm-system.md` "Naming a message across instances").

The WS reaction handlers accept a federated account (a user whose `homeInstance` is another instance) like any DM member. Until #295 they silently dropped its DM reactions: a leftover of the `isFederated` gate that `662143bf` lifted for every other DM operation, so a client whose DM was pinned to a remote origin could not react at all.

The mutation log entry for reactions stores a simpler payload (no `messageId`/`messageHomeInstance`), while the outbox entry carries the full reaction payload including those fields. The sync endpoint (`POST /api/federation/sync`) fills them when it replays a reaction: it reads the reacted-to row (the log's `entity_id`) and names it with the same `dmMessageFederationRef`, so a replayed reaction resolves on the receiver exactly like a live one. A reaction whose message row is gone by the time of the sync is not replayed, and a reaction row is served only when the reaction's current state agrees with it (an add while the reaction exists, a remove while it does not), so a replay converges on the state now.

### Inbound

**`processReactionAddEvent` (`routes/federation/events/dmMessages.ts`):**
1. Resolve message via `resolveLocalDmMessage(canonicalMessageId, messageHomeInstance, sourceInstance, db)`:
   - If `messageHomeInstance === getOurOrigin()` -> find by local ID (the message originated here)
   - Otherwise -> find by `(messageHomeInstance || sourceInstance, canonicalMessageId)` tracking -- uses `messageHomeInstance` when available (correct origin in 3-instance relay), falls back to `sourceInstance`
2. Resolve reacting user via `resolveRelayActor` (must already exist): unknown → `user_not_found`
3. Dedup: check existing reaction by `(dmMessageId, userId, emoji)`
4. Insert `dm_reactions`, broadcast `reaction_added` to local clients

**`processReactionRemoveEvent` (`routes/federation/events/dmMessages.ts`):**
- Same resolution logic
- Delete matching reaction, broadcast `reaction_removed` if changes > 0

---

## 12. Pull Sync and Initial Sync

### Pull sync

An instance pulls each active peer's mutation log through the peer's `POST /api/federation/sync` and applies what it finds, so an event the live relay lost reaches it anyway: a refusal that later resolves, an outbox row that expired while the peer was down, a restart, or a restore from backup (its cursors go back with the database, so the next pull re-reads what the backup lacks). Before #255 this ran only when a peering became active, so a gap that opened after peering was permanent. Source: `utils/federationSync.ts`.

**When.** On every activation (`onPeerActivated`), and periodically: `processResyncTick` runs a minute after boot and every 15 minutes after, over every `active` peer, four peers at a time (`SYNC_PEER_CONCURRENCY`). Both pull all three contexts: `dm`, `friend`, `profile`. A retry tick every 5 minutes replays kept events (below), every peer's side by side. Each peer is pulled by one caller at a time: for that peer, activation, the periodic tick and the retry tick queue behind each other (`runForPeer`); other peers never wait for it.

**Budget.** A pass reads at most 20 pages and spends at most 45 seconds on each context of a peer (`SYNC_PASS_BUDGET`); the time bounds the page request in flight too, so a peer that answers slowly, or answers `hasMore` for ever, ends its pass on time. A pass that stops at its budget leaves the context `partial`: the cursor is saved after every page, the next pass resumes from it, `last_synced_at` is not set, and the next periodic tick comes after a minute (`RESYNC_CONTINUE_DELAY_MS`) instead of 15, so a long catch-up continues promptly without holding anything up.

**Cursor.** One row per (peer, context) in `federation_sync_cursors`, in the **peer's** clock: the `(mutated_at, id)` of the last log row consumed (the page's `checkpoint` / `checkpointId`), saved after every page, so a long catch-up resumes where it stopped. It never moves back. Each pass starts `FIRST_PAGE_OVERLAP_MS` (2 min) before the cursor, which absorbs a backward clock step on the peer (the rows it re-reads apply as no-ops); later pages continue by keyset (`afterId = checkpointId`). Against a server without keyset pagination the next page starts at `checkpoint - 1`, re-reading the checkpoint's millisecond instead of skipping the rows of it that fell past the page; a full page within one millisecond can only move on by skipping the rest of it, which is logged. A cursor with no row starts at 0: every processor is safe to apply twice (below). Migration 0022 created every cursor of a peer that had synced before at its `last_synced_at`, where the pull it replaced (which asked for rows after that time) would have continued, so the upgrade does not replay 90 days of every peer's DM and profile history. **The friend context never reads before the ledger start** (`friendHistoryFloor`): friend events applied before `instance_settings.ledger_started_at` (the upgrade's time) cannot be recognized by the ledger (`social.md` "Applied-event ledger"), so the first request of a friend pass is the later of the overlap and the ledger start, for every peer row, including one created after the upgrade (re-peered after a revoke or a reset) whose cursors start at 0. Once the ledger start is older than the log's 90-day retention, no peer can serve a row from before it and the floor is dropped; an instance that ran this release from its first boot has none. The ledger start is in this instance's clock and the log in the peer's: a peer clock ahead by some minutes lets through that much of the friend history before the upgrade, the same tolerance the overlap has. `peer_epoch` is the peer's instance id the cursor was taken against: a new incarnation restarts every cursor of that peer at 0 and drops its kept events. The epoch is checked before every pull and before every retry run (`reconcileCursorEpoch`): a reset peer that peers again reactivates the same peer row with a new instance id, and its predecessor's kept events must not be replayed as its word. `federation_peers.last_synced_at` is only the local time of the last pull that completed every context asked for, shown to admins.

**Outcomes.** Every pulled event is applied through `processRelayEvents` with `delivery: 'catch_up'` and its answer classified by [`classifyPulledRejection`](#rejection-reasons):

- accepted, or `taken`: applied (counted as already held for `taken`);
- `refused`: dropped with a warning;
- `retry`: kept in `federation_sync_retry` with the whole event, one row per distinct event (`event_hash`, the sha256 of its canonical JSON, so a re-read adds nothing and two reactions in one millisecond are both kept). The cursor moves on regardless; stopping it would leave the peer stuck behind one event for ever.

`unknown_message` answering an `update` or `reaction_add` is decided from what this instance knows. It is final (dropped) when the message can no longer arrive: it is homed here; it is homed on the peer that served the event, whose log holds its create earlier and whose events the pull applies in order, so that create was applied and the message deleted since, refused for good, or lies before this instance's cursor; or its home's delete of it is recorded (`dm_delete:<id>` in `federation_applied_events`). A message homed on a third instance may still come from that instance, so the event is kept.

**Order.** Events are ordered per subject, `syncSubjectKey`: a message (the peer's id for it: its create, edits, delete and reactions), a group member (keyed as its [subject clock](#subject-clocks-member-and-friend-events-are-last-writer-wins)), a friend pair (likewise), a group's owner and metadata, one member's closed state or read state, or a profile. A subject with a kept event holds its later pulled events behind it (kept with reason `held_behind_earlier_event`), so the pull applies one subject's events in the peer's order. Other subjects never wait for it: a message the receiver cannot place yet holds back its own edits and reactions, not the rest of its conversation. This order covers one peer's pull only; member and friend events are ordered across the live relay, the pull and every peer by their subject clocks.

**Retry.** `processSyncRetryTick` replays a peer's kept events in the peer's order, `(event_ts, id)` across subjects, so an event a later one depends on (the `member_add` that bootstraps a group, before a message in it) goes first. A subject goes when its first row is due: an applied, `taken` or `refused` answer removes the row and the next row of the subject goes at once; a `retry` answer reschedules it (1 min, 5 min, 30 min, 2 h, 6 h, then 24 h) and stops the subject. A row kept for more than 7 days is dropped with a warning, which bounds what the table holds. Rows of a peer that is not `active` wait. Replay is local: it needs no network and does not depend on the 90-day log retention.

**Catch-up is not news.** A pulled event raises no sound or notification on a client. `processCreateEvent` stores a pulled message and sends no `dm_message_created`; clients see it when they next load the conversation. A pulled message that created this instance's copy of a 1-on-1 sends each member a `dm_channel_created` for the copy, which makes no sound, so the conversation is listed without a reconnect. Unread state follows the read pointer as always: the conversation's newest message decides it, so a healed old message below the reader's pointer counts as read. Edits, deletes and reactions still broadcast their updates, which correct what an open client shows.

**401 / 403.** A refused `/sync` only skips that context for this pull. Peer state belongs to the outbox and recovery workers; the pull never writes `federation_peers.status` or the auth-failure counter. `/sync` requires the requester's row to be `active` on the serving side, so a peer that currently marks this instance `unreachable` answers 403 until its own recovery.

**Mixed versions.** Nothing requires the peer to upgrade: `/sync` exists on every version, an older server ignores `afterId` and omits `checkpointId` (handled above). An older peer never pulls periodically from this instance, as before.

### Receiver guarantees: applying an event twice

The pull re-delivers events the live relay already delivered, often after local actions that reacted to them, and the outbox may send a delete for a create whose delivery it could not confirm. Every relay processor is therefore safe to apply twice and to apply late:

| Event | Applied again | Arriving after a newer state |
|---|---|---|
| `create` | `duplicate` (dedup on `(source_instance, source_message_id)`), no side effects | a `delete` for it arrived first: `duplicate`, the message never appears (tombstone below). Pulled, it reopens only members who closed the conversation before the message was written (`dm-system.md` "Closed state is last-writer-wins") |
| `update` | no-op, no broadcast (the copy already holds that `editedAt`) | an older `editedAt` is ignored; an older sender without `editedAt` applies only when the content differs |
| `delete` of a held message | deletes it, records a tombstone | n/a |
| `delete` of a message not held | accepted as a no-op on both paths, live and pull. When the message is homed on the signing peer, records the tombstone `dm_delete:<messageId>` for that peer in `federation_applied_events`, so a create of it arriving later is answered `duplicate`. A delete naming a message homed elsewhere records nothing: no peer can block another's messages | n/a |
| `reaction_add` / `reaction_remove` | set semantics, broadcast only on change | the sync endpoint serves a reaction row only in the reaction's current state ([Sync Endpoint](#sync-endpoint-post-apifederationsync)). Known limit: a stale add can undo a removal made on the receiver through client federation, when a pull runs between the removal and its relay to the reaction's home |
| `member_add` / `member_remove` | accepted no-op (system-message marker on `(source_instance, source_message_id)`) | older than the member's clock: accepted, changes nothing ([Subject clocks](#subject-clocks-member-and-friend-events-are-last-writer-wins)) |
| `ownership_transfer` | accepted no-op (system-message marker) | only the current owner's instance may transfer, so a transfer from an earlier owner's instance is refused `unauthorized_source` |
| `group_metadata_update` / `read_state_update` / `profile_update` | last-writer-wins on `metadataUpdatedAt` / `timestamp` / `profileUpdatedAt` | same |
| `dm_close` / `dm_reopen` | no change, no broadcast | last-writer-wins on `dm_members.closed_changed_at` |
| `file_rejected` | no broadcast unless a new affected user is added | n/a |
| `friend_request_create` / `_update` / `_cancel`, `friend_add`, `friend_remove` | `duplicate` through the applied-event ledger (`social.md` "Applied-event ledger"), recorded on accept, on both paths | older than the pair's clock: accepted, changes nothing ([Subject clocks](#subject-clocks-member-and-friend-events-are-last-writer-wins)) |

`federation_applied_events` rows live 100 days (janitor), longer than the 90-day mutation log a pull reads.

### Subject clocks: member and friend events are last-writer-wins

This is the one place the rule is written; other specs point here.

A member or friend event moves its subject between two states, and the same subject can be moved by events from different instances (an add from the adder's instance, a kick from the owner's, a leave from the member's home) on two paths (the live relay and the pull). One event lost on one path and delivered later on the other would otherwise land after a newer one and undo it: an add delivered by a pull after the kick that followed it, or a request delivered after its cancel. So each subject has a clock, `federation_subject_clocks`, read and written only through `utils/federationSubjectClock.ts`:

| Subject | Key | Events |
|---|---|---|
| Group member | the group's `federatedId` + the member's identity (`homeUserId` + home domain) | `member_add`, `member_remove` |
| Friend pair | both identities, in either order | `friend_request_create`, `friend_request_update`, `friend_request_cancel`, `friend_add`, `friend_remove` |

Identities are compared the way `sameRelayActor` compares them: home user id and home domain, with this instance's own names (origin host, identity domain) as one.

- **A relayed event older than the clock is stale.** Its timestamp (`event.timestamp`, which the live relay and the mutation log carry alike) is older than the subject's last recorded change: it is accepted and changes nothing, no system message, no broadcast. An event at the clock's own time is not stale: an acceptance's `friend_request_update` and `friend_add` share one timestamp, and each is idempotent.
- **An applied event moves the clock to its timestamp**, never back. So does an event accepted as a no-op once its sender's authority over it was checked: a kick of someone who is not a member, a cancel of a request that is not here. That is what makes the add or request delivered after it stale. A kick of a group this instance does not hold moves no clock, because the owner's instance that authorizes it is named only by a copy of the group; a leave does, since its attribution is checked against the member's home.
- **A change made here moves the clock** to the timestamp of the event that relays it: group creation (every member), `POST /api/dm/:id/members`, kicks and leaves (`removeDmMember`), and the friend routes (request, accept or decline, cancel, remove) for a pair with a federated side.
- **A subject with no row has no known change.** Its first event applies and starts the clock. Migration 0022 created the table empty: a membership or friendship from before the upgrade gets its clock from its first event after it.

Both paths reach the processors through `processRelayEvents`, as does the replay of a kept pulled event, and each processor claims the clock (`claimSubjectChange`, check and write in one step) at the point where it writes, after its authority checks and with no `await` in between, so no path and no concurrent delivery can apply an older event over a newer one. `member_add` also checks the clock before a bootstrap, so a stale add never creates a copy of the group; the bootstrap roster is the sender's view at the time of the add, so a roster member whose clock is newer is left out, and the roster moves no clock (that view may itself lag behind a change made elsewhere). Only the added member's clock moves.

Timestamps come from different instances' clocks. The rule only has to order events that a lost delivery set apart by minutes to days, not milliseconds. A clock row is swept 400 days after its last write (`sweepSubjectClocks`), longer than an event can still arrive: the outbox TTL is at most 365 days and the mutation log keeps 90.

### `startupBootstrapSync()` (`federationPeerActivation.ts`)

Triggered once at server startup (async, non-blocking). Finds peers with `status = 'active'` and `lastSyncedAt = 0` and calls `onPeerActivated(peerId, 'startup_bootstrap')` for each, for the rest of what activation does (outbound subscriber fan-out, stub backfill, presence snapshot). Peers that have synced before are covered by the periodic pull's first run a minute after boot.

### Peer Activation Recovery

Every transition of `federation_peers.status` to `active` invokes `onPeerActivated(peerId, reason)` — one handler wired at all transition sites. Two independent invariants, both unconditional:

1. **`resetOutboxBackoff`** — sets `nextRetryAt = now` and `attempts = 0` for every outbox entry belonging to the peer. Entries that accumulated exponential backoff before the peer went unreachable are immediately eligible again. Attempts counter is also reset so a freshly-healthy peer's next failure starts at `BACKOFF_SCHEDULE_MS[0]` (30s), not wherever the counter left off.
2. **`syncPeerMutationLog`** (`utils/federationSync.ts`) — pulls the peer's mutation log from this instance's cursors for it, every context: DM, friend, profile, in that order, each paginated. See [Pull sync](#pull-sync).

#### Where it is called

The peer state machine (`utils/federationPeerState.ts`) calls it on every transition into `active`, with the transition's activation reason: `initiate_accepted`, `accept_new`, `accept_pending`, `accept_rejected_override`, `accept_awaiting_approval`, `accept_awaiting_approval_fallback`, `approval_handshake`, `ensure_peered`, `stale_peering_verified` (a parked row whose `/epoch` now verifies) and `health_check_recovery`. `startupBootstrapSync` calls it with `startup_bootstrap`. Nothing else calls it; see [Peer state](#peer-state). The effects run after the write commits and are not awaited by HTTP handlers.

Concurrent activations for the same peer are deduplicated via an in-flight promise map keyed by `peerId`.

### onPeerDeactivated

Mirror of `onPeerActivated` for the transition *out* of `active`. Responsibility: sweep `ConnectionManager.federatedCalls` for entries whose `federatedCallHost` matches the deactivated peer and evict them — emitting `dm_call_undeliverable { phase: 'host_unreachable', terminal: true }` to each entry's `ringedUserIds`. See `docs/systems/voice.md` for the client teardown contract.

**Where it is called:** the peer state machine calls it on every transition out of `active`, with the transition's cause (`auth_threshold`, `admin_revoked`, `reset_detected`, ...). That includes the outbox worker's unreachable threshold (`markPeerUnreachable`, cause `network_threshold`). No other code calls it.

Deduplicated by peerId using a **separate** `inFlightDeactivation` map (not shared with activation) so flapping peers retain clean activate-then-deactivate ordering.

A 30s periodic sentinel in `federationWorker.ts` (`runFederatedCallSentinelTick`) is the backstop — it scans active FederatedCallEntries, compares each host's current peer status against reality, and catches transitions missed by the hook sites.

#### Peer-state × outbox-enqueue × recovery matrix

| Status | `queueOutboxEvent` enqueue | Mutation log captures | Recovery on transition to `active` |
|---|---|---|---|
| `active` | Queue | Yes (for covered event types — see below) | N/A |
| `pending` | Queue | Yes | `onPeerActivated` |
| `unreachable` | Queue | Yes | `onPeerActivated` |
| `awaiting_approval` | **Drop, debug-log** | Yes | `onPeerActivated` |
| `needs_attention` | **Drop, debug-log** | Yes | `onPeerActivated` (fires when the row is re-created via admin Reset + re-peer) |
| `rejected` | Drop, debug-log | Yes | `onPeerActivated` |
| `revoked` | Drop, debug-log | Yes | `onPeerActivated` (fires when the row is re-created via hard-delete + re-initiate) |

`queueOutboxEvent` uses an exhaustive TypeScript `switch` on the narrowed peer-status union — adding a new status value without handling it fails compile-time typecheck (`const _exhaustive: never = status;`).

**Mid-call race catch:** when the initial peers SELECT filters out a peer because its status is non-deliverable, but the fallback loop observes the status has since flipped to `active`/`pending`/`unreachable`, the code re-fetches the peer row and appends it to `matchedPeers` so the outer enqueue loop includes it. Silent drops would lose real-time delivery under asymmetric failure (e.g., `/peer/accept` 200 response lost on the wire, health-check transition firing on only one side).

#### Mutation log coverage

Event types covered by `appendMutationLog` (replayed on sync-pull):

| Event type | `contextType` | Source |
|---|---|---|
| DM `create` / `update` / `delete` | `dm` | `federationOutbox.queueDmRelay`, `federationOutbox.queueDmMessageDeleteRelay` |
| `reaction_add` / `reaction_remove` | `dm` | `ws/events.ts` |
| `member_add` / `member_remove` / `ownership_transfer` | `dm` | `dm.ts` |
| `dm_close` / `dm_reopen` | `dm` | `federationOutbox.queueDmCloseRelay` |
| `read_state_update` | `dm` | `federationOutbox.queueReadStateRelay` |
| `file_rejected` | `dm` | `federationWorker.handleSizeRejection` |
| `group_metadata_update` | `dm` | `federationOutbox.queueGroupMetadataRelay` |
| `friend_request_*` / `friend_add` / `friend_remove` | `friend` | `social.ts` |
| `profile_update` | `profile` | `routes/users.ts` (PATCH `/api/users/@me`) |

Ephemeral events (`dm_typing_*`, `dm_call_*`) are fire-and-forget by design and are NOT captured — missed typing/call-signaling packets are acceptable and carry no durable state.

### Sync Endpoint (`POST /api/federation/sync`)

HMAC-authenticated (`authenticateS2SPeer`, active requester only). Serves one page of this instance's `federation_mutation_log`, read and serialized by `routes/federation/handlers/syncPage.ts`. The log only holds mutations made on this instance (a receiver never appends to it), so everything served is this instance's own word, including messages its users wrote as federated accounts of another instance and its reactions to relayed copies.

**Request:**
```typescript
{ sinceTimestamp: number, afterId?: string, dmChannelId?: string, federatedId?: string, contextType?: 'dm'|'friend'|'profile', limit?: 1-500 }
```

**Response:**
```typescript
{ events: FederationRelayEvent[], hasMore: boolean, checkpoint: number, checkpointId?: string }
```

**Pagination.** Rows are read in `(mutated_at, id)` order, strictly after `(sinceTimestamp, afterId)`, or after `sinceTimestamp` when `afterId` is absent. `checkpoint` / `checkpointId` are the last row READ, and `hasMore` is whether the last page read held `limit` rows: a row filtered out or not serializable still moves the requester past it. `checkpointId` is absent when nothing was read (`checkpoint` is then `sinceTimestamp`). Before #255 the next page asked for `> checkpoint`, which skipped the rows of that millisecond that fell past the page.

**A page is never empty while a row the requester may see follows** (`buildSyncResponse`, `handlers/syncPage.ts`). Every version before #255 stops pulling at the first page with no events and then records the pull as complete, so an empty page in the middle of the log would end its catch-up for good. Rows that would serialize to nothing are left out in SQL, where the condition is cheap (below); for the rest (friend events about other instances, a `file_rejected` for another instance), a full page that serves nothing is followed by the next page in the same request, until a page serves an event or the log ends. The request yields to the event loop between those pages.

| `contextType` | Rows |
|---|---|
| `'dm'` / omitted | DM events of conversations shared with the requester, optionally one (`dmChannelId`, or `federatedId`) |
| `'friend'` | Friend events one of whose sides is the requester's (relevance below) |
| `'profile'` | Profile update events |

**DM rows.** Shared conversations are those with a non-null `federated_id`, not soft-deleted, with at least one live member (`is_deleted = 0`, `federation_home_orphaned = 0`) homed at the requester's host; every row of one is the requester's. In any other federated conversation, only the `member_add` and `member_remove` rows whose `membership.user` is one of the requester's live, attached users are: when the kick of the requester's last member there is lost on the live relay, the conversation is no longer shared, and the pull is the only way the kick still arrives. What each row becomes:
- `create` / `update`: the message as it is now, built with `buildRelayPayload`, the live relay's builder (same `type`, author identity, `replyTo`, `mentions`), plus attachments (`sourceUrl` on `getOurOrigin()`), participants, the group `federatedId`, and an update's `target`. Not read once the message is deleted (left out in SQL, as before #255); its `delete` row follows.
- `delete`: the target the delete path logged (the row is gone).
- `reaction_add` / `reaction_remove`: see §11. Read only while the message exists and the reaction's current state agrees with the row (in SQL), so a replay converges on the state now instead of passing through every add and remove.
- `member_add` / `member_remove` / `ownership_transfer`: the stored event.
- `dm_close` / `dm_reopen`, `read_state_update`, `group_metadata_update`: the stored payload with the conversation's `federatedId`.
- `file_rejected`: served only to the instance the rejected message came from (the requester must be the `source_instance` of this instance's copy): it is a reverse relay naming the message by that instance's id.

**Relevance scoping.** Conversations and friend events are the requester's by host, compared the way attribution compares (`identityHost`: lowercase hostname, no scheme or port), so a member stored as `https://host:port` or `host` is the requester's either way. A freshly reset peer receives an empty DM page: its pre-reset history stays with the detached accounts on this side. A friend event qualifies when one side is homed at the requester and that side, when it has a row here, is live and not detached.

### Relay Event Processing

The event processing logic is extracted into `processRelayEvents()` (exported from `federation.ts`), shared by the HTTP relay endpoint (`delivery: 'live'`) and the pull (`delivery: 'catch_up'`, see [Pull sync](#pull-sync)). This avoids a DNS hairpin issue where the server would HTTP-request itself through public DNS, which fails on networks without hairpin NAT.

---

## 13. DM Calls over Federation

DM calls work across federated instances. The caller's instance hosts the LiveKit room. Remote clients connect directly to the caller's LiveKit server using a token passed through S2S relay — no media is routed through the federation layer.

```
User A's client <--WS--> Instance 1 (hosts LiveKit) <--S2S HTTP--> Instance 2 <--WS--> User B's client
                              |                                                            |
                              +------------- LiveKit (direct client connection) -----------+
```

### S2S Event Types

Four relay event types are processed in `processRelayEvents()`:

| Event Type | Direction | Key Payload Fields |
|---|---|---|
| `dm_call_start` | Host → each participant-homing peer | `federatedId`, `livekitUrl`, `tokens: Record<string, string>` (keyed by `homeUserId`, **scoped to the recipient's own members**), `memberTokens?` (the same tokens as `{ homeUserId, homeInstance, token }`; see "Token Scoping"), `caller: { homeUserId, homeInstance, displayName }`, `participants` (full roster) |
| `dm_call_accept` | Participant → Host, then Host → All Peers | `federatedId`, `acceptor: { homeUserId, homeInstance }` |
| `dm_call_reject` | Participant → Host, then Host → All Peers | `federatedId`, `rejector: { homeUserId, homeInstance }` |
| `dm_call_end` | Any → Host (if not host), then Host → All Peers | `federatedId`, `endedBy: { homeUserId, homeInstance }` |

All events carry standard relay fields: `eventType`, `messageId`, `encryptionVersion: 0`, `timestamp`. All events pass through `attributionRefusal()` before any DB or state mutations.

### Direct Delivery (No Outbox)

**`sendCallRelay(targetPeerOrigin, events, opts?)`** (`federationOutbox.ts`):

- Latency-sensitive: returns `CallRelayResult = { ok: true } | { ok: false; reason: CallRelayFailureReason; error: string }`.
- Peering resolution:
  1. If the peer row is `active` or `unreachable`, POST directly (the health check restores `unreachable` peers; re-handshaking is wasteful).
  2. Otherwise race `ensurePeered` against `opts.peeringTimeoutMs` (default `CALL_PEERING_TIMEOUT_MS = 3_000` ms). The background handshake is **not** aborted on race loss — a warn-logged catch is attached so a late-rejecting background promise does not emit `unhandledRejection`.
- Peer-state → reason mapping is exhaustive over the `EnsurePeeredResult` union (`active` / `rejected` / `pending` / `failed`) plus the external `timeout` branch. TypeScript `never` check in the switch default catches future additions. Note: the `livekit_unavailable` reason in `DmCallUndeliverableReason` is emitted separately from `sendFederatedCallStart`'s LiveKit pre-flight in `ws/events.ts`, not from this switch — `sendCallRelay` only produces `CallRelayFailureReason` values (`peer_rejected` / `peer_awaiting_approval` / `peer_transient_failure` / `post_failed`).
- Non-blocking mode: `peeringTimeoutMs: 0` (used by typing) skips the POST for non-active peers, kicks off `ensurePeered` as a background warm-up, returns `peer_transient_failure` silently.

**`sendTypingRelay(dmChannelId, eventType, userId)`**:

- Fire-and-forget to each remote DM participant's home instance via `sendCallRelay(origin, [event], { peeringTimeoutMs: 0 })`. Typing is an ephemeral hint — lost packets are acceptable and there is no user-facing failure surface.

**Call-start failure surfacing.** `sendFederatedCallStart` aggregates targeted-peer results and emits `dm_call_undeliverable { phase: 'start' }` to the caller for failed targeted peers. See `docs/systems/voice.md` and `docs/systems/websocket.md` for the event contract.

**Accept / reject / end relay discipline.** Every `handleDmCall{Accept,Reject,End}` Path-2 branch awaits `sendCallRelay` and emits `dm_call_undeliverable { phase, terminal, failures }` to the originator on failure. Accept is pessimistic-rollback (terminal: true — local `FederatedCallEntry` cleared, optimistic `dm_call_accepted` walked back via `sendToFederatedCallUsers`); reject and end are optimistic (terminal: false — state already cleared, informational toast only). Path-1 fan-outs via `sendFederatedCallAccept` / `sendFederatedCallEnd` / `fanOutCallEvent` return `CallFanoutFailure[]` and the host-side caller receives `dm_call_undeliverable { terminal: false }` listing peers that were not reached.

**Ring-timeout fan-out.** `ConnectionManager.createDmRoom`'s 60 s ringing auto-clean now invokes a registered hook (`setRingTimeoutFanoutHook`, registered from `ws/events.ts:registerCallRelayHooks`) that fans `dm_call_end` out to remote peers, so stranded Path-A/B ringees on other instances exit their ring state instead of lingering until their own 60 s cleanup fires.

### Call Flows

**Start:** Host validates membership, broadcasts `dm_call_incoming` to local WS clients, then sends `dm_call_start` S2S to each instance that homes a remote DM member. The relay is built per recipient: the host mints tokens only for the members that recipient homes. A DM with no remote member is not relayed at all, and peers that home no DM member are not contacted. See "Token Scoping" below.

**Accept:** Remote instance sends `dm_call_accept` S2S to host. Host transitions `ringing → active`, broadcasts `dm_call_accepted` locally, fans out `dm_call_accept` to all other remote instances.

**Reject:** Remote sends `dm_call_reject` to host. Host destroys room, sends `dm_call_end` to all peers. (For 1-on-1 DMs, reject = end.)

**End:** Initiating instance (host or not) routes through the host. Host destroys room, fans out `dm_call_end` to all remote instances.

**Timeout:** Both host and remote instances auto-clean stale ringing calls after 60 seconds.

### LiveKit Room Naming

Room name = `federatedId` (the cross-instance stable UUID), never the local `dmChannelId` (which differs per instance).

- 1-on-1 DMs: `federatedId` is a deterministic SHA-256 hash of the sorted `homeUserId` pair
- Group DMs: `federatedId` is a UUID assigned at creation

### LiveKit Token Generation

`generateFederatedCallToken(roomName, homeUserId, displayName)` generates tokens with:
- **TTL:** 5 minutes (short join window; local calls use 1 hour)
- **Room:** scoped to exact `federatedId`
- **Identity:** `${homeUserId}:${displayName}`
- **Permissions:** full DM grants (mic, camera, screen share, subscribe, data channel)

### Token Scoping

A federated call token is a bearer credential: whoever holds it can join the room and publish under the identity it was minted for. Peers are admin-approved but not trusted, so `sendFederatedCallStart` (`ws/events.ts`) treats the token map as a per-recipient secret:

- Remote members are bucketed by their home instance (`canonicalizeHomeInstance`; comparisons use `normalizeOriginForCompare`, since `homeInstance` is stored both bare and scheme-prefixed). Each bucket is exactly the set of identities that peer is entitled to act for.
- `buildRelayEvent(recipients)` mints tokens for that bucket only. No peer receives the caller's token, a local member's token, or a token for a member homed on another peer.
- With no remote members the function returns before minting anything — a purely local call produces zero relays, so no peer learns it happened.
- Only bucketed origins are contacted; there is no all-peers broadcast. `affectedUserIds` on a `dm_call_undeliverable` failure is derived from the failing peer's bucket.
- Per-recipient keying also removes the ambiguity of one global `homeUserId → token` map, where the same `homeUserId` on two instances would collide.

`participants` is the non-secret roster and is still sent in full, because Path B recipients need it to match a participant to a local identity.

Each token also travels with its holder's federated identity in the optional `call.memberTokens` (`{ homeUserId, homeInstance, token }`), because a home user id is unique only on the instance that issued it. `tokens` stays for receivers that predate the field.

Recipient side (`routes/federation/events/calls.ts`): `callTokensByLocalUser` resolves each holder with `resolveRelayActor` and keys the tokens by local user id; from an older sender (no `memberTokens`), each `tokens` key is taken as a user homed on the receiver, which is what the sender scopes the map to. Ringing, the caller skip and the ready payload's `activeCalls` token all go by local user id, never by a bare home user id. Both Path A and Path B skip a local member with no token rather than dispatching a `dm_call_incoming` the client cannot use. This is reachable for a member homed on a third instance who holds a client-federation connection here; their own home instance receives their token and rings them.

### Public LiveKit URL

The URL sent in S2S payloads is always `https://${DOMAIN}/livekit` (the Caddy-proxied public address). The internal `LIVEKIT_URL` env var (`http://livekit:7880`) is never sent to peers.

Instances without LiveKit configured can still receive federated calls — they pass the host's URL and token to the client, which does all the heavy lifting.

### In-Memory Call Registry

When a remote instance receives `dm_call_start`, it creates a `FederatedCallEntry` in memory:

```typescript
interface FederatedCallEntry {
  dmChannelId: string;          // local dmChannelId for this DM
  federatedId: string;          // cross-instance room identifier
  callerId: string;             // local userId of caller's stub
  callerHomeUserId: string;
  federatedCallHost: string;    // peer origin of the host instance
  livekitUrl: string;
  tokens: Map<string, string>;  // local userId → LiveKit token minted for that user (callTokensByLocalUser)
  state: 'ringing' | 'active';
  startedAt: number;
}
```

This registry ensures tokens and `livekitUrl` survive browser refreshes via the `activeCalls` array in the `ready` WS payload. The server filters to the per-user token at payload assembly time.

---

## 14. Background Workers

All workers are started by `startFederationWorkers()` on server boot and stopped by `stopFederationWorkers()` on shutdown. Each worker uses `setTimeout` chains (not `setInterval`) with abort controllers for graceful shutdown.

| Worker | Interval | Batch | Timeout | Source |
|--------|----------|-------|---------|--------|
| Outbox delivery | 1s | 50 | 30s | `processOutboxTick` |
| File download | 30s | 5 | 60s | `processFileQueueTick` |
| Health check | 15min | all unreachable | 10s | `processHealthCheckTick` |
| Epoch-refresh baseline | Startup + 15min (end of health tick) | active peers w/ `peer_instance_id IS NULL` | 10s per peer | `refreshPeerEpochs` (populate-if-null, self-terminating) |
| Janitor | 1h | -- | -- | `runFederationJanitor` (sync) |
| Startup bootstrap sync | Once at startup | -- | 30s per page | `startupBootstrapSync` → `onPeerActivated` |
| Periodic pull | 1 min after startup, then 15min (1 min while a pass stopped at its budget) | all active peers, four at a time, every context, 20 pages per context | 30s per page, 45s per context | `processResyncTick` (`utils/federationSync.ts`, started by `startPeerSyncWorkers`) |
| Pull retry | 5min | kept events whose subject is due, every peer side by side | -- | `processSyncRetryTick` |
| Dead-incarnation sweep | Once at startup | -- | -- | `sweepDeadIncarnationArtifacts` (sync, idempotent) |

`sweepDeadIncarnationArtifacts` — startup, idempotent: deletes DM channels with no native member (with explicit child-row cleanup) and unreferenced replicated stubs homed at this instance's own domain; still-referenced stubs are skipped and logged. It does not rely on FK cascade (must not assume `PRAGMA foreign_keys` is ON): the channel delete explicitly clears its `dm_reactions`/`attachments`/`dm_messages`/`dm_members`/`read_states` rows, and the stub delete explicitly clears its `dm_reactions`/`reactions`/`read_states` rows — and the stub's deletable guard mirrors the non-cascading FKs to `users.id` by hand (a future non-cascading FK to `users.id` needs a matching NOT-EXISTS clause).

The 1-on-1 key sweep that used to run here (`reconcileDriftedDmFederatedIds`) is `backfillOneOnOneKeys`, run by `initDatabase` on every boot whether or not the workers start, and widened to unkeyed rows: every 1-on-1 (no owner, exactly 2 members, not soft-deleted) whose key is NULL or differs from its members' current home identities goes through `reconcileDmChannelFederatedId`. It still **heals accounts re-attached before inline reconciliation shipped** (§3.2). See dm-system.md "Federated ID Algorithm".

### Janitor Cleanup (`storageJanitor.ts:runFederationJanitor`)

| Target | Condition | Retention |
|--------|-----------|-----------|
| `federation_outbox` | `expiresAt < now`; in a DM message's queue the rows behind an expired row go with it (see [Outbox Delivery Worker](#outbox-delivery-worker-federationworkertsprocessoutboxtick), **Expiry**) | Configurable via `federationRelayTtlDays` (default 30) |
| `federation_mutation_log` | `mutatedAt < (now - 90 days)` | 90 days |
| `federation_applied_events` | `appliedAt < (now - 100 days)` | 100 days (`sweepAppliedEvents`), longer than the mutation log a pull reads |
| `federation_subject_clocks` | `recordedAt < (now - 400 days)` | 400 days (`sweepSubjectClocks`), longer than the longest outbox TTL ([Subject clocks](#subject-clocks-member-and-friend-events-are-last-writer-wins)) |
| `federation_file_queue` (completed) | `createdAt < (now - 7 days)` | 7 days |
| `federation_file_queue` (any) | `expiresAt < now` | 30 days (set at queue time) |
| `dm_channels` (soft-deleted) | `deletedAt < (now - 24h)` | 24-hour grace period |
| `federation_peers` (unused auto rows) | `status = 'pending'`, `initiated_by = 'auto'`, `created_at < (now - 1h)`, no outbox entry, no handshake with the origin in flight | 1-hour grace (`AUTO_PENDING_PEER_GRACE_MS`) |

DM channel hard-delete cascades: reactions, embeds, attachments (DB rows + disk files), messages, members, outbox entries, mutation log entries, file queue entries.

**Unused auto pending peer rows (`cleanupUnusedAutoPendingPeers`).** A `pending` row that local traffic created is kept for the entries waiting on its handshake. Once those are gone (typically expired at the relay TTL while the origin never answered) nothing else removes the row, and while it exists `/peer/initiate` for the origin answers `409`. The sweep runs after the outbox expiry in the same janitor pass and deletes such a row, then sends `federation_peers_changed` to admins. It needs no exception for any event type: broadcasts are not queued onto pending peers ([Event Queuing](#event-queuing-federationoutboxtsqueueoutboxevent)), so every entry on a pending row was addressed to that origin. Before #321 broadcasts did land there; the sweep then ignored `presence_update` entries, and a profile edit at least once a month kept a dead origin's row alive for good. The one-hour grace equals `UNLINKED_AGE_MS` and the janitor interval, so a row is never removed by the sweep that first sees it and the worker has made several paced attempts on it first. Rows an admin or the remote created, and auto rows that left `pending`, are never touched.

### Worker Startup Gate

`startFederationWorkers()` in `utils/federationWorker.ts:1211` starts: outbox-delivery tick, federated-call sentinel, file-replication ticks, health-check ticks, and the storage janitor. The whole bundle is gated by `process.env.DISABLE_FEDERATION_WORKERS` matching `'1'` or `'true'` at `index.ts:171-176` (envBool semantics). Tests set `DISABLE_FEDERATION_WORKERS=1` to silence cross-instance background traffic during setup.

### Public Origin Override

`PUBLIC_ORIGIN` env (read via `config.publicOrigin`, consumed by `getOurOrigin()` in `utils/federationAuth.ts`) overrides the federation transport URL verbatim, taking precedence over the default `https://${DOMAIN}`. When unset, behaviour is unchanged. Intended for reverse-proxy / dev-without-TLS deployments where the public origin must be advertised explicitly (typically `http://...`) and differs from the bare `DOMAIN` value used for federated identity. The seed-peer integration harness (`seedPeer.ts`) does NOT use this override — see it for why localhost-port instances cannot collapse to a single peer row. The **real-handshake** harness (`realHandshake.ts`) does the opposite: it sets `PUBLIC_ORIGIN` to each instance's ephemeral `http://127.0.0.1:<port>` so the advertised `sourceOrigin` matches the transport, exercising the same path as production.

**A `PUBLIC_ORIGIN` on another hostname than `DOMAIN` is not supported for federation.** A peer keys this instance by the transport origin and cannot map an identity naming the `DOMAIN` host to that row (`resolveOriginFromHostname` matches only the host, or the one active peer on a port-less hostname), so first contact with this instance's users keeps the `<homeUserId>@<domain>` name until a username arrives by relay, and friend-add by that domain dials `https://DOMAIN` instead of the existing peering. A different scheme or a port on the same hostname is supported.

**Handshake `sourceOrigin` honors this override.** `resolveLocalOrigin()` (`routes/federation.ts`) delegates to `getOurOrigin()`, so the origin advertised in the `/peer/accept` handshake body is identical to the `X-Federation-Origin` used for authenticated S2S requests. Using `https://${DOMAIN}` directly (the prior behavior) desynced the responder's peer-row key from the auth origin whenever `PUBLIC_ORIGIN != https://DOMAIN`, causing permanent `403 Not peered`. See "Trust re-establishment contract" (§1).

### Test-Only Routes

`POST /api/admin/test/federation/resync { peerOrigin, contexts?, retryAt? }` runs one pull from that peer now (`syncPeerMutationLog(peerId, 'manual', contexts)`, all contexts by default) and then `processSyncRetryTick(retryAt ?? now)`, and answers `{ result, retried }`. Same gate as seed-peer below. The two-instance e2e suites use it so a pull happens when the test says, not on the periodic timer.

`POST /api/admin/test/seed-peer` directly inserts a `federation_peers` row, skipping the multi-step peer handshake. Strictly gated: `NODE_ENV='test'` AND `ENABLE_TEST_ROUTES='1'` together; returns 404 in any other configuration. Used exclusively by the two-instance integration harness in `packages/server/test/`. Validates `origin` (must be http(s) URL), `hmacSecret` (≥32 chars), and `status` (must be one of `'active'`, `'pending'`, `'awaiting_approval'`, `'rejected'`, `'revoked'`, `'needs_attention'`, `'unreachable'`, `'accepted'`).

### Retry backoff divisor (test only)

`FEDERATION_BACKOFF_DIVISOR` (`config.federation.backoffDivisor`, read once in `config.ts`) divides every federation retry wait: `BACKOFF_SCHEDULE_MS` for outbox entries and file downloads, and `RECOVERY_BACKOFF_MS` for unreachable-peer probes and pending-peer handshakes (`retryWait` in `federationWorker.ts`). Unset or 1 is the production schedule. It must be a whole number ≥ 1, so it can only shorten waits; 0 and fractions refuse to boot. The health-check interval and the 15-minute silent-peer backstop are not retry waits and are not divided.

The two-instance harness sets 30 in every spawned instance (`HARNESS_BACKOFF_DIVISOR` in `twoInstanceHarness.ts`), so the retries come after 1 s, 2 s, 10 s. Production's first retry is 30 s, longer than any relay wait in the e2e suites, so without it a relay whose first attempt failed on a loaded runner (a busy peer, a timed-out request) would fail its test while the instance behaved as designed. Not an operator setting: a larger divisor only makes an instance retry a struggling peer harder.

### Rate-limit bypass (test only)

`DISABLE_RATE_LIMITS=1` bypasses all `@fastify/rate-limit` enforcement at boot (envBool semantics: `'1'` or `'true'`). Used by integration test harnesses where many tests share the loopback IP and would otherwise exhaust per-IP buckets across unrelated tests. Defaults to enforced rate limits in production. The two-instance harness sets this in every spawned instance's env; tests that need to assert rate-limit behaviour (e.g. Test #15) use `bootTwoInstancesWithRateLimits()` which omits the env var.

---

## 15. Settings Cache

`federationOutbox.ts` caches `federationRelayEnabled` and `federationRelayTtlDays` from `instance_settings` for 30 seconds (`CACHE_TTL_MS`). This prevents repeated DB reads on every message send. The cache is invalidated by TTL only -- there is no explicit cache bust on settings change.

Relevant settings in `instance_settings`:

| Column | Default | Purpose |
|--------|---------|---------|
| `federation_relay_enabled` | 1 | Master toggle for all federation relay |
| `federation_relay_ttl_days` | 30 | Outbox entry TTL |
| `max_upload_size_bytes` | `null` (uses `config.maxUploadSize`) | File download size limit |

---

## 16. Client-Side Identity Helpers (`identity.ts`)

The frontend needs to resolve federated identities for display purposes:

**`parseFederatedUsername(username)`** -- splits `"erin@nova.ddns.net"` into `{baseName: "erin", domain: "nova.ddns.net"}`.

**Who a row is, and whether it is the signed-in user** (`homeIdentityOf`, `userKey`, `authStore.myRowIds`, `isMine`, `personRequest`) are described in `client-federation.md` section 5.

---

## 17. Self-Healing Migrations (`migrate.ts`)

The migration system includes several data integrity checks that run on every server startup:

**Group DM ownerId repair:**
Detects group DMs with UUID-format `federated_id` (length 36, matches `________-____-____-____-____________`) but `NULL owner_id`. Restores the owner from the first remaining member or from `owner_home_user_id`/`owner_home_instance`. Root cause: a bug in `processOwnershipTransferEvent` (fixed in cd7aff0) could set `ownerId = NULL` via `resolveLocalUser` fallback.

**Federated ID backfill:**
Finds 1-on-1 DM channels without `federated_id`, computes deterministic SHA-256 hash from home user IDs, and sets it. Also detects relay-created duplicate channels with the same `federated_id` and merges messages into the oldest channel.

**Duplicate channel merge:**
Finds `federated_id` values appearing on multiple channels and merges them into the oldest, moving messages, members, and cleaning up the duplicates.

**Mutation log backfill:**
If the `federation_mutation_log` table exists but is empty, populates it with `create` entries for all existing DM messages where `source_instance IS NULL` (locally-created messages).

---

## Known Issues

See `docs/federation-production-roadmap.md` for open items (FED-001 through FED-013).

- **Accept/reject/end relay failures now surfaced.** All three federated call-state transitions emit `dm_call_undeliverable { phase, terminal, failures }` to the originator on relay failure — accept rolls back optimistic state (terminal: true), reject/end keep the optimistic clear and emit an informational toast (terminal: false). See `docs/systems/voice.md` "Call relay failure surface" for the full contract. The host-side ring timeout also fans `dm_call_end` out to peers so stranded Path-A/B ringees exit the ring. One remaining edge documented in voice.md: non-host end-relay failure leaves the host's local `activeDmCall` marker until manual cleanup.
