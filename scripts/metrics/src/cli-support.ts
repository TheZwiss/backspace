import { GitHubError } from './github.ts';
import type { CollectResult } from './collect.ts';
import type { IsoDate } from './types.ts';

/**
 * Reads and validates one required environment variable.
 *
 * Rejects `undefined`, the empty string, and a whitespace-only value alike —
 * a workflow-injected secret with a stray trailing newline, or a step that
 * exports an empty string instead of omitting the variable entirely, must
 * fail here with a clear message rather than flow into
 * `createClient`/`createStore` and produce a stream of 401s or `ENOENT`
 * errors that read like an unrelated outage. The returned value is trimmed:
 * the only realistic way whitespace reaches a GitHub Actions env var is
 * accidental (a trailing newline picked up from a prior step's output),
 * never a value where the whitespace is meaningful.
 *
 * Takes `env` as a parameter rather than reading `process.env` itself so
 * this function stays a pure, unit-testable helper — `cli-collect.ts` and
 * `cli-backfill.ts` are the only two places in this package allowed to read
 * the real `process.env`, and both do so by passing it in here.
 */
export function requiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const raw = env[name];
  if (raw === undefined) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  const value = raw.trim();
  if (value === '') {
    throw new Error(
      `Missing required environment variable ${name} (present but empty or whitespace-only)`,
    );
  }
  return value;
}

/** Matches any C0 control character or DEL — none of which are legal in an HTTP header value. */
const HEADER_UNSAFE_RE = /[\x00-\x1f\x7f]/;

/**
 * Rejects a token containing control characters (a newline, a tab, or any
 * other C0/DEL byte) before it can ever reach
 * `Authorization: Bearer <token>`.
 *
 * This is not a hypothetical concern. Verified directly against this
 * package's own Node version: a newline embedded in a header value makes
 * `fetch`'s underlying `Headers` implementation throw a `TypeError` whose
 * *message* is `Headers.append: "Bearer <the entire broken value>" is an
 * invalid header value.` — the secret, verbatim, inside the exception text.
 * `github.ts`'s `createClient` builds exactly that header from the raw
 * token, and this CLI's top-level catch prints whatever any thrown error
 * says. Without this guard, a malformed `METRICS_TOKEN` would put the
 * secret straight into a public CI log via that one code path. This check
 * exists so that path is never reached: a malformed token fails here first,
 * with a message that names the problem without repeating the value.
 */
export function assertHeaderSafeToken(token: string): void {
  if (HEADER_UNSAFE_RE.test(token)) {
    throw new Error(
      'METRICS_TOKEN contains a control character (e.g. a newline or tab) and cannot be sent as an HTTP header value',
    );
  }
}

/**
 * Derives this run's `now` and `today` from the system clock, both UTC.
 *
 * `Date#toISOString` is always UTC by spec, independent of the host's local
 * timezone or `process.env.TZ`, so slicing its first 10 characters already
 * is the correct UTC calendar day — no explicit UTC getters are needed, and
 * none should be added. `getDate()`/`getMonth()`/`getFullYear()` (and
 * anything built on them, e.g. `toLocaleDateString`) read the LOCAL
 * calendar day and would silently misfile a run's data under the wrong
 * date for any host not running in UTC — exactly the failure `collect.ts`
 * requires `today` never suffer from, since the archive treats every date
 * as a UTC calendar day.
 */
export function deriveRunTimestamps(date: Date): { now: string; today: IsoDate } {
  const now = date.toISOString();
  const today: IsoDate = now.slice(0, 10);
  return { now, today };
}

/** Formats `collect`'s result as the lines a maintainer reading the run log should see. */
export function formatCollectSummary(result: CollectResult): string[] {
  const lines = [`wrote: ${result.written.join(', ')}`];
  if (result.skipped.length > 0) {
    lines.push(`skipped (left at previous value): ${result.skipped.join(', ')}`);
  }
  return lines;
}

/**
 * Formats `backfill`'s result for the run log.
 *
 * Deliberately does not call this list "written" the way `collect`'s output
 * does: `backfill`'s `written` field is the fixed, exhaustive set of files
 * it is PERMITTED to touch (`WRITABLE` in `backfill.ts`), not the set that
 * actually changed on this run — every write there is if-absent, so a
 * rerun against an already-seeded archive legitimately reports the same
 * list while changing nothing on disk. Phrasing it as "target files" here,
 * with the if-absent caveat spelled out, keeps a maintainer from reading
 * this line the same way they'd read `collect`'s `wrote:` line and
 * concluding new history was recovered when none was.
 */
export function formatBackfillSummary(result: { written: string[] }): string {
  return `backfill target files (write-if-absent, listed whether or not they changed this run): ${result.written.join(', ')}`;
}

/**
 * Renders a thrown value, and its full `cause` chain, for a CI log.
 *
 * Takes only `error: unknown` — never `process.env` or any credential — so
 * this function is structurally incapable of printing a secret: there is
 * nothing here for it to read one from. The only way a token could reach
 * this function's output is if it were already embedded in a thrown error's
 * `message` upstream, which is exactly what `assertHeaderSafeToken` exists
 * to prevent before any request is ever made.
 *
 * Walks `.cause` (as `Store` and `GitHubClient` both use it to wrap lower-
 * level failures — a raw `ENOSPC`, an unparseable response body) so a
 * maintainer sees every layer, not just the outermost message. Bounded to
 * 10 levels and tracked with a `seen` set purely as a defensive backstop
 * against a pathological or circular `cause` chain looping this function
 * forever in a scheduled job with no one watching it; no code in this
 * package is expected to ever produce one.
 */
export function describeFailure(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  let guard = 0;

  while (guard < 10) {
    guard += 1;
    if (typeof current === 'object' && current !== null) {
      if (seen.has(current)) {
        parts.push('[circular cause reference — stopping]');
        break;
      }
      seen.add(current);
    }

    if (current instanceof GitHubError) {
      parts.push(`GitHub API error (status ${current.status}): ${current.stack ?? current.message}`);
    } else if (current instanceof Error) {
      parts.push(current.stack ?? current.message);
    } else {
      parts.push(`Non-Error value thrown: ${String(current)}`);
      break;
    }

    const cause = current instanceof Error ? current.cause : undefined;
    if (cause === undefined) break;
    parts.push('Caused by:');
    current = cause;
  }

  return parts.join('\n');
}
