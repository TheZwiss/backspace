import { describe, expect, it } from 'vitest';
import type { DmChannel } from '@backspace/shared';
import { locateDmChannel } from './dmChannelLookup';

const ORBIT = 'https://orbit.example';

function dm(id: string, federatedId: string | null): DmChannel {
  return { id, federatedId, ownerId: null, createdAt: 1, members: [], lastMessage: null } as unknown as DmChannel;
}

describe('locateDmChannel', () => {
  const pinned = dm('dm-home', 'fed-1');
  const alternatives = new Map([['fed-1', new Map([['', 'dm-home'], [ORBIT, 'dm-orbit']])]]);

  it('finds a pinned entry by its own id', () => {
    expect(locateDmChannel([pinned], alternatives, 'dm-home')).toEqual({ kind: 'pinned', dm: pinned });
  });

  it("finds another origin's id for a listed conversation, with the origin that issued it", () => {
    expect(locateDmChannel([pinned], alternatives, 'dm-orbit')).toEqual({ kind: 'alternate', dm: pinned, origin: ORBIT });
  });

  it('misses an id it does not know', () => {
    expect(locateDmChannel([pinned], alternatives, 'dm-other')).toBeNull();
  });

  it('misses an alternate id whose conversation is no longer listed', () => {
    expect(locateDmChannel([], alternatives, 'dm-orbit')).toBeNull();
  });
});
