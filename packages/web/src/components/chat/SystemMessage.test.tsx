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

  it('unresolvable actor (member missing from roster) → "✎ Unknown renamed …"', () => {
    const msg = buildMessage({ event: 'name_changed', oldName: null, newName: 'X' }, 'GHOST');
    renderSM(msg, dm); // dm.members has only U1, not GHOST
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
