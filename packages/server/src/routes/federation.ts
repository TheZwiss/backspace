// Barrel for the federation route subsystem.
//
// The implementation was split out of a single 7.6k-line file into cohesive
// modules under ./federation/. This barrel preserves the original public import
// surface (every `from '.../routes/federation.js'` import resolves unchanged) and
// composes the HTTP route registrars into `federationRoutes()`.
//
// See docs/systems/federation.md and
// docs/superpowers/specs/2026-07-10-federation-ts-split-design.md.

import type { FastifyInstance } from 'fastify';
import { registerPeerHandshakeRoutes } from './federation/handlers/peerHandshake.js';
import { registerPeerAdminRoutes } from './federation/handlers/peerAdmin.js';
import { registerApprovalRoutes } from './federation/handlers/approvals.js';
import { registerRelayRoutes } from './federation/handlers/relay.js';
import { registerLookupRoutes } from './federation/handlers/lookup.js';
import { registerAttachRoutes } from './federation/handlers/attach.js';

export { processRelayEvents } from './federation/events/dispatch.js';
export { processPresenceUpdateEvent } from './federation/events/dmState.js';
export { processGroupMetadataUpdateEvent, processMemberAddEvent, processMemberRemoveEvent, processOwnershipTransferEvent } from './federation/events/membership.js';
export { extractDomain, findFederatedUser, getOurIdentityDomain, resolveLocalUser, resolveOrCreateReplicatedUser, verifyAttribution } from './federation/identity.js';
export { validateOrigin } from './federation/origin.js';
export { backfillReplicatedProfileAssets, hydrateReplicatedUserProfile, processProfileUpdateEvent } from './federation/profile.js';
export { _resetLookupRateBuckets } from './federation/rateLimits.js';
export { reconcileDmChannelFederatedId, reconcileDriftedDmFederatedIds, sweepDeadIncarnationArtifacts } from './federation/reconciliation.js';
export type { DmReconcileResult } from './federation/reconciliation.js';

/**
 * Register every federation HTTP endpoint on the Fastify instance.
 * Delegates to per-concern registrars; see ./federation/handlers/*.
 */
export async function federationRoutes(app: FastifyInstance): Promise<void> {
  registerPeerHandshakeRoutes(app);
  registerPeerAdminRoutes(app);
  registerApprovalRoutes(app);
  registerRelayRoutes(app);
  registerLookupRoutes(app);
  registerAttachRoutes(app);
}
