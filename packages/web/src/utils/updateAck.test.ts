import { describe, it, expect } from 'vitest';
import type { InstanceUpdateStatus } from '@backspace/shared';
import {
  EMPTY_ACK,
  ackStorageKey,
  readUpdateAck,
  writeUpdateAck,
  shouldBadgeUpdate,
  shouldToastUpdate,
  pendingUpdateVersion,
} from './updateAck';

/** In-memory Storage stand-in. `throwing` simulates private-mode denial. */
function makeStorage(seed: Record<string, string> = {}, throwing = false) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => {
      if (throwing) throw new Error('denied');
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throwing) throw new Error('denied');
      map.set(k, v);
    },
    dump: () => Object.fromEntries(map),
  };
}

function status(over: Partial<InstanceUpdateStatus> = {}): InstanceUpdateStatus {
  return {
    current: { version: '1.2.1', commit: 'abc1234' },
    latest: { version: '1.3.0', url: 'https://github.com/TheZwiss/backspace/releases/tag/v1.3.0', publishedAt: '2026-09-08T00:00:00Z' },
    state: 'update-available',
    checkedAt: 1_757_000_000_000,
    checkEnabled: true,
    reason: null,
    channel: 'prebuilt',
    ...over,
  };
}

describe('ackStorageKey', () => {
  it('scopes the key to the user id', () => {
    expect(ackStorageKey('u1')).toBe('backspace_update_ack_u1');
  });
});

describe('readUpdateAck', () => {
  it('returns the empty ack when nothing is stored', () => {
    expect(readUpdateAck(makeStorage(), 'u1')).toEqual(EMPTY_ACK);
  });

  it('returns the empty ack for a null user id', () => {
    expect(readUpdateAck(makeStorage(), null)).toEqual(EMPTY_ACK);
  });

  it('reads a stored record', () => {
    const storage = makeStorage({
      'backspace_update_ack_u1': JSON.stringify({ seenVersion: '1.3.0', toastShownFor: '1.3.0' }),
    });
    expect(readUpdateAck(storage, 'u1')).toEqual({ seenVersion: '1.3.0', toastShownFor: '1.3.0' });
  });

  it('returns the empty ack for corrupt JSON rather than throwing', () => {
    const storage = makeStorage({ 'backspace_update_ack_u1': '{not json' });
    expect(readUpdateAck(storage, 'u1')).toEqual(EMPTY_ACK);
  });

  it('returns the empty ack for a wrong-shaped record', () => {
    const storage = makeStorage({ 'backspace_update_ack_u1': JSON.stringify({ seenVersion: 7 }) });
    expect(readUpdateAck(storage, 'u1')).toEqual(EMPTY_ACK);
  });

  it('returns the empty ack when storage access throws', () => {
    expect(readUpdateAck(makeStorage({}, true), 'u1')).toEqual(EMPTY_ACK);
  });
});

describe('writeUpdateAck', () => {
  it('persists under the scoped key', () => {
    const storage = makeStorage();
    writeUpdateAck(storage, 'u1', { seenVersion: '1.3.0', toastShownFor: null });
    expect(JSON.parse(storage.dump()['backspace_update_ack_u1'] ?? '{}')).toEqual({
      seenVersion: '1.3.0',
      toastShownFor: null,
    });
  });

  it('writes nothing for a null user id', () => {
    const storage = makeStorage();
    writeUpdateAck(storage, null, { seenVersion: '1.3.0', toastShownFor: null });
    expect(storage.dump()).toEqual({});
  });

  it('swallows a storage denial', () => {
    expect(() => writeUpdateAck(makeStorage({}, true), 'u1', EMPTY_ACK)).not.toThrow();
  });
});

describe('pendingUpdateVersion', () => {
  it('returns the version when an update is available', () => {
    expect(pendingUpdateVersion(status())).toBe('1.3.0');
  });

  it('returns null for a null status', () => {
    expect(pendingUpdateVersion(null)).toBeNull();
  });

  it('returns null when the state is unknown even though latest is populated', () => {
    // Reachable: compareVersions returns null when the RUNNING version does not
    // parse, so the server can report a latest release alongside state 'unknown'.
    expect(pendingUpdateVersion(status({ state: 'unknown', reason: 'unparseable' }))).toBeNull();
  });

  it('returns null when up to date', () => {
    expect(pendingUpdateVersion(status({ state: 'up-to-date', latest: { version: '1.2.1', url: 'u', publishedAt: '' } }))).toBeNull();
  });
});

describe('shouldBadgeUpdate', () => {
  it('badges an unseen available update for an admin', () => {
    expect(shouldBadgeUpdate(status(), EMPTY_ACK, true)).toBe(true);
  });

  it('does not badge a non-admin', () => {
    expect(shouldBadgeUpdate(status(), EMPTY_ACK, false)).toBe(false);
  });

  it('does not badge a version already seen', () => {
    expect(shouldBadgeUpdate(status(), { seenVersion: '1.3.0', toastShownFor: null }, true)).toBe(false);
  });

  it('badges again when a newer version supersedes the seen one', () => {
    expect(shouldBadgeUpdate(status(), { seenVersion: '1.2.9', toastShownFor: null }, true)).toBe(true);
  });

  it('does not badge when the check is disabled', () => {
    expect(shouldBadgeUpdate(status({ state: 'unknown', reason: 'disabled', latest: null, checkEnabled: false }), EMPTY_ACK, true)).toBe(false);
  });

  it('does not badge on an unreachable lookup', () => {
    expect(shouldBadgeUpdate(status({ state: 'unknown', reason: 'unreachable', latest: null }), EMPTY_ACK, true)).toBe(false);
  });

  it('does not badge when the status has not loaded', () => {
    expect(shouldBadgeUpdate(null, EMPTY_ACK, true)).toBe(false);
  });
});

describe('shouldToastUpdate', () => {
  it('toasts an available update never toasted before', () => {
    expect(shouldToastUpdate(status(), EMPTY_ACK, true)).toBe(true);
  });

  it('does not toast the same version twice', () => {
    expect(shouldToastUpdate(status(), { seenVersion: null, toastShownFor: '1.3.0' }, true)).toBe(false);
  });

  it('toasts a newer version even after the panel was viewed for it', () => {
    expect(shouldToastUpdate(status(), { seenVersion: '1.3.0', toastShownFor: '1.2.9' }, true)).toBe(true);
  });

  it('does not toast a non-admin', () => {
    expect(shouldToastUpdate(status(), EMPTY_ACK, false)).toBe(false);
  });
});
