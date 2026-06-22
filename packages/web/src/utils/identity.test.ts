import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeOriginToHost,
  canonicalUserKey,
  isDeliveryFromHome,
  isFederationGlobeApplicable,
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

describe('canonicalUserKey', () => {
  it('keys purely-local users by id only (empty host segment)', () => {
    expect(canonicalUserKey({ id: '123' })).toBe(':123');
    expect(canonicalUserKey({ id: '123', homeUserId: null, homeInstance: null })).toBe(':123');
  });

  it('keys federated users by their home host + homeUserId', () => {
    expect(canonicalUserKey({
      id: '999', // local id on the receiving instance (irrelevant)
      homeUserId: '291641217365663744',
      homeInstance: 'nova.ddns.net',
    })).toBe('nova.ddns.net:291641217365663744');
  });

  it('produces the same key for stubs of the same person across instances', () => {
    const fromOrbit = canonicalUserKey({
      id: 'orbitLocalId',
      homeUserId: 'nova-frank',
      homeInstance: 'nova.ddns.net',
    });
    const fromAnotherPeer = canonicalUserKey({
      id: 'otherPeerLocalId',
      homeUserId: 'nova-frank',
      homeInstance: 'nova.ddns.net',
    });
    expect(fromOrbit).toBe(fromAnotherPeer);
  });

  it('falls back to local id when homeInstance is set but homeUserId is missing', () => {
    expect(canonicalUserKey({
      id: 'localId',
      homeInstance: 'nova.ddns.net',
      homeUserId: null,
    })).toBe('nova.ddns.net:localId');
  });

  it('local users do not collide with federated keys', () => {
    const local = canonicalUserKey({ id: '291641217365663744' });
    const federated = canonicalUserKey({
      id: '999',
      homeUserId: '291641217365663744',
      homeInstance: 'nova.ddns.net',
    });
    expect(local).not.toBe(federated);
  });
});

describe('isDeliveryFromHome', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      value: { host: 'nova.ddns.net' },
      writable: true,
    });
  });

  it('treats native users delivered by our home connection as home view', () => {
    expect(isDeliveryFromHome({ homeInstance: null }, '')).toBe(true);
    expect(isDeliveryFromHome({ homeInstance: undefined }, '')).toBe(true);
  });

  it('treats native users delivered by a remote connection as home view of that remote', () => {
    expect(isDeliveryFromHome({ homeInstance: null }, 'https://orbit.ddns.net')).toBe(true);
  });

  it('marks federated user as home view when delivering origin is their home', () => {
    expect(isDeliveryFromHome(
      { homeInstance: 'nova.ddns.net' },
      'https://nova.ddns.net',
    )).toBe(true);
  });

  it('marks federated user as home view when our home connection (origin "") IS their home', () => {
    // We are at nova; user.homeInstance is nova; delivery from origin '' means our home.
    expect(isDeliveryFromHome(
      { homeInstance: 'nova.ddns.net' },
      '',
    )).toBe(true);
  });

  it('rejects sibling-stub deliveries (orbit delivering Frank whose home is nova)', () => {
    expect(isDeliveryFromHome(
      { homeInstance: 'nova.ddns.net' },
      'https://orbit.ddns.net',
    )).toBe(false);
  });

  it('rejects our-home delivery of a user whose home is a different instance', () => {
    // We are at nova; user.homeInstance is orbit; delivery from '' (our home).
    expect(isDeliveryFromHome(
      { homeInstance: 'orbit.ddns.net' },
      '',
    )).toBe(false);
  });

  it('handles bare-domain homeInstance against full-URL delivering origin', () => {
    expect(isDeliveryFromHome(
      { homeInstance: 'orbit.ddns.net' },
      'https://orbit.ddns.net',
    )).toBe(true);
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
