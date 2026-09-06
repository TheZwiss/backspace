import type { ChangedFile } from './types.ts';

const API_ROOT = 'https://api.github.com';

/**
 * Files larger than this are not analysed. The repository's lockfile is
 * under half a megabyte; a fork PR that makes it fifty times larger is
 * itself something the maintainer reads, and the caller reports it as a
 * problem (fail closed) rather than parsing it.
 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`GitHub API ${status}: ${message}`);
    this.name = 'GitHubError';
    this.status = status;
  }
}

/** The fields of `GET /pulls/{n}` the triage reads. */
export interface PullRequest {
  number: number;
  changed_files: number;
  user: { login: string } | null;
  head: { sha: string; repo: { full_name: string } | null };
  base: { sha: string };
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string } | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The bot only ever talks to the base repository. A file at the PR's head
 * commit is fetched as `/repos/{base}/contents/{path}?ref={headSha}`: the
 * commit is reachable through the pull request's ref, so this works
 * whether the fork still exists or not, and no owner or repository name
 * from the event payload is ever placed in a URL.
 */
export class GitHubClient {
  private readonly headers: Record<string, string>;
  private readonly repository: string;
  private readonly fetchFn: FetchLike;

  constructor(token: string, repository: string, fetchFn: FetchLike = (input, init) => fetch(input, init)) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error(`not an owner/repo string: ${repository}`);
    }
    this.repository = repository;
    this.fetchFn = fetchFn;
    this.headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'backspace-pr-triage',
    };
  }

  private async request(path: string, init: RequestInit = {}, accept?: string): Promise<Response> {
    const url = path.startsWith('https://') ? path : `${API_ROOT}${path}`;
    const headers: Record<string, string> = { ...this.headers, ...(init.headers as Record<string, string> | undefined) };
    if (accept) headers['Accept'] = accept;
    return this.fetchFn(url, { ...init, headers });
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.request(path);
    if (!res.ok) throw new GitHubError(res.status, `${path}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Every page of a list endpoint, following `Link: rel="next"`. */
  private async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    let next: string | null = `${API_ROOT}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    while (next !== null) {
      if (seen.has(next)) throw new Error(`pagination cycle at ${next}`);
      seen.add(next);
      const res = await this.request(next);
      if (!res.ok) throw new GitHubError(res.status, `${next}: ${await res.text()}`);
      const page = (await res.json()) as T[];
      if (!Array.isArray(page)) throw new Error(`expected an array from ${next}`);
      out.push(...page);
      next = nextLink(res.headers.get('link'));
    }
    return out;
  }

  getPull(number: number): Promise<PullRequest> {
    return this.getJson(`/repos/${this.repository}/pulls/${number}`);
  }

  listPullFiles(number: number): Promise<ChangedFile[]> {
    return this.paginate<ChangedFile>(`/repos/${this.repository}/pulls/${number}/files`);
  }

  /**
   * The merge base of the PR, from the compare endpoint. Diffing against
   * the base branch tip instead would attribute every commit main gained
   * since the PR branched to the PR.
   */
  async mergeBase(baseSha: string, headSha: string): Promise<string> {
    assertSha(baseSha);
    assertSha(headSha);
    const body = await this.getJson<{ merge_base_commit?: { sha?: string } }>(
      `/repos/${this.repository}/compare/${baseSha}...${headSha}?per_page=1`,
    );
    const sha = body.merge_base_commit?.sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('compare returned no merge base');
    return sha;
  }

  /**
   * Raw contents of one file at one commit, or `null` when it does not
   * exist there. Throws when the file exceeds `MAX_FILE_BYTES`; the caller
   * turns that into an "unanalysable" verdict.
   */
  async getRawFile(path: string, ref: string): Promise<string | null> {
    assertSha(ref);
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(path) || path.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      throw new Error(`refusing to fetch path: ${JSON.stringify(path)}`);
    }
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await this.request(
      `/repos/${this.repository}/contents/${encoded}?ref=${ref}`,
      {},
      'application/vnd.github.raw+json',
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubError(res.status, `${path}@${ref}: ${await res.text()}`);
    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > MAX_FILE_BYTES) throw new Error(`${path} is ${length} bytes, above the ${MAX_FILE_BYTES} byte limit`);
    const text = await res.text();
    if (text.length > MAX_FILE_BYTES) throw new Error(`${path} is above the ${MAX_FILE_BYTES} byte limit`);
    return text;
  }

  listIssueComments(number: number): Promise<IssueComment[]> {
    return this.paginate<IssueComment>(`/repos/${this.repository}/issues/${number}/comments`);
  }

  async createIssueComment(number: number, body: string): Promise<void> {
    const res = await this.request(`/repos/${this.repository}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new GitHubError(res.status, `create comment: ${await res.text()}`);
  }

  async updateIssueComment(id: number, body: string): Promise<void> {
    const res = await this.request(`/repos/${this.repository}/issues/comments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new GitHubError(res.status, `update comment ${id}: ${await res.text()}`);
  }
}

function assertSha(value: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`not a commit sha: ${JSON.stringify(value)}`);
}

export function nextLink(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m) return m[1]!;
  }
  return null;
}
