import { describe, it, expect } from 'vitest';
import { classifyAddress, isPublicAddress, type AddressClass } from './ipClass.js';

// Each row is [address, expected class, why it matters]. The third column is
// not decoration: it is what tells a future reader whether deleting a row is
// safe. Rows marked (regression) were returning 'public' before this change.
const CASES: Array<[string, AddressClass, string]> = [
  // --- IPv4 ---
  ['127.0.0.1', 'loopback', 'the obvious one'],
  ['127.255.255.254', 'loopback', 'whole /8, not just 127.0.0.x'],
  ['0.0.0.0', 'unspecified', 'binds to every interface'],
  ['0.1.2.3', 'reserved', '0.0.0.0/8 this-network'],
  ['10.0.0.1', 'private', 'RFC1918'],
  ['172.15.255.255', 'public', 'just below the /12: must NOT be caught'],
  ['172.16.0.1', 'private', 'RFC1918 lower bound'],
  ['172.31.255.255', 'private', 'RFC1918 upper bound'],
  ['172.32.0.1', 'public', 'just above the /12: must NOT be caught'],
  ['192.168.1.1', 'private', 'RFC1918'],
  ['169.254.169.254', 'link-local', 'cloud instance metadata'],
  ['100.64.0.1', 'cgnat', '(regression) RFC6598'],
  ['100.127.255.255', 'cgnat', '(regression) /10 upper bound'],
  ['100.128.0.1', 'public', 'just above the /10: must NOT be caught'],
  ['224.0.0.1', 'multicast', 'RFC5771'],
  ['255.255.255.255', 'reserved', 'broadcast'],
  ['8.8.8.8', 'public', 'the control: a real public address'],

  // --- IPv6 ---
  ['::1', 'loopback', 'the obvious one'],
  ['::', 'unspecified', '(regression) connects to loopback on most stacks'],
  ['fc00::1', 'private', 'unique local'],
  ['fd12:3456::1', 'private', 'unique local'],
  ['fe80::1', 'link-local', 'was caught only by the literal prefix'],
  ['fe9a::1', 'link-local', '(regression) fe80::/10 is fe80-febf, not "fe80"'],
  ['febf:ffff::1', 'link-local', '(regression) /10 upper bound'],
  ['fec0::1', 'public', 'just above the /10: must NOT be caught'],
  ['ff02::1', 'multicast', 'all-nodes'],
  ['2606:4700::1111', 'public', 'the control: a real public address'],

  // --- IPv4-mapped IPv6: both spellings, because both occur ---
  ['::ffff:7f00:1', 'loopback', '(regression) hex form, what the URL parser emits'],
  ['::ffff:127.0.0.1', 'loopback', '(regression) dotted form, what inet_ntop emits'],
  ['::ffff:a00:1', 'private', '(regression) 10.0.0.1 mapped, hex'],
  ['::ffff:10.0.0.1', 'private', '(regression) 10.0.0.1 mapped, dotted'],
  ['::ffff:a9fe:a9fe', 'link-local', '(regression) 169.254.169.254 mapped'],
  ['::ffff:808:808', 'public', 'a mapped PUBLIC address must stay public'],

  // --- garbage ---
  ['', 'reserved', 'empty string must not fall through to public'],
  ['not-an-ip', 'reserved', 'unparseable must not fall through to public'],
  ['999.1.1.1', 'reserved', 'out-of-range octet must not fall through to public'],
];

describe('classifyAddress', () => {
  for (const [addr, expected, why] of CASES) {
    it(`${addr || '(empty)'} -> ${expected} (${why})`, () => {
      expect(classifyAddress(addr)).toBe(expected);
    });
  }
});

describe('isPublicAddress', () => {
  it('is true only for the public rows', () => {
    for (const [addr, expected] of CASES) {
      expect(isPublicAddress(addr), addr).toBe(expected === 'public');
    }
  });

  it('fails closed on anything it cannot parse', () => {
    expect(isPublicAddress('::ffff:')).toBe(false);
    expect(isPublicAddress('1.2.3')).toBe(false);
    expect(isPublicAddress('0x7f000001')).toBe(false);
  });
});
