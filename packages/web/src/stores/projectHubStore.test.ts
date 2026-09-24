import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hubUpdateState, useProjectHubStore } from './projectHubStore';
import { hubSeenVersionKey, readHubSeenVersion, writeHubSeenVersion } from '../utils/hubSeenVersion';

function resetStore(): void {
  useProjectHubStore.setState({ userId: null, seenVersion: null });
}

/** Makes every access to `localStorage` itself throw, as some private modes do. */
function denyLocalStorage(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('denied', 'SecurityError'); },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
  };
}

describe('hubUpdateState', () => {
  // One row per row of spec section 4's table.
  it.each([
    ['unknown', null, null],
    ['unknown', '1.5.0', null],
    ['first-run', null, '1.5.1'],
    ['current', '1.5.1', '1.5.1'],
    ['updated', '1.5.0', '1.5.1'],
  ] as const)('is %s for seen %s and version %s', (expected, seenVersion, version) => {
    expect(hubUpdateState(seenVersion, version)).toBe(expected);
  });

  it('treats a downgrade as a change, not as current', () => {
    expect(hubUpdateState('1.6.0', '1.5.1')).toBe('updated');
  });
});

describe('useProjectHubStore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('loads the stored value for a user', () => {
    writeHubSeenVersion(localStorage, 'alice', '1.5.0');
    useProjectHubStore.getState().load('alice');
    expect(useProjectHubStore.getState()).toMatchObject({ userId: 'alice', seenVersion: '1.5.0' });
  });

  it('swaps the value when a second user loads', () => {
    writeHubSeenVersion(localStorage, 'alice', '1.5.0');
    writeHubSeenVersion(localStorage, 'bob', '1.5.1');
    useProjectHubStore.getState().load('alice');
    useProjectHubStore.getState().load('bob');
    expect(useProjectHubStore.getState()).toMatchObject({ userId: 'bob', seenVersion: '1.5.1' });
  });

  it('gives a user with nothing stored a null value, not the previous user\'s', () => {
    writeHubSeenVersion(localStorage, 'alice', '1.5.0');
    useProjectHubStore.getState().load('alice');
    useProjectHubStore.getState().load('bob');
    expect(useProjectHubStore.getState()).toMatchObject({ userId: 'bob', seenVersion: null });
  });

  it('clears the value on sign-out', () => {
    writeHubSeenVersion(localStorage, 'alice', '1.5.0');
    useProjectHubStore.getState().load('alice');
    useProjectHubStore.getState().load(null);
    expect(useProjectHubStore.getState()).toMatchObject({ userId: null, seenVersion: null });
  });

  it('does not reread storage for the user already loaded', () => {
    useProjectHubStore.getState().load('alice');
    useProjectHubStore.getState().markSeen('1.5.1');
    // Storage changes under the store; a repeat load for the same user is a no-op.
    writeHubSeenVersion(localStorage, 'alice', '1.4.0');
    useProjectHubStore.getState().load('alice');
    expect(useProjectHubStore.getState().seenVersion).toBe('1.5.1');
  });

  it('markSeen records the version in memory and in storage for the loaded user only', () => {
    writeHubSeenVersion(localStorage, 'bob', '1.4.0');
    useProjectHubStore.getState().load('alice');
    useProjectHubStore.getState().markSeen('1.5.1');
    expect(useProjectHubStore.getState().seenVersion).toBe('1.5.1');
    expect(readHubSeenVersion(localStorage, 'alice')).toBe('1.5.1');
    expect(readHubSeenVersion(localStorage, 'bob')).toBe('1.4.0');
  });

  it('markSeen is a no-op with no user', () => {
    useProjectHubStore.getState().load(null);
    useProjectHubStore.getState().markSeen('1.5.1');
    expect(useProjectHubStore.getState().seenVersion).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('survives a storage that throws on access: loads null and marks in memory', () => {
    const restore = denyLocalStorage();
    try {
      expect(() => useProjectHubStore.getState().load('alice')).not.toThrow();
      expect(useProjectHubStore.getState()).toMatchObject({ userId: 'alice', seenVersion: null });
      expect(() => useProjectHubStore.getState().markSeen('1.5.1')).not.toThrow();
      expect(useProjectHubStore.getState().seenVersion).toBe('1.5.1');
    } finally {
      restore();
    }
    expect(localStorage.getItem(hubSeenVersionKey('alice'))).toBeNull();
  });
});
