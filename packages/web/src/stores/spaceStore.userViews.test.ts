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

vi.mock('./authStore', async () => {
  const state = { user: null, token: null };
  return (await import('../test/authStoreMock')).authStoreMock(() => state);
});

import { useSpaceStore } from './spaceStore';
import { userKey } from '../utils/identity';
import type { User } from '@backspace/shared';

function makeUser(extras: Partial<User> & Pick<User, 'id' | 'username'>): User {
  return {
    displayName: extras.username,
    avatar: '',
    avatarColor: 'mint',
    homeUserId: null,
    homeInstance: null,
    status: 'online',
    customStatus: null,
    bio: null,
    banner: null,
    isAdmin: false,
    isDeleted: false,
    discoverable: true,
    showActivity: true,
    createdAt: 0,
    ...extras,
  } as User;
}

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    value: { host: 'nova.ddns.net' },
    writable: true,
  });
  useSpaceStore.getState().reset();
});

describe('spaceStore.upsertUserView preference rule', () => {
  it('inserts a fresh entry when none exists', () => {
    const user = makeUser({ id: 'local-1', username: 'alice' });
    useSpaceStore.getState().upsertUserView(user, '');
    const entry = useSpaceStore.getState().userViews.get(userKey(user, ''));
    expect(entry).toBeDefined();
    expect(entry!.user).toBe(user);
    expect(entry!.isHome).toBe(true);
    expect(entry!.deliveredBy).toBe('');
  });

  it('home view (delivered by user home) wins over an existing stub', () => {
    // orbit delivers Frank as a federated stub (frank's home is nova).
    const stubAxel = makeUser({
      id: 'orbit-local-id',
      username: 'frank@nova.ddns.net',
      homeUserId: 'nova-frank-id',
      homeInstance: 'nova.ddns.net',
      avatarColor: 'lavender',
      avatar: 'https://nova.ddns.net/api/uploads/old.png',
    });
    useSpaceStore.getState().upsertUserView(stubAxel, 'https://orbit.ddns.net');

    // Then nova, the page's own instance, delivers Frank's own row: native,
    // no homeInstance. It is the same person, so it lands on the same key and,
    // being his home's view, replaces orbit's copy.
    const homeAxel = makeUser({
      id: 'nova-frank-id',
      username: 'frank',
      avatar: '',
      avatarColor: 'teal',
    });
    useSpaceStore.getState().upsertUserView(homeAxel, '');

    expect(userKey(stubAxel, 'https://orbit.ddns.net')).toBe(userKey(homeAxel, ''));
    const entry = useSpaceStore.getState().userViews.get(userKey(homeAxel, ''));
    expect(entry?.isHome).toBe(true);
    expect(entry?.user.avatarColor).toBe('teal');
    expect(useSpaceStore.getState().userViews.size).toBe(1);
  });

  it('two same-canonical-key federated views: home delivery upgrades over sibling stub', () => {
    // Same person, same canonical key (homeInstance=nova, homeUserId=nova-frank-id),
    // but delivered from two different origins.
    const fromOrbit = makeUser({
      id: 'orbit-local',
      username: 'frank@nova.ddns.net',
      homeUserId: 'nova-frank-id',
      homeInstance: 'nova.ddns.net',
      avatarColor: 'lavender',
    });
    const fromNova = makeUser({
      id: 'nova-local',
      username: 'frank@nova.ddns.net',
      homeUserId: 'nova-frank-id',
      homeInstance: 'nova.ddns.net',
      avatarColor: 'teal',
    });

    useSpaceStore.getState().upsertUserView(fromOrbit, 'https://orbit.ddns.net');
    useSpaceStore.getState().upsertUserView(fromNova, 'https://nova.ddns.net');

    const entry = useSpaceStore.getState().userViews.get(userKey(fromNova, 'https://nova.ddns.net'));
    expect(entry?.isHome).toBe(true);
    expect(entry?.user.avatarColor).toBe('teal');
    expect(entry?.deliveredBy).toBe('https://nova.ddns.net');
  });

  it('stub view does NOT overwrite an existing home view', () => {
    const fromNova = makeUser({
      id: 'nova-local',
      username: 'frank@nova.ddns.net',
      homeUserId: 'nova-frank-id',
      homeInstance: 'nova.ddns.net',
      avatarColor: 'teal',
    });
    const fromOrbit = makeUser({
      id: 'orbit-local',
      username: 'frank@nova.ddns.net',
      homeUserId: 'nova-frank-id',
      homeInstance: 'nova.ddns.net',
      avatarColor: 'lavender',
    });

    useSpaceStore.getState().upsertUserView(fromNova, 'https://nova.ddns.net');
    useSpaceStore.getState().upsertUserView(fromOrbit, 'https://orbit.ddns.net');

    const entry = useSpaceStore.getState().userViews.get(userKey(fromNova, 'https://nova.ddns.net'));
    expect(entry?.isHome).toBe(true);
    expect(entry?.user.avatarColor).toBe('teal');
    expect(entry?.deliveredBy).toBe('https://nova.ddns.net');
  });

  it('same-tier writes update freshness (later write wins)', () => {
    const a = makeUser({
      id: 'orbit-1',
      username: 'frank@nova.ddns.net',
      homeUserId: 'nova-frank-id',
      homeInstance: 'nova.ddns.net',
      avatarColor: 'lavender',
    });
    const b = makeUser({
      id: 'orbit-1',
      username: 'frank@nova.ddns.net',
      homeUserId: 'nova-frank-id',
      homeInstance: 'nova.ddns.net',
      avatarColor: 'sky', // simulating a later profile-update event
    });

    useSpaceStore.getState().upsertUserView(a, 'https://orbit.ddns.net');
    useSpaceStore.getState().upsertUserView(b, 'https://orbit.ddns.net');

    const entry = useSpaceStore.getState().userViews.get(userKey(b, 'https://orbit.ddns.net'));
    expect(entry?.user.avatarColor).toBe('sky');
  });

  it('reset clears userViews', () => {
    const user = makeUser({ id: 'local-1', username: 'alice' });
    useSpaceStore.getState().upsertUserView(user, '');
    expect(useSpaceStore.getState().userViews.size).toBe(1);
    useSpaceStore.getState().reset();
    expect(useSpaceStore.getState().userViews.size).toBe(0);
  });

  it('removeInstanceSpaces prunes entries delivered by the removed origin only', () => {
    const frank = makeUser({
      id: 'nova-frank-id',
      username: 'frank',
      avatarColor: 'teal',
    });
    const heidi = makeUser({
      id: 'orbit-heidi-id',
      username: 'heidi',
      avatarColor: 'lavender',
    });

    useSpaceStore.getState().upsertUserView(frank, '');
    useSpaceStore.getState().upsertUserView(heidi, 'https://orbit.ddns.net');
    expect(useSpaceStore.getState().userViews.size).toBe(2);

    // Removing orbit drops what orbit delivered and keeps the rest.
    useSpaceStore.getState().removeInstanceSpaces('https://orbit.ddns.net');
    const remaining = useSpaceStore.getState().userViews;
    expect(remaining.size).toBe(1);
    expect(remaining.get(userKey(frank, ''))).toBeDefined();
    expect(remaining.get(userKey(heidi, 'https://orbit.ddns.net'))).toBeUndefined();
  });

  it('removeInstanceSpaces of the home origin evicts entries it delivered', () => {
    const homeView = makeUser({
      id: 'nova-frank-id',
      username: 'frank',
      avatarColor: 'teal',
    });
    useSpaceStore.getState().upsertUserView(homeView, '');
    useSpaceStore.getState().removeInstanceSpaces('');
    expect(useSpaceStore.getState().userViews.size).toBe(0);
  });

  it('treats native users delivered by a remote as that remote\'s home view', () => {
    // heidi is native to orbit (homeInstance=null on orbit). When orbit
    // delivers her, that is the home view.
    const heidi = makeUser({
      id: 'orbit-heidi-id',
      username: 'heidi',
      avatarColor: 'sky',
    });
    useSpaceStore.getState().upsertUserView(heidi, 'https://orbit.ddns.net');
    // A native row's home is the instance that issued it: orbit.
    const entry = useSpaceStore.getState().userViews.get('orbit.ddns.net:orbit-heidi-id');
    expect(entry?.isHome).toBe(true);
  });
});
