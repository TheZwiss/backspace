import { eq } from 'drizzle-orm';
import type { FederationNeedsAttentionReason, FederationRejectedReason } from '@backspace/shared';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { getOurOrigin, generateHmacSecret } from './federationAuth.js';
import { getInstanceId, probeEpoch } from './federationEpoch.js';
import { federationFetch } from './federationFetch.js';
import type { PeerActivationReason } from './federationPeerActivation.js';
import {
  insertPeer,
  readPeerState,
  readPeerStateByOrigin,
  recordPeerAttempt,
  removePeer,
  transitionPeer,
  type PeerStateSnapshot,
} from './federationPeerState.js';

/**
 * The outbound half of the peering handshake, shared by every sender of
 * `POST /api/federation/peer/accept`: auto-peering (`performHandshake`), an
 * admin's `/peer/initiate`, and both approval handlers. Each sender prepares
 * its row, calls `runOutboundHandshake`, and maps the outcome to its own reply.
 * See docs/systems/federation.md, "Sending a handshake".
 */

const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * The `error` a Backspace `/peer/accept` answers with when its row for us is
 * `revoked`. Releases before PEER_REVOKED sent it with no `code`, so this exact
 * string is how their answer is told apart from a 403 sent by something in
 * front of the remote. The text has not changed since the handshake shipped.
 */
export const REMOTE_REVOKED_ERROR = 'Peering with this instance has been revoked';

/** What the remote's `/peer/accept` answered. */
export type AcceptAnswer =
  | { kind: 'accepted'; instanceName: string | null; instanceId: string | null }
  | { kind: 'queued'; approvalToken: string | null }
  | { kind: 'refused'; reason: Extract<FederationRejectedReason, 'denied_by_remote' | 'revoked_by_remote'>; error: string }
  | { kind: 'exists'; error: string }
  | { kind: 'in_progress'; error: string }
  | { kind: 'transient'; error: string; httpStatus: number }
  | { kind: 'unreachable'; error: string; timedOut: boolean };

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Classify a `/peer/accept` response. Reads the body once. */
export async function interpretAcceptAnswer(response: Response): Promise<AcceptAnswer> {
  let body: Record<string, unknown> = {};
  try {
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: an older peer's empty body, or a page from something in front of the remote.
  }
  const code = nonEmptyString(body.code);
  const error = nonEmptyString(body.error);

  if (response.status === 202) {
    return { kind: 'queued', approvalToken: nonEmptyString(body.approvalToken) };
  }
  if (response.ok) {
    return { kind: 'accepted', instanceName: nonEmptyString(body.instanceName), instanceId: nonEmptyString(body.instanceId) };
  }
  if (response.status === 409 && code === 'PEER_EXISTS_RESET_REQUIRED') {
    return { kind: 'exists', error: error ?? 'The remote instance already holds peering for this instance' };
  }
  if (response.status === 409 && code === 'PEER_HANDSHAKE_IN_PROGRESS') {
    return { kind: 'in_progress', error: error ?? 'The remote instance is completing its own handshake with this instance' };
  }
  // Only the two refusals a Backspace /peer/accept sends are permanent. Any
  // other 403 (a WAF, an IP block, a proxy deny rule, a default vhost during a
  // redeploy) is not the remote's answer and stays transient.
  if (response.status === 403 && code === 'PEERING_REQUIRES_APPROVAL') {
    return { kind: 'refused', reason: 'denied_by_remote', error: error ?? 'The remote instance requires manual peering approval' };
  }
  if (response.status === 403 && (code === 'PEER_REVOKED' || error === REMOTE_REVOKED_ERROR)) {
    return { kind: 'refused', reason: 'revoked_by_remote', error: error ?? REMOTE_REVOKED_ERROR };
  }
  return { kind: 'transient', error: error ?? `Remote rejected peering (HTTP ${response.status})`, httpStatus: response.status };
}

function localInstanceName(): string | undefined {
  return getDb()
    .select({ name: schema.instanceSettings.instanceName })
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.id, 1))
    .get()?.name ?? undefined;
}

/**
 * POST our half of the handshake to `origin`. `trust` is the federationFetch
 * origin policy: 'approved' for an origin a local admin named, 'asserted' for
 * one that came from traffic or from the remote itself.
 */
export async function requestPeerAccept(
  origin: string,
  opts: { hmacSecret: string; approvalToken?: string | null; trust: 'approved' | 'asserted' },
): Promise<AcceptAnswer> {
  try {
    const response = await federationFetch(origin, '/api/federation/peer/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceOrigin: getOurOrigin(),
        hmacSecret: opts.hmacSecret,
        instanceName: localInstanceName(),
        instanceId: getInstanceId(),
        ...(opts.approvalToken ? { approvalToken: opts.approvalToken } : {}),
      }),
      signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    }, opts.trust);
    return await interpretAcceptAnswer(response);
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return { kind: 'unreachable', error: 'Remote instance did not respond within 10 seconds', timedOut: true };
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { kind: 'unreachable', error: `Failed to reach remote instance: ${message}`, timedOut: false };
  }
}

/** Where a handshake left the peer row. */
export type HandshakeOutcome =
  | { kind: 'active'; peerId: string; verified: boolean }
  | { kind: 'awaiting_approval'; peerId: string }
  | { kind: 'rejected'; peerId: string; reason: FederationRejectedReason | null; error: string }
  | { kind: 'needs_attention'; peerId: string; reason: FederationNeedsAttentionReason | null }
  | { kind: 'revoked'; peerId: string }
  /** `httpStatus` is the remote's answer when it answered; null when it could not be reached. */
  | { kind: 'failed'; peerId: string | null; error: string; timedOut: boolean; httpStatus: number | null };

/** The outcome a row's current state stands for, when this handshake did not settle it. */
export function outcomeForRow(
  row: PeerStateSnapshot | null,
  fallbackError: string,
  failure: { timedOut: boolean; httpStatus: number | null } = { timedOut: false, httpStatus: null },
): HandshakeOutcome {
  if (!row) return { kind: 'failed', peerId: null, error: fallbackError, ...failure };
  switch (row.status) {
    case 'active':
    case 'unreachable':
      return { kind: 'active', peerId: row.id, verified: false };
    case 'awaiting_approval':
      return { kind: 'awaiting_approval', peerId: row.id };
    case 'rejected':
      return { kind: 'rejected', peerId: row.id, reason: row.statusReason as FederationRejectedReason | null, error: fallbackError };
    case 'needs_attention':
      return { kind: 'needs_attention', peerId: row.id, reason: row.statusReason as FederationNeedsAttentionReason | null };
    case 'revoked':
      return { kind: 'revoked', peerId: row.id };
    case 'pending':
      return { kind: 'failed', peerId: row.id, error: fallbackError, ...failure };
  }
}

export interface OutboundHandshakeOptions {
  /** The row the handshake runs on (status `pending`, holding `hmacSecret`). */
  peerId: string;
  origin: string;
  hmacSecret: string;
  approvalToken?: string | null;
  trust: 'approved' | 'asserted';
  /** The activation reason recorded when this handshake activates the row. */
  activation: PeerActivationReason;
  /** When the attempt started, for the pacing of a failed attempt. */
  startedAt: number;
  /** What happens to the row when the attempt fails transiently. */
  onFailure: 'keep' | 'remove_unless_queued' | 'release_to_traffic';
}

/**
 * Activate the row after the remote showed it holds `secret` (a verified
 * signed /epoch round-trip). The verified epoch is the trusted baseline.
 */
function activateVerified(
  opts: OutboundHandshakeOptions,
  secret: string,
  epoch: string,
  instanceName: string | null,
  from: readonly ['pending'] | readonly ['active'],
  cause: PeerActivationReason,
): boolean {
  return transitionPeer(opts.peerId, {
    from,
    expectSecret: from[0] === 'pending' ? secret : undefined,
    to: 'active',
    cause,
    fields: {
      hmacSecret: secret,
      lastSeenAt: Date.now(),
      peerInstanceId: epoch,
      approvalToken: null,
      ...(instanceName !== null ? { instanceName } : {}),
    },
  }).applied;
}

/**
 * Run one outbound handshake on a prepared row and settle the row from the
 * answer. Every write is a compare-and-set on the row still being `pending`
 * with the secret we sent: when something else settled the row while the
 * request was in flight (the remote's own handshake, an admin), that state is
 * the outcome.
 *
 * Trust contract: a 200 is only believed after a signed /epoch round-trip with
 * the secret we sent verifies. Without that the row parks in `needs_attention`
 * (`repeer_incomplete`) rather than going active on a secret nobody proved.
 */
export async function runOutboundHandshake(opts: OutboundHandshakeOptions): Promise<HandshakeOutcome> {
  const answer = await requestPeerAccept(opts.origin, {
    hmacSecret: opts.hmacSecret,
    approvalToken: opts.approvalToken,
    trust: opts.trust,
  });
  const stillOurs = (row: PeerStateSnapshot | null): boolean =>
    row !== null && row.status === 'pending' && row.hmacSecret === opts.hmacSecret;

  switch (answer.kind) {
    case 'queued': {
      const outcome = transitionPeer(opts.peerId, {
        from: ['pending'],
        expectSecret: opts.hmacSecret,
        to: 'awaiting_approval',
        cause: 'handshake_queued',
        fields: { approvalToken: answer.approvalToken },
      });
      return outcome.applied
        ? { kind: 'awaiting_approval', peerId: opts.peerId }
        : outcomeForRow(outcome.current, 'The peer changed while the handshake was in flight');
    }

    case 'refused': {
      const outcome = transitionPeer(opts.peerId, {
        from: ['pending'],
        expectSecret: opts.hmacSecret,
        to: 'rejected',
        reason: answer.reason,
        cause: 'remote_refused',
      });
      console.warn(`[federation] handshake with ${opts.origin} refused (${answer.reason}): ${answer.error}`);
      return outcome.applied
        ? { kind: 'rejected', peerId: opts.peerId, reason: answer.reason, error: answer.error }
        : outcomeForRow(outcome.current, answer.error);
    }

    case 'accepted':
      return settleAccepted(opts, answer.instanceName);

    case 'exists': {
      const row = readPeerState(opts.peerId);
      if (!stillOurs(row)) return outcomeForRow(row, answer.error);
      // The remote holds a row for us. If it holds our own secret (an earlier
      // attempt with this secret went through but its answer was lost), the
      // peering is already whole.
      const probe = await probeEpoch({ origin: opts.origin, hmacSecret: opts.hmacSecret });
      if (probe.kind === 'verified' && activateVerified(opts, opts.hmacSecret, probe.instanceId, null, ['pending'], opts.activation)) {
        return { kind: 'active', peerId: opts.peerId, verified: true };
      }
      // Otherwise its admin has to reset that row. Park instead of retrying:
      // every retry only reaches the same refusal.
      const parked = transitionPeer(opts.peerId, {
        from: ['pending'],
        expectSecret: opts.hmacSecret,
        to: 'rejected',
        reason: 'stale_peering_on_remote',
        cause: 'stale_peering',
      });
      console.warn(`[federation] ${opts.origin} still holds an older peering with this instance; parked until its admin resets it`);
      return parked.applied
        ? { kind: 'rejected', peerId: opts.peerId, reason: 'stale_peering_on_remote', error: answer.error }
        : outcomeForRow(parked.current, answer.error);
    }

    case 'in_progress': {
      // The remote is handshaking with us at the same moment and its handshake
      // wins; its /peer/accept settles this row. Count the attempt so the
      // worker does not retry before that lands.
      recordPeerAttempt(opts.peerId, { from: ['pending'], startedAt: opts.startedAt });
      return outcomeForRow(readPeerState(opts.peerId), answer.error);
    }

    case 'transient':
    case 'unreachable': {
      const failure = answer.kind === 'unreachable'
        ? { timedOut: answer.timedOut, httpStatus: null }
        : { timedOut: false, httpStatus: answer.httpStatus };
      recordPeerAttempt(opts.peerId, { from: ['pending'], startedAt: opts.startedAt });
      if (opts.onFailure === 'remove_unless_queued') {
        removePeer(opts.peerId, { from: ['pending'], unlessQueued: true });
      } else if (opts.onFailure === 'release_to_traffic') {
        transitionPeer(opts.peerId, {
          from: ['pending'],
          to: 'pending',
          cause: 'handshake_released',
          fields: { initiatedBy: 'auto' },
        });
      }
      return outcomeForRow(readPeerState(opts.peerId), answer.error, failure);
    }
  }
}

async function settleAccepted(opts: OutboundHandshakeOptions, instanceName: string | null): Promise<HandshakeOutcome> {
  const probe = await probeEpoch({ origin: opts.origin, hmacSecret: opts.hmacSecret });
  const row = readPeerState(opts.peerId);

  if (row && row.status === 'pending' && row.hmacSecret === opts.hmacSecret) {
    if (probe.kind === 'verified') {
      if (activateVerified(opts, opts.hmacSecret, probe.instanceId, instanceName, ['pending'], opts.activation)) {
        return { kind: 'active', peerId: opts.peerId, verified: true };
      }
      return outcomeForRow(readPeerState(opts.peerId), 'The peer changed while the handshake was in flight');
    }
    const parked = transitionPeer(opts.peerId, {
      from: ['pending'],
      expectSecret: opts.hmacSecret,
      to: 'needs_attention',
      reason: 'repeer_incomplete',
      cause: 'repeer_unverified',
      fields: { lastSeenAt: Date.now(), ...(instanceName !== null ? { instanceName } : {}) },
    });
    return parked.applied
      ? { kind: 'needs_attention', peerId: opts.peerId, reason: 'repeer_incomplete' }
      : outcomeForRow(parked.current, 'The peer changed while the handshake was in flight');
  }

  // The row changed while our request was in flight. The one case to repair:
  // the remote's own handshake reached us first and we took its secret, and
  // then the remote took ours too (a release without the concurrent-handshake
  // rule accepts both). Both sides now hold the other's secret. The remote
  // keeps ours, so adopt whichever secret it verifiably holds.
  if (row && row.status === 'active' && row.hmacSecret !== opts.hmacSecret) {
    if (probe.kind === 'verified') {
      transitionPeer(opts.peerId, {
        from: ['active'],
        expectSecret: row.hmacSecret,
        to: 'active',
        cause: opts.activation,
        fields: { hmacSecret: opts.hmacSecret, peerInstanceId: probe.instanceId },
      });
      console.warn(`[federation] ${opts.origin} took both concurrent handshakes; adopted the secret it holds`);
    }
    return outcomeForRow(readPeerState(opts.peerId), 'The peer changed while the handshake was in flight');
  }

  return outcomeForRow(row, 'The peer changed while the handshake was in flight');
}

// ─── Admin-initiated handshakes ─────────────────────────────────────────────

export type AdminRowPreparation =
  | { kind: 'ready'; peerId: string; hmacSecret: string; created: boolean }
  | { kind: 'already_active'; peerId: string }
  | { kind: 'busy'; error: string };

/**
 * Prepare the row an admin-initiated handshake runs on. The caller holds the
 * origin's handshake claim (`claimAdminHandshake`).
 *
 * - `initiate` (`/peer/initiate`): an existing peering is returned as it is;
 *   a `pending` row local traffic created becomes the admin's (kept with its
 *   secret and queued entries); a pending row an admin or the remote created, or an
 *   `awaiting_approval` row, is busy; any other row is replaced.
 * - `approve` (an approval request): as `initiate`, except that an
 *   `awaiting_approval` row is replaced (the approval carries the remote's
 *   token) and a `needs_attention` row is busy until an admin resets it.
 */
export function prepareAdminHandshakeRow(
  origin: string,
  mode: 'initiate' | 'approve',
  instanceName: string | null = null,
): AdminRowPreparation {
  const existing = readPeerStateByOrigin(origin);

  if (existing) {
    switch (existing.status) {
      case 'active':
      case 'unreachable':
        return { kind: 'already_active', peerId: existing.id };
      case 'pending': {
        if (existing.initiatedBy !== 'auto') {
          return { kind: 'busy', error: 'A peering handshake with this instance is already in progress' };
        }
        const claimed = transitionPeer(existing.id, {
          from: ['pending'],
          expectSecret: existing.hmacSecret,
          to: 'pending',
          cause: 'admin_claimed',
          fields: { initiatedBy: 'admin' },
        });
        if (!claimed.applied) return { kind: 'busy', error: 'The peer changed; try again' };
        return { kind: 'ready', peerId: existing.id, hmacSecret: existing.hmacSecret, created: false };
      }
      case 'awaiting_approval':
        if (mode === 'initiate') {
          return { kind: 'busy', error: "A peering handshake with this instance is awaiting the remote admin's approval" };
        }
        break;
      case 'needs_attention':
        if (mode === 'approve') {
          return { kind: 'busy', error: 'This peer needs attention; reset it before approving a new handshake' };
        }
        break;
      case 'rejected':
      case 'revoked':
        break;
    }
    // Replaced: a re-peer starts from a fresh row. The reset journal survives
    // the row (it is keyed by origin), and onPeerActivated heals after the
    // fresh handshake.
    if (!removePeer(existing.id, { from: [existing.status] })) {
      return { kind: 'busy', error: 'The peer changed; try again' };
    }
  }

  const hmacSecret = generateHmacSecret();
  const inserted = insertPeer({ origin, hmacSecret, initiatedBy: 'admin', status: 'pending', instanceName });
  if (!inserted) return { kind: 'busy', error: 'The peer changed; try again' };
  return { kind: 'ready', peerId: inserted.row.id, hmacSecret, created: true };
}
