import crypto from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { generateSnowflake } from './snowflake.js';
import { config } from '../config.js';
import type {
  InviteLinkSummary,
  CreateInviteRequest,
  InviteRedemption,
  UpdateInviteRequest,
  ReinstateInviteRequest,
  ReinstateInviteResponse,
} from '@backspace/shared';

/**
 * Derived status of an invite link. Mirrors the `InviteStatus` union exported
 * from `@backspace/shared` (kept side-by-side intentionally — the shared union
 * defines the API contract, this local one drives internal service logic, and
 * keeping them independent lets a drift surface as a real type error).
 */
export type InviteStatus = 'active' | 'expired' | 'exhausted' | 'revoked';

/**
 * Minimal row shape needed to derive an invite's status. Matches the relevant
 * columns of `invite_links` (revokedAt, expiresAt, maxUses, usedCount).
 */
export interface InviteStatusInput {
  revokedAt: number | null;
  expiresAt: number | null;
  maxUses: number | null;
  usedCount: number;
}

/**
 * Derive the current status of an invite from its row. Precedence order:
 * revoked > expired > exhausted > active. A `maxUses` of `null` means
 * unlimited; an `expiresAt` of `null` means no expiry.
 */
export function inviteStatus(row: InviteStatusInput): InviteStatus {
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt !== null && row.expiresAt < Date.now()) return 'expired';
  if (row.maxUses !== null && row.usedCount >= row.maxUses) return 'exhausted';
  return 'active';
}

/**
 * Generate a fresh invite token: 16 random bytes encoded as base64url, which
 * yields a 22-character URL-safe string (16 * 8 / 6 = 21.33, rounded up; no
 * `=` padding because base64url omits it).
 */
export function generateInviteToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * Thrown by invite-service mutations when caller-supplied input violates a
 * field rule (length, sign, ordering, etc.). Caller (HTTP route) maps this to
 * a 400 Bad Request with the message as `error`.
 */
export class InviteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteValidationError';
  }
}

/**
 * Build the public-facing invite URL embedded in API responses. Production
 * deployments always set `DOMAIN`; the localhost fallback is only used in
 * local dev (where `config.host` is typically `0.0.0.0` and unusable as a
 * URL host). Per spec §1.2 + §5.4 the server owns URL construction so
 * clients never have to assemble it.
 */
function buildInviteUrl(token: string): string {
  if (config.domain) return `https://${config.domain}/register?invite=${token}`;
  return `http://localhost:${config.port}/register?invite=${token}`;
}

/**
 * Validate the invite name (1–64 chars after trim). Trimming is part of
 * normalization so `"  foo  "` is stored as `"foo"`.
 */
function validateName(name: string): string {
  const trimmed = (name ?? '').trim();
  if (trimmed.length < 1 || trimmed.length > 64) {
    throw new InviteValidationError('Name must be 1-64 characters');
  }
  return trimmed;
}

/**
 * Validate `maxUses`: `null` means unlimited; otherwise a positive integer.
 * Zero is rejected because an invite that can never be used is meaningless
 * (use revoke for that).
 */
function validateMaxUses(maxUses: number | null): number | null {
  if (maxUses === null) return null;
  if (!Number.isInteger(maxUses) || maxUses < 1) {
    throw new InviteValidationError('maxUses must be a positive integer or null');
  }
  return maxUses;
}

/**
 * Validate `expiresAt` (epoch ms). On create, must be in the future; on
 * patch/reinstate, `allowPast` lets admins keep an unchanged past value or
 * deliberately set a past expiry to soft-shut. `Date.now()` exactly is not
 * "in the future" and is rejected when `allowPast` is false.
 */
function validateExpiresAt(expiresAt: number | null, allowPast: boolean): number | null {
  if (expiresAt === null) return null;
  if (!Number.isInteger(expiresAt)) {
    throw new InviteValidationError('expiresAt must be an integer epoch ms or null');
  }
  if (!allowPast && expiresAt <= Date.now()) {
    throw new InviteValidationError('expiresAt must be in the future');
  }
  return expiresAt;
}

/**
 * Folds a (username, isDeleted) pair into the display string used by
 * InviteLinkSummary.createdByUsername / InviteRedemption.currentUsername.
 *
 * - null username → null (FK unresolvable; should be rare, defensive)
 * - isDeleted=1   → 'Deleted User' (matches sanitizeUser convention)
 * - else          → username
 */
function foldUsername(username: string | null, isDeleted: number | null): string | null {
  if (username === null) return null;
  return isDeleted === 1 ? 'Deleted User' : username;
}

/**
 * Project an `invite_links` row plus the resolved creator-username into the
 * shared `InviteLinkSummary` shape. Centralized so list/create/patch/reinstate
 * all return identically-shaped rows. Status is derived (never stored) per
 * spec §2.1.
 */
function rowToSummary(
  row: typeof schema.inviteLinks.$inferSelect,
  createdByUsername: string | null,
): InviteLinkSummary {
  return {
    id: row.id,
    token: row.token,
    name: row.name,
    status: inviteStatus(row),
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdBy: row.createdBy,
    createdByUsername,
    createdAt: row.createdAt,
    url: buildInviteUrl(row.token),
  };
}

/**
 * Resolve the username to display for an invite's creator. Returns the live
 * username, `'Deleted User'` for tombstoned accounts (spec §3.1, §4.1), or
 * `null` if the FK is unresolvable (defensive — should not happen in practice).
 *
 * Accepts an optional Drizzle handle so callers inside a `db.transaction`
 * body can pass the `tx` proxy and keep the read on the same logical txn as
 * surrounding writes. Defaults to the outer `getDb()` for non-txn callers.
 */
function resolveCreatorUsername(
  creatorId: string,
  dbHandle: ReturnType<typeof getDb> = getDb(),
): string | null {
  const u = dbHandle.select({ username: schema.users.username, isDeleted: schema.users.isDeleted })
    .from(schema.users)
    .where(eq(schema.users.id, creatorId))
    .get();
  return foldUsername(u?.username ?? null, u?.isDeleted ?? null);
}

/**
 * Create a new invite link. Validates input, generates id + token, inserts the
 * row, and returns the projected summary. Throws `InviteValidationError` on
 * bad input (caller maps to 400).
 */
export function createInvite(req: CreateInviteRequest, creatorId: string): InviteLinkSummary {
  const name = validateName(req.name);
  const maxUses = validateMaxUses(req.maxUses);
  const expiresAt = validateExpiresAt(req.expiresAt, false);

  const db = getDb();
  const id = generateSnowflake();
  const token = generateInviteToken();
  const now = Date.now();

  db.insert(schema.inviteLinks).values({
    id,
    token,
    name,
    createdBy: creatorId,
    createdAt: now,
    maxUses,
    usedCount: 0,
    expiresAt,
    revokedAt: null,
  }).run();

  const row = db.select().from(schema.inviteLinks).where(eq(schema.inviteLinks.id, id)).get();
  if (!row) throw new Error('Failed to insert invite');
  return rowToSummary(row, resolveCreatorUsername(creatorId));
}

/**
 * Look up the raw `invite_links` row by token. Used by the registration flow
 * (check-invite, register) — those sites do their own derived-status checks.
 * The format guard short-circuits before hitting the DB to keep malformed
 * tokens cheap.
 */
export function getInviteByToken(token: string): typeof schema.inviteLinks.$inferSelect | null {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(token)) return null;
  const db = getDb();
  const row = db.select().from(schema.inviteLinks).where(eq(schema.inviteLinks.token, token)).get();
  return row ?? null;
}

/**
 * List invites filtered by lifecycle state. `'active'` returns only rows whose
 * derived status is `active`; `'archived'` returns rows in `expired`,
 * `exhausted`, or `revoked`. The status is derived in TS (single source of
 * truth: `inviteStatus()`), so we fetch all rows then filter — see spec §6.3
 * (no per-instance invite policy / janitor) for why this is acceptable at v1
 * scale; switch to a SQL-side filter only if instances accumulate thousands of
 * invites. The LEFT JOIN against `users` resolves `createdByUsername` in a
 * single query, avoiding the N+1 the spec calls out (§3.1).
 */
export function listInvites(filter: 'active' | 'archived'): InviteLinkSummary[] {
  const db = getDb();
  const rows = db.select({
    invite: schema.inviteLinks,
    creatorUsername: schema.users.username,
    creatorIsDeleted: schema.users.isDeleted,
  })
    .from(schema.inviteLinks)
    .leftJoin(schema.users, eq(schema.inviteLinks.createdBy, schema.users.id))
    .orderBy(desc(schema.inviteLinks.createdAt))
    .all();

  const summaries = rows.map(({ invite, creatorUsername, creatorIsDeleted }) => {
    const username = foldUsername(creatorUsername, creatorIsDeleted);
    return rowToSummary(invite, username);
  });

  if (filter === 'active') return summaries.filter(s => s.status === 'active');
  return summaries.filter(s => s.status !== 'active');
}

/**
 * List redemptions for one invite, newest first. The LEFT JOIN against `users`
 * via `userId` surfaces the live username so the UI can render
 * "registered as alice (now Anastasia)" — the snapshot in `registrantUsername`
 * stays forensically stable while `currentUsername` reflects the live state.
 *
 * Three null-handling branches per spec §3.1:
 *   - live user           → `currentUsername = users.username`, `isDeleted = false`
 *   - tombstoned user     → `currentUsername = 'Deleted User'`,  `isDeleted = true`
 *   - hard-deleted user   → `userId = null`, `currentUsername = null`,
 *                           `isDeleted = false` (the row is genuinely gone, not
 *                           soft-deleted; "Deleted User" would be misleading)
 */
export function listRedemptions(inviteId: string): InviteRedemption[] {
  const db = getDb();
  const rows = db.select({
    redemption: schema.inviteRedemptions,
    currentUsername: schema.users.username,
    currentIsDeleted: schema.users.isDeleted,
  })
    .from(schema.inviteRedemptions)
    .leftJoin(schema.users, eq(schema.inviteRedemptions.userId, schema.users.id))
    .where(eq(schema.inviteRedemptions.inviteId, inviteId))
    .orderBy(desc(schema.inviteRedemptions.redeemedAt))
    .all();

  return rows.map(({ redemption, currentUsername, currentIsDeleted }) => ({
    id: redemption.id,
    userId: redemption.userId,
    registrantUsername: redemption.registrantUsername,
    currentUsername: redemption.userId === null ? null : foldUsername(currentUsername, currentIsDeleted),
    isDeleted: currentIsDeleted === 1,
    redeemedAt: redemption.redeemedAt,
  }));
}

/**
 * Thrown when a mutation targets an invite id that does not exist. Caller
 * (HTTP route) maps this to 404 Not Found.
 */
export class InviteNotFoundError extends Error {
  constructor() {
    super('Invite not found');
    this.name = 'InviteNotFoundError';
  }
}

/**
 * Thrown when a mutation is rejected because the invite's current state
 * forbids it (e.g. patching a revoked invite, double-revoking). Caller
 * (HTTP route) maps this to 409 Conflict; the message is the user-facing
 * copy that surfaces in the toast.
 */
export class InviteStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteStateConflictError';
  }
}

/**
 * Patch an existing invite's mutable fields. Wrapped in a SQLite transaction
 * with an in-txn re-fetch so concurrent admin edits are serialized: the
 * second writer sees the first writer's committed state and either applies
 * its own delta on top or rejects (e.g. observed-revoked).
 *
 * Validation rules per spec §3.1:
 *   - 404 if id not found.
 *   - 409 if invite is currently revoked (must reinstate first to modify).
 *   - 400 if maxUses would drop below current usedCount (would retroactively
 *     exhaust — confusing; admin should use revoke instead).
 *   - expiresAt may be moved into the past (effective soft-shut → status
 *     flips to 'expired' on next read).
 *
 * An empty patch body is a no-op that returns the current summary unchanged.
 */
export function patchInvite(id: string, req: UpdateInviteRequest): InviteLinkSummary {
  const db = getDb();
  return db.transaction((tx) => {
    const row = tx.select().from(schema.inviteLinks).where(eq(schema.inviteLinks.id, id)).get();
    if (!row) throw new InviteNotFoundError();
    if (row.revokedAt !== null) {
      throw new InviteStateConflictError('Invite is revoked. Reinstate first to modify.');
    }

    const updates: Partial<typeof schema.inviteLinks.$inferInsert> = {};
    if (req.name !== undefined) updates.name = validateName(req.name);
    if (req.maxUses !== undefined) {
      const v = validateMaxUses(req.maxUses);
      if (v !== null && v < row.usedCount) {
        throw new InviteValidationError(
          `maxUses (${v}) cannot be less than current usedCount (${row.usedCount})`,
        );
      }
      updates.maxUses = v;
    }
    if (req.expiresAt !== undefined) {
      updates.expiresAt = validateExpiresAt(req.expiresAt, true);
    }

    if (Object.keys(updates).length === 0) {
      // No-op: just return current summary
      return rowToSummary(row, resolveCreatorUsername(row.createdBy, tx));
    }

    tx.update(schema.inviteLinks).set(updates).where(eq(schema.inviteLinks.id, id)).run();
    const updated = tx.select().from(schema.inviteLinks).where(eq(schema.inviteLinks.id, id)).get();
    if (!updated) throw new Error('Failed to read updated invite');
    return rowToSummary(updated, resolveCreatorUsername(updated.createdBy, tx));
  });
}

/**
 * Revoke an invite. Wrapped in a SQLite transaction with an in-txn re-fetch
 * so concurrent revokes are serialized: the first wins, the second sees
 * `revokedAt !== null` and throws `InviteStateConflictError` (mapped to 409
 * by the route — explicit rejection rather than silent no-op, per spec §3.1).
 *
 * Token is preserved on revoke; reinstate-from-revoked rotates the token as
 * a security boundary (handled in `reinstateInvite`, not here).
 */
export function revokeInvite(id: string): InviteLinkSummary {
  const db = getDb();
  return db.transaction((tx) => {
    const row = tx.select().from(schema.inviteLinks).where(eq(schema.inviteLinks.id, id)).get();
    if (!row) throw new InviteNotFoundError();
    if (row.revokedAt !== null) {
      throw new InviteStateConflictError('Invite is already revoked');
    }
    tx.update(schema.inviteLinks).set({ revokedAt: Date.now() }).where(eq(schema.inviteLinks.id, id)).run();
    const updated = tx.select().from(schema.inviteLinks).where(eq(schema.inviteLinks.id, id)).get();
    if (!updated) throw new Error('Failed to read updated invite');
    return rowToSummary(updated, resolveCreatorUsername(updated.createdBy, tx));
  });
}

/**
 * Reinstate a non-active invite back to `active`. Three branches per spec §3.1:
 *
 *   - **Path A (revoked)**: rotates the token (security boundary — old shared
 *     links must stop working) and clears `revokedAt`. Caller may also bump
 *     `maxUses` / `expiresAt` in the same call.
 *   - **Path B (expired/exhausted)**: preserves the token. Caller MUST supply
 *     bumps that push the row back into derived `active` state, otherwise the
 *     txn rolls back with `InviteValidationError` (we never leave an invite
 *     half-reinstated, e.g. exhausted-and-still-exhausted with no token rotation
 *     and no state change).
 *   - **Path C (already active)**: rejected with `InviteStateConflictError`
 *     (mapped to 409). Reinstating an active invite is meaningless and would
 *     surprise an admin who clicked the wrong row.
 *
 * Wrapped in a SQLite transaction with an in-txn re-read so the post-update
 * status check sees the row as the next reader would. If the post-state isn't
 * `active`, the throw aborts the txn and the row reverts.
 */
export function reinstateInvite(id: string, req: ReinstateInviteRequest): ReinstateInviteResponse {
  const db = getDb();
  return db.transaction((tx) => {
    const row = tx.select().from(schema.inviteLinks).where(eq(schema.inviteLinks.id, id)).get();
    if (!row) throw new InviteNotFoundError();

    const currentStatus = inviteStatus(row);
    if (currentStatus === 'active') {
      throw new InviteStateConflictError('Invite is already active');
    }

    const updates: Partial<typeof schema.inviteLinks.$inferInsert> = {};
    let tokenRotated = false;

    if (currentStatus === 'revoked') {
      updates.revokedAt = null;
      updates.token = generateInviteToken();
      tokenRotated = true;
    }

    if (req.maxUses !== undefined) {
      const v = validateMaxUses(req.maxUses);
      if (v !== null && v < row.usedCount) {
        throw new InviteValidationError(
          `maxUses (${v}) cannot be less than current usedCount (${row.usedCount})`,
        );
      }
      updates.maxUses = v;
    }
    if (req.expiresAt !== undefined) {
      updates.expiresAt = validateExpiresAt(req.expiresAt, true);
    }

    // Skip the UPDATE entirely when there's nothing to set — Drizzle throws
    // 'No values to set' before our post-state validator can produce the
    // user-facing InviteValidationError. Path C (already active) handles its
    // rejection above, so an empty updates map only reaches here when the
    // caller didn't provide bumps for an expired/exhausted invite — the
    // post-state check below will throw the correct error in that case.
    if (Object.keys(updates).length > 0) {
      tx.update(schema.inviteLinks).set(updates).where(eq(schema.inviteLinks.id, id)).run();
    }

    const updated = tx.select().from(schema.inviteLinks).where(eq(schema.inviteLinks.id, id)).get();
    if (!updated) throw new Error('Failed to read updated invite');

    if (inviteStatus(updated) !== 'active') {
      // Caller did not bump enough — abort the txn so nothing is half-applied
      throw new InviteValidationError(
        'Reinstate would leave invite in non-active state. Bump maxUses and/or expiresAt.',
      );
    }

    return {
      invite: rowToSummary(updated, resolveCreatorUsername(updated.createdBy, tx)),
      tokenRotated,
    };
  });
}

/**
 * Discriminant union of reasons an invite cannot be redeemed. Surfaced as a
 * typed public field on `InviteUnavailableError` so the HTTP register route
 * can switch on it to produce user-facing copy without parsing the message
 * string. Mirrors the non-active subset of `InviteStatus` plus `'not found'`
 * for the missing-token case.
 */
export type InviteUnavailableReason = 'not found' | 'revoked' | 'expired' | 'exhausted';

/**
 * Thrown when an invite cannot be redeemed because its current state forbids
 * it (token not found, revoked, expired, exhausted). Caller (HTTP register
 * route) maps this to 403 Forbidden. The `reason` field is the structured
 * discriminant; the message string is preserved for debugging/logging.
 */
export class InviteUnavailableError extends Error {
  constructor(public readonly reason: InviteUnavailableReason) {
    super(`Invite unavailable: ${reason}`);
    this.name = 'InviteUnavailableError';
  }
}

/**
 * Result returned by the `insertUser` callback to `redeemInvite`. Captures
 * just the fields needed to write the redemption row (id for the FK,
 * username for the forensic snapshot in `registrant_username`).
 */
export interface RedemptionUserResult {
  id: string;
  username: string;
}

/**
 * Atomically redeem an invite token. The caller-supplied `insertUser` callback
 * runs inside the same SQLite transaction as the usedCount increment + redemption
 * insert. If insertUser throws, the entire transaction rolls back — the invite
 * is NOT consumed for failed registrations (e.g. username uniqueness collisions).
 *
 * Re-derives status under the transaction to close the TOCTOU window between
 * `/api/auth/check-invite` (which the client may call seconds before submit)
 * and the actual register POST: another user could have consumed the last slot
 * in between. Re-checking inside the txn ensures the slot we increment is the
 * one we observed available.
 */
export function redeemInvite(
  token: string,
  insertUser: () => RedemptionUserResult,
): RedemptionUserResult {
  const db = getDb();
  return db.transaction((tx) => {
    const row = tx.select().from(schema.inviteLinks).where(eq(schema.inviteLinks.token, token)).get();
    if (!row) throw new InviteUnavailableError('not found');
    const status = inviteStatus(row);
    if (status !== 'active') {
      // 'active' is excluded by the guard above, so `status` is necessarily
      // one of 'revoked' | 'expired' | 'exhausted' — all valid
      // InviteUnavailableReason values. TS narrows the union here.
      throw new InviteUnavailableError(status);
    }

    // The insertUser callback runs inside the transaction. The caller's INSERT
    // statement uses the outer `db` connection, but better-sqlite3 serializes
    // all writes regardless of which Drizzle handle issued them, so the user
    // insert joins the same atomic unit. If insertUser throws, the entire
    // transaction rolls back including the usedCount bump and redemption row.
    const userResult = insertUser();

    tx.update(schema.inviteLinks)
      .set({ usedCount: row.usedCount + 1 })
      .where(eq(schema.inviteLinks.id, row.id))
      .run();

    tx.insert(schema.inviteRedemptions).values({
      id: generateSnowflake(),
      inviteId: row.id,
      userId: userResult.id,
      registrantUsername: userResult.username,
      redeemedAt: Date.now(),
    }).run();

    return userResult;
  });
}

/**
 * Permanently delete an invite. Redemption rows for this invite are removed
 * via `ON DELETE CASCADE` on `invite_redemptions.invite_id` — this is the
 * documented destructive intent of "delete the invite and its history".
 *
 * No transaction needed: deleteInvite has no read-modify-write state semantics
 * that other concurrent mutators would race against. The existence check is
 * for the 404 response only; if a concurrent process deletes the row between
 * the SELECT and the DELETE, the DELETE is a harmless no-op and the caller
 * still observes the row gone afterwards.
 */
export function deleteInvite(id: string): void {
  const db = getDb();
  const row = db.select().from(schema.inviteLinks).where(eq(schema.inviteLinks.id, id)).get();
  if (!row) throw new InviteNotFoundError();
  db.delete(schema.inviteLinks).where(eq(schema.inviteLinks.id, id)).run();
}
