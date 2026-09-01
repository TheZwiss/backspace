import { describe, it, expect } from 'vitest';
import { GitHubError } from './github.ts';
import {
  requiredEnv,
  assertHeaderSafeToken,
  deriveRunTimestamps,
  formatCollectSummary,
  formatBackfillSummary,
  describeFailure,
} from './cli-support.ts';

describe('requiredEnv', () => {
  it('returns the value when present', () => {
    expect(requiredEnv({ FOO: 'bar' }, 'FOO')).toBe('bar');
  });

  it('trims surrounding whitespace, e.g. a trailing newline from a prior CI step', () => {
    expect(requiredEnv({ FOO: '  bar\n' }, 'FOO')).toBe('bar');
  });

  it('throws when the variable is absent', () => {
    expect(() => requiredEnv({}, 'FOO')).toThrow('Missing required environment variable FOO');
  });

  it('throws when the variable is the empty string', () => {
    expect(() => requiredEnv({ FOO: '' }, 'FOO')).toThrow(/FOO/);
  });

  it('throws when the variable is whitespace-only', () => {
    expect(() => requiredEnv({ FOO: '   \n\t  ' }, 'FOO')).toThrow(/FOO/);
  });

  it('names the specific missing variable, not a generic message', () => {
    expect(() => requiredEnv({}, 'METRICS_TOKEN')).toThrow(/METRICS_TOKEN/);
    expect(() => requiredEnv({}, 'GITHUB_REPOSITORY')).toThrow(/GITHUB_REPOSITORY/);
  });
});

describe('assertHeaderSafeToken', () => {
  it('accepts an ordinary token', () => {
    expect(() => assertHeaderSafeToken('ghp_abcdefg1234567890')).not.toThrow();
  });

  it('rejects a token containing a newline', () => {
    expect(() => assertHeaderSafeToken('ghp_abc\ndef')).toThrow();
  });

  it('rejects a token containing a tab', () => {
    expect(() => assertHeaderSafeToken('ghp_abc\tdef')).toThrow();
  });

  it('rejects a token containing a DEL byte', () => {
    expect(() => assertHeaderSafeToken('ghp_abc\x7fdef')).toThrow();
  });

  it('never echoes the rejected token value in its error message', () => {
    // Regression test for a real, verified leak: Node's fetch/undici throws
    // `Headers.append: "Bearer <the whole broken value>" is an invalid
    // header value.` when a header value contains a control character —
    // meaning the secret would otherwise land verbatim in the thrown
    // error's message, and from there in this CLI's stderr, and from there
    // in a public CI log. This guard must reject the value BEFORE it ever
    // reaches `fetch`, with a message that names the problem without
    // repeating the secret.
    const secret = 'ghp_SECRETVALUE1234\nINJECTED';
    let thrown: unknown;
    try {
      assertHeaderSafeToken(secret);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain('SECRETVALUE1234');
    expect((thrown as Error).message).not.toContain(secret);
  });
});

describe('deriveRunTimestamps', () => {
  it('returns the full ISO timestamp as `now`', () => {
    const { now } = deriveRunTimestamps(new Date('2026-03-14T09:26:53.589Z'));
    expect(now).toBe('2026-03-14T09:26:53.589Z');
  });

  it('derives `today` as the UTC calendar date, not a local one', () => {
    const { today } = deriveRunTimestamps(new Date('2026-03-14T09:26:53.589Z'));
    expect(today).toBe('2026-03-14');
  });

  it('stays on the correct UTC day for an instant near UTC midnight, regardless of host TZ', () => {
    // 23:59:59.999 UTC on the 31st is still the 1st in several timezones
    // east of UTC, and still the 31st (barely) in several west of it. Only
    // the UTC day is correct for this archive; a local-time derivation
    // would disagree with this assertion in at least one direction.
    const instant = new Date('2026-01-31T23:59:59.999Z');
    const originalTz = process.env['TZ'];
    try {
      process.env['TZ'] = 'Pacific/Kiritimati'; // UTC+14
      expect(deriveRunTimestamps(instant).today).toBe('2026-01-31');
      process.env['TZ'] = 'Etc/GMT+12'; // UTC-12
      expect(deriveRunTimestamps(instant).today).toBe('2026-01-31');
    } finally {
      if (originalTz === undefined) {
        delete process.env['TZ'];
      } else {
        process.env['TZ'] = originalTz;
      }
    }
  });

  it('produces a `today` that is a strict prefix of `now`', () => {
    const { now, today } = deriveRunTimestamps(new Date('2026-07-04T00:00:00.000Z'));
    expect(now.startsWith(today)).toBe(true);
  });
});

describe('formatCollectSummary', () => {
  it('reports only the written line when nothing was skipped', () => {
    expect(formatCollectSummary({ written: ['stars.csv', 'forks.csv'], skipped: [] })).toEqual([
      'wrote: stars.csv, forks.csv',
    ]);
  });

  it('adds a skipped line, distinct from the written line, when something was skipped', () => {
    const lines = formatCollectSummary({
      written: ['stars.csv'],
      skipped: ['releases.csv', 'contributors.csv'],
    });
    expect(lines).toEqual([
      'wrote: stars.csv',
      'skipped (left at previous value): releases.csv, contributors.csv',
    ]);
  });

  it('renders an empty written list rather than omitting the line', () => {
    expect(formatCollectSummary({ written: [], skipped: [] })).toEqual(['wrote: ']);
  });
});

describe('formatBackfillSummary', () => {
  it('lists the permitted target files', () => {
    expect(formatBackfillSummary({ written: ['stars.csv', 'forks.csv', 'releases.csv'] })).toBe(
      'backfill target files (write-if-absent, listed whether or not they changed this run): stars.csv, forks.csv, releases.csv',
    );
  });

  it('does not use the word "wrote", so it cannot be misread the way collect\'s summary is read', () => {
    const line = formatBackfillSummary({ written: ['stars.csv'] });
    expect(line).not.toContain('wrote:');
  });
});

describe('describeFailure', () => {
  it('renders a plain Error, including its stack', () => {
    const error = new Error('disk is full');
    const rendered = describeFailure(error);
    expect(rendered).toContain('disk is full');
  });

  it('surfaces the numeric status of a thrown GitHubError', () => {
    const error = new GitHubError(404, 'Not Found');
    const rendered = describeFailure(error);
    expect(rendered).toContain('404');
    expect(rendered).toContain('Not Found');
  });

  it('surfaces the status distinctly enough to grep for it (not just buried in prose)', () => {
    const error = new GitHubError(401, 'Bad credentials');
    expect(describeFailure(error)).toMatch(/status 401/);
  });

  it('walks the full `cause` chain', () => {
    const inner = new Error('ENOSPC: no space left on device');
    const outer = new Error('Store: failed to write "stars.csv"', { cause: inner });
    const rendered = describeFailure(outer);
    expect(rendered).toContain('failed to write "stars.csv"');
    expect(rendered).toContain('ENOSPC');
    expect(rendered).toContain('Caused by:');
  });

  it('renders a non-Error thrown value without crashing', () => {
    expect(describeFailure('a bare string was thrown')).toContain('a bare string was thrown');
  });

  it('renders a thrown undefined without crashing', () => {
    expect(() => describeFailure(undefined)).not.toThrow();
  });

  it('does not loop forever on a circular cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(() => describeFailure(a)).not.toThrow();
    expect(describeFailure(a)).toContain('circular');
  });

  it('has no access to process.env, so it cannot itself introduce a leak', () => {
    // Structural guarantee, exercised rather than merely asserted: build an
    // error whose message contains a value that looks like a secret, and
    // confirm describeFailure's output contains exactly that value and
    // nothing appended from the environment.
    const originalToken = process.env['METRICS_TOKEN'];
    process.env['METRICS_TOKEN'] = 'ghp_shouldNeverAppearHere';
    try {
      const rendered = describeFailure(new Error('unrelated failure'));
      expect(rendered).not.toContain('ghp_shouldNeverAppearHere');
    } finally {
      if (originalToken === undefined) {
        delete process.env['METRICS_TOKEN'];
      } else {
        process.env['METRICS_TOKEN'] = originalToken;
      }
    }
  });
});
