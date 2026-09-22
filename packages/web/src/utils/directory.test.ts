import { describe, it, expect } from 'vitest';
import type { DirectoryEntry } from '@backspace/shared';
import type { FederationRegistryEntry } from '@backspace/shared';
import { dedupeAgainstConnected, innerOrigins, isDirectoryEntry } from './directory';

const e = (origin: string, id: string): DirectoryEntry => ({
  origin,
  id,
  name: id,
  description: null,
  icon: null,
  banner: null,
  avatarColor: null,
  visibility: 'public' as const,
  memberCount: 1,
  createdAt: 1,
  instanceName: origin,
  federatedRegistrationOpen: true,
});

describe('dedupeAgainstConnected', () => {
  it('drops entries whose origin is connected, in any spelling', () => {
    const out = dedupeAgainstConnected(
      [e('https://a.test', '1'), e('https://B.test', '2'), e('https://c.test', '3')],
      ['https://a.test', 'https://b.test/'],
    );
    expect(out.map((x) => x.id)).toEqual(['3']);
  });

  it('drops nothing when nothing is connected', () => {
    expect(dedupeAgainstConnected([e('https://a.test', '1')], [])).toHaveLength(1);
  });

  it('ignores a connected value that does not parse', () => {
    expect(dedupeAgainstConnected([e('https://a.test', '1')], ['not a url'])).toHaveLength(1);
  });

  it('keeps an entry whose own origin does not parse', () => {
    expect(dedupeAgainstConnected([e('not a url', '1')], ['https://a.test'])).toHaveLength(1);
  });

  it('treats a connected value with a path as its origin', () => {
    expect(dedupeAgainstConnected([e('https://a.test', '1')], ['https://a.test/some/path'])).toHaveLength(0);
  });

  it('keeps the same space id from a different origin', () => {
    const out = dedupeAgainstConnected(
      [e('https://a.test', 'same'), e('https://b.test', 'same')],
      ['https://a.test'],
    );
    expect(out.map((x) => x.origin)).toEqual(['https://b.test']);
  });
});

describe('isDirectoryEntry', () => {
  it('accepts an entry with the fields the connect flow reads', () => {
    expect(isDirectoryEntry(e('https://a.example', 's1'))).toBe(true);
  });

  it('rejects non-objects, missing fields and an unknown visibility', () => {
    expect(isDirectoryEntry(null)).toBe(false);
    expect(isDirectoryEntry('entry')).toBe(false);
    expect(isDirectoryEntry({ id: 's1', name: 'S', visibility: 'public' })).toBe(false);
    expect(isDirectoryEntry({ ...e('https://a.example', 's1'), visibility: 'private' })).toBe(false);
    expect(isDirectoryEntry({ ...e('https://a.example', 's1'), id: 7 })).toBe(false);
  });
});

describe('innerOrigins', () => {
  const reg = (origin: string, status: FederationRegistryEntry['status']): FederationRegistryEntry => ({
    origin, label: '', username: '', remoteUserId: '', status, addedAt: 1, lastConnectedAt: null, disconnectedAt: null, errorMessage: null,
  });

  it('keeps a connected, an expired and an unreachable registry entry inner', () => {
    const out = innerOrigins(
      [reg('https://a.test', 'connected'), reg('https://b.test', 'auth_expired'), reg('https://c.test', 'unreachable')],
      [],
    );
    expect(out).toEqual(['https://a.test', 'https://b.test', 'https://c.test']);
  });

  it('a disconnected registry entry is outer again, even with a live instance holding its token', () => {
    const out = innerOrigins(
      [reg('https://a.test', 'disconnected')],
      [{ origin: 'https://a.test', status: 'disconnected' }],
    );
    expect(out).toEqual([]);
  });

  it('a live instance that is connected or connecting is inner whatever the registry says', () => {
    const out = innerOrigins(
      [reg('https://a.test', 'disconnected')],
      [{ origin: 'https://a.test', status: 'connecting' }, { origin: 'https://b.test', status: 'connected' }],
    );
    expect(out).toEqual(['https://a.test', 'https://b.test']);
  });

  it('a live instance in error or disconnected with no registry entry is outer', () => {
    const out = innerOrigins([], [{ origin: 'https://a.test', status: 'error' }, { origin: 'https://b.test', status: 'disconnected' }]);
    expect(out).toEqual([]);
  });

  it('lists an origin once', () => {
    const out = innerOrigins([reg('https://a.test', 'connected')], [{ origin: 'https://a.test', status: 'connected' }]);
    expect(out).toEqual(['https://a.test']);
  });
});
