/**
 * Pure parsing and validation for the two things the hub reads from the
 * network: the origin in an incoming ping and the document fetched from that
 * origin. No Workers binding, no IO, no global state, so the routes can call
 * these and the tests can exercise them without a request. See section 7 of
 * docs/superpowers/specs/2026-09-21-space-directory-design.md, ping steps 3
 * and 6.
 */

/** A ping body is read in full and rejected past this size, whatever Content-Length claimed. */
export const MAX_PING_BYTES = 1024;

/**
 * A fetched document is rejected past this size. The reader in the ping route
 * caps the response stream at the same figure; this check is the second line
 * of defence for a caller that hands over an already-read string.
 */
export const MAX_DOCUMENT_BYTES = 512 * 1024;

/** The document never carries more spaces than this; the instance truncates at the same figure. */
export const MAX_SPACES = 200;
export const MAX_NAME_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 200;
export const MAX_INSTANCE_NAME_LENGTH = 100;

/** No real member count comes near this; anything above it is a broken or hostile sender. */
export const MAX_MEMBER_COUNT = 1_000_000_000;

/**
 * The telemetry receiver's version pattern, so both Workers bound the one free
 * text field that names a build the same way. Optional: an instance that
 * reports no version is still listed.
 */
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;

/** A dotted-quad IPv4 hostname. IPv6 literals are bracketed and caught by the `[` check. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * `AVATAR_COLORS` from packages/shared/src/types.ts, re-declared because the
 * hub has no dependency on `@backspace/shared`. The two lists must stay equal;
 * a colour the hub does not know becomes null on the feed rather than failing
 * the document, since it is cosmetic.
 */
export const AVATAR_COLORS = ['mint', 'sky', 'lavender', 'coral', 'rose', 'teal', 'amber'] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

/** The subset of `DirectoryDocumentSpace` the hub stores, with the same types. */
export interface ValidSpace {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  banner: string | null;
  avatarColor: AvatarColor | null;
  visibility: 'public' | 'request';
  memberCount: number;
  createdAt: number;
}

export interface ValidDocument {
  instanceName: string;
  federatedRegistrationOpen: boolean;
  version: string | null;
  spaces: ValidSpace[];
}

export type OriginResult = { ok: true; origin: string } | { ok: false };
export type DocumentResult = { ok: true; doc: ValidDocument } | { ok: false; reason: 'invalid' | 'origin-mismatch' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonNegativeInteger(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}

/**
 * Canonicalise the origin named in a ping, ping step 3 of the spec. The result
 * is `new URL(raw).origin`, which lowercases the scheme and host, and it is
 * accepted only when the input was already nothing but an origin: `https`, no
 * userinfo, no port, no path beyond the root, no query, no fragment, a hostname
 * with at least one dot that is not an IP literal and not the hub itself. The
 * hub fetches whatever passes here, so this is the whole allow-list for its
 * outbound requests.
 */
export function parseOrigin(raw: unknown, selfHost: string): OriginResult {
  if (typeof raw !== 'string') return { ok: false };
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false }; }
  if (url.protocol !== 'https:') return { ok: false };
  if (url.username !== '' || url.password !== '') return { ok: false };
  if (url.port !== '') return { ok: false };
  // The parser turns `https://host` into `https://host/`, so a pathname of exactly
  // `/` is not a path and `https://host/` canonicalises like `https://host`.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return { ok: false };
  const host = url.hostname;
  if (!host.includes('.') || host.startsWith('[') || IPV4.test(host)) return { ok: false };
  if (host === selfHost.toLowerCase()) return { ok: false };
  return { ok: true, origin: url.origin };
}

/**
 * `new URL(value).origin`, or null when the value does not parse. Both the
 * document's `origin` and its asset URLs go through this before they are
 * compared with the canonical origin the hub fetched, because an instance whose
 * `DOMAIN` has upper case letters serves them as configured while the hub
 * lowercased the host in `parseOrigin`. The two are the same origin.
 */
function canonicalOrigin(value: string): string | null {
  try { return new URL(value).origin; } catch { return null; }
}

/**
 * The one asset rule, ping step 6: an icon or banner is null or an absolute URL
 * on the origin the document came from, with a path below it, so a listing can
 * never point a viewer's browser at a third party. Comparing parsed origins
 * rather than string prefixes is what makes the look-alike host
 * `https://chat.example.org.evil.example/x` fail: its origin is the evil host.
 */
function isAssetUrl(v: unknown, origin: string): v is string | null {
  if (v === null) return true;
  if (typeof v !== 'string') return false;
  let url: URL;
  try { url = new URL(v); } catch { return false; }
  return url.origin === origin && url.pathname.length > 1;
}

function parseSpace(raw: unknown, origin: string): ValidSpace | null {
  if (!isRecord(raw)) return null;
  const { id, name, description, icon, banner, avatarColor, visibility, memberCount, createdAt } = raw;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  if (description !== null && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH)) return null;
  if (!isAssetUrl(icon, origin) || !isAssetUrl(banner, origin)) return null;
  if (visibility !== 'public' && visibility !== 'request') return null;
  if (!isNonNegativeInteger(memberCount, MAX_MEMBER_COUNT)) return null;
  // A millisecond timestamp. `Number.isInteger(1e300)` is true, so the cap keeps
  // the value inside what a D1 INTEGER column and the feed's JSON can carry exactly.
  if (!isNonNegativeInteger(createdAt, Number.MAX_SAFE_INTEGER)) return null;
  return {
    id,
    name,
    description,
    icon,
    banner,
    avatarColor: AVATAR_COLORS.find((c) => c === avatarColor) ?? null,
    visibility,
    memberCount,
    createdAt,
  };
}

/**
 * Validate the document fetched from `expectedOrigin`, ping step 6. Everything
 * the feed will serve is copied field by field into a fresh object, so unknown
 * top-level and space fields never reach storage. The origin check has its own
 * reason because a mismatch is nearly always a `DOMAIN` or reverse-proxy
 * problem on the instance, and the admin panel says so.
 */
export function parseDocument(text: string, expectedOrigin: string): DocumentResult {
  if (new TextEncoder().encode(text).byteLength > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'invalid' };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: 'invalid' }; }
  if (!isRecord(parsed)) return { ok: false, reason: 'invalid' };

  const { schema, origin, instance, spaces } = parsed;
  if (schema !== 1) return { ok: false, reason: 'invalid' };
  if (typeof origin !== 'string') return { ok: false, reason: 'invalid' };
  const documentOrigin = canonicalOrigin(origin);
  if (documentOrigin === null) return { ok: false, reason: 'invalid' };
  if (documentOrigin !== expectedOrigin) return { ok: false, reason: 'origin-mismatch' };

  if (!isRecord(instance)) return { ok: false, reason: 'invalid' };
  const { name, federatedRegistrationOpen, version } = instance;
  if (typeof name !== 'string' || name.length > MAX_INSTANCE_NAME_LENGTH) return { ok: false, reason: 'invalid' };
  if (typeof federatedRegistrationOpen !== 'boolean') return { ok: false, reason: 'invalid' };
  if (version !== undefined && version !== null && (typeof version !== 'string' || !VERSION.test(version))) {
    return { ok: false, reason: 'invalid' };
  }

  if (!Array.isArray(spaces) || spaces.length > MAX_SPACES) return { ok: false, reason: 'invalid' };
  const validSpaces: ValidSpace[] = [];
  for (const raw of spaces) {
    const space = parseSpace(raw, expectedOrigin);
    if (space === null) return { ok: false, reason: 'invalid' };
    validSpaces.push(space);
  }

  return {
    ok: true,
    doc: {
      instanceName: name,
      federatedRegistrationOpen,
      version: version ?? null,
      spaces: validSpaces,
    },
  };
}
