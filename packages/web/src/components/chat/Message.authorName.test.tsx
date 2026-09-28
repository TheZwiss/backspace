import { render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmChannel, MessageWithUser, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { Message } from './Message';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

function makeUser(id: string, username: string, displayName: string | null): User {
  return {
    id, username, displayName, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

const me = makeUser('me', 'alice', 'Alice');
// Replicated rows from orbit: their usernames carry the instance.
const zed = makeUser('zed-stub', 'zed@orbit.example', null);
const zedNamed = makeUser('zed-named', 'zed@orbit.example', 'Zed');
// A user native to this instance, and a replicated row of a user whose home
// is this instance (seen through another instance's space).
const mira = makeUser('mira', 'mira', null);
const frank = makeUser('frank-stub', `frank@${window.location.host}`, 'Frank');
const dm = { id: 'dm-1', ownerId: 'me', name: 'Crew', createdAt: 1, members: [me, zed, zedNamed, mira, frank], lastMessage: null } as unknown as DmChannel;

function dmMessage(id: string, author: User, replyTo: MessageWithUser | null): MessageWithUser {
  return {
    id,
    channelId: '',
    dmChannelId: dm.id,
    userId: author.id,
    replyToId: replyTo?.id ?? null,
    replyTo,
    content: `message ${id}`,
    editedAt: null,
    createdAt: 1,
    user: author,
    attachments: [],
    embeds: [],
    reactions: [],
  } as MessageWithUser;
}

beforeEach(() => {
  useAuthStore.setState({ user: me });
  useSpaceStore.setState({ dmChannels: [dm], channelOriginMap: new Map([[dm.id, '']]) });
});

afterEach(() => {
  useAuthStore.setState({ user: null });
  useSpaceStore.setState({ dmChannels: [], channelOriginMap: new Map() });
});

/** The name element in a row, and whether it carries the federation globe. */
function nameIn(rowId: string, text: string): { text: string | null; globe: boolean } {
  const row = document.getElementById(`msg-${rowId}`)!;
  const name = within(row).getByText(text);
  return { text: name.textContent, globe: name.querySelector('svg') !== null };
}

// One rule for every row that names a person, as the DM list and header do:
// the display name, else the base of the username, as plain text, and the
// globe exactly when the person is from another instance.
describe('Message author names', () => {
  it.each([
    ['a federated author without a display name', zed, 'zed', true],
    ['a federated author with a display name', zedNamed, 'Zed', true],
    ['a native author', mira, 'mira', false],
    ["a replicated row of a user whose home is this instance", frank, 'Frank', false],
  ])('names %s in the author row', (_label, author, shown, globe) => {
    const message = dmMessage('m-1', author, null);
    render(<Message message={message} isCompact={false} isFirstInGroup previousMessageId={null} />);
    expect(nameIn(message.id, shown)).toEqual({ text: shown, globe });
  });

  it.each([
    ['a federated author without a display name', zed, 'zed', true],
    ['a federated author with a display name', zedNamed, 'Zed', true],
    ['a native author', mira, 'mira', false],
  ])('names %s in a reply preview', (_label, author, shown, globe) => {
    const original = dmMessage('m-0', author, null);
    const reply = dmMessage('m-2', me, original);
    render(<Message message={reply} isCompact={false} isFirstInGroup previousMessageId={null} />);
    expect(nameIn(reply.id, shown)).toEqual({ text: shown, globe });
  });
});
