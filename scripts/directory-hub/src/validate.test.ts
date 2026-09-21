import { describe, it, expect } from 'vitest';
import { parseOrigin, parseDocument, MAX_DOCUMENT_BYTES, MAX_PING_BYTES } from './validate';

const SELF = 'explore.backspacechat.com';
const ORIGIN = 'https://chat.example.org';

describe('parseOrigin', () => {
  it('accepts a plain https origin', () => {
    expect(parseOrigin(ORIGIN, SELF)).toEqual({ ok: true, origin: ORIGIN });
  });

  it('canonicalises scheme and host to lowercase', () => {
    expect(parseOrigin('HTTPS://Chat.Example.org', SELF)).toEqual({ ok: true, origin: ORIGIN });
  });

  it('accepts a trailing slash and drops it, since a pathname of exactly / is not a path', () => {
    expect(parseOrigin('https://Chat.Example.org/', SELF)).toEqual({ ok: true, origin: ORIGIN });
  });

  it.each<[string, unknown]>([
    ['not a string', 42],
    ['null', null],
    ['undefined', undefined],
    ['http scheme', 'http://chat.example.org'],
    ['a port', 'https://chat.example.org:8443'],
    ['userinfo', 'https://user:pw@chat.example.org'],
    ['a path', 'https://chat.example.org/api'],
    ['a query', 'https://chat.example.org?x=1'],
    ['a fragment', 'https://chat.example.org#top'],
    ['localhost', 'https://localhost'],
    ['an IPv4 literal', 'https://127.0.0.1'],
    ['an IPv6 literal', 'https://[::1]'],
    ['a bare host without a dot', 'https://example'],
    ['the hub itself', `https://${SELF}`],
    ['the hub itself in another case', `https://${SELF.toUpperCase()}`],
    ['an empty string', ''],
    ['garbage', 'not a url'],
  ])('rejects %s', (_label, raw) => {
    expect(parseOrigin(raw, SELF)).toEqual({ ok: false });
  });
});

function space(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'space-1',
    name: 'Kobold Lounge',
    description: 'A place for kobolds.',
    icon: `${ORIGIN}/api/uploads/icon.png`,
    banner: null,
    avatarColor: 'mint',
    visibility: 'public',
    memberCount: 12,
    createdAt: 1758400000000,
    ...overrides,
  };
}

function document(overrides: Record<string, unknown> = {}, spaces: Record<string, unknown>[] = [space()]): string {
  return JSON.stringify({
    schema: 1,
    origin: ORIGIN,
    instance: { name: 'Kobold Truppe', federatedRegistrationOpen: true, version: '1.4.0' },
    spaces,
    ...overrides,
  });
}

describe('parseDocument', () => {
  it('accepts a well-formed document and returns the typed shape', () => {
    expect(parseDocument(document(), ORIGIN)).toEqual({
      ok: true,
      doc: {
        instanceName: 'Kobold Truppe',
        federatedRegistrationOpen: true,
        version: '1.4.0',
        spaces: [{
          id: 'space-1',
          name: 'Kobold Lounge',
          description: 'A place for kobolds.',
          icon: `${ORIGIN}/api/uploads/icon.png`,
          banner: null,
          avatarColor: 'mint',
          visibility: 'public',
          memberCount: 12,
          createdAt: 1758400000000,
        }],
      },
    });
  });

  it('rejects a body that is not JSON or not an object', () => {
    expect(parseDocument('{', ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument('[]', ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument('"x"', ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects schema 2', () => {
    expect(parseDocument(document({ schema: 2 }), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects an origin that differs from the fetched one', () => {
    expect(parseDocument(document({ origin: 'https://other.example.org' }), ORIGIN)).toEqual({ ok: false, reason: 'origin-mismatch' });
  });

  it('canonicalises the document origin before comparing, so a mixed-case DOMAIN passes', () => {
    expect(parseDocument(document({ origin: 'https://Chat.Example.org' }), ORIGIN).ok).toBe(true);
    expect(parseDocument(document({ origin: 'https://Chat.Example.org/' }), ORIGIN).ok).toBe(true);
  });

  it('rejects an origin that does not parse as invalid, not as a mismatch', () => {
    expect(parseDocument(document({ origin: 'not a url' }), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects an origin that is not a string as invalid, not as a mismatch', () => {
    expect(parseDocument(document({ origin: 7 }), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('accepts exactly 200 spaces and rejects 201', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => space({ id: `s${i}` }));
    expect(parseDocument(document({}, many(200)), ORIGIN).ok).toBe(true);
    expect(parseDocument(document({}, many(201)), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a missing or non-array spaces field', () => {
    expect(parseDocument(document({ spaces: undefined }), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({ spaces: {} }), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('bounds the space name at 100 characters', () => {
    expect(parseDocument(document({}, [space({ name: 'a'.repeat(100) })]), ORIGIN).ok).toBe(true);
    expect(parseDocument(document({}, [space({ name: 'a'.repeat(101) })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ name: '' })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ name: null })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('bounds the description at 200 characters and allows null', () => {
    expect(parseDocument(document({}, [space({ description: 'd'.repeat(200) })]), ORIGIN).ok).toBe(true);
    expect(parseDocument(document({}, [space({ description: null })]), ORIGIN).ok).toBe(true);
    expect(parseDocument(document({}, [space({ description: 'd'.repeat(201) })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ description: 5 })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('requires icon and banner to be null or on the expected origin', () => {
    expect(parseDocument(document({}, [space({ icon: 'https://other.example/x.png' })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ banner: 'https://other.example/x.png' })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ icon: 'https://chat.example.org.evil.example/x.png' })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ icon: ORIGIN })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ icon: '/api/uploads/x.png' })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ icon: 'https://chat.example.org:8443/x.png' })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ icon: 'http://chat.example.org/x.png' })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ icon: 'not a url' })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ icon: `${ORIGIN}/` })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ icon: null })]), ORIGIN).ok).toBe(true);
    expect(parseDocument(document({}, [space({ icon: 'https://Chat.Example.org/api/uploads/x.png' })]), ORIGIN)).toMatchObject({
      ok: true,
      doc: { spaces: [{ icon: 'https://Chat.Example.org/api/uploads/x.png' }] },
    });
    expect(parseDocument(document({}, [space({ banner: `${ORIGIN}/api/uploads/b.png` })]), ORIGIN).ok).toBe(true);
  });

  it('requires memberCount to be an integer between 0 and 10^9', () => {
    expect(parseDocument(document({}, [space({ memberCount: 0 })]), ORIGIN).ok).toBe(true);
    expect(parseDocument(document({}, [space({ memberCount: 10 ** 9 })]), ORIGIN).ok).toBe(true);
    expect(parseDocument(document({}, [space({ memberCount: -1 })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ memberCount: 1.5 })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ memberCount: 10 ** 9 + 1 })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ memberCount: '12' })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('requires createdAt to be a non-negative integer', () => {
    expect(parseDocument(document({}, [space({ createdAt: 0 })]), ORIGIN).ok).toBe(true);
    expect(parseDocument(document({}, [space({ createdAt: -1 })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ createdAt: 1.5 })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ createdAt: null })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('accepts public and request visibility and rejects anything else', () => {
    expect(parseDocument(document({}, [space({ visibility: 'request' })]), ORIGIN).ok).toBe(true);
    expect(parseDocument(document({}, [space({ visibility: 'private' })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ visibility: null })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('keeps a known avatarColor and maps anything else to null', () => {
    for (const color of ['mint', 'sky', 'lavender', 'coral', 'rose', 'teal', 'amber']) {
      const result = parseDocument(document({}, [space({ avatarColor: color })]), ORIGIN);
      expect(result.ok && result.doc.spaces[0]?.avatarColor).toBe(color);
    }
    for (const bad of [null, undefined, 'peach', 'MINT', 7, {}]) {
      const result = parseDocument(document({}, [space({ avatarColor: bad })]), ORIGIN);
      expect(result.ok && result.doc.spaces[0]?.avatarColor).toBeNull();
    }
  });

  it('requires id to be a non-empty string', () => {
    expect(parseDocument(document({}, [space({ id: '' })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ id: 3 })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({}, [space({ id: undefined })]), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('bounds instance.version to the version pattern and allows null or absent', () => {
    const instance = (version: unknown) => ({ name: 'n', federatedRegistrationOpen: false, version });
    expect(parseDocument(document({ instance: instance(null) }), ORIGIN)).toMatchObject({ ok: true, doc: { version: null } });
    expect(parseDocument(document({ instance: { name: 'n', federatedRegistrationOpen: false } }), ORIGIN)).toMatchObject({ ok: true, doc: { version: null } });
    expect(parseDocument(document({ instance: instance('1.4.0-rc.1+build') }), ORIGIN)).toMatchObject({ ok: true, doc: { version: '1.4.0-rc.1+build' } });
    expect(parseDocument(document({ instance: instance('a'.repeat(33)) }), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({ instance: instance('1.0 beta') }), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({ instance: instance('') }), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({ instance: instance(7) }), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('bounds instance.name at 100 characters', () => {
    const instance = (name: unknown) => ({ name, federatedRegistrationOpen: false, version: null });
    expect(parseDocument(document({ instance: instance('n'.repeat(100)) }), ORIGIN).ok).toBe(true);
    expect(parseDocument(document({ instance: instance('n'.repeat(101)) }), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({ instance: instance(7) }), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('requires instance.federatedRegistrationOpen to be a boolean', () => {
    expect(parseDocument(document({ instance: { name: 'n', federatedRegistrationOpen: 1, version: null } }), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDocument(document({ instance: null }), ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a body larger than MAX_DOCUMENT_BYTES by encoded size', () => {
    const padding = 'é'.repeat(MAX_DOCUMENT_BYTES / 2);
    const text = document({ padding });
    expect(text.length).toBeLessThan(MAX_DOCUMENT_BYTES);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(MAX_DOCUMENT_BYTES);
    expect(parseDocument(text, ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('ignores unknown top-level and space fields', () => {
    const result = parseDocument(document({ extra: { deep: true } }, [space({ mood: 'sleepy' })]), ORIGIN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.doc)).toEqual(['instanceName', 'federatedRegistrationOpen', 'version', 'spaces']);
    expect(Object.keys(result.doc.spaces[0] ?? {})).toEqual([
      'id', 'name', 'description', 'icon', 'banner', 'avatarColor', 'visibility', 'memberCount', 'createdAt',
    ]);
  });
});

describe('constants', () => {
  it('pins the byte caps from the spec', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(512 * 1024);
    expect(MAX_PING_BYTES).toBe(1024);
  });
});
