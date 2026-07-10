# Design: Split `routes/federation.ts` into cohesive modules

**Date:** 2026-07-10
**Status:** Approved (strategy) — pending implementation plan
**Author:** Lead Developer

## Problem

`packages/server/src/routes/federation.ts` is **7,626 lines** — the largest file in the
codebase by nearly 3×. It bundles at least five unrelated responsibilities:

1. HTTP route registration (`federationRoutes()` alone is ~2,800 lines / 30 endpoints)
2. Federated identity resolution (`resolveLocalUser`, `resolveOrCreateReplicatedUser`, …)
3. ~30 inbound relay event processors (`process*Event`)
4. DM channel / federated-id reconciliation helpers
5. Rate-limiting, nonce, and peer-approval-queue internals

A file this size is unreviewable (the originating complaint) and unsafe to change: any
diff touching it is hard to reason about, and the file is too large to hold in working
memory (human or model) at once.

This is a **structural** problem, not a behavioral one. The fix is to split the file
along its existing responsibility seams — **not** to change any behavior.

## Goals

- Every module has **one clear purpose**, is independently readable (~150–850 lines),
  and communicates through explicit imports/exports.
- **Zero behavior change.** The ~21,700 lines of existing federation tests are the proof
  and must pass unchanged.
- **Zero import-path churn** anywhere else in the codebase or tests.

## Non-Goals (explicitly deferred to a separate follow-up — "Phase C")

- Refactoring or de-duplicating logic *inside* the moved functions.
- Removing intra-function dead branches.
- Renaming symbols or changing signatures.

These are real but must not be mixed into the move: an edit-while-moving diff destroys
`git`'s move detection and re-creates the unreviewability problem. Cleanup, if warranted,
lands afterward as small edits scoped to the now-isolated modules.

## Key findings from analysis

- **No dead top-level code.** All 78 top-level symbols are reachable (self-referenced,
  imported by another source module, or exercised by tests). A "prune dead functions"
  phase has **no targets** — this is a pure move. (Verified by a per-symbol reference
  count across all `packages/**/*.ts`.)
- **Small public surface.** Only **5 symbols** are imported by other *source* files:
  `validateOrigin`, `extractDomain`, `backfillReplicatedProfileAssets`,
  `sweepDeadIncarnationArtifacts`, `reconcileDriftedDmFederatedIds`, plus `federationRoutes`
  (from `index.ts`). Tests import the 22 currently-`export`ed symbols. Everything else is
  file-internal.
- **`federationRoutes()` has no function-local shared state.** Its body is a flat list of
  `app.<verb>()` registrations; each handler closes only over module-level imports and the
  5 module-level rate-limit maps + nonce store. Splitting it into independent registrar
  functions requires no hoisting.
- **Build mechanics:** `moduleResolution: "bundler"`, `isolatedModules: true`,
  `noUnusedLocals: false`. Importers use explicit `./routes/federation.js` specifiers.

## Strategy: barrel + submodule directory

`routes/federation.ts` **stays as a file** and becomes a thin **barrel**:

- It re-exports the 22 public symbols from their new homes, so every existing
  `from '.../routes/federation.js'` import (source **and** test) resolves unchanged.
  The one interface (`DmReconcileResult`) is re-exported via `export type { … }`
  (required by `isolatedModules`).
- It defines `federationRoutes(app)` as a thin function that calls the six route
  registrars in order.

Because importers use the explicit `.js` specifier, the barrel **must** remain a file at
`routes/federation.ts`; the extracted modules live beside it in a new `routes/federation/`
directory (a file and a same-named directory coexist fine on disk and under bundler
resolution).

## Target module layout

```
packages/server/src/routes/
  federation.ts                     ← BARREL: re-exports public API + federationRoutes()
  federation/
    rateLimits.ts                   ← rate-limit consts+maps+fns, nonce store, _resetLookupRateBuckets
    origin.ts                       ← validateOrigin, resolveLocalOrigin, sanitizePeer, SanitizedPeer
    identity.ts                     ← extractDomain, getOurIdentityDomain, verifyAttribution,
                                       resolveLocalUser, findFederatedUser,
                                       resolveOrCreateReplicatedUser, backfillHomeUserId
    dmChannels.ts                   ← buildDmChannelPayload, findOrCreateDmChannel,
                                       buildDmMessagePayload, isUrlFromPeer, resolveLocalDmMessage
    profile.ts                      ← hydrateReplicatedUserProfile, downloadProfileAsset,
                                       processProfileUpdateEvent, backfillReplicatedProfileAssets
    reconciliation.ts               ← DmReconcileResult, reconcileDmChannelFederatedId,
                                       reconcileDriftedDmFederatedIds, sweepDeadIncarnationArtifacts
    events/
      dmMessages.ts                 ← processCreate/Update/Delete/ReactionAdd/ReactionRemove Event
      membership.ts                 ← processMemberAdd/MemberRemove/OwnershipTransfer/GroupMetadataUpdate Event
      friends.ts                    ← processFriendRequestCreate/Update/Cancel, FriendAdd/Remove Event
      calls.ts                      ← processDmCallStart/Accept/Reject/End, TypingStart/Stop,
                                       fanOutCallEvent, emitHostFanoutUndeliverable
      dmState.ts                    ← processDmClose/DmReopen/ReadStateUpdate/PresenceUpdate/FileRejected Event
      dispatch.ts                   ← processRelayEvents (imports every processor above)
    handlers/
      peerHandshake.ts              ← POST peer/initiate, peer/accept, peer/ensure, peer/rotate, peer/denied
      peerAdmin.ts                  ← GET peers, reset-events(+ack), peers/:id GET/DELETE/permanent,
                                       peers/:id reset/recheck/rotate
      approvals.ts                  ← approval-requests(+approve/deny), peering-subscriptions,
                                       peering-notifications + queueApprovalRequest,
                                       handleInbound/OutboundApprove, handleInbound/OutboundDeny
      relay.ts                      ← POST identity, relay, epoch, sync
      lookup.ts                     ← POST users/lookup, users/by-home-id
      files.ts                      ← POST verify-attach-proof
```

~19 modules, ~150–850 lines each (avg ~400). Route-registration order across registrars
is preserved by calling them in path order; Fastify does not depend on cross-path
registration order, so intra-group reordering (grouping interleaved endpoints) is safe.

### Dependency layering (acyclic)

```
L0 leaves:   rateLimits · origin · identity · dmChannels
L1:          profile · reconciliation · events/* (use L0)
L2:          events/dispatch (uses all events/*)
L3:          handlers/* (use L0–L2)
L4 barrel:   federation.ts (re-exports + calls handlers/*)
```

No leaf imports upward, so no import cycles.

## Correctness / verification strategy

- **Test net:** the full server suite (`pnpm --filter @backspace/server test`, ~30
  federation test files / ~21.7k lines) runs after **each** module group is extracted.
  Green throughout = behavior preserved.
- **Typecheck + build** (`pnpm -w typecheck && pnpm --filter @backspace/server build`)
  after each group catches import/type regressions immediately.
- **Move discipline:** functions are moved **verbatim**. The only permitted edits are
  (a) adding `import`/`export` statements, and (b) the barrel re-exports. No logic edits.
- **`git diff -M`** on the final result should render as moves + a small barrel — the
  reviewability property we are buying.

## Rollout (phased so each commit is independently verifiable)

- **Phase A — Prune.** *Empty by analysis* (no dead top-level code). Skipped; documented
  here so the absence is deliberate, not overlooked.
- **Phase B — Extract (this design).** One commit per module group, tests green at each:
  1. Leaf helpers: `rateLimits`, `origin`, `identity`, `dmChannels`
  2. `profile`, `reconciliation`
  3. `events/*` + `events/dispatch`
  4. `handlers/*` + convert `federation.ts` to the barrel
  5. Update `docs/systems/federation.md` source-file map
- **Phase C — Cleanup (separate, later, optional).** Intra-module logic simplification,
  now reviewable because each concern is isolated in a small file.

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Import cycle between extracted modules | Enforced L0–L4 layering; typecheck catches any cycle immediately |
| A test imports a symbol the barrel forgot to re-export | Barrel re-exports the exact set of 22 currently-`export`ed symbols; verified against the export grep |
| `isolatedModules` breaks type re-export | `DmReconcileResult` re-exported via `export type { … }` |
| Route path resolution changes | Barrel stays a file at `routes/federation.ts`; no importer specifier changes |
| Hidden shared local state in `federationRoutes` | Verified none exists (flat `app.<verb>()` body) |
```
