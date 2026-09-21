import { describe, it, expect } from 'vitest';
import type { DirectoryEntry } from '@backspace/shared';
import { dedupeAgainstConnected } from './directory';

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
