import { describe, it, expect } from 'vitest';
import { deriveMissingOneOnOneKeys, oneOnOneFederatedId } from './dmConversationKey';
import { wireDm, asListedBy161 } from '../test/dmWireShape';
import type { User } from '@backspace/shared';

function user(id: string, homeUserId: string | null = null, homeInstance: string | null = null): User {
  return {
    id, username: id, displayName: null, avatar: null, avatarColor: null, status: 'online',
    createdAt: 1, homeInstance, homeUserId,
  } as User;
}

describe('oneOnOneFederatedId', () => {
  it('equals the server\'s oneOnOneKey for the same pair, in either order', async () => {
    // The vector packages/server/src/utils/dmConversation.test.ts checks oneOnOneKey against.
    const expected = 'fc8aa3239ccea0cd4cbfb7701d770ac9';
    expect(await oneOnOneFederatedId(user('alice-home'), user('bob-stub', 'bob-remote', 'b.example'))).toBe(expected);
    expect(await oneOnOneFederatedId(user('bob-remote'), user('alice-on-b', 'alice-home', 'a.example'))).toBe(expected);
  });
});

describe('deriveMissingOneOnOneKeys', () => {
  const aliceOnRemote = user('alice-on-remote', 'alice-home', 'home.example');
  const bobOnRemote = user('bob-remote');

  it('keys a federated 1-on-1 listed without a key', async () => {
    const listed = [asListedBy161(wireDm({ id: 'dm-1', createdAt: 1, members: [aliceOnRemote, bobOnRemote] }))];
    expect((await deriveMissingOneOnOneKeys(listed)).get('dm-1')).toBe('fc8aa3239ccea0cd4cbfb7701d770ac9');
  });

  it('leaves alone a key the server sent, null included', async () => {
    const listed = [wireDm({ id: 'dm-1', createdAt: 1, federatedId: null, members: [aliceOnRemote, bobOnRemote] })];
    expect((await deriveMissingOneOnOneKeys(listed)).size).toBe(0);
  });

  it('does not key a group or a 1-on-1 between two native users', async () => {
    const group = asListedBy161(wireDm({
      id: 'dm-g', createdAt: 1, ownerId: 'alice-on-remote', members: [aliceOnRemote, bobOnRemote],
    }));
    const local = asListedBy161(wireDm({ id: 'dm-l', createdAt: 1, members: [user('x'), user('y')] }));
    expect((await deriveMissingOneOnOneKeys([group, local])).size).toBe(0);
  });
});
