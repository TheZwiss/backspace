const API_ROOT = 'https://api.github.com';

/**
 * Any non-2xx GitHub API response, carrying the HTTP status so callers can
 * distinguish e.g. a 404 (resource genuinely absent) from a 403 (rate
 * limited or unauthorized) without re-parsing the message string. Thrown by
 * every method on `GitHubClient` except the deliberate 202-swallowing in
 * `getStats` — see there for why that status alone is not an error.
 */
export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: { cause?: unknown }) {
    super(`GitHub API ${status}: ${message}`, options);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export interface GitHubClient {
  /**
   * Fetches one resource. Throws GitHubError on any non-2xx response, and
   * also on a 2xx response whose body cannot be parsed as JSON (e.g. a 204),
   * so every failure this method can produce carries a status uniformly.
   */
  get<T>(path: string, accept?: string): Promise<T>;
  /**
   * Fetches a `/stats/*` resource. GitHub computes these asynchronously and
   * answers with 202 and an empty body while the computation is in flight;
   * the cache is invalidated by every push to the default branch, so on an
   * active repo a 202 is routine rather than exceptional and can persist
   * across every retry in a run.
   *
   * Returns `null` when the resource is still computing after every retry.
   * `null` is the ONLY way this method can report "not available" — the `T`
   * branch is only ever produced by parsing a genuine 200 response body, so
   * there is no code path that turns an in-progress computation into a
   * zero-shaped value of `T`. Callers MUST treat `null` as "skip this metric
   * today, leave the previously recorded value alone" and must never
   * substitute a zero for it: a zero written for a metric GitHub never
   * finished computing is a permanent, silent lie in an archive that is the
   * only surviving copy of data GitHub deletes after 14 days.
   *
   * A 200 whose body is literally `null` also produces a `null` return here,
   * indistinguishable to the caller from a persistent 202. That is safe, not
   * an oversight: the contract above already requires every caller to treat
   * `null` as "skip this metric today" regardless of why it came back, so no
   * caller needs to tell the two cases apart to behave correctly.
   */
  getStats<T>(path: string): Promise<T | null>;
  /**
   * Fetches every page of a list endpoint by following the `Link` header's
   * `rel="next"` until it is absent, concatenating pages in order. Any
   * non-2xx response or unparseable page aborts the whole call by throwing
   * — there is no partial-result fallback, so a caller can never mistake a
   * pagination failure partway through for a complete list. Also throws if a
   * `rel="next"` URL repeats a URL already fetched in this call, rather than
   * following a cycle forever.
   */
  paginate<T>(path: string, accept?: string): Promise<T[]>;
}

export interface ClientOptions {
  /** Injectable in place of global `fetch`, so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Injectable in place of a real timer, so tests never actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Number of times `getStats` polls a 202 before giving up and returning `null`. */
  statsAttempts?: number;
}

/**
 * Extracts the `rel="next"` URL from a `Link` header, or `null` when there
 * is no next page. GitHub's `Link` header packs multiple relations
 * (`next`, `last`, `prev`, `first`) into one comma-separated value, so this
 * splits on `,` first and matches each `<url>; rel="..."` segment
 * individually rather than searching the raw header text, which could
 * false-match a `rel="next"` substring belonging to a different URL.
 */
function nextLink(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

export function createClient(token: string, options: ClientOptions = {}): GitHubClient {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const statsAttempts = options.statsAttempts ?? 5;

  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'backspace-metrics',
  };

  function absolute(path: string): string {
    return path.startsWith('http') ? path : `${API_ROOT}${path}`;
  }

  async function request(url: string, accept?: string): Promise<Response> {
    const headers = accept === undefined ? baseHeaders : { ...baseHeaders, Accept: accept };
    return doFetch(url, { headers });
  }

  /**
   * Reads a non-2xx response body as text for the error message and throws.
   * Shared by every method so a failure looks the same regardless of which
   * one produced it. Deliberately does not attempt to parse the body as
   * JSON: GitHub's own error bodies are JSON, but a proxy or outage page in
   * front of the API need not be, and failing to parse THAT would mask the
   * original non-2xx status behind a confusing secondary SyntaxError.
   */
  async function throwForStatus(response: Response): Promise<never> {
    throw new GitHubError(response.status, await response.text());
  }

  /**
   * Parses a 2xx response body as JSON, so every method that reaches this
   * point returns either a real parsed value or a `GitHubError`. Without
   * this wrapper, an empty body (a 204) or a body that isn't valid JSON
   * would reach `response.json()` directly and throw a raw `SyntaxError` —
   * the one failure path in this client that wouldn't carry a status and
   * wouldn't be a `GitHubError`, forcing callers to handle it specially. The
   * original `SyntaxError` is preserved as `cause` rather than discarded, so
   * a maintainer diagnosing a parse failure still sees exactly what broke.
   */
  async function parseBody<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new GitHubError(response.status, 'response body could not be parsed as JSON', {
        cause,
      });
    }
  }

  async function get<T>(path: string, accept?: string): Promise<T> {
    const response = await request(absolute(path), accept);
    if (!response.ok) return throwForStatus(response);
    return parseBody<T>(response);
  }

  async function getStats<T>(path: string): Promise<T | null> {
    const url = absolute(path);
    for (let attempt = 0; attempt < statsAttempts; attempt++) {
      const response = await request(url);
      // 202 means GitHub is still computing the statistic; the body is a
      // placeholder and reading it as data would write a zero over a real
      // value. Never parse the body on this branch — the only way this
      // function can produce a `T` is from a genuine 200 below.
      if (response.status === 202) {
        const isLastAttempt = attempt === statsAttempts - 1;
        if (!isLastAttempt) await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!response.ok) return throwForStatus(response);
      return parseBody<T>(response);
    }
    return null;
  }

  async function paginate<T>(path: string, accept?: string): Promise<T[]> {
    const separator = path.includes('?') ? '&' : '?';
    let url: string | null = absolute(`${path}${separator}per_page=100`);
    const items: T[] = [];
    // Tracks every URL already fetched in this call so a self-referential or
    // looping `rel="next"` chain is caught and thrown on instead of followed
    // forever. A scheduled workflow has no human watching it: an infinite
    // loop here means a runner burning CPU until it's killed, and collection
    // silently never finishing rather than failing loud. A fixed page cap
    // was considered and rejected in favor of this: a cap invents an
    // arbitrary ceiling that a legitimately long result set (e.g. paginated
    // stargazers during backfill) could one day cross, while tracking actual
    // repeats catches the real failure mode with no ceiling at all.
    const seen = new Set<string>();
    while (url !== null) {
      if (seen.has(url)) {
        throw new Error(
          `paginate: rel="next" returned ${url} a second time in the same call — the pagination sequence is cyclic and would loop forever`,
        );
      }
      seen.add(url);
      const response: Response = await request(url, accept);
      if (!response.ok) return throwForStatus(response);
      const page = await parseBody<unknown>(response);
      if (!Array.isArray(page)) {
        throw new Error(
          `paginate: expected an array from ${url} but got ${typeof page} — the pagination sequence is truncated or the endpoint does not return a list`,
        );
      }
      items.push(...(page as T[]));
      url = nextLink(response.headers.get('link'));
    }
    return items;
  }

  return { get, getStats, paginate };
}
