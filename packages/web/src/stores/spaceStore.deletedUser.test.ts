import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

vi.mock('./instanceStore', () => ({
  useInstanceStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ instances: [], _autoConnectDone: true }),
    {
      getState: () => ({ instances: [], _autoConnectDone: true }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    }
  ),
}));

vi.mock('./authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: null, token: null }),
    {
      getState: () => ({ user: null, token: null }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    }
  ),
}));

import { useSpaceStore } from './spaceStore';
import type { DmChannel, User } from '@backspace/shared';

describe('updateUserEverywhere → DM member patch (drives the live Deleted-User update)', () => {
  beforeEach(() => {
    useSpaceStore.setState({
      dmChannels: [{
        id: 'd1', ownerId: null, createdAt: 0,
        members: [
          { id: 'me', username: 'me' } as User,
          { id: 'partner', username: 'partner', displayName: 'Partner', isDeleted: false } as User,
        ],
      } as DmChannel],
    });
  });

  it('rewrites the matching member to the sanitized deleted user', () => {
    const deleted = { id: 'partner', username: 'Deleted User', displayName: null, isDeleted: true } as User;
    useSpaceStore.getState().updateUserEverywhere(deleted);
    const member = useSpaceStore.getState().dmChannels[0].members.find(m => m.id === 'partner')!;
    expect(member.username).toBe('Deleted User');
    expect(member.isDeleted).toBe(true);
    expect(member.displayName).toBeNull();
  });
});
