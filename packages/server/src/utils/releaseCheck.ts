import { config } from '../config.js';

/**
 * Looks up the newest published Backspace release.
 *
 * Three properties matter more than the feature itself:
 *
 *  1. **No background poller.** Nothing in the server calls this on a timer.
 *     It runs only while a signed-in admin has the Updates panel open and the
 *     cache is cold. An instance whose admin never opens that panel never
 *     contacts github.com. For a self-hosted product that is a promise worth
 *     keeping, not a detail.
 *  2. **Nothing identifying leaves the box.** The User-Agent is the bare word
 *     "Backspace" (GitHub requires one). No instance id, no domain, not even
 *     the running version, which would otherwise turn GitHub's logs into a
 *     version census of every deployment.
 *  3. **Every failure is soft.** A timeout, a rate limit, a captive portal, or
 *     no outbound route at all yields `unknown` with a reason. An operator with
 *     no internet still gets a working panel that tells them what they run.
 *
 * The URL is a compile-time constant and is never derived from user input, so
 * the SSRF policy in docs/systems/embeds.md does not apply here.
 */

const RELEASES_API = 'https://api.github.com/repos/TheZwiss/backspace/releases/latest';
const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Enough for a release payload; anything larger is not a release payload. */
const MAX_RESPONSE_BYTES = 512 * 1024;

export type ReleaseCheckState = 'up-to-date' | 'update-available' | 'unknown';
export type ReleaseCheckReason = 'disabled' | 'unreachable' | 'rate-limited' | 'unparseable';

export interface LatestRelease {
  version: string;
  url: string;
  publishedAt: string;
}

export interface ReleaseCheckResult {
  latest: LatestRelease | null;
  reason: ReleaseCheckReason | null;
  checkedAt: number;
}

interface CacheEntry {
  result: ReleaseCheckResult;
  expiresAt: number;
}

let cache: CacheEntry | null = null;
/** Coalesces concurrent panel opens into one outbound request. */
let inFlight: Promise<ReleaseCheckResult> | null = null;

/**
 * Parses a GitHub release payload.
 *
 * Exported for tests, and deliberately tolerant about everything except the
 * tag: a release with no `html_url` or `published_at` is still a release worth
 * telling the operator about.
 */
export function parseLatestRelease(payload: unknown): LatestRelease | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as Record<string, unknown>;

  // Drafts and prereleases are not what a self-hoster should be pointed at.
  if (raw.draft === true || raw.prerelease === true) return null;

  const tag = typeof raw.tag_name === 'string' ? raw.tag_name.trim() : '';
  const version = tag.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+/.test(version)) return null;

  return {
    version,
    url: typeof raw.html_url === 'string' && raw.html_url.startsWith('https://github.com/')
      ? raw.html_url
      : `https://github.com/TheZwiss/backspace/releases/tag/${tag}`,
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : '',
  };
}

/**
 * Compares two `major.minor.patch` versions.
 *
 * Returns null when either side does not parse, which the caller reports as
 * `unknown`. Answering "you are up to date" off an unparseable comparison would
 * be worse than admitting ignorance.
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (value: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) return null;
  for (let i = 0; i < 3; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * Derives the reported state from the running version and the lookup result.
 * Pure, so the comparison rules are testable without a network.
 */
export function deriveState(
  currentVersion: string,
  result: ReleaseCheckResult,
): ReleaseCheckState {
  if (result.latest === null) return 'unknown';
  const comparison = compareVersions(currentVersion, result.latest.version);
  if (comparison === null) return 'unknown';
  return comparison < 0 ? 'update-available' : 'up-to-date';
}

/**
 * Fetches the latest release, subject to the cache and the kill switch.
 *
 * `force` bypasses the cache for an explicit "Check again" click. It does not
 * bypass the kill switch, which no request from the UI can override.
 */
export async function getLatestRelease(force = false): Promise<ReleaseCheckResult> {
  if (!config.updates.checkEnabled) {
    return { latest: null, reason: 'disabled', checkedAt: Date.now() };
  }

  const now = Date.now();
  if (!force && cache !== null && cache.expiresAt > now) {
    return cache.result;
  }

  // A second admin opening the panel while a request is in flight waits for
  // that request rather than starting another.
  if (inFlight !== null) return inFlight;

  inFlight = performLookup()
    .then((result) => {
      // A failed lookup is cached for a tenth of the TTL. Long enough that a
      // panel refresh does not hammer a rate-limited endpoint, short enough
      // that a transient outage does not persist for six hours.
      const ttl = result.latest === null ? CACHE_TTL_MS / 10 : CACHE_TTL_MS;
      cache = { result, expiresAt: Date.now() + ttl };
      return result;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

async function performLookup(): Promise<ReleaseCheckResult> {
  const checkedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(RELEASES_API, {
      signal: controller.signal,
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub rejects requests with no User-Agent. This one says what the
        // software is and nothing about which instance is asking.
        'User-Agent': 'Backspace',
      },
    });

    if (response.status === 403 || response.status === 429) {
      return { latest: null, reason: 'rate-limited', checkedAt };
    }
    if (!response.ok) {
      return { latest: null, reason: 'unreachable', checkedAt };
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > MAX_RESPONSE_BYTES) {
      return { latest: null, reason: 'unparseable', checkedAt };
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      return { latest: null, reason: 'unparseable', checkedAt };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { latest: null, reason: 'unparseable', checkedAt };
    }

    const latest = parseLatestRelease(payload);
    if (latest === null) {
      return { latest: null, reason: 'unparseable', checkedAt };
    }
    return { latest, reason: null, checkedAt };
  } catch {
    // Timeout, DNS failure, TLS failure, no route. All the same to an operator:
    // we could not ask, so we do not know.
    return { latest: null, reason: 'unreachable', checkedAt };
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam. Drops the cache and any in-flight coalescing. */
export function resetReleaseCacheForTest(): void {
  cache = null;
  inFlight = null;
}
