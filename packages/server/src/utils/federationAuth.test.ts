import { describe, it, expect } from 'vitest';
import { verifyPeerSignature, signRequest, ROTATION_GRACE_PERIOD_MS, normalizeOriginForCompare } from './federationAuth.js';

describe('verifyPeerSignature', () => {
  const primarySecret = 'a'.repeat(64);
  const pendingSecret = 'b'.repeat(64);
  const body = '{"test":"data"}';
  const nonce = 'test-nonce-uuid';

  function makePeer(overrides: Partial<{
    hmacSecret: string;
    pendingHmacSecret: string | null;
    secretRotationAt: number | null;
  }> = {}) {
    return {
      hmacSecret: primarySecret,
      pendingHmacSecret: null,
      secretRotationAt: null,
      ...overrides,
    };
  }

  it('accepts signature signed with primary secret', () => {
    const timestamp = Date.now();
    const sig = signRequest(body, primarySecret, timestamp, nonce);
    expect(verifyPeerSignature(body, sig, timestamp, nonce, makePeer())).toBe(true);
  });

  it('rejects invalid signature with no pending secret', () => {
    const timestamp = Date.now();
    const sig = signRequest(body, 'wrong-secret', timestamp, nonce);
    expect(verifyPeerSignature(body, sig, timestamp, nonce, makePeer())).toBe(false);
  });

  it('accepts signature signed with pending secret during grace period', () => {
    const timestamp = Date.now();
    const sig = signRequest(body, pendingSecret, timestamp, nonce);
    const peer = makePeer({
      pendingHmacSecret: pendingSecret,
      secretRotationAt: Date.now() - 1000,
    });
    expect(verifyPeerSignature(body, sig, timestamp, nonce, peer)).toBe(true);
  });

  it('rejects pending secret after grace period expires', () => {
    const timestamp = Date.now();
    const sig = signRequest(body, pendingSecret, timestamp, nonce);
    const peer = makePeer({
      pendingHmacSecret: pendingSecret,
      secretRotationAt: Date.now() - ROTATION_GRACE_PERIOD_MS - 1000,
    });
    expect(verifyPeerSignature(body, sig, timestamp, nonce, peer)).toBe(false);
  });

  it('still accepts primary secret during grace period', () => {
    const timestamp = Date.now();
    const sig = signRequest(body, primarySecret, timestamp, nonce);
    const peer = makePeer({
      pendingHmacSecret: pendingSecret,
      secretRotationAt: Date.now() - 1000,
    });
    expect(verifyPeerSignature(body, sig, timestamp, nonce, peer)).toBe(true);
  });

  it('handles null nonce (legacy peers)', () => {
    const timestamp = Date.now();
    const sig = signRequest(body, primarySecret, timestamp, null);
    expect(verifyPeerSignature(body, sig, timestamp, null, makePeer())).toBe(true);
  });

  it('does not try pending secret when secretRotationAt is null', () => {
    const timestamp = Date.now();
    const sig = signRequest(body, pendingSecret, timestamp, nonce);
    const peer = makePeer({
      pendingHmacSecret: pendingSecret,
      secretRotationAt: null,
    });
    expect(verifyPeerSignature(body, sig, timestamp, nonce, peer)).toBe(false);
  });
});

describe('normalizeOriginForCompare', () => {
  it('canonicalizes a bare host', () => {
    expect(normalizeOriginForCompare('nova.ddns.net')).toBe('nova.ddns.net');
  });
  it('strips https:// scheme', () => {
    expect(normalizeOriginForCompare('https://nova.ddns.net')).toBe('nova.ddns.net');
  });
  it('strips http:// scheme', () => {
    expect(normalizeOriginForCompare('http://localhost:3005')).toBe('localhost:3005');
  });
  it('strips trailing slash', () => {
    expect(normalizeOriginForCompare('https://nova.ddns.net/')).toBe('nova.ddns.net');
  });
  it('lowercases the host', () => {
    expect(normalizeOriginForCompare('HTTPS://Nova.DDNS.net')).toBe('nova.ddns.net');
  });
  it('returns null for null input', () => {
    expect(normalizeOriginForCompare(null)).toBeNull();
  });
  it('returns null for undefined input', () => {
    expect(normalizeOriginForCompare(undefined)).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(normalizeOriginForCompare('')).toBeNull();
  });
  it('treats bare and full-URL forms as equal', () => {
    expect(normalizeOriginForCompare('nova.ddns.net'))
      .toBe(normalizeOriginForCompare('https://nova.ddns.net'));
  });
});
