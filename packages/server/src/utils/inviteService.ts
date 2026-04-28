import crypto from 'node:crypto';

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
