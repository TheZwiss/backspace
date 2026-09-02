import { describe, it, expect } from 'vitest';
import {
  canonicalizeHomeInstance,
  normalizeOriginForCompare,
  stripTrailingSlashes,
} from './federationAuth.js';

/**
 * The implementation these tests replaced. Kept here as a reference oracle:
 *   1. every contract case must produce the same value as the shipping helper,
 *      so the rewrite is provably behaviour-preserving; and
 *   2. the timing test measures it too, so the timing test is a positive
 *      control rather than a bound nothing could ever cross.
 */
function canonicalizeHomeInstanceRegex(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = value.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    return s.replace(/\/+$/, '');
  }
  return `https://${s.replace(/\/+$/, '')}`;
}

/** Every documented case from the `canonicalizeHomeInstance` contract. */
const CONTRACT_CASES: ReadonlyArray<readonly [string, string | null | undefined, string | null]> = [
  ['null', null, null],
  ['undefined', undefined, null],
  ['empty string', '', null],
  ['spaces only', '   ', null],
  ['whitespace only', '\t\n ', null],
  ['bare host', 'nova.ddns.net', 'https://nova.ddns.net'],
  ['bare host with surrounding whitespace', '  nova.ddns.net  ', 'https://nova.ddns.net'],
  ['bare host with one trailing slash', 'nova.ddns.net/', 'https://nova.ddns.net'],
  ['bare host with many trailing slashes', 'nova.ddns.net//////', 'https://nova.ddns.net'],
  ['bare host with port and trailing slashes', 'nova.ddns.net:443//', 'https://nova.ddns.net:443'],
  ['bare host with path and trailing slashes', 'nova.ddns.net/path//', 'https://nova.ddns.net/path'],
  ['https origin', 'https://nova.ddns.net', 'https://nova.ddns.net'],
  ['https origin with one trailing slash', 'https://nova.ddns.net/', 'https://nova.ddns.net'],
  ['https origin with many trailing slashes', 'https://nova.ddns.net/////', 'https://nova.ddns.net'],
  ['https origin with path and trailing slash', 'https://nova.ddns.net/path/', 'https://nova.ddns.net/path'],
  ['mixed-case scheme is preserved verbatim', 'HTTPS://Nova.DDNS.net/', 'HTTPS://Nova.DDNS.net'],
  ['localhost keeps an explicit http scheme', 'http://localhost:3005', 'http://localhost:3005'],
  ['localhost keeps http and drops the trailing slash', 'http://localhost:3005/', 'http://localhost:3005'],
  ['bare localhost defaults to https', 'localhost:3005', 'https://localhost:3005'],
  ['loopback keeps http', 'http://127.0.0.1:8080//', 'http://127.0.0.1:8080'],
  ['mixed-case http scheme is preserved', 'HtTp://x.test/', 'HtTp://x.test'],
  ['lone slash', '/', 'https://'],
  ['slashes only', '///', 'https://'],
  ['bare scheme https', 'https://', 'https:'],
  ['bare scheme http', 'http://', 'http:'],
  ['scheme with an extra slash', 'https:///', 'https:'],
  ['path segments with a trailing slash', 'a/b/c/', 'https://a/b/c'],
];

describe('stripTrailingSlashes', () => {
  it('leaves a string with no trailing slash untouched', () => {
    expect(stripTrailingSlashes('nova.ddns.net')).toBe('nova.ddns.net');
  });

  it('removes a single trailing slash', () => {
    expect(stripTrailingSlashes('nova.ddns.net/')).toBe('nova.ddns.net');
  });

  it('removes a run of trailing slashes', () => {
    expect(stripTrailingSlashes('nova.ddns.net////')).toBe('nova.ddns.net');
  });

  it('keeps interior slashes', () => {
    expect(stripTrailingSlashes('https://nova.ddns.net/a//b//')).toBe('https://nova.ddns.net/a//b');
  });

  it('collapses an all-slash string to empty', () => {
    expect(stripTrailingSlashes('////')).toBe('');
  });

  it('handles the empty string', () => {
    expect(stripTrailingSlashes('')).toBe('');
  });

  it('matches the regex it replaced across a spread of inputs', () => {
    const inputs = [
      '',
      '/',
      '//',
      'a',
      'a/',
      'a//',
      '/a',
      '/a/',
      'https://nova.ddns.net',
      'https://nova.ddns.net///',
      '////a////',
    ];
    for (const input of inputs) {
      expect(stripTrailingSlashes(input)).toBe(input.replace(/\/+$/, ''));
    }
  });
});

describe('canonicalizeHomeInstance', () => {
  for (const [label, input, expected] of CONTRACT_CASES) {
    it(`${label}`, () => {
      expect(canonicalizeHomeInstance(input)).toBe(expected);
    });
  }

  it('produces the same value as the regex implementation for every contract case', () => {
    for (const [label, input] of CONTRACT_CASES) {
      expect(
        canonicalizeHomeInstance(input),
        `mismatch for case: ${label}`,
      ).toBe(canonicalizeHomeInstanceRegex(input));
    }
  });
});

describe('normalizeOriginForCompare trailing slashes', () => {
  it('strips a run of trailing slashes', () => {
    expect(normalizeOriginForCompare('https://nova.ddns.net////')).toBe('nova.ddns.net');
  });

  it('returns null for a slash-only value', () => {
    expect(normalizeOriginForCompare('////')).toBeNull();
  });
});

describe('canonicalizeHomeInstance timing on a long run of slashes', () => {
  // A run of slashes followed by one non-slash character: the regex form has to
  // fail the end-anchored match once per start position, which is quadratic.
  // 40k characters is well inside what a federation peer or an API client can
  // put in a single JSON string field.
  const PATHOLOGICAL = `${'/'.repeat(40_000)}a`;

  const measure = (fn: () => unknown): number => {
    const start = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - start) / 1e6;
  };

  it('completes in well under 100ms', () => {
    // Warm the function up so the measurement is not dominated by first-call JIT.
    canonicalizeHomeInstance('https://nova.ddns.net/');

    const elapsed = measure(() => canonicalizeHomeInstance(PATHOLOGICAL));
    expect(canonicalizeHomeInstance(PATHOLOGICAL)).toBe(`https://${'/'.repeat(40_000)}a`);
    expect(elapsed).toBeLessThan(100);
  });

  it('positive control: the regex implementation blows past that bound', () => {
    // Guards against a vacuous bound above. Measured locally on the same input:
    // regex 2250ms, scan 0.013ms. The assertion is deliberately loose (300ms)
    // so a fast CI runner cannot flake it, while still being ~7x below what the
    // regex form actually costs here.
    canonicalizeHomeInstanceRegex('https://nova.ddns.net/');

    const elapsed = measure(() => canonicalizeHomeInstanceRegex(PATHOLOGICAL));
    expect(elapsed).toBeGreaterThan(300);
  });
});
