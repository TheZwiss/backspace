import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SystemMessage } from './SystemMessage';
import type { DmChannel, MessageWithUser, User } from '@backspace/shared';

// SpaceInviteCard is unrelated to the cases under test but is imported by
// SystemMessage; stub its store hooks so the import graph resolves cleanly.
vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: (selector: (s: unknown) => unknown) =>
    selector({ joinByCode: vi.fn() }),
  getApiForOrigin: vi.fn(),
}));
vi.mock('../../api/client', () => ({
  api: {},
  createApiClient: vi.fn(),
}));

const actor: User = {
  id: 'U1',
  username: 'heidi',
  displayName: 'Heidi',
  avatar: null,
  banner: null,
  accentColor: null,
  avatarColor: 'mint',
  bio: null,
  status: 'online',
  customStatus: null,
  isAdmin: false,
  createdAt: 0,
  homeUserId: null,
  homeInstance: null,
  replicatedInstances: [],
};

function buildMessage(content: object, userId = 'U1'): MessageWithUser {
  return {
    id: 'M1',
    channelId: '',
    userId,
    user: actor,
    content: JSON.stringify(content),
    type: 'system',
    createdAt: 1,
    editedAt: null,
    replyToId: null,
    replyTo: null,
    attachments: [],
    embeds: [],
    reactions: [],
    mentions: [],
    everyoneMentioned: false,
    pinnedAt: null,
  } as unknown as MessageWithUser;
}

const dm: Pick<DmChannel, 'members'> = { members: [actor] };

function renderSM(message: MessageWithUser, dmArg: Pick<DmChannel, 'members'> | null) {
  return render(
    <MemoryRouter>
      <SystemMessage message={message} dm={dmArg} />
    </MemoryRouter>,
  );
}

describe('SystemMessage — name_changed', () => {
  it('newName="Cool Group" with resolvable actor → "✎ Heidi renamed the group to \\"Cool Group\\""', () => {
    const msg = buildMessage({ event: 'name_changed', oldName: null, newName: 'Cool Group' });
    renderSM(msg, dm);
    expect(screen.getByText('✎')).toBeDefined();
    expect(screen.getByText(/Heidi renamed the group to "Cool Group"/)).toBeDefined();
  });

  it('newName=null (cleared) with resolvable actor → "✎ Heidi cleared the group name"', () => {
    const msg = buildMessage({ event: 'name_changed', oldName: 'Old', newName: null });
    renderSM(msg, dm);
    expect(screen.getByText('✎')).toBeDefined();
    expect(screen.getByText(/Heidi cleared the group name/)).toBeDefined();
  });

  it('actor missing from the roster → the author the message carries', () => {
    const msg = buildMessage({ event: 'name_changed', oldName: null, newName: 'X' }, 'GHOST');
    renderSM(msg, dm); // dm.members has only U1, not GHOST
    expect(screen.getByText(/Heidi renamed the group to "X"/)).toBeDefined();
  });

  it('actor neither in the roster nor on the message → "Unknown renamed …"', () => {
    const msg = { ...buildMessage({ event: 'name_changed', oldName: null, newName: 'X' }, 'GHOST'), user: undefined } as unknown as MessageWithUser;
    renderSM(msg, dm);
    expect(screen.getByText(/Unknown renamed the group to "X"/)).toBeDefined();
  });
});

describe('SystemMessage — icon_changed', () => {
  it('resolvable actor → "🖼 Heidi updated the group icon"', () => {
    const msg = buildMessage({ event: 'icon_changed' });
    renderSM(msg, dm);
    // The 🖼 character is U+1F5BC (FRAME WITH PICTURE), not 🖼️ (with VS-16).
    expect(screen.getByText('\u{1F5BC}')).toBeDefined();
    expect(screen.getByText(/Heidi updated the group icon/)).toBeDefined();
  });
});

describe('SystemMessage: membership events', () => {
  it('member_added → "Heidi added Bob to the group"', () => {
    renderSM(buildMessage({ event: 'member_added', targetUserId: 'U2', targetDisplayName: 'Bob' }), dm);
    expect(screen.getByText(/Heidi added Bob to the group/)).toBeDefined();
  });

  it('member_removed by leave → "Bob left the group"', () => {
    renderSM(buildMessage({ event: 'member_removed', targetUserId: 'U2', targetDisplayName: 'Bob', reason: 'leave' }), dm);
    expect(screen.getByText(/Bob left the group/)).toBeDefined();
  });

  it('member_removed by kick → "Heidi removed Bob from the group"', () => {
    renderSM(buildMessage({ event: 'member_removed', targetUserId: 'U2', targetDisplayName: 'Bob', reason: 'kick' }), dm);
    expect(screen.getByText(/Heidi removed Bob from the group/)).toBeDefined();
  });

  it('owner_changed → "Mira is now the group owner"', () => {
    renderSM(buildMessage({ event: 'owner_changed', newOwnerId: 'U3', newOwnerDisplayName: 'Mira' }), dm);
    expect(screen.getByText(/Mira is now the group owner/)).toBeDefined();
  });
});

describe('SystemMessage: content it does not know', () => {
  it('an unknown event renders the generic label, never the content', () => {
    const { container } = renderSM(buildMessage({ event: 'call_started', note: 'visible text' }), dm);
    expect(screen.getByText('System message')).toBeDefined();
    expect(container.textContent).not.toContain('visible text');
  });

  it('an event with missing fields renders the generic label', () => {
    const { container } = renderSM(buildMessage({ event: 'owner_changed', newOwnerId: 'U3' }), dm);
    expect(screen.getByText('System message')).toBeDefined();
    expect(container.textContent).not.toContain('owner');
  });

  it('content that is not JSON renders the generic label, never the text', () => {
    const msg = { ...buildMessage({}), content: 'Heidi is now the group owner' } as MessageWithUser;
    const { container } = renderSM(msg, dm);
    expect(screen.getByText('System message')).toBeDefined();
    expect(container.textContent).not.toContain('Heidi is now the group owner');
  });
});
