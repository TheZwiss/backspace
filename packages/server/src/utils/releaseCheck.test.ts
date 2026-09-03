import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseLatestRelease,
  compareVersions,
  deriveState,
  getLatestRelease,
  resetReleaseCacheForTest,
  type ReleaseCheckResult,
} from './releaseCheck.js';
import { config } from '../config.js';

const mutableUpdates = config.updates as { checkEnabled: boolean; installChannel?: string };

describe('parseLatestRelease', () => {
  it('reads a real GitHub release payload', () => {
    const payload = {
      tag_name: 'v1.0.4',
      html_url: 'https://github.com/TheZwiss/backspace/releases/tag/v1.0.4',
      published_at: '2026-09-03T11:00:00Z',
      draft: false,
      prerelease: false,
    };
    expect(parseLatestRelease(payload)).toEqual({
      version: '1.0.4',
      url: 'https://github.com/TheZwiss/backspace/releases/tag/v1.0.4',
      publishedAt: '2026-09-03T11:00:00Z',
    });
  });

  it('strips the leading v from the tag', () => {
    expect(parseLatestRelease({ tag_name: 'v2.10.3' })?.version).toBe('2.10.3');
    expect(parseLatestRelease({ tag_name: '2.10.3' })?.version).toBe('2.10.3');
  });

  it('refuses to point operators at a draft or a prerelease', () => {
    expect(parseLatestRelease({ tag_name: 'v1.0.5', draft: true })).toBeNull();
    expect(parseLatestRelease({ tag_name: 'v1.0.5', prerelease: true })).toBeNull();
  });

  it('rejects a tag that is not a version', () => {
    expect(parseLatestRelease({ tag_name: 'nightly' })).toBeNull();
    expect(parseLatestRelease({ tag_name: 'v1.0' })).toBeNull();
    expect(parseLatestRelease({ tag_name: '' })).toBeNull();
    expect(parseLatestRelease({})).toBeNull();
  });

  it('rejects a non-object payload', () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease('v1.0.4')).toBeNull();
    expect(parseLatestRelease([])).toBeNull();
  });

  it('falls back to a constructed URL rather than trusting an off-site one', () => {
    // An html_url pointing anywhere but github.com would be a link the panel
    // renders, so it is replaced rather than passed through.
    const result = parseLatestRelease({
      tag_name: 'v1.0.4',
      html_url: 'https://evil.example.com/phish',
    });
    expect(result?.url).toBe('https://github.com/TheZwiss/backspace/releases/tag/v1.0.4');
  });

  it('tolerates a missing published_at', () => {
    expect(parseLatestRelease({ tag_name: 'v1.0.4' })?.publishedAt).toBe('');
  });
});

describe('compareVersions', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
  });

  it('detects equality and the reverse order', () => {
    expect(compareVersions('1.0.4', '1.0.4')).toBe(0);
    expect(compareVersions('1.0.5', '1.0.4')).toBe(1);
  });

  it('returns null rather than guessing on an unparseable version', () => {
    expect(compareVersions('nightly', '1.0.4')).toBeNull();
    expect(compareVersions('1.0.4', '')).toBeNull();
    expect(compareVersions('1.0', '1.0.4')).toBeNull();
  });
});

describe('deriveState', () => {
  const found = (version: string): ReleaseCheckResult => ({
    latest: { version, url: 'https://github.com/x', publishedAt: '' },
    reason: null,
    checkedAt: 0,
  });

  it('reports an available update', () => {
    expect(deriveState('1.0.3', found('1.0.4'))).toBe('update-available');
  });

  it('reports up to date when equal', () => {
    expect(deriveState('1.0.4', found('1.0.4'))).toBe('up-to-date');
  });

  it('reports up to date when running ahead of the latest release', () => {
    // A maintainer running an unreleased build should not be told to downgrade.
    expect(deriveState('1.1.0', found('1.0.4'))).toBe('up-to-date');
  });

  it('reports unknown when the lookup found nothing', () => {
    expect(deriveState('1.0.4', { latest: null, reason: 'unreachable', checkedAt: 0 }))
      .toBe('unknown');
  });

  it('reports unknown rather than a wrong answer on an unparseable version', () => {
    expect(deriveState('dev', found('1.0.4'))).toBe('unknown');
  });
});

describe('getLatestRelease', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetReleaseCacheForTest();
    mutableUpdates.checkEnabled = true;
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    resetReleaseCacheForTest();
    mutableUpdates.checkEnabled = true;
  });

  function stubFetch(impl: (...args: unknown[]) => Promise<Response>): void {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(impl as typeof fetch);
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('opens no socket at all when the check is disabled', async () => {
    mutableUpdates.checkEnabled = false;
    stubFetch(() => Promise.reject(new Error('fetch must not be called')));

    const result = await getLatestRelease();
    expect(result).toMatchObject({ latest: null, reason: 'disabled' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends a User-Agent that identifies the software but not the instance', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ tag_name: 'v1.0.4' })));
    await getLatestRelease();

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('Backspace');
    // Nothing that says which deployment is asking.
    const serialised = JSON.stringify(headers);
    expect(serialised).not.toMatch(/instance|domain|\d+\.\d+\.\d+/i);
  });

  it('returns the parsed release on success', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({
      tag_name: 'v1.0.4',
      html_url: 'https://github.com/TheZwiss/backspace/releases/tag/v1.0.4',
      published_at: '2026-09-03T11:00:00Z',
    })));

    const result = await getLatestRelease();
    expect(result.latest?.version).toBe('1.0.4');
    expect(result.reason).toBeNull();
  });

  it('serves the second call from cache without a second request', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ tag_name: 'v1.0.4' })));
    await getLatestRelease();
    await getLatestRelease();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache when the admin explicitly re-checks', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ tag_name: 'v1.0.4' })));
    await getLatestRelease();
    await getLatestRelease(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent calls into one request', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ tag_name: 'v1.0.4' })));
    await Promise.all([getLatestRelease(), getLatestRelease(), getLatestRelease()]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reports rate limiting distinctly from being unreachable', async () => {
    stubFetch(() => Promise.resolve(new Response('{}', { status: 403 })));
    expect((await getLatestRelease()).reason).toBe('rate-limited');

    resetReleaseCacheForTest();
    fetchSpy.mockResolvedValue(new Response('{}', { status: 429 }));
    expect((await getLatestRelease()).reason).toBe('rate-limited');
  });

  it('reports a server error as unreachable', async () => {
    stubFetch(() => Promise.resolve(new Response('nope', { status: 502 })));
    expect((await getLatestRelease()).reason).toBe('unreachable');
  });

  it('never throws when the network fails outright', async () => {
    stubFetch(() => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com')));
    const result = await getLatestRelease();
    expect(result).toMatchObject({ latest: null, reason: 'unreachable' });
  });

  it('never throws on a body that is not JSON', async () => {
    stubFetch(() => Promise.resolve(new Response('<html>captive portal</html>', { status: 200 })));
    expect((await getLatestRelease()).reason).toBe('unparseable');
  });

  it('refuses an absurdly large body rather than parsing it', async () => {
    stubFetch(() => Promise.resolve(new Response('x'.repeat(600 * 1024), { status: 200 })));
    expect((await getLatestRelease()).reason).toBe('unparseable');
  });

  it('caches a failure only briefly, so a transient outage clears', async () => {
    stubFetch(() => Promise.resolve(new Response('nope', { status: 502 })));
    const failed = await getLatestRelease();
    // The failure is cached (no second request), but for a tenth of the TTL.
    await getLatestRelease();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(failed.reason).toBe('unreachable');
  });
});
