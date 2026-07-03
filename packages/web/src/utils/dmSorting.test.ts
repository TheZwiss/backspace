import { describe, it, expect } from 'vitest';
import { sortDmChannels } from './dmSorting';
import type { DmChannel } from '@backspace/shared';

function makeDm(id: string, lastMessageCreatedAt: number | null, createdAt = 1000): DmChannel {
  return {
    id,
    createdAt,
    members: [],
    lastMessage: lastMessageCreatedAt != null
      ? { id: `msg-${id}`, dmChannelId: id, userId: 'u1', content: 'test', createdAt: lastMessageCreatedAt }
      : null,
  };
}

describe('sortDmChannels', () => {
  it('sorts by recency when no unreads', () => {
    const dms = [
      makeDm('old', 100),
      makeDm('new', 300),
      makeDm('mid', 200),
    ];
    const sorted = sortDmChannels(dms, new Set(), null);
    expect(sorted.map(d => d.id)).toEqual(['new', 'mid', 'old']);
  });

  it('puts unread channels first', () => {
    const dms = [
      makeDm('read-new', 300),
      makeDm('unread-old', 100),
      makeDm('read-mid', 200),
    ];
    const sorted = sortDmChannels(dms, new Set(['unread-old']), null);
    expect(sorted.map(d => d.id)).toEqual(['unread-old', 'read-new', 'read-mid']);
  });

  it('sorts within unread group by recency', () => {
    const dms = [
      makeDm('unread-old', 100),
      makeDm('unread-new', 300),
      makeDm('read', 200),
    ];
    const sorted = sortDmChannels(dms, new Set(['unread-old', 'unread-new']), null);
    expect(sorted.map(d => d.id)).toEqual(['unread-new', 'unread-old', 'read']);
  });

  it('sorts within read group by recency', () => {
    const dms = [
      makeDm('read-old', 100),
      makeDm('read-new', 300),
      makeDm('unread', 200),
    ];
    const sorted = sortDmChannels(dms, new Set(['unread']), null);
    expect(sorted.map(d => d.id)).toEqual(['unread', 'read-new', 'read-old']);
  });

  it('excludes current channel from unread group', () => {
    const dms = [
      makeDm('current-unread', 100),
      makeDm('other-unread', 200),
      makeDm('read', 300),
    ];
    // current-unread is in unreadChannels but is the active channel — treat as read
    const sorted = sortDmChannels(dms, new Set(['current-unread', 'other-unread']), 'current-unread');
    expect(sorted.map(d => d.id)).toEqual(['other-unread', 'read', 'current-unread']);
  });

  it('falls back to createdAt when no lastMessage', () => {
    const dms = [
      makeDm('no-msg-old', null, 100),
      makeDm('no-msg-new', null, 300),
      makeDm('has-msg', 200),
    ];
    const sorted = sortDmChannels(dms, new Set(), null);
    expect(sorted.map(d => d.id)).toEqual(['no-msg-new', 'has-msg', 'no-msg-old']);
  });

  it('does not mutate the input array', () => {
    const dms = [makeDm('b', 100), makeDm('a', 200)];
    const original = [...dms];
    sortDmChannels(dms, new Set(), null);
    expect(dms).toEqual(original);
  });
});
