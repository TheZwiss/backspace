import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// The download writes through config.uploadDir. Point it at a throwaway
// directory before config.ts is imported, so a test that is *supposed* to
// abandon a file cannot leave one in the repo's real data/uploads.
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-profile-dl-'));
process.env.UPLOAD_DIR = UPLOAD_DIR;

// Real safeFetch semantics: validate, then fetch with redirect:'manual', then
// re-validate the Location before following. The point of this suite is that
// downloadProfileAsset goes through that loop at all, so the double is honest
// rather than permissive.
const validate = vi.fn<(url: string) => Promise<void>>();
const rawFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

vi.mock('../../utils/ssrf.js', () => ({
  isPrivateIp: () => false,
  validateExternalUrl: (u: string) => validate(u),
  safeFetch: async (url: string, init?: RequestInit) => {
    let current = url;
    for (let hop = 0; hop <= 5; hop++) {
      await validate(current);
      const res = await rawFetch(current, { ...init, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return res;
        current = new URL(loc, current).toString();
        continue;
      }
      return res;
    }
    throw new Error('Too many redirects');
  },
}));

// A bare global fetch here would mean the code under test bypassed safeFetch.
// Make that loud rather than letting it fall through to the real network.
vi.stubGlobal('fetch', vi.fn(async () => {
  throw new Error('global fetch called: downloadProfileAsset bypassed safeFetch');
}));

const { downloadProfileAsset, MAX_PROFILE_ASSET_BYTES } = await import('./profile.js');
const { setWorkerId } = await import('../../utils/snowflake.js');

// downloadProfileAsset names its temp file with a snowflake, and the generator
// refuses to run before startup has assigned a worker ID. Without this every
// case past the hostname check dies on that instead of on what it is testing.
setWorkerId(1);

afterAll(() => {
  try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('downloadProfileAsset', () => {
  beforeEach(() => {
    validate.mockReset();
    validate.mockResolvedValue(undefined);
    rawFetch.mockReset();
  });

  it('refuses a URL whose host does not match the authenticated source instance', async () => {
    const result = await downloadProfileAsset('https://elsewhere.test/a.png', 'https://peer.test');
    expect(result).toBeNull();
    expect(rawFetch).not.toHaveBeenCalled();
  });

  it('re-validates the destination of a redirect instead of following it blindly', async () => {
    rawFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9200/logo.png' } }),
    );
    validate.mockReset();
    validate.mockResolvedValueOnce(undefined)                                   // first hop, the peer
            .mockRejectedValueOnce(new Error('Private IP not allowed'));        // the redirect target

    const result = await downloadProfileAsset('https://peer.test/a.png', 'https://peer.test');

    expect(result).toBeNull();
    expect(validate).toHaveBeenCalledWith('http://127.0.0.1:9200/logo.png');
    expect(rawFetch).toHaveBeenCalledTimes(1); // the second hop was never issued
  });

  it('rejects a response that is not an image', async () => {
    rawFetch.mockResolvedValueOnce(
      new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    expect(await downloadProfileAsset('https://peer.test/a.png', 'https://peer.test')).toBeNull();
    // Without this the case is vacuous: any transport failure also returns
    // null, so a null result alone does not show the content-type branch ran.
    expect(rawFetch).toHaveBeenCalledTimes(1);
  });

  it('abandons a body that exceeds the cap instead of streaming it to disk', async () => {
    const oversize = new Uint8Array(MAX_PROFILE_ASSET_BYTES + 1024);
    rawFetch.mockResolvedValueOnce(
      new Response(oversize, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    expect(await downloadProfileAsset('https://peer.test/a.png', 'https://peer.test')).toBeNull();
    expect(rawFetch).toHaveBeenCalledTimes(1);
    // Same reason, plus the claim in the test name: nothing is left behind,
    // neither the temp file nor a renamed final one.
    expect(fs.readdirSync(UPLOAD_DIR)).toEqual([]);
  });
});
