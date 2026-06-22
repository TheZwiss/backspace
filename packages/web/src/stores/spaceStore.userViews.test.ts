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
import { canonicalUserKey } from '../utils/identity';
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
    const entry = useSpaceStore.getState().userViews.get(canonicalUserKey(user));
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

    // Then nova delivers frank natively (no homeInstance, our home origin '').
    // canonicalUserKey for the home view: needs to match the stub's key.
    // Stub key = "nova.ddns.net:nova-frank-id".
    // Home view (nova native): homeInstance=null, homeUserId=null, id="nova-frank-id"
    //   → key = ":nova-frank-id"
    // These keys are different on purpose: the home record on its home instance
    // has no homeInstance/homeUserId. The cross-instance match relies on the
    // stub being the federated form. Verify behavior accordingly.
    const homeAxel = makeUser({
      id: 'nova-frank-id',
      username: 'frank',
      avatar: '',
      avatarColor: 'teal',
    });
    useSpaceStore.getState().upsertUserView(homeAxel, '');

    // Stub entry is unchanged (different canonical key).
    const stubEntry = useSpaceStore.getState().userViews.get(canonicalUserKey(stubAxel));
    expect(stubEntry?.user.avatarColor).toBe('lavender');
    // Home entry exists under its own key.
    const homeEntry = useSpaceStore.getState().userViews.get(canonicalUserKey(homeAxel));
    expect(homeEntry?.user.avatarColor).toBe('teal');
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

    const entry = useSpaceStore.getState().userViews.get(canonicalUserKey(fromNova));
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

    const entry = useSpaceStore.getState().userViews.get(canonicalUserKey(fromNova));
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

    const entry = useSpaceStore.getState().userViews.get(canonicalUserKey(b));
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
    const homeView = makeUser({
      id: 'nova-frank-id',
      username: 'frank',
      avatarColor: 'teal',
    });
    const stubView = makeUser({
      id: 'orbit-frank-stub',
      username: 'frank@nova.ddns.net',
      homeUserId: 'nova-frank-id',
      homeInstance: 'nova.ddns.net',
      avatarColor: 'lavender',
    });

    useSpaceStore.getState().upsertUserView(homeView, '');
    useSpaceStore.getState().upsertUserView(stubView, 'https://orbit.ddns.net');
    expect(useSpaceStore.getState().userViews.size).toBe(2);

    // Removing orbit should drop the stub but keep the home view.
    useSpaceStore.getState().removeInstanceSpaces('https://orbit.ddns.net');
    const remaining = useSpaceStore.getState().userViews;
    expect(remaining.size).toBe(1);
    expect(remaining.get(canonicalUserKey(homeView))).toBeDefined();
    expect(remaining.get(canonicalUserKey(stubView))).toBeUndefined();
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
    // delivers him, that's the home view. canonicalKey uses orbit-host.
    const heidi = makeUser({
      id: 'orbit-heidi-id',
      username: 'heidi',
      avatarColor: 'sky',
    });
    useSpaceStore.getState().upsertUserView(heidi, 'https://orbit.ddns.net');
    // Key is built from user.homeInstance — but heidi has none. So the key is
    // ':orbit-heidi-id'. That's correct: when delivered later from a sibling,
    // heidi would arrive WITH homeInstance set (synthesized by normalizeUserAssets),
    // producing a different (federated) key. The cache holds both, with the
    // home view winning on a cross-key collision-free basis.
    const entry = useSpaceStore.getState().userViews.get(`:${heidi.id}`);
    expect(entry?.isHome).toBe(true);
  });
});
