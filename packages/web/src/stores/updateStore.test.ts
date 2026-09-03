import { describe, it, expect } from 'vitest';
import {
  coerceSnapshot,
  shouldPrompt,
  canRestartToInstall,
  statusVersion,
} from './updateStore';

function snap(over: Partial<DesktopUpdateSnapshot>): DesktopUpdateSnapshot {
  return { capability: 'auto', dismissedVersion: null, status: { phase: 'idle' }, ...over };
}

describe('coerceSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    const value = {
      capability: 'manual',
      dismissedVersion: null,
      status: { phase: 'available', version: '1.0.4' },
    };
    expect(coerceSnapshot(value)).toEqual(value);
  });

  it('accepts the externally-managed capability', () => {
    const value = {
      capability: 'external',
      dismissedVersion: null,
      status: { phase: 'idle' },
    };
    expect(coerceSnapshot(value)).toEqual(value);
  });

  it('accepts every phase the main process can send', () => {
    const phases: unknown[] = [
      { phase: 'idle' },
      { phase: 'checking' },
      { phase: 'available', version: '1.0.4' },
      { phase: 'downloading', version: '1.0.4', percent: 42, bytesPerSecond: 1000 },
      { phase: 'ready', version: '1.0.4' },
      { phase: 'failed', version: '1.0.4', message: 'nope' },
      { phase: 'failed', version: null, message: 'check failed' },
      { phase: 'up-to-date', checkedAt: 1 },
    ];
    for (const status of phases) {
      expect(coerceSnapshot({ capability: 'auto', dismissedVersion: null, status })).not.toBeNull();
    }
  });

  it('rejects a non-object payload', () => {
    expect(coerceSnapshot(null)).toBeNull();
    expect(coerceSnapshot(undefined)).toBeNull();
    expect(coerceSnapshot('ready')).toBeNull();
    expect(coerceSnapshot(42)).toBeNull();
  });

  it('rejects an unknown capability', () => {
    expect(coerceSnapshot({ capability: 'sometimes', dismissedVersion: null, status: { phase: 'idle' } }))
      .toBeNull();
  });

  it('rejects a non-string dismissedVersion', () => {
    expect(coerceSnapshot({ capability: 'auto', dismissedVersion: 104, status: { phase: 'idle' } }))
      .toBeNull();
  });

  it('rejects an unknown phase, so a newer app cannot render as garbage', () => {
    expect(coerceSnapshot({ capability: 'auto', dismissedVersion: null, status: { phase: 'teleporting' } }))
      .toBeNull();
  });

  it('rejects a versioned phase that carries no version', () => {
    for (const phase of ['available', 'ready', 'downloading']) {
      expect(coerceSnapshot({ capability: 'auto', dismissedVersion: null, status: { phase } }))
        .toBeNull();
    }
  });

  it('repairs non-finite numeric fields rather than rejecting the snapshot', () => {
    const result = coerceSnapshot({
      capability: 'auto',
      dismissedVersion: null,
      status: { phase: 'downloading', version: '1.0.4', percent: NaN, bytesPerSecond: 'fast' },
    });
    expect(result?.status).toEqual({
      phase: 'downloading', version: '1.0.4', percent: 0, bytesPerSecond: 0,
    });
  });

  it('supplies a fallback message for a failure that carries none', () => {
    const result = coerceSnapshot({
      capability: 'auto',
      dismissedVersion: null,
      status: { phase: 'failed', version: '1.0.4' },
    });
    expect(result?.status).toEqual({ phase: 'failed', version: '1.0.4', message: 'The update failed.' });
  });
});

describe('statusVersion', () => {
  it('extracts the version where one exists', () => {
    expect(statusVersion({ phase: 'available', version: '1.0.4' })).toBe('1.0.4');
    expect(statusVersion({ phase: 'ready', version: '1.0.4' })).toBe('1.0.4');
    expect(statusVersion({ phase: 'failed', version: '1.0.4', message: 'x' })).toBe('1.0.4');
    expect(statusVersion({ phase: 'downloading', version: '1.0.4', percent: 1, bytesPerSecond: 1 })).toBe('1.0.4');
  });

  it('returns null where none exists', () => {
    expect(statusVersion({ phase: 'idle' })).toBeNull();
    expect(statusVersion({ phase: 'checking' })).toBeNull();
    expect(statusVersion({ phase: 'up-to-date', checkedAt: 1 })).toBeNull();
    expect(statusVersion({ phase: 'failed', version: null, message: 'x' })).toBeNull();
  });
});

describe('shouldPrompt', () => {
  it('prompts for available, ready, and failed', () => {
    expect(shouldPrompt(snap({ status: { phase: 'available', version: '1.0.4' } }))).toBe(true);
    expect(shouldPrompt(snap({ status: { phase: 'ready', version: '1.0.4' } }))).toBe(true);
    expect(shouldPrompt(snap({ status: { phase: 'failed', version: '1.0.4', message: 'x' } }))).toBe(true);
  });

  it('stays quiet for progress phases, which are not news', () => {
    expect(shouldPrompt(snap({ status: { phase: 'idle' } }))).toBe(false);
    expect(shouldPrompt(snap({ status: { phase: 'checking' } }))).toBe(false);
    expect(shouldPrompt(snap({ status: { phase: 'up-to-date', checkedAt: 1 } }))).toBe(false);
    expect(shouldPrompt(snap({
      status: { phase: 'downloading', version: '1.0.4', percent: 10, bytesPerSecond: 1 },
    }))).toBe(false);
  });

  it('stays quiet before any snapshot arrives, and in a browser', () => {
    expect(shouldPrompt(null)).toBe(false);
  });

  it('stays quiet for a dismissed version but not for a newer one', () => {
    expect(shouldPrompt(snap({
      dismissedVersion: '1.0.4', status: { phase: 'available', version: '1.0.4' },
    }))).toBe(false);
    expect(shouldPrompt(snap({
      dismissedVersion: '1.0.4', status: { phase: 'available', version: '1.0.5' },
    }))).toBe(true);
  });

  it('stays quiet for a check failure that never learned a version', () => {
    expect(shouldPrompt(snap({
      status: { phase: 'failed', version: null, message: 'getaddrinfo ENOTFOUND' },
    }))).toBe(false);
  });

  it('stays quiet when updates are owned by the package manager', () => {
    expect(shouldPrompt(snap({
      capability: 'external',
      status: { phase: 'available', version: '1.0.5' },
    }))).toBe(false);
  });
});

describe('canRestartToInstall', () => {
  it('is true only for a staged update on an auto-capable build', () => {
    expect(canRestartToInstall(snap({ capability: 'auto', status: { phase: 'ready', version: '1.0.4' } }))).toBe(true);
  });

  it('is false on an ad-hoc signed build, which is what removes the dead button', () => {
    expect(canRestartToInstall(snap({ capability: 'manual', status: { phase: 'ready', version: '1.0.4' } }))).toBe(false);
  });

  it('is false for any other phase, and before a snapshot exists', () => {
    expect(canRestartToInstall(snap({ status: { phase: 'available', version: '1.0.4' } }))).toBe(false);
    expect(canRestartToInstall(null)).toBe(false);
  });
});
