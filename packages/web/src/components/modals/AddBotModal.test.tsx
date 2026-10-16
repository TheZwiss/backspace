import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { BotSearchResult } from '@backspace/shared';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  addToSpace: vi.fn(),
  spacePermissions: new Map<string, string>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../stores/spaceStore', () => ({
  getApiForOrigin: () => ({
    bots: { search: mocks.search, addToSpace: mocks.addToSpace },
    uploads: { url: (p: string) => p },
  }),
  useSpaceStore: (select: (s: { spacePermissions: Map<string, string> }) => unknown) =>
    select({ spacePermissions: mocks.spacePermissions }),
}));
vi.mock('../../i18n/errors', () => ({ describeError: (e: unknown) => (e instanceof Error ? e.message : 'error') }));
vi.mock('../ui/Avatar', () => ({ Avatar: () => null }));
vi.mock('../ui/Modal', () => ({
  Modal: ({ isOpen, title, children }: { isOpen: boolean; title: string; children: ReactNode }) =>
    (isOpen ? <div role="dialog" aria-label={title}>{children}</div> : null),
}));

import { AddBotModal } from './AddBotModal';

const SEND = 1n << 10n;
const KICK = 1n << 6n;

const bot = (requestedPermissions: string): BotSearchResult => ({
  id: 'b1',
  username: 'radio_bot',
  displayName: 'Radio_bot',
  avatar: null,
  avatarColor: null,
  bio: null,
  activity: null,
  requestedPermissions,
  createdAt: 1,
  ownerUsername: 'owner',
});

const openAndFind = async (requested: string) => {
  mocks.search.mockResolvedValue({ bots: [bot(requested)] });
  render(<AddBotModal isOpen onClose={vi.fn()} origin="" spaceId="s1" onAdded={vi.fn()} />);
  fireEvent.change(screen.getByPlaceholderText('settings.members.botInvite.searchPlaceholder'), { target: { value: 'radio' } });
  fireEvent.click(await screen.findByText('settings.members.botInvite.add', {}, { timeout: 2000 }));
};

describe('AddBotModal permissions step', () => {
  beforeEach(() => {
    mocks.search.mockReset();
    mocks.addToSpace.mockReset().mockResolvedValue({ success: true });
    mocks.spacePermissions.clear();
  });
  afterEach(() => cleanup());

  it('shows what the bot asks for, ticked, and adds it with the grant left ticked', async () => {
    await openAndFind(String(SEND | KICK));
    expect(screen.getByRole('dialog', { name: 'settings.members.botInvite.permissionsTitle' })).toBeTruthy();
    expect((screen.getByLabelText('spaces:permissions.names.sendMessages') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText('spaces:permissions.names.kickMembers'));
    fireEvent.click(screen.getByText('settings.members.botInvite.add'));
    await waitFor(() => expect(mocks.addToSpace).toHaveBeenCalledWith('b1', 's1', String(SEND)));
  });

  it('locks and leaves out what the manager does not hold', async () => {
    mocks.spacePermissions.set('s1', String(SEND | (1n << 4n)));
    await openAndFind(String(SEND | KICK));
    const kick = screen.getByLabelText('spaces:permissions.names.kickMembers') as HTMLInputElement;
    expect(kick.disabled).toBe(true);
    expect(kick.checked).toBe(false);
    expect(screen.getByText('settings.members.botInvite.permissionsUnheld')).toBeTruthy();
  });

  it('adds a bot that asks for nothing at once, without a role', async () => {
    await openAndFind('0');
    await waitFor(() => expect(mocks.addToSpace).toHaveBeenCalledWith('b1', 's1', '0'));
  });
});
