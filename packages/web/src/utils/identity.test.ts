import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeOriginToHost,
  homeIdentityOf,
  userKey,
  isIssuedByHome,
  personRequest,
  isFederationGlobeApplicable,
  hostOf,
  userDisplayName,
  ownRowAt,
  isMine,
  selfIdentityOf,
} from './identity';

describe('normalizeOriginToHost', () => {
  it('returns empty for falsy inputs', () => {
    expect(normalizeOriginToHost('')).toBe('');
    expect(normalizeOriginToHost(null)).toBe('');
    expect(normalizeOriginToHost(undefined)).toBe('');
  });

  it('extracts host from full URLs', () => {
    expect(normalizeOriginToHost('https://nova.ddns.net')).toBe('nova.ddns.net');
    expect(normalizeOriginToHost('http://localhost:3000')).toBe('localhost:3000');
    expect(normalizeOriginToHost('https://orbit.ddns.net:8443/path')).toBe('orbit.ddns.net:8443');
  });

  it('returns bare-domain inputs unchanged', () => {
    expect(normalizeOriginToHost('nova.ddns.net')).toBe('nova.ddns.net');
    expect(normalizeOriginToHost('localhost:3000')).toBe('localhost:3000');
  });

  it('returns empty string for malformed URL inputs (defensive)', () => {
    expect(normalizeOriginToHost('https://')).toBe('');
    expect(normalizeOriginToHost('://broken')).toBe('');
  });
});

describe('homeIdentityOf and userKey', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', { value: { host: 'nova.ddns.net' }, writable: true });
  });

  it('names a native row by the host of the instance that issued it', () => {
    expect(homeIdentityOf({ id: '42' }, '')).toEqual({ host: 'nova.ddns.net', userId: '42' });
    expect(homeIdentityOf({ id: '42', homeInstance: null }, 'https://orbit.ddns.net')).toEqual({ host: 'orbit.ddns.net', userId: '42' });
  });

  it('names a replicated row by the home identity it carries, whoever issued it', () => {
    const row = { id: 'local', homeUserId: 'frank', homeInstance: 'nova.ddns.net' };
    expect(homeIdentityOf(row, 'https://orbit.ddns.net')).toEqual({ host: 'nova.ddns.net', userId: 'frank' });
  });

  it('keeps natives of two instances apart even when their ids are equal (#353)', () => {
    expect(userKey({ id: '42' }, '')).not.toBe(userKey({ id: '42' }, 'https://orbit.ddns.net'));
  });

  it("keys a page-native user's own row and another instance's copy of them alike", () => {
    const own = userKey({ id: 'frank' }, '');
    const copyOnOrbit = userKey({ id: 'orbit-row', homeUserId: 'frank', homeInstance: 'nova.ddns.net' }, 'https://orbit.ddns.net');
    expect(own).toBe(copyOnOrbit);
  });

  it("keys a remote native's own row and the page's copy of them alike", () => {
    const own = userKey({ id: 'bob' }, 'https://orbit.ddns.net');
    const copyHere = userKey({ id: 'nova-row', homeUserId: 'bob', homeInstance: 'orbit.ddns.net' }, '');
    expect(own).toBe(copyHere);
  });

  it('compares hosts through homeHostOf (scheme, case and port)', () => {
    expect(userKey({ id: 'a', homeUserId: 'x', homeInstance: 'Orbit.ddns.net:443' }, ''))
      .toBe(userKey({ id: 'x' }, 'https://orbit.ddns.net'));
  });

  it("keys a home on a non-default port alike with the copy the server stores of its user", () => {
    // The server stores a replicated row's homeInstance as the bare hostname
    // (extractDomain), so the copy of a user of nova:8443 names no port.
    const own = userKey({ id: 'bob' }, 'https://nova.ddns.net:8443');
    const copyOnOrbit = userKey({ id: 'orbit-row', homeUserId: 'bob', homeInstance: 'nova.ddns.net' }, 'https://orbit.ddns.net');
    expect(own).toBe(copyOnOrbit);
  });

  it('gives two instances on one hostname one identity host, as the server does', () => {
    expect(userKey({ id: '42' }, 'http://localhost:3005')).toBe(userKey({ id: '42' }, 'http://localhost:3006'));
  });

  it('gives a legacy stub without homeUserId a key no other row shares', () => {
    const stub = { id: '42', homeUserId: null, homeInstance: 'orbit.ddns.net' };
    expect(homeIdentityOf(stub, '')).toBeNull();
    expect(userKey(stub, '')).toBe('~nova.ddns.net:42');
    expect(userKey(stub, '')).not.toBe(userKey({ id: '42' }, ''));
    expect(userKey(stub, '')).not.toBe(userKey({ id: '42' }, 'https://orbit.ddns.net'));
  });
});

describe('isIssuedByHome', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', { value: { host: 'nova.ddns.net' }, writable: true });
  });

  it('is true for a native row from any instance', () => {
    expect(isIssuedByHome({ id: 'a' }, '')).toBe(true);
    expect(isIssuedByHome({ id: 'a' }, 'https://orbit.ddns.net')).toBe(true);
  });

  it('is true when the issuing instance is the home the row names', () => {
    expect(isIssuedByHome({ id: 'a', homeUserId: 'x', homeInstance: 'nova.ddns.net' }, '')).toBe(true);
    expect(isIssuedByHome({ id: 'a', homeUserId: 'x', homeInstance: 'orbit.ddns.net' }, 'https://orbit.ddns.net')).toBe(true);
  });

  it("is false for another instance's copy of the person", () => {
    expect(isIssuedByHome({ id: 'a', homeUserId: 'x', homeInstance: 'nova.ddns.net' }, 'https://orbit.ddns.net')).toBe(false);
    expect(isIssuedByHome({ id: 'a', homeUserId: 'x', homeInstance: 'orbit.ddns.net' }, '')).toBe(false);
  });

  it('is false for a legacy stub', () => {
    expect(isIssuedByHome({ id: 'a', homeInstance: 'orbit.ddns.net' }, 'https://orbit.ddns.net')).toBe(false);
  });
});

describe('personRequest', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', { value: { host: 'nova.ddns.net' }, writable: true });
  });

  it("names a page-native user by their id on the page's instance", () => {
    expect(personRequest({ id: 'a' }, '')).toEqual({ origin: '', target: { userId: 'a' } });
  });

  it("names a remote instance's native user by their identity there, never by their remote id alone", () => {
    expect(personRequest({ id: 'bob' }, 'https://orbit.ddns.net'))
      .toEqual({ origin: '', target: { homeUserId: 'bob', homeInstance: 'orbit.ddns.net' } });
  });

  it('names a replicated row by the home identity it carries', () => {
    expect(personRequest({ id: 'r', homeUserId: 'bob', homeInstance: 'orbit.ddns.net' }, 'https://third.example'))
      .toEqual({ origin: '', target: { homeUserId: 'bob', homeInstance: 'orbit.ddns.net' } });
  });

  it('asks about a legacy stub on the instance that issued it, by its id there', () => {
    expect(personRequest({ id: 'r', homeInstance: 'orbit.ddns.net' }, '')).toEqual({ origin: '', target: { userId: 'r' } });
    expect(personRequest({ id: 'r', homeInstance: 'x.example' }, 'https://orbit.ddns.net'))
      .toEqual({ origin: 'https://orbit.ddns.net', target: { userId: 'r' } });
  });

  describe('to another connected instance', () => {
    const ORBIT = 'https://orbit.ddns.net';

    it('names that instance\'s own native user by their id there', () => {
      expect(personRequest({ id: 'bob' }, ORBIT, ORBIT)).toEqual({ origin: ORBIT, target: { userId: 'bob' } });
    });

    it('names a page-native user by their identity at the page\'s host, never by the page\'s id alone', () => {
      expect(personRequest({ id: 'a' }, '', ORBIT))
        .toEqual({ origin: ORBIT, target: { homeUserId: 'a', homeInstance: 'nova.ddns.net' } });
    });

    it('names a replicated row that instance issued by the home identity it carries', () => {
      expect(personRequest({ id: 'r', homeUserId: 'a', homeInstance: 'nova.ddns.net' }, ORBIT, ORBIT))
        .toEqual({ origin: ORBIT, target: { homeUserId: 'a', homeInstance: 'nova.ddns.net' } });
    });

    it('cannot name a legacy stub another instance issued: the origin it returns is not the one asked', () => {
      expect(personRequest({ id: 'r', homeInstance: 'x.example' }, '', ORBIT))
        .toEqual({ origin: '', target: { userId: 'r' } });
    });
  });
});

describe('isFederationGlobeApplicable', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      value: { host: 'nova.ddns.net' },
      writable: true,
    });
  });

  it('returns false for purely-local users (no @domain in username)', () => {
    expect(isFederationGlobeApplicable({ username: 'frank' })).toBe(false);
    expect(isFederationGlobeApplicable({ username: 'erin' })).toBe(false);
  });

  it('returns false when the username domain matches our own host (the load-bearing case)', () => {
    // Logged in to nova; viewing orbit-stub of Frank whose username is "frank@nova.ddns.net".
    expect(isFederationGlobeApplicable({ username: 'frank@nova.ddns.net' })).toBe(false);
  });

  it('returns true for genuinely remote users', () => {
    expect(isFederationGlobeApplicable({ username: 'heidi@orbit.ddns.net' })).toBe(true);
  });
});

describe('hostOf', () => {
  it('returns the host of an origin, and the input itself when it does not parse', () => {
    expect(hostOf('https://chat.example.org')).toBe('chat.example.org');
    expect(hostOf('https://chat.example.org:8443/path')).toBe('chat.example.org:8443');
    expect(hostOf('not an origin')).toBe('not an origin');
  });
});

describe('userDisplayName', () => {
  it('is the display name when there is one', () => {
    expect(userDisplayName({ displayName: 'Kai', username: 'kai@orbit.example' })).toBe('Kai');
  });

  it('is the base of the username without a display name, never the instance part', () => {
    expect(userDisplayName({ displayName: null, username: 'kai@orbit.example' })).toBe('kai');
    expect(userDisplayName({ displayName: null, username: 'kai' })).toBe('kai');
  });

  it('treats an empty display name as none', () => {
    expect(userDisplayName({ displayName: '', username: 'kai@orbit.example' })).toBe('kai');
  });
});

describe('ownRowAt', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', { value: { host: 'nova.ddns.net' }, writable: true });
  });

  const ORBIT = 'https://orbit.ddns.net';

  it("makes a nova-native session's row on orbit orbit's copy of them", () => {
    const session = { id: 'n-1', homeInstance: null, homeUserId: null };
    const row = ownRowAt(session, ORBIT, 'o-7');
    expect(row).toEqual({ id: 'o-7', homeInstance: 'nova.ddns.net', homeUserId: 'n-1' });
    expect(userKey(row, ORBIT)).toBe(userKey(session, ''));
    expect(isMine(row, ORBIT, selfIdentityOf(session, new Map([[ORBIT, 'o-7']])))).toBe(true);
  });

  it("is never orbit's own user who has the session row's id", () => {
    const session = { id: 'n-1', homeInstance: null, homeUserId: null };
    expect(userKey(ownRowAt(session, ORBIT, 'o-7'), ORBIT)).not.toBe(userKey({ id: 'n-1' }, ORBIT));
  });

  it('makes a replicated session\'s row on its true home that home\'s native row', () => {
    const session = { id: 'n-5', homeInstance: 'orbit.ddns.net', homeUserId: 'o-7' };
    const row = ownRowAt(session, ORBIT, 'o-7');
    expect(row).toEqual({ id: 'o-7', homeInstance: null, homeUserId: null });
    expect(userKey(row, ORBIT)).toBe(userKey(session, ''));
  });

  it('keeps the home identity of a replicated session on a third instance', () => {
    const session = { id: 'n-5', homeInstance: 'orbit.ddns.net', homeUserId: 'o-7' };
    const row = ownRowAt(session, 'https://vega.ddns.net', 'v-3');
    expect(row).toEqual({ id: 'v-3', homeInstance: 'orbit.ddns.net', homeUserId: 'o-7' });
  });

  it("is the session row's identity on the page's own instance", () => {
    const session = { id: 'n-1', homeInstance: null, homeUserId: null };
    expect(ownRowAt(session, '', 'n-1')).toEqual(session);
  });
});
