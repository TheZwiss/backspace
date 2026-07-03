import { describe, it, expect, vi } from 'vitest';

// Mock federationAuth before importing the module under test
vi.mock('../utils/federationAuth.js', () => ({
  getOurOrigin: () => 'https://nova.ddns.net',
}));

import { verifyAttribution, extractDomain } from './federation.js';

describe('verifyAttribution', () => {
  it('accepts when author home matches source instance (standard S2S)', () => {
    expect(verifyAttribution('orbit.ddns.net', 'https://orbit.ddns.net')).toBe(true);
  });

  it('accepts when author home matches source with bare domain', () => {
    expect(verifyAttribution('nova.ddns.net', 'https://nova.ddns.net')).toBe(true);
  });

  it('rejects when author home matches neither source nor receiver', () => {
    expect(verifyAttribution('evil.net', 'https://orbit.ddns.net')).toBe(false);
  });

  it('accepts homeward relay — author home matches receiving instance', () => {
    // Author from nova (home), source is orbit → relay going HOME → accept
    // getOurOrigin() returns 'https://nova.ddns.net' (mocked above)
    expect(verifyAttribution('nova.ddns.net', 'https://orbit.ddns.net')).toBe(true);
  });

  it('accepts homeward relay with full URL homeInstance', () => {
    expect(verifyAttribution('https://nova.ddns.net', 'https://orbit.ddns.net')).toBe(true);
  });
});

describe('extractDomain', () => {
  it('strips https:// prefix', () => {
    expect(extractDomain('https://nova.ddns.net')).toBe('nova.ddns.net');
  });

  it('returns bare domain unchanged', () => {
    expect(extractDomain('nova.ddns.net')).toBe('nova.ddns.net');
  });

  it('strips http:// prefix and port via URL constructor', () => {
    // URL.hostname strips port — extractDomain returns bare hostname
    expect(extractDomain('http://localhost:3000')).toBe('localhost');
  });
});
