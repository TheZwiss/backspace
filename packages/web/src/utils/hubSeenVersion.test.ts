import { describe, it, expect } from 'vitest';
import { hubSeenVersionKey, readHubSeenVersion, writeHubSeenVersion } from './hubSeenVersion';

/** In-memory Storage stand-in. `throwing` simulates private-mode denial. */
function makeStorage(seed: Record<string, string> = {}, throwing = false) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => {
      if (throwing) throw new Error('denied');
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throwing) throw new Error('denied');
      map.set(k, v);
    },
    dump: () => Object.fromEntries(map),
  };
}

describe('hubSeenVersionKey', () => {
  it('scopes the key to the user id', () => {
    expect(hubSeenVersionKey('u1')).toBe('backspace_hub_seen_version_u1');
  });
});

describe('readHubSeenVersion', () => {
  it('returns null when nothing is stored', () => {
    expect(readHubSeenVersion(makeStorage(), 'u1')).toBeNull();
  });

  it('returns null for a null user id without touching storage', () => {
    expect(readHubSeenVersion(makeStorage({}, true), null)).toBeNull();
  });

  it('reads back what was written', () => {
    const storage = makeStorage();
    writeHubSeenVersion(storage, 'u1', '1.5.1');
    expect(readHubSeenVersion(storage, 'u1')).toBe('1.5.1');
  });

  it('returns null for corrupt JSON rather than throwing', () => {
    const storage = makeStorage({ backspace_hub_seen_version_u1: '{not json' });
    expect(readHubSeenVersion(storage, 'u1')).toBeNull();
  });

  it.each([
    ['a number', JSON.stringify({ seenVersion: 7 })],
    ['an empty string', JSON.stringify({ seenVersion: '' })],
    ['a missing field', JSON.stringify({})],
    ['a bare string', JSON.stringify('1.5.1')],
    ['null', 'null'],
  ])('returns null for a record holding %s', (_label, raw) => {
    const storage = makeStorage({ backspace_hub_seen_version_u1: raw });
    expect(readHubSeenVersion(storage, 'u1')).toBeNull();
  });

  it('returns null when storage access throws', () => {
    expect(readHubSeenVersion(makeStorage({}, true), 'u1')).toBeNull();
  });

  it('keeps two users apart', () => {
    const storage = makeStorage();
    writeHubSeenVersion(storage, 'alice', '1.5.0');
    writeHubSeenVersion(storage, 'bob', '1.5.1');
    expect(readHubSeenVersion(storage, 'alice')).toBe('1.5.0');
    expect(readHubSeenVersion(storage, 'bob')).toBe('1.5.1');
  });

  it('does not let one user read another user\'s value', () => {
    const storage = makeStorage();
    writeHubSeenVersion(storage, 'alice', '1.5.1');
    expect(readHubSeenVersion(storage, 'bob')).toBeNull();
  });
});

describe('writeHubSeenVersion', () => {
  it('persists under the scoped key', () => {
    const storage = makeStorage();
    writeHubSeenVersion(storage, 'u1', '1.5.1');
    expect(Object.keys(storage.dump())).toEqual(['backspace_hub_seen_version_u1']);
  });

  it('writes nothing for a null user id', () => {
    const storage = makeStorage();
    writeHubSeenVersion(storage, null, '1.5.1');
    expect(storage.dump()).toEqual({});
  });

  it('swallows a storage denial', () => {
    expect(() => writeHubSeenVersion(makeStorage({}, true), 'u1', '1.5.1')).not.toThrow();
  });
});
