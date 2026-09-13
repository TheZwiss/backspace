/**
 * Bot / service-account token utility (issue #184).
 *
 * Token format:
 *   bsbot_<base32(20 random bytes)>
 *
 *   Example: bsbot_GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
 *
 *   - Prefix `bsbot_` makes tokens trivially distinguishable from human JWTs
 *     and from the user's session cookie. Operators can grep logs and detect
 *     leakage.
 *   - 20 random bytes = 160 bits entropy — well above brute-force territory.
 *   - Stored as sha256(token) for O(1) lookup (unique index on `token_hash`).
 *     sha256 is acceptable here because the token has full 160 bits of
 *     entropy (no password-stretching threat). bcrypt would be overkill
 *     and would prevent fast indexed lookup.
 *   - Plaintext is returned to the owner EXACTLY ONCE at mint time. Never
 *     stored, never logged, never returned again. The tokenPrefix column
 *     holds the first 8 chars for masked UI display ("bsbot_GE...NRXQ").
 *
 * Scope model:
 *   - Scopes are strings in dotted form: "messages:write", "channels:read",
 *     "reactions:write", "threads:write", "attachments:write", "presence".
 *   - A scope set is just a `Set<string>`. Comparison is exact-string match.
 *   - There is NO `admin:*` scope. Admin endpoints refuse bot tokens by
 *     checking `accountType` instead.
 *   - "Receive new messages without unrestricted history access" (per the
 *     issue) is enforced via the `messages:read` scope + the
 *     `allowedChannels` allowlist (full enforcement lands in #186).
 *
 * Federation:
 *   - This file knows nothing about federation; the routes layer enforces
 *     that bots cannot be created by federated or replicated-stub accounts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { base32Encode } from './totp.js';

export const BOT_TOKEN_PREFIX = 'bsbot_';
const TOKEN_RANDOM_BYTES = 20;
const TOKEN_PREFIX_DISPLAY_LENGTH = 8;

/** Full scope catalog. Admin-like scopes intentionally absent. */
export const BOT_SCOPES = [
  'channels:read',
  'messages:read',
  'messages:write',
  'messages:edit',
  'messages:delete',
  'reactions:write',
  'threads:write',
  'attachments:write',
  'presence',
  'voice:join',
] as const;

export type BotScope = (typeof BOT_SCOPES)[number];

/** Returns true if `scope` is a recognised scope string. */
export function isKnownScope(scope: string): scope is BotScope {
  return (BOT_SCOPES as readonly string[]).includes(scope);
}

/** Validate a raw scope list. Throws on the first unknown scope. */
export function parseScopeList(raw: unknown): BotScope[] {
  if (!Array.isArray(raw)) {
    throw new Error('scopes must be an array');
  }
  const out: BotScope[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new Error('scope entries must be strings');
    }
    if (!isKnownScope(entry)) {
      throw new Error(`unknown scope: ${entry}`);
    }
    if (!out.includes(entry)) {
      out.push(entry);
    }
  }
  return out;
}

/** Mint a new bot token. Returns plaintext + sha256 hash + masked prefix. */
export function mintBotToken(): {
  plaintext: string;
  tokenHash: string;
  tokenPrefix: string;
} {
  const random = base32Encode(randomBytes(TOKEN_RANDOM_BYTES));
  const plaintext = `${BOT_TOKEN_PREFIX}${random}`;
  const tokenHash = createHash('sha256').update(plaintext, 'utf8').digest('hex');
  const tokenPrefix = plaintext.slice(0, TOKEN_PREFIX_DISPLAY_LENGTH);
  return { plaintext, tokenHash, tokenPrefix };
}

/** sha256 of a token, hex-encoded — for lookup. */
export function hashBotToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Returns true if `plaintext` matches the prefix convention. */
export function isWellFormedBotToken(plaintext: string): boolean {
  return plaintext.startsWith(BOT_TOKEN_PREFIX) && plaintext.length === BOT_TOKEN_PREFIX.length + 32;
}

/** Build the mask shown in the UI: "bsbot_GE...NRXQ" */
export function maskBotToken(plaintextOrPrefix: string): string {
  if (plaintextOrPrefix.length <= TOKEN_PREFIX_DISPLAY_LENGTH + 4) {
    return plaintextOrPrefix; // already a prefix
  }
  const head = plaintextOrPrefix.slice(0, TOKEN_PREFIX_DISPLAY_LENGTH);
  const tail = plaintextOrPrefix.slice(-4);
  return `${head}...${tail}`;
}
