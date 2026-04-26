import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { generateSnowflake } from './snowflake.js';
import { getOurOrigin, generateHmacSecret } from './federationAuth.js';
import { validateOrigin } from '../routes/federation.js';
import { onPeerActivated, onPeerDeactivated } from './federationPeerActivation.js';
import type { EnsurePeeredCallerIntent } from '@backspace/shared';

// ─── Types ───────────────────────────────────────────────────────────────────

export type EnsurePeeredResult =
  | { status: 'active'; peerId: string }
  | { status: 'rejected'; error: string }
  | { status: 'failed'; error: string }
  | { status: 'pending'; error: string }
  | { status: 'admin_required'; error: string };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getInstanceName(): string | undefined {
  const db = getDb();
  const row = db
    .select({ name: schema.instanceSettings.instanceName })
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.id, 1))
    .get();
  return row?.name ?? undefined;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * When the outbound gate fires for a `user_action` intent, upsert the
 * `peer_approval_requests` (parent, keyed on origin+direction='outbound')
 * and `peer_approval_subscribers` (per-user, keyed on parent+user+reason+target)
 * rows, then broadcast WS events so the admin queue and the user's pending
 * list refresh. Idempotent: repeated calls for the same (origin, user, reason,
 * target) refresh `created_at` rather than creating duplicate rows.
 *
 * NOTE: parent row is created with `hmac_secret = NULL`. The CHECK constraint
 * permits this for `direction='outbound'`. The approve handler generates fresh
 * HMAC at the moment it actually sends `/peer/accept` to the remote.
 */
async function queueOutboundApproval(
  origin: string,
  intent: Extract<EnsurePeeredCallerIntent, { kind: 'user_action' }>,
): Promise<void> {
  const db = getDb();
  const now = Date.now();

  // Upsert parent row keyed on (origin, direction='outbound').
  let parent = db
    .select()
    .from(schema.peerApprovalRequests)
    .where(
      and(
        eq(schema.peerApprovalRequests.origin, origin),
        eq(schema.peerApprovalRequests.direction, 'outbound'),
      ),
    )
    .get();

  if (!parent) {
    const id = generateSnowflake();
    db.insert(schema.peerApprovalRequests)
      .values({
        id,
        origin,
        direction: 'outbound',
        instanceName: null,
        hmacSecret: null,
        requestedAt: now,
        expiresAt: now + THIRTY_DAYS_MS,
        approvalToken: null,
      })
      .run();
    parent = db
      .select()
      .from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, id))
      .get()!;
  }

  // Upsert subscriber row.
  const existingSub = db
    .select({ id: schema.peerApprovalSubscribers.id })
    .from(schema.peerApprovalSubscribers)
    .where(
      and(
        eq(schema.peerApprovalSubscribers.requestId, parent.id),
        eq(schema.peerApprovalSubscribers.userId, intent.userId),
        eq(schema.peerApprovalSubscribers.triggerReason, intent.reason),
        eq(schema.peerApprovalSubscribers.triggerTarget, intent.target),
      ),
    )
    .get();

  if (existingSub) {
    db.update(schema.peerApprovalSubscribers)
      .set({ createdAt: now })
      .where(eq(schema.peerApprovalSubscribers.id, existingSub.id))
      .run();
  } else {
    db.insert(schema.peerApprovalSubscribers)
      .values({
        id: generateSnowflake(),
        requestId: parent.id,
        userId: intent.userId,
        triggerReason: intent.reason,
        triggerTarget: intent.target,
        createdAt: now,
      })
      .run();
  }

  // Broadcast: admins refresh queue; the calling user refreshes pending list.
  // Dynamic import is the existing circular-dep workaround in this file
  // (see ws/handler.js imports later). Keep it consistent.
  const { connectionManager } = await import('../ws/handler.js');
  connectionManager.sendToAdmins({
    type: 'federation_approval_request_received' as const,
    origin,
    instanceName: undefined,
  });
  connectionManager.sendToUser(intent.userId, {
    type: 'peering_subscription_changed' as const,
  });
}

// ─── In-flight deduplication ─────────────────────────────────────────────────

const inFlightPeering = new Map<string, Promise<EnsurePeeredResult>>();

/**
 * Ensure we have an active peering relationship with the given origin.
 * If no peer exists, creates a pending record and runs the handshake.
 * Deduplicates concurrent calls for the same origin.
 *
 * Returns:
 * - { status: 'active', peerId } — peer is active (existing or newly handshaked)
 * - { status: 'rejected', error } — remote rejected auto-peering, or peer was revoked
 * - { status: 'failed', error } — transient error (network, timeout), will retry
 */
export async function ensurePeered(
  origin: string,
  intent: EnsurePeeredCallerIntent,
): Promise<EnsurePeeredResult> {
  // Validate origin format
  const normalized = validateOrigin(origin);
  if (!normalized) {
    return { status: 'failed', error: `Invalid origin: ${origin}` };
  }

  // Prevent self-peering
  const ourOrigin = getOurOrigin();
  if (normalized === ourOrigin) {
    return { status: 'failed', error: 'Cannot peer with self' };
  }

  // Check existing peer state
  const db = getDb();
  const existing = db
    .select()
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, normalized))
    .get();

  if (existing) {
    switch (existing.status) {
      case 'active':
        return { status: 'active', peerId: existing.id };
      case 'rejected':
        return { status: 'rejected', error: 'Remote instance requires manual peering approval' };
      case 'revoked':
        return { status: 'rejected', error: 'Peer was revoked by admin' };
      case 'unreachable':
        // Unreachable peers were previously active — treat as active for peering
        // (the health check will restore them; don't re-handshake)
        return { status: 'active', peerId: existing.id };
      case 'needs_attention':
        // Admin intervention required — do not auto-heal via performHandshake
        return { status: 'rejected', error: 'Peer in needs_attention — admin Reset required' };
      case 'awaiting_approval':
        return { status: 'pending', error: 'Awaiting admin approval on remote instance' };
      case 'pending':
        // Fall through to dedup logic below
        break;
    }
  }

  // Pre-handshake gate: refuse if we have an unresolved inbound approval-request
  // for this origin. The local admin must approve or deny it first. Without this
  // check, any code path calling ensurePeered (e.g., the silent auto-reconnect
  // in stores/instanceStore.ts) could bypass autoAcceptPeering=0 by initiating a
  // fresh handshake to the remote, which the remote then accepts against its
  // existing awaiting_approval row (routes/federation.ts /peer/accept branch).
  // The legitimate approval flow (routes/federation.ts /approval-requests/:id/
  // approve) does NOT call ensurePeered — it deletes the approval-request first
  // and does its own fetch — so this guard does not block legitimate approvals.
  const pendingInbound = db
    .select({ id: schema.peerApprovalRequests.id })
    .from(schema.peerApprovalRequests)
    .where(eq(schema.peerApprovalRequests.origin, normalized))
    .get();

  if (pendingInbound) {
    return {
      status: 'rejected',
      error: 'Local admin must resolve pending peering approval before initiating',
    };
  }

  // Outbound gate: when autoAcceptPeering=0, regular-user-initiated outbound
  // becomes admin-approvable; system-initiated outbound is refused outright.
  // Runs only when no peer row exists (existing rows already passed the gate
  // when first created — toggling autoAccept later doesn't retroactively gate).
  if (!existing) {
    const settings = db
      .select({ autoAcceptPeering: schema.instanceSettings.autoAcceptPeering })
      .from(schema.instanceSettings)
      .where(eq(schema.instanceSettings.id, 1))
      .get();
    const autoAccept = settings?.autoAcceptPeering ?? 1;

    if (autoAccept === 0) {
      if (intent.kind === 'user_action') {
        await queueOutboundApproval(normalized, intent);
        return {
          status: 'admin_required',
          error: 'Awaiting your admin\'s approval to initiate peering',
        };
      }
      // system intent — refuse without queue
      return {
        status: 'admin_required',
        error: 'Outbound peering requires admin approval on this instance',
      };
    }
  }

  // Deduplicate: if a handshake is already in flight, share the promise
  const inflight = inFlightPeering.get(normalized);
  if (inflight) {
    return inflight;
  }

  // Run the handshake
  const promise = performHandshake(normalized, existing?.id, existing?.hmacSecret);
  inFlightPeering.set(normalized, promise);

  try {
    return await promise;
  } finally {
    inFlightPeering.delete(normalized);
  }
}

/**
 * Perform the actual handshake with a remote instance.
 * Creates a pending peer if one doesn't exist, then POSTs to peer/accept.
 */
async function performHandshake(
  origin: string,
  existingPeerId?: string,
  existingSecret?: string,
): Promise<EnsurePeeredResult> {
  const db = getDb();
  const ourOrigin = getOurOrigin();

  // Reuse existing pending peer's secret, or generate a new one
  const hmacSecret = existingSecret || generateHmacSecret();
  let peerId = existingPeerId;

  if (!peerId) {
    // Create pending peer placeholder
    peerId = generateSnowflake();
    db.insert(schema.federationPeers)
      .values({
        id: peerId,
        origin,
        hmacSecret,
        status: 'pending',
        createdAt: Date.now(),
      })
      .run();
  }

  try {
    const response = await fetch(`${origin}/api/federation/peer/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceOrigin: ourOrigin,
        hmacSecret,
        instanceName: getInstanceName(),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 202) {
      // Capture the approval token from the 202 body if present. Stored on
      // our federation_peers row so a subsequent inbound /peer/accept (from
      // the remote's /approve flow) can be cryptographically verified before
      // we promote awaiting_approval → active. Spec §3.7.
      let approvalToken: string | null = null;
      try {
        const body = (await response.json()) as { approvalToken?: string };
        if (typeof body?.approvalToken === 'string' && body.approvalToken.length > 0) {
          approvalToken = body.approvalToken;
        }
      } catch {
        // Non-JSON or empty body — legacy receiver, leave null.
      }

      db.update(schema.federationPeers)
        .set({ status: 'awaiting_approval', approvalToken })
        .where(eq(schema.federationPeers.id, peerId))
        .run();
      const { connectionManager } = await import('../ws/handler.js');
      connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
      return { status: 'pending', error: 'Awaiting admin approval on remote instance' };
    }

    if (response.ok) {
      // 200 = peer accepted and activated. Parse remote's instanceName from
      // the response body so we can render a friendly label for the peer.
      // Tolerate omission (older peers) and non-JSON bodies (defensive).
      let remoteInstanceName: string | null = null;
      try {
        const body = (await response.json()) as { instanceName?: string | null };
        if (typeof body?.instanceName === 'string' && body.instanceName.length > 0) {
          remoteInstanceName = body.instanceName;
        }
      } catch {
        // Non-JSON or empty body — leave remoteInstanceName as null.
      }

      db.update(schema.federationPeers)
        .set({ status: 'active', lastSeenAt: Date.now(), instanceName: remoteInstanceName, approvalToken: null })
        .where(eq(schema.federationPeers.id, peerId))
        .run();
      const { connectionManager } = await import('../ws/handler.js');
      connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
      onPeerActivated(peerId, 'ensure_peered').catch(err =>
        console.error('[federation] onPeerActivated from ensurePeered failed:', err)
      );
      return { status: 'active', peerId };
    }

    // Check for explicit rejection (autoAcceptPeering = 0)
    let code: string | undefined;
    let errorMessage = `Remote rejected peering (HTTP ${response.status})`;
    try {
      const body = (await response.json()) as { error?: string; code?: string };
      if (body.error) errorMessage = body.error;
      code = body.code;
    } catch {
      // Ignore parse failures
    }

    if (response.status === 403 && code === 'PEERING_REQUIRES_APPROVAL') {
      // Explicit rejection — set rejected status (sticky)
      db.update(schema.federationPeers)
        .set({ status: 'rejected' })
        .where(eq(schema.federationPeers.id, peerId))
        .run();
      const { connectionManager } = await import('../ws/handler.js');
      connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
      onPeerDeactivated(peerId, 'remote_rejected').catch(err =>
        console.error('[federation] onPeerDeactivated from performHandshake rejected failed:', err)
      );
      return { status: 'rejected', error: errorMessage };
    }

    // Other errors (4xx, 5xx) — transient, clean up pending peer
    if (!existingPeerId) {
      db.delete(schema.federationPeers)
        .where(eq(schema.federationPeers.id, peerId))
        .run();
    }
    return { status: 'failed', error: errorMessage };
  } catch (err: unknown) {
    // Network or timeout error — transient, clean up pending peer
    if (!existingPeerId) {
      db.delete(schema.federationPeers)
        .where(eq(schema.federationPeers.id, peerId))
        .run();
    }

    const message = err instanceof Error ? err.message : 'Unknown error';
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return { status: 'failed', error: 'Remote instance did not respond within 10 seconds' };
    }
    return { status: 'failed', error: `Failed to reach remote instance: ${message}` };
  }
}

/** Clear in-flight peering map (for tests). */
export function _clearInFlightPeering(): void {
  inFlightPeering.clear();
}

/**
 * Race ensurePeered() against a deadline. On timeout, the background
 * handshake is NOT aborted — it continues so the next attempt finds
 * the peer active. A warn-logged catch is attached so a late-rejecting
 * background promise does not emit an unhandledRejection.
 *
 * The ensurePeered implementation is injectable for testing; the default
 * is the real function.
 */
export async function racePeering(
  origin: string,
  timeoutMs: number,
  intent: EnsurePeeredCallerIntent,
  ensurePeeredFn: (
    origin: string,
    intent: EnsurePeeredCallerIntent,
  ) => Promise<EnsurePeeredResult> = ensurePeered,
): Promise<EnsurePeeredResult | { status: 'timeout' }> {
  const handshake = ensurePeeredFn(origin, intent);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ status: 'timeout' }>(resolve => {
    timeoutHandle = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });

  let raceResult: EnsurePeeredResult | { status: 'timeout' };
  try {
    raceResult = await Promise.race([handshake, timeoutPromise]);
  } catch (err) {
    // ensurePeeredFn rejected as the race winner. Normalize to failed.
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const message = err instanceof Error ? err.message : 'Unknown handshake error';
    return { status: 'failed', error: message };
  }
  if (timeoutHandle) clearTimeout(timeoutHandle);

  // Only when the timeout arm won is the background handshake still running.
  // Guard its eventual rejection so we don't emit unhandledRejection.
  if (raceResult.status === 'timeout') {
    handshake.catch(err => {
      console.warn('[federation] background handshake after call-relay race:', origin, err);
    });
  }

  return raceResult;
}
