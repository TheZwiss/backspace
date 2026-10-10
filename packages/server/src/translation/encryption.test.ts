import { describe, expect, it } from 'vitest';
import { TranslationEncryption } from './encryption.js';

const KEY = 'ab'.repeat(32); // Test-only key, never an application default.
describe('translation encryption', () => {
  it('uses fresh authenticated ciphertext for every write', () => {
    const encryption = new TranslationEncryption(KEY);
    const first = encryption.encrypt('secret', 'settings:alice');
    const second = encryption.encrypt('secret', 'settings:alice');
    expect(first.equals(second)).toBe(false);
    expect(first.includes('secret')).toBe(false);
    expect(encryption.decrypt(first, 'settings:alice')).toBe('secret');
  });
  it.each(['', 'short', 'zz'.repeat(32), 'ab'.repeat(31), KEY + ' '])('rejects malformed keys without echoing them', key => {
    expect(() => new TranslationEncryption(key)).toThrow('must contain exactly 64 hexadecimal characters');
  });
  it('rejects wrong keys, owners, purposes and tampered data', () => {
    const encryption = new TranslationEncryption(KEY);
    const cipher = encryption.encrypt('secret', 'settings:alice');
    expect(() => new TranslationEncryption('cd'.repeat(32)).decrypt(cipher, 'settings:alice')).toThrow();
    expect(() => encryption.decrypt(cipher, 'settings:bob')).toThrow();
    expect(() => encryption.decrypt(cipher, 'result:alice')).toThrow();
    const damaged = Buffer.from(cipher);
    damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
    expect(() => encryption.decrypt(damaged, 'settings:alice')).toThrow();
    expect(() => encryption.decrypt(cipher.subarray(0, 10), 'settings:alice')).toThrow();
    cipher[0] = 9;
    expect(() => encryption.decrypt(cipher, 'settings:alice')).toThrow();
  });
});
