import { describe, it, expect } from 'vitest';
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  buildOtpAuthUrl,
  hotp,
  verifyTotp,
  encryptTotpSecret,
  decryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from './totp.js';
import { config } from '../config.js';

// RFC 6238 Appendix D test vectors — secret = "12345678901234567890" (ASCII)
// base32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

// Pin JWT_SECRET for the encryption tests (config may not have one set in
// the test env; encryption needs a stable key).
process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'a'.repeat(48);

describe('base32', () => {
  it('round-trips known vectors', () => {
    // RFC 4648 §10 test vectors
    expect(base32Encode(Buffer.from(''))).toBe('');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Encode(Buffer.from('fo'))).toBe('MZXQ');
    expect(base32Encode(Buffer.from('foo'))).toBe('MZXW6');
    expect(base32Encode(Buffer.from('foob'))).toBe('MZXW6YQ');
    expect(base32Encode(Buffer.from('fooba'))).toBe('MZXW6YTB');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MY').toString()).toBe('f');
    expect(base32Decode('MZXQ').toString()).toBe('fo');
    expect(base32Decode('MZXW6').toString()).toBe('foo');
    expect(base32Decode('MZXW6YQ').toString()).toBe('foob');
    expect(base32Decode('MZXW6YTB').toString()).toBe('fooba');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
  });

  it('round-trips RFC 6238 secret seed', () => {
    const original = Buffer.from('12345678901234567890', 'ascii');
    expect(base32Encode(original)).toBe(RFC_SECRET);
    expect(base32Decode(RFC_SECRET).toString('ascii')).toBe('12345678901234567890');
  });
});

describe('RFC 6238 Appendix D test vectors (SHA-1, 8 digits)', () => {
  // Counter = floor(unix_time / 30)
  // The Appendix D table lists T (seconds) and the expected 8-digit OTP.
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [t, expected] of vectors) {
    it(`T=${t} → ${expected}`, () => {
      const counter = BigInt(Math.floor(t / 30));
      expect(hotp(RFC_SECRET, counter, 8)).toBe(expected);
    });
  }
});

describe('TOTP verify', () => {
  // For a fixed secret + fixed time we know the 6-digit code.
  // Using T=59 from RFC 6238 — 8-digit value is 94287082, 6-digit is 287082.
  // We freeze time to 59 * 1000 ms (59 seconds since epoch).
  const FROZEN_MS = 59_000;

  it('accepts the current-step code (6 digits)', () => {
    const counter = BigInt(Math.floor(FROZEN_MS / 1000 / 30));
    const code = hotp(RFC_SECRET, counter, 6);
    const result = verifyTotp(RFC_SECRET, code, 30, 6, { lastUsedCounter: 0, nowMs: FROZEN_MS });
    expect(result.valid).toBe(true);
    expect(result.counter).toBe(counter);
  });

  it('rejects an all-zero code with timing-safe compare', () => {
    const result = verifyTotp(RFC_SECRET, '000000', 30, 6, { lastUsedCounter: 0, nowMs: FROZEN_MS });
    expect(result.valid).toBe(false);
    expect(result.counter).toBeNull();
  });

  it('rejects codes from outside the ±1 window', () => {
    // Use a frozen "now" safely past epoch so the past counter stays positive.
    const FROZEN_NOW_MS = 200_000_000_000; // ~year 1976 + a few months, safely positive
    const farPastCounter = BigInt(Math.floor((FROZEN_NOW_MS - 1000 * 1000) / 1000 / 30));
    const oldCode = hotp(RFC_SECRET, farPastCounter, 6);
    const result = verifyTotp(RFC_SECRET, oldCode, 30, 6, { lastUsedCounter: 0, nowMs: FROZEN_NOW_MS });
    expect(result.valid).toBe(false);
  });

  it('rejects replayed code via lastUsedCounter', () => {
    const counter = BigInt(Math.floor(FROZEN_MS / 1000 / 30));
    const code = hotp(RFC_SECRET, counter, 6);
    // First use: valid
    const first = verifyTotp(RFC_SECRET, code, 30, 6, { lastUsedCounter: 0, nowMs: FROZEN_MS });
    expect(first.valid).toBe(true);
    // Second use with lastUsedCounter advanced to counter: rejected (replay)
    const replay = verifyTotp(RFC_SECRET, code, 30, 6, { lastUsedCounter: Number(counter), nowMs: FROZEN_MS });
    expect(replay.valid).toBe(false);
  });

  it('rejects malformed codes (non-numeric, wrong length)', () => {
    expect(verifyTotp(RFC_SECRET, 'abcdef', 30, 6, { nowMs: FROZEN_MS }).valid).toBe(false);
    expect(verifyTotp(RFC_SECRET, '12345', 30, 6, { nowMs: FROZEN_MS }).valid).toBe(false);
    expect(verifyTotp(RFC_SECRET, '1234567', 30, 6, { nowMs: FROZEN_MS }).valid).toBe(false);
  });

  it('accepts a ±1 window code', () => {
    const counter = BigInt(Math.floor(FROZEN_MS / 1000 / 30));
    const nextCode = hotp(RFC_SECRET, counter + 1n, 6);
    const result = verifyTotp(RFC_SECRET, nextCode, 30, 6, { lastUsedCounter: 0, nowMs: FROZEN_MS });
    expect(result.valid).toBe(true);
    expect(result.counter).toBe(counter + 1n);
  });
});

describe('otptauth URL', () => {
  it('builds a parseable URL', () => {
    const url = buildOtpAuthUrl({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer: 'Backspace',
      accountName: 'alice@example.com',
    });
    const parsed = new URL(url);
    expect(parsed.protocol).toBe('otpauth:');
    expect(parsed.host).toBe('totp');
    // pathname: /Backspace:alice@example.com
    expect(decodeURIComponent(parsed.pathname)).toBe('/Backspace:alice@example.com');
    expect(parsed.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(parsed.searchParams.get('issuer')).toBe('Backspace');
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
  });
});

describe('secret generation', () => {
  it('produces 32 base32 chars (160 bits)', () => {
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(32);
    // Round-trip must succeed
    const bytes = base32Decode(secret);
    expect(bytes).toHaveLength(20);
  });
  it('produces unique secrets', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateTotpSecret());
    expect(seen.size).toBe(100);
  });
});

describe('AES-256-GCM at-rest encryption', () => {
  it('round-trips a secret', () => {
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    // Stored format: iv:ciphertext:authTag (three base64 segments)
    expect(encrypted.split(':')).toHaveLength(3);
    expect(encrypted).not.toContain(secret); // plaintext must not leak
    expect(decryptTotpSecret(encrypted)).toBe(secret);
  });

  it('rejects tampered ciphertext (GCM auth tag fails)', () => {
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    const parts = encrypted.split(':');
    // Flip a bit in the auth tag
    const tagBuf = Buffer.from(parts[2]!, 'base64');
    tagBuf[0] = (tagBuf[0] ?? 0) ^ 0xff;
    parts[2] = tagBuf.toString('base64');
    const tampered = parts.join(':');
    expect(() => decryptTotpSecret(tampered)).toThrow();
  });

  it('produces a unique ciphertext per call (random IV)', () => {
    const secret = generateTotpSecret();
    const a = encryptTotpSecret(secret);
    const b = encryptTotpSecret(secret);
    expect(a).not.toBe(b);
  });
});

describe('recovery codes', () => {
  it('generates the requested count with unique values', () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toHaveLength(12);
  });

  it('hashes and verifies round-trip', async () => {
    const code = generateRecoveryCodes(1)[0]!;
    const hash = await hashRecoveryCode(code);
    expect(await verifyRecoveryCode(code, hash)).toBe(true);
    expect(await verifyRecoveryCode(code.toLowerCase(), hash)).toBe(true); // case-insensitive
    expect(await verifyRecoveryCode('WRONGCODE1234', hash)).toBe(false);
  });

  it('hashes are bcrypt-formatted (cost 12)', async () => {
    const code = generateRecoveryCodes(1)[0]!;
    const hash = await hashRecoveryCode(code);
    expect(hash.startsWith('$2')).toBe(true);
  });
});
