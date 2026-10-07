import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MessageWithUser, Reaction, User } from '@backspace/shared';

vi.mock('../hooks/useWebSocket', () => ({
  wsSend: vi.fn(),
  wsSendAll: vi.fn(),
}));

vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { wsSend } from '../hooks/useWebSocket';
import { REACTION_ADD_IN_FLIGHT_MS, useChatStore } from './chatStore';
import { useSpaceStore } from './spaceStore';
import { useAuthStore } from './authStore';

/**
 * #393: the client never sends a second `reaction_add` for a reaction the
 * user holds, whether it is stored or its add is still in flight, and a
 * `reaction_added` the store already holds is not counted twice.
 *
 * The user is native to the page's instance (origin ''), where they are row
 * n-1; orbit knows them as row o-7.
 */

const ORBIT = 'https://orbit.example';
const CHANNEL = 'orbit-chan';
const MESSAGE = 'msg-1';

const me = { id: 'n-1', username: 'jannis', displayName: 'Jannis', avatar: null, homeInstance: null, homeUserId: null, createdAt: 1 } as unknown as User;
const orbitMe = { ...me, id: 'o-7', username: 'jannis@localhost:3000', homeInstance: 'localhost:3000', homeUserId: 'n-1' } as User;
const orbitMira = { id: 'o-2', username: 'mira', displayName: 'Mira', avatar: null, homeInstance: null, homeUserId: null, createdAt: 1 } as unknown as User;

function message(reactions: Reaction[] = []): MessageWithUser {
  return {
    id: MESSAGE, channelId: CHANNEL, userId: 'o-2', replyToId: null, content: 'hello',
    editedAt: null, createdAt: 1, user: orbitMira, attachments: [], embeds: [], reactions,
  };
}

function reaction(id: string, user: User, emoji: string): Reaction {
  return { id, messageId: MESSAGE, userId: user.id, emoji, createdAt: 1, user };
}

function sent(type: 'reaction_add' | 'reaction_remove'): unknown[] {
  return vi.mocked(wsSend).mock.calls.filter(([event]) => (event as { type: string }).type === type);
}

function reactionsHeld(): Reaction[] {
  return useChatStore.getState().messages.get(CHANNEL)?.[0]?.reactions ?? [];
}

beforeEach(() => {
  vi.mocked(wsSend).mockClear();
  useAuthStore.setState({ user: me, myRowIds: new Map([[ORBIT, 'o-7']]) });
  useSpaceStore.setState({ channelOriginMap: new Map([[CHANNEL, ORBIT]]) });
  useChatStore.setState({
    messages: new Map([[CHANNEL, [message()]]]),
    detachedChannels: new Map(),
    reactionAddsInFlight: new Map(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  useChatStore.setState({ messages: new Map(), reactionAddsInFlight: new Map() });
  useSpaceStore.setState({ channelOriginMap: new Map() });
  useAuthStore.setState({ user: null, myRowIds: new Map() });
});

describe('addReaction', () => {
  it('sends one add, to the message\'s instance, however often it is called before the answer', () => {
    const { addReaction } = useChatStore.getState();
    addReaction(MESSAGE, '👍');
    addReaction(MESSAGE, '👍');
    addReaction(MESSAGE, '👍');
    expect(sent('reaction_add')).toEqual([[{ type: 'reaction_add', messageId: MESSAGE, emoji: '👍' }, ORBIT]]);
  });

  it('sends nothing for a reaction the user already has stored', () => {
    useChatStore.setState({ messages: new Map([[CHANNEL, [message([reaction('r1', orbitMe, '👍')])]]]) });
    useChatStore.getState().addReaction(MESSAGE, '👍');
    expect(sent('reaction_add')).toEqual([]);
  });

  it('sends the add when only someone else has the emoji, or the user has another', () => {
    useChatStore.setState({ messages: new Map([[CHANNEL, [message([reaction('r1', orbitMira, '👍'), reaction('r2', orbitMe, '🎉')])]]]) });
    useChatStore.getState().addReaction(MESSAGE, '👍');
    expect(sent('reaction_add')).toHaveLength(1);
  });

  it('sends the add again once an unanswered one has timed out', () => {
    vi.useFakeTimers();
    const { addReaction } = useChatStore.getState();
    addReaction(MESSAGE, '👍');
    vi.advanceTimersByTime(REACTION_ADD_IN_FLIGHT_MS - 1);
    addReaction(MESSAGE, '👍');
    expect(sent('reaction_add')).toHaveLength(1);
    vi.advanceTimersByTime(1);
    addReaction(MESSAGE, '👍');
    expect(sent('reaction_add')).toHaveLength(2);
  });
});

describe('hasOwnReaction', () => {
  it('counts an add in flight, then the stored reaction its answer brings', () => {
    const store = useChatStore.getState();
    expect(store.hasOwnReaction(MESSAGE, '👍')).toBe(false);
    store.addReaction(MESSAGE, '👍');
    expect(useChatStore.getState().hasOwnReaction(MESSAGE, '👍')).toBe(true);

    useChatStore.getState().onReactionAdded(MESSAGE, reaction('r1', orbitMe, '👍'));
    expect(useChatStore.getState().reactionAddsInFlight.size).toBe(0);
    expect(useChatStore.getState().hasOwnReaction(MESSAGE, '👍')).toBe(true);
  });

  it('does not end the in-flight add when someone else\'s reaction with the emoji arrives', () => {
    useChatStore.getState().addReaction(MESSAGE, '👍');
    useChatStore.getState().onReactionAdded(MESSAGE, reaction('r1', orbitMira, '👍'));
    expect(useChatStore.getState().reactionAddsInFlight.size).toBe(1);
    useChatStore.getState().addReaction(MESSAGE, '👍');
    expect(sent('reaction_add')).toHaveLength(1);
  });

  it('is false once the user removes the reaction, so it can be added again', () => {
    const store = useChatStore.getState();
    store.addReaction(MESSAGE, '👍');
    store.removeReaction(MESSAGE, '👍');
    expect(useChatStore.getState().hasOwnReaction(MESSAGE, '👍')).toBe(false);
    useChatStore.getState().addReaction(MESSAGE, '👍');
    expect(sent('reaction_add')).toHaveLength(2);
    expect(sent('reaction_remove')).toEqual([[{ type: 'reaction_remove', messageId: MESSAGE, emoji: '👍' }, ORBIT]]);
  });

  it('reads a message held by a detached window', () => {
    useChatStore.setState({
      messages: new Map(),
      detachedChannels: new Map([[CHANNEL, [message([reaction('r1', orbitMe, '👍')])]]]),
    });
    expect(useChatStore.getState().hasOwnReaction(MESSAGE, '👍')).toBe(true);
  });
});

describe('onReactionAdded', () => {
  it('keeps one reaction when the same reaction_added arrives twice', () => {
    const { onReactionAdded } = useChatStore.getState();
    onReactionAdded(MESSAGE, reaction('r1', orbitMe, '👍'));
    onReactionAdded(MESSAGE, reaction('r1', orbitMe, '👍'));
    expect(reactionsHeld().map(r => r.id)).toEqual(['r1']);
  });

  it('keeps one reaction per user and emoji, as the server stores them', () => {
    const { onReactionAdded } = useChatStore.getState();
    onReactionAdded(MESSAGE, reaction('r1', orbitMe, '👍'));
    onReactionAdded(MESSAGE, reaction('r2', orbitMe, '👍'));
    onReactionAdded(MESSAGE, reaction('r3', orbitMira, '👍'));
    onReactionAdded(MESSAGE, reaction('r4', orbitMe, '🎉'));
    expect(reactionsHeld().map(r => r.id)).toEqual(['r1', 'r3', 'r4']);
  });
});
