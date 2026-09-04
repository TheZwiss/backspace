import { describe, expect, it } from 'vitest';
import type { MessageWithUser, User } from '@backspace/shared';
import { findLastOwnEditableMessage } from './messageEditing';

const me: User = {
  id: 'me',
  username: 'alice',
  displayName: 'Alice',
  avatar: null,
  banner: null,
  accentColor: null,
  avatarColor: null,
  bio: null,
  status: 'online',
  customStatus: null,
  isAdmin: false,
  createdAt: 1,
  homeInstance: null,
  homeUserId: null,
  replicatedInstances: [],
};

const other: User = { ...me, id: 'other', username: 'bob', displayName: 'Bob' };

function message(id: string, user: User, content: string | null, type: 'user' | 'system' = 'user'): MessageWithUser {
  return {
    id,
    channelId: 'channel',
    userId: user.id,
    replyToId: null,
    content,
    type,
    editedAt: null,
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    user,
    attachments: [],
    embeds: [],
    reactions: [],
  };
}

describe('findLastOwnEditableMessage', () => {
  it('returns the newest own text message', () => {
    const messages = [
      message('1', me, 'older'),
      message('2', other, 'someone else'),
      message('3', me, 'newest'),
    ];

    expect(findLastOwnEditableMessage(messages, me)?.id).toBe('3');
  });

  it('skips system and attachment-only messages', () => {
    const messages = [
      message('1', me, 'editable'),
      message('2', me, null),
      message('3', me, '{"event":"member_added"}', 'system'),
    ];

    expect(findLastOwnEditableMessage(messages, me)?.id).toBe('1');
  });

  it('does not fall back to an older message while the newest own message is pending', () => {
    const messages = [
      message('1', me, 'older'),
      message('temp_2', me, 'sending'),
    ];

    expect(findLastOwnEditableMessage(messages, me)).toBeNull();
  });
});
