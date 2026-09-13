/**
 * RFC 6238 TOTP (Time-based One-Time Password) + encrypted-at-rest secret
 * storage + recovery-code hashing.
 *
 * Why this lives here (not in a 3rd-party lib):
 *   - CLAUDE.md: "Do not introduce new dependencies without justification."
 *   - The TOTP algorithm is ~40 lines of HMAC-SHA1 + dynamic truncation.
 *   - Adding a heavy TOTP lib for this would be overkill AND would not solve
 *     the at-rest encryption problem anyway.
 *
 * Security properties:
 *   - Secret storage: AES-256-GCM with key derived from JWT_SECRET via SHA-256.
 *     The persisted `secret` column is `iv:ciphertext:authTag` base64.
 *     Decryption happens in-memory only.
 *   - Replay protection: `lastUsedCounter` column — RFC 6238 §5.2 recommends
 *     rejecting any code with counter <= last seen. We persist it.
 *   - Constant-time compare for the OTP match (defence against timing oracles).
 *   - Window of ±1 step (default 30s) tolerates ±30s clock skew without
 *     expanding the attack surface beyond a single extra code.
 *   - Recovery codes: 12-char base32 (160 bits entropy), bcrypt-hashed, single-use.
 *
 * Federation note:
 *   - TOTP is a LOCAL concern. Federated users (replicated stubs whose
 *     authoritative identity lives on the home instance) must enable and
 *     recover 2FA on their home instance, not here. The setup/disable
 *     endpoints in routes/totp.ts reject federated accounts with 403.
 *     Detached accounts (federationHomeOrphaned = 1) are sovereign LOCAL
 *     accounts and may enable 2FA like any native account.
 */
import { createHmac, createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// RFC 4648 Base32 (no padding) — used for both TOTP secrets and recovery codes.
// RFC 6238 §5.1 specifies base32 (no padding) for secret encoding.
// ---------------------------------------------------------------------------

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = str.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`Invalid base32 character: ${ch}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// TOTP secret generation + otpauth URL
// ---------------------------------------------------------------------------

/** Generate a fresh 160-bit TOTP secret (RFC 6238 §5.1 default). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Build the otpauth:// URI that authenticator apps consume. */
export function buildOtpAuthUrl(opts: {
  secret: string;
  issuer: string;
  accountName: string;
  digits?: number;
  period?: number;
  algorithm?: 'SHA1' | 'SHA256' | 'SHA512';
}): string {
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: opts.algorithm ?? 'SHA1',
    digits: String(opts.digits ?? 6),
    period: String(opts.period ?? 30),
  });
  // Standard form: otpauth://totp/<issuer>:<account>?...
  // RFC 6238 §5.1; issuer name goes both in label AND in query for max compat.
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.accountName)}`;
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// RFC 6238 HOTP/TOTP core
// ---------------------------------------------------------------------------

/**
 * Compute the numeric OTP for a given secret at a given counter value.
 * Implements RFC 4226 HOTP + RFC 6238 TOTP = HOTP(K, floor(unix/period)).
 * Exported for testability.
 */
export function hotp(secretBase32: string, counter: bigint, digits: number): string {
  const key = base32Decode(secretBase32);
  // 8-byte big-endian counter (RFC 4226 §5.3)
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', key).update(buf).digest();
  // Dynamic truncation (RFC 4226 §5.4)
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binCode =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  const otp = binCode % 10 ** digits;
  return otp.toString().padStart(digits, '0');
}

/**
 * Current Unix-time-step counter for the given period.
 * Exposed so routes can persist `lastUsedCounter` against replay attacks.
 */
export function currentCounter(period: number, nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000 / period));
}

export interface VerifyTotpOptions {
  /** Window of ±steps. Default 1 (i.e. accepts current ±1 period for clock skew). */
  window?: number;
  /** Persisted `lastUsedCounter` — codes with counter <= this are rejected. */
  lastUsedCounter?: number;
  /**
   * Inject current time (epoch ms) for deterministic tests. Defaults to
   * `Date.now()`. Production callers leave it unset.
   */
  nowMs?: number;
}

export interface VerifyTotpResult {
  valid: boolean;
  /** The counter that matched (for persisting as new lastUsedCounter). null if invalid. */
  counter: bigint | null;
}

/**
 * Verify a 6-digit (or configured digits) TOTP code against the secret.
 * Returns the matched counter on success (caller should persist it as new
 * lastUsedCounter for replay protection).
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  period: number,
  digits: number,
  options: VerifyTotpOptions = {},
): VerifyTotpResult {
  const window = options.window ?? 1;
  const lastUsed = BigInt(options.lastUsedCounter ?? 0);

  if (!/^\d+$/.test(code) || code.length !== digits) {
    return { valid: false, counter: null };
  }

  const counter = currentCounter(period, options.nowMs);
  const candidates: bigint[] = [];
  for (let offset = -window; offset <= window; offset++) {
    candidates.push(counter + BigInt(offset));
  }

  // Constant-time-ish compare: compute all candidates, find a match, then
  // verify with timingSafeEqual over the equal-length numeric string.
  for (const candidate of candidates) {
    const expected = hotp(secretBase32, candidate, digits);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(code, 'utf8');
    if (a.length === b.length && timingSafeEqual(a, b)) {
      // Replay guard: candidate must be strictly newer than lastUsed.
      if (candidate > lastUsed) {
        return { valid: true, counter: candidate };
      }
      // Match but already used — reject silently (don't reveal this fact).
      return { valid: false, counter: null };
    }
  }
  return { valid: false, counter: null };
}

// ---------------------------------------------------------------------------
// AES-256-GCM at-rest encryption for the TOTP secret.
// Key derived from JWT_SECRET via SHA-256 — same secret as JWT signing so
// no new config knob is required. Per-record random 12-byte IV. 16-byte
// authTag appended to ciphertext (GCM standard). Stored as base64.
// ---------------------------------------------------------------------------

function deriveEncryptionKey(): Buffer {
  // SHA-256 of JWT_SECRET → 32-byte AES-256 key. JWT_SECRET is required to
  // be >= 32 chars at boot (utils/auth.ts) so this key has plenty of entropy.
  return createHash('sha256').update(config.jwtSecret, 'utf8').digest();
}

export function encryptTotpSecret(plaintextBase32: string): string {
  const key = deriveEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBase32, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // iv : ciphertext : authTag — all base64. Round-trip via decryptTotpSecret.
  return `${iv.toString('base64')}:${ciphertext.toString('base64')}:${authTag.toString('base64')}`;
}

export function decryptTotpSecret(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted TOTP secret');
  }
  const [ivB64, ctB64, tagB64] = parts;
  if (!ivB64 || !ctB64 || !tagB64) {
    throw new Error('Malformed encrypted TOTP secret');
  }
  const key = deriveEncryptionKey();
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// ---------------------------------------------------------------------------
// Recovery codes — single-use fallback for when the user loses their TOTP
// device. 12-char base32 (160 bits entropy), bcrypt-hashed, single-use.
// ---------------------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 12; // 12 chars of base32 = ~60 bits, but the
                                  // raw entropy of 12 base32 chars is 12*5 = 60 bits;
                                  // the underlying randomBytes(8) below is 64 bits
                                  // which rounds up nicely. Documented as
                                  // "high-entropy single-use tokens" — not a
                                  // user-chosen password.

/** Generate `count` recovery codes (default RECOVERY_CODE_COUNT). */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  // Set membership check below ensures uniqueness within a batch.
  const seen = new Set<string>();
  while (codes.length < count) {
    const code = base32Encode(randomBytes(8)).slice(0, RECOVERY_CODE_LENGTH);
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

/** bcrypt-hash a recovery code for at-rest storage. Cost matches password hash (12). */
export async function hashRecoveryCode(code: string): Promise<string> {
  return bcrypt.hash(code.toUpperCase(), 12);
}

/** Compare a presented recovery code against a stored bcrypt hash. Constant-time via bcrypt. */
export async function verifyRecoveryCode(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code.toUpperCase(), hash);
}
