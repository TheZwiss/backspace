import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmChannel, MemberWithUser, User } from '@backspace/shared';
import { setLanguage } from '../../i18n';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { TypingIndicator } from './TypingIndicator';

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

const me = makeUser('me', 'alice', 'Alice');
const kai = makeUser('kai', 'kai', 'Kai');
// A replicated stub whose username is still in the id shape.
const stub = makeUser('stub', '1234567890123456789@friend.example', 'Quinn');
const dm = { id: 'dm-1', ownerId: null, createdAt: 1, members: [me, kai, stub], lastMessage: null } as unknown as DmChannel;

function typing(channelId: string, entries: Array<[string, string]>): void {
  const now = Date.now();
  useChatStore.setState({
    typingUsers: new Map([[channelId, entries.map(([userId, username]) => ({ userId, username, timestamp: now }))]]),
  });
}

/** The rendered sentence; names and the verb are separate elements inside it. */
function typingLine(): HTMLElement {
  const line = document.querySelector<HTMLElement>('[data-typing-line]');
  if (!line) throw new Error('no typing line rendered');
  return line;
}

beforeEach(() => {
  useAuthStore.setState({ user: me });
  useSpaceStore.setState({ dmChannels: [dm] });
});

afterEach(async () => {
  useAuthStore.setState({ user: null });
  useChatStore.setState({ typingUsers: new Map() });
  useSpaceStore.setState({ dmChannels: [], members: [], channelToSpaceMap: new Map(), channelOriginMap: new Map() });
  useAuthStore.setState({ myRowIds: new Map() });
  await setLanguage('en');
});

describe('TypingIndicator', () => {
  it("shows a DM member's display name, not the username from the wire", () => {
    typing(dm.id, [[stub.id, stub.username]]);
    render(<TypingIndicator channelId={dm.id} />);
    expect(typingLine().textContent).toBe('Quinn is typing');
  });

  it('names two typers', () => {
    typing(dm.id, [[kai.id, 'kai'], [stub.id, stub.username]]);
    render(<TypingIndicator channelId={dm.id} />);
    expect(typingLine().textContent).toBe('Kai and Quinn are typing');
  });

  it('summarises three or more typers', () => {
    const mira = makeUser('mira', 'mira', null);
    useSpaceStore.setState({ dmChannels: [{ ...dm, members: [me, kai, stub, mira] } as DmChannel] });
    typing(dm.id, [[kai.id, 'kai'], [stub.id, stub.username], [mira.id, 'mira']]);
    render(<TypingIndicator channelId={dm.id} />);
    expect(typingLine().textContent).toBe('Several people are typing');
  });

  it('keeps long names whole, each in its own truncating box, and never truncates the verb', () => {
    const longA = makeUser('long-a', 'maxi', 'Maximiliane von Hohenzollern-Sigmaringen');
    const longB = makeUser('long-b', 'bart', 'Bartholomew Featherstonehaugh-Whittingstall the Third');
    useSpaceStore.setState({ dmChannels: [{ ...dm, members: [me, longA, longB] } as DmChannel] });
    typing(dm.id, [[longA.id, 'maxi'], [longB.id, 'bart']]);
    render(<TypingIndicator channelId={dm.id} />);

    expect(typingLine().textContent).toBe(`${longA.displayName} and ${longB.displayName} are typing`);
    const nameA = screen.getByTitle(longA.displayName!);
    const nameB = screen.getByTitle(longB.displayName!);
    expect(nameA).toHaveTextContent(longA.displayName!);
    expect(nameA).toHaveClass('truncate');
    expect(nameB).toHaveClass('truncate');
    const verb = screen.getByText(/are typing$/);
    expect(verb).not.toHaveClass('truncate');
    expect(verb).toHaveClass('shrink-0');
  });

  it('keeps an emoji sequence in a name whole', () => {
    const family = makeUser('fam', 'fam', 'Johnson family 👨‍👩‍👧‍👦 fans of long names');
    useSpaceStore.setState({ dmChannels: [{ ...dm, members: [me, family] } as DmChannel] });
    typing(dm.id, [[family.id, 'fam']]);
    render(<TypingIndicator channelId={dm.id} />);
    expect(screen.getByTitle(family.displayName!)).toHaveTextContent(family.displayName!);
  });

  it("falls back to the base of the wire username when the typer is not in the channel's roster", () => {
    typing(dm.id, [['ghost', 'ghost@far.example']]);
    render(<TypingIndicator channelId={dm.id} />);
    expect(typingLine().textContent).toBe('ghost is typing');
  });

  it("resolves a space channel's typer through that space's roster", () => {
    const member: MemberWithUser = { spaceId: 'space-1', userId: kai.id, nickname: null, joinedAt: 1, user: kai, roles: [] };
    useSpaceStore.setState({ channelToSpaceMap: new Map([['chan-1', 'space-1']]), members: [member] });
    typing('chan-1', [[kai.id, 'kai']]);
    render(<TypingIndicator channelId="chan-1" />);
    expect(typingLine().textContent).toBe('Kai is typing');
  });

  it('speaks the reader\'s language', async () => {
    await setLanguage('de');
    typing(dm.id, [[kai.id, 'kai'], [stub.id, stub.username]]);
    render(<TypingIndicator channelId={dm.id} />);
    expect(typingLine().textContent).toBe('Kai und Quinn schreiben');
  });

  describe("leaves out the viewer by the viewer's id on the channel's instance", () => {
    const ORBIT = 'https://orbit.example';
    const meOnOrbit = makeUser('me-orbit', 'alice@home.example', 'Alice');
    // Orbit issued this row an id that happens to equal the viewer's home id.
    const sameIdOnOrbit = makeUser(me.id, 'mira', 'Mira');
    const orbitDm = { id: 'dm-orbit', ownerId: null, createdAt: 1, members: [meOnOrbit, sameIdOnOrbit], lastMessage: null } as unknown as DmChannel;

    beforeEach(() => {
      useAuthStore.getState().recordMyRow(ORBIT, meOnOrbit.id);
      useSpaceStore.setState({ dmChannels: [orbitDm], channelOriginMap: new Map([[orbitDm.id, ORBIT]]) });
    });

    it("hides the viewer's own typing on a channel another instance serves", () => {
      typing(orbitDm.id, [[meOnOrbit.id, meOnOrbit.username]]);
      render(<TypingIndicator channelId={orbitDm.id} />);
      expect(document.querySelector('[data-typing-line]')).toBeNull();
    });

    it("shows someone else there whose id equals the viewer's home id", () => {
      typing(orbitDm.id, [[sameIdOnOrbit.id, sameIdOnOrbit.username]]);
      render(<TypingIndicator channelId={orbitDm.id} />);
      expect(typingLine().textContent).toBe('Mira is typing');
    });
  });
});
