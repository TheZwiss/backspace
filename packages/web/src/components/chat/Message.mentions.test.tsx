import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmChannel, MessageWithUser, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { clearMyUserIdCache, setMyUserIdForOrigin } from '../../utils/crossStoreResolvers';
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
    id,
    username,
    displayName,
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
}

const ORBIT = 'https://orbit.example';
const me = makeUser('me-home', 'alice', 'Alice');
const meOnOrbit = makeUser('me-orbit', 'alice@home.example', 'Alice');
const kaiOnOrbit = makeUser('kai-orbit', 'kai', 'Kai');

// A DM pinned to a remote origin: every id in it is that origin's id.
const remoteDm = {
  id: 'dm-r',
  ownerId: null,
  createdAt: 1,
  members: [meOnOrbit, kaiOnOrbit],
  lastMessage: null,
} as unknown as DmChannel;

function dmMessage(content: string): MessageWithUser {
  return {
    id: `m-${content}`,
    channelId: '',
    dmChannelId: remoteDm.id,
    userId: kaiOnOrbit.id,
    replyToId: null,
    content,
    editedAt: null,
    createdAt: 1,
    user: kaiOnOrbit,
    attachments: [],
    embeds: [],
    reactions: [],
  } as MessageWithUser;
}

function rowOf(message: MessageWithUser): HTMLElement {
  return document.getElementById(`msg-${message.id}`)!;
}

beforeEach(() => {
  useAuthStore.setState({ user: me });
  setMyUserIdForOrigin(ORBIT, meOnOrbit.id);
  useSpaceStore.setState({
    dmChannels: [remoteDm],
    channelOriginMap: new Map([[remoteDm.id, ORBIT]]),
  });
});

afterEach(() => {
  useAuthStore.setState({ user: null });
  useSpaceStore.setState({ dmChannels: [], channelOriginMap: new Map() });
  clearMyUserIdCache();
});

describe('Message mention highlight (#332)', () => {
  it("highlights a mention of my id on the DM's origin", () => {
    const message = dmMessage(`hey <@${meOnOrbit.id}>`);
    render(<Message message={message} isCompact={false} isFirstInGroup previousMessageId={null} />);
    expect(rowOf(message).className).toContain('border-l-accent-amber');
    // The badge resolves the mention to me, in the DM's own id space.
    expect(screen.getByText('@Alice')).toBeInTheDocument();
  });

  it("does not highlight my home id in a DM on another origin (that id is someone else's there)", () => {
    const message = dmMessage(`hey <@${me.id}>`);
    render(<Message message={message} isCompact={false} isFirstInGroup previousMessageId={null} />);
    expect(rowOf(message).className).not.toContain('border-l-accent-amber');
  });
});
