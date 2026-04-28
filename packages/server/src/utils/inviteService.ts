import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { generateSnowflake } from './snowflake.js';
import { config } from '../config.js';
import type { InviteLinkSummary, CreateInviteRequest } from '@backspace/shared';

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
 */
function resolveCreatorUsername(creatorId: string): string | null {
  const db = getDb();
  const u = db.select({ username: schema.users.username, isDeleted: schema.users.isDeleted })
    .from(schema.users)
    .where(eq(schema.users.id, creatorId))
    .get();
  if (!u) return null;
  if (u.isDeleted === 1) return 'Deleted User';
  return u.username;
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
