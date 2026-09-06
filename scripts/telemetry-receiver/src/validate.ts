/**
 * Pure parsing and validation for an incoming ping. No Workers binding, no IO,
 * no global state, so the ping route can call it and the tests can exercise it
 * without a request. See section 7 of docs/superpowers/specs/2026-09-06-instance-telemetry-design.md.
 */

/** A body is read in full and rejected past this size, whatever Content-Length claimed. */
export const MAX_BODY_BYTES = 4096;

/** No count in a real payload comes near this; anything above it is a broken or hostile sender. */
export const MAX_COUNT = 1_000_000_000;

// Version 4 only, per section 7 of the spec. The server mints its id with
// crypto.randomUUID(), which is always v4; a v1 id would carry the minting
// machine's MAC address, so no other version is worth accepting here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `build.version` is the only free text in a ping that reaches the public
 * archive: the collector tallies it and, once three instances share a value,
 * writes it to the metrics branch, where the insights page renders it. Bound it
 * on arrival to what a version string can look like. The field stays optional, so
 * a build that reports no version at all is still a valid ping.
 */
const BUILD_VERSION = /^[0-9A-Za-z.+-]{1,32}$/;

/** How far a reported day may sit from the receiver's own UTC day, in either direction. */
const MAX_DAY_DRIFT = 2;

/**
 * Every numeric field schema 1 defines, section 5 of the spec. Anything else in
 * the body is opaque and passes through untouched. A field missing from this list
 * is neither range checked nor rounded, so a new numeric field in the payload has
 * to be added here in the same change.
 */
const COUNT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['users', 'registered'], ['users', 'active1d'], ['users', 'active7d'], ['users', 'active30d'],
  ['clients', 'web'], ['clients', 'desktop'], ['clients', 'mobile'],
  ['content', 'spaces'], ['content', 'channels'], ['content', 'messages'], ['content', 'messages7d'], ['content', 'storageMiB'],
  ['features', 'peers'],
  ['runtime', 'node'],
];

export interface ValidPing { instance: string; day: string; schema: number; body: string }
export type ParseResult = { ok: true; ping: ValidPing } | { ok: false; reason: string };

/**
 * Two significant digits, floored at zero, integers only. Values below 100 are
 * already two digits and stay exact; 12345 becomes 12000. This mirrors
 * packages/server/src/telemetry/rounding.ts exactly: the instance rounds before
 * sending and the receiver rounds again on arrival, so an old or modified build
 * cannot ship finer numbers than the schema promises. Both sides must return the
 * same value for every input; the shared cases are pinned in both test files.
 */
export function roundTwoSignificant(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const whole = Math.floor(n);
  if (whole < 100) return whole;
  const magnitude = 10 ** (Math.floor(Math.log10(whole)) - 1);
  return Math.round(whole / magnitude) * magnitude;
}

/**
 * The stored country for a ping. Cloudflare reports an upper case ISO 3166-1
 * alpha-2 code, `XX` for an unknown client and `T1` for a Tor exit; those two and
 * anything that is not a two letter code become `ZZ` (unknown).
 */
export function normaliseCountry(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value) || value === 'XX' || value === 'T1') return 'ZZ';
  return value;
}

/**
 * True only for a day that exists. `Date.parse` accepts `2026-02-30` and rolls it
 * over into March, so the parsed instant is compared back against the input.
 */
function isCalendarDay(day: string): boolean {
  const t = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === day;
}

/**
 * Whole days from `b` to `a`, both `YYYY-MM-DD`. Negative when `a` is the earlier
 * day, `NaN` when either side is not a parseable day.
 */
function dayOffset(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a ping body and return it re-serialised with every known count
 * rounded. Unknown fields are kept untouched, so a newer instance reporting a
 * field this receiver has never heard of still stores it.
 */
export function parsePing(text: string, receiverToday: string): ParseResult {
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { ok: false, reason: 'too large' };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: 'not json' }; }
  if (!isRecord(parsed)) return { ok: false, reason: 'not an object' };

  const { schema, instance, day } = parsed;
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 1) return { ok: false, reason: 'schema' };
  if (typeof instance !== 'string' || !UUID.test(instance)) return { ok: false, reason: 'instance' };
  if (typeof day !== 'string' || !ISO_DAY.test(day) || !isCalendarDay(day)) return { ok: false, reason: 'day' };
  // A non-finite offset means the caller passed a day this function cannot place;
  // reject rather than let the comparison fall through as "in range".
  const offset = dayOffset(day, receiverToday);
  if (!Number.isFinite(offset) || Math.abs(offset) > MAX_DAY_DRIFT) return { ok: false, reason: 'day out of range' };

  const build = parsed['build'];
  if (isRecord(build) && build['version'] !== undefined) {
    const version = build['version'];
    if (typeof version !== 'string' || !BUILD_VERSION.test(version)) return { ok: false, reason: 'build.version' };
  }

  for (const [group, field] of COUNT_FIELDS) {
    const g = parsed[group];
    if (!isRecord(g)) continue;
    const v = g[field];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_COUNT) return { ok: false, reason: `${group}.${field}` };
    g[field] = roundTwoSignificant(v);
  }

  return { ok: true, ping: { instance: instance.toLowerCase(), day, schema, body: JSON.stringify(parsed) } };
}
