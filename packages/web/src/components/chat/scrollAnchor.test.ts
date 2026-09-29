import { describe, expect, it } from 'vitest';
import {
  firstUnreadMessageId,
  pageReachesReadPosition,
  resolveOpenTarget,
  type ScrollAnchor,
} from './scrollAnchor';

interface Row { id: string; mine?: boolean }

const rows = (...ids: Array<string | Row>): Row[] => ids.map((r) => (typeof r === 'string' ? { id: r } : r));
const isMine = (row: Row) => row.mine === true;

describe('resolveOpenTarget', () => {
  it('restores a reading position saved earlier in the session', () => {
    const saved: ScrollAnchor = { kind: 'message', messageId: '40', offsetPx: -12 };
    expect(resolveOpenTarget(saved, '90')).toEqual(saved);
  });

  it('opens at the first unread message when the view was left at the bottom', () => {
    expect(resolveOpenTarget({ kind: 'bottom' }, '90')).toEqual({ kind: 'unread', lastReadId: '90' });
  });

  it('opens at the first unread message on a first visit', () => {
    expect(resolveOpenTarget(undefined, '90')).toEqual({ kind: 'unread', lastReadId: '90' });
  });

  it('opens at the latest message when the channel has no read state', () => {
    expect(resolveOpenTarget(undefined, undefined)).toEqual({ kind: 'bottom' });
    expect(resolveOpenTarget({ kind: 'bottom' }, undefined)).toEqual({ kind: 'bottom' });
  });
});

describe('firstUnreadMessageId', () => {
  it('is the first message after the read position', () => {
    expect(firstUnreadMessageId(rows('8', '9', '10', '11'), '9', isMine)).toBe('10');
  });

  it('skips the viewer\'s own messages', () => {
    expect(firstUnreadMessageId(rows('9', { id: '10', mine: true }, '11'), '9', isMine)).toBe('11');
  });

  it('is null when nothing after the read position was written by someone else', () => {
    expect(firstUnreadMessageId(rows('9', { id: '10', mine: true }), '9', isMine)).toBeNull();
    expect(firstUnreadMessageId(rows('8', '9'), '9', isMine)).toBeNull();
  });

  it('compares ids as numbers, not strings', () => {
    expect(firstUnreadMessageId(rows('99', '100'), '99', isMine)).toBe('100');
  });

  it('ignores rows without a server id (optimistic sends)', () => {
    expect(firstUnreadMessageId(rows('9', 'pending-abc', 'temp_1'), '9', isMine)).toBeNull();
  });
});

describe('pageReachesReadPosition', () => {
  it('holds when the page starts at or before the read message', () => {
    expect(pageReachesReadPosition(rows('9', '10'), '9', true)).toBe(true);
    expect(pageReachesReadPosition(rows('5', '10'), '9', true)).toBe(true);
  });

  it('holds when the page is the start of the channel', () => {
    expect(pageReachesReadPosition(rows('20', '21'), '9', false)).toBe(true);
  });

  it('fails when older unread messages sit before the page', () => {
    expect(pageReachesReadPosition(rows('20', '21'), '9', true)).toBe(false);
  });

  it('fails on an empty page', () => {
    expect(pageReachesReadPosition([], '9', true)).toBe(false);
  });
});
