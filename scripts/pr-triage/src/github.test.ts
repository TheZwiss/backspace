import { describe, it, expect } from 'vitest';
import { GitHubClient, GitHubError, MAX_FILE_BYTES, nextLink } from './github.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fake(routes: Record<string, (req: Recorded) => Response>) {
  const calls: Recorded[] = [];
  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const req: Recorded = {
      url: input,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(req);
    const key = Object.keys(routes).find((k) => input.startsWith(k));
    if (!key) return new Response('no route', { status: 599 });
    return routes[key]!(req);
  };
  return { calls, client: new GitHubClient('tok', 'TheZwiss/backspace', fetchFn) };
}

const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), { status: 200, ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });

describe('GitHubClient', () => {
  it('rejects a repository string that is not owner/repo', () => {
    expect(() => new GitHubClient('t', 'evil/../x', async () => new Response())).toThrow();
    expect(() => new GitHubClient('t', 'nope', async () => new Response())).toThrow();
  });

  it('sends the token and API headers on every request', async () => {
    const { calls, client } = fake({ 'https://api.github.com/repos/TheZwiss/backspace/pulls/1': () => json({ number: 1 }) });
    await client.getPull(1);
    expect(calls[0]!.headers['Authorization']).toBe('Bearer tok');
    expect(calls[0]!.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('throws GitHubError with the status on a non-2xx', async () => {
    const { client } = fake({ 'https://api.github.com/repos/TheZwiss/backspace/pulls/1': () => new Response('nope', { status: 403 }) });
    await expect(client.getPull(1)).rejects.toMatchObject({ name: 'GitHubError', status: 403 });
  });

  it('follows Link rel=next across pages and refuses a cycle', async () => {
    const base = 'https://api.github.com/repos/TheZwiss/backspace/pulls/7/files';
    const { calls, client } = fake({
      [`${base}?per_page=100&page=2`]: () => json([{ filename: 'b', status: 'added' }]),
      [`${base}?per_page=100`]: () =>
        json([{ filename: 'a', status: 'modified' }], { headers: { link: `<${base}?per_page=100&page=2>; rel="next", <x>; rel="last"` } }),
    });
    const files = await client.listPullFiles(7);
    expect(files.map((f) => f.filename)).toEqual(['a', 'b']);
    expect(calls).toHaveLength(2);

    const loop = fake({ [base]: () => json([], { headers: { link: `<${base}?per_page=100>; rel="next"` } }) });
    await expect(loop.client.listPullFiles(7)).rejects.toThrow(/cycle/);
  });

  it('reads the merge base from the compare endpoint and validates shas', async () => {
    const { calls, client } = fake({
      'https://api.github.com/repos/TheZwiss/backspace/compare/': () => json({ merge_base_commit: { sha: 'c'.repeat(40) } }),
    });
    expect(await client.mergeBase(SHA_A, SHA_B)).toBe('c'.repeat(40));
    expect(calls[0]!.url).toBe(`https://api.github.com/repos/TheZwiss/backspace/compare/${SHA_A}...${SHA_B}?per_page=1`);
    await expect(client.mergeBase('main', SHA_B)).rejects.toThrow(/not a commit sha/);
  });

  it('fetches raw contents through the base repository, URL-encoding each path segment', async () => {
    const { calls, client } = fake({
      'https://api.github.com/repos/TheZwiss/backspace/contents/': () => new Response('{"a":1}', { status: 200 }),
    });
    const text = await client.getRawFile('packages/x/package.json?ref=main', SHA_A);
    expect(text).toBe('{"a":1}');
    expect(calls[0]!.url).toBe(
      `https://api.github.com/repos/TheZwiss/backspace/contents/packages/x/package.json%3Fref%3Dmain?ref=${SHA_A}`,
    );
    expect(calls[0]!.headers['Accept']).toBe('application/vnd.github.raw+json');
  });

  it('returns null for a missing file and throws on other errors', async () => {
    const { client } = fake({
      'https://api.github.com/repos/TheZwiss/backspace/contents/missing': () => new Response('', { status: 404 }),
      'https://api.github.com/repos/TheZwiss/backspace/contents/broken': () => new Response('', { status: 500 }),
    });
    expect(await client.getRawFile('missing', SHA_A)).toBeNull();
    await expect(client.getRawFile('broken', SHA_A)).rejects.toBeInstanceOf(GitHubError);
  });

  it('refuses paths with control characters, empty or dot segments', async () => {
    const { client } = fake({});
    await expect(client.getRawFile('a\nb', SHA_A)).rejects.toThrow(/refusing/);
    await expect(client.getRawFile('a//b', SHA_A)).rejects.toThrow(/refusing/);
    await expect(client.getRawFile('../b', SHA_A)).rejects.toThrow(/refusing/);
    await expect(client.getRawFile('a/./b', SHA_A)).rejects.toThrow(/refusing/);
  });

  it('refuses a file above the size limit by header or by body', async () => {
    const { client } = fake({
      'https://api.github.com/repos/TheZwiss/backspace/contents/big-header': () =>
        new Response('x', { status: 200, headers: { 'content-length': String(MAX_FILE_BYTES + 1) } }),
      'https://api.github.com/repos/TheZwiss/backspace/contents/big-body': () =>
        new Response('x'.repeat(MAX_FILE_BYTES + 1), { status: 200 }),
    });
    await expect(client.getRawFile('big-header', SHA_A)).rejects.toThrow(/limit/);
    await expect(client.getRawFile('big-body', SHA_A)).rejects.toThrow(/limit/);
  });

  it('creates and updates comments with a JSON body', async () => {
    const { calls, client } = fake({
      'https://api.github.com/repos/TheZwiss/backspace/issues/7/comments': () => json({ id: 1 }, { status: 201 }),
      'https://api.github.com/repos/TheZwiss/backspace/issues/comments/9': () => json({ id: 9 }),
    });
    await client.createIssueComment(7, 'hello');
    await client.updateIssueComment(9, 'again');
    expect(calls[0]).toMatchObject({ method: 'POST', body: JSON.stringify({ body: 'hello' }) });
    expect(calls[1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ body: 'again' }) });
  });
});

describe('nextLink', () => {
  it('extracts the next URL and ignores the rest', () => {
    expect(nextLink('<https://x/a?page=2>; rel="next", <https://x/a?page=9>; rel="last"')).toBe('https://x/a?page=2');
    expect(nextLink('<https://x/a?page=9>; rel="last"')).toBeNull();
    expect(nextLink(null)).toBeNull();
  });
});
