import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BotSummary } from '@backspace/shared';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listTokens: vi.fn(),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
  regenerateToken: vi.fn(),
  update: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../api/client', () => ({
  api: {
    bots: {
      list: mocks.list,
      listTokens: mocks.listTokens,
      createToken: mocks.createToken,
      revokeToken: mocks.revokeToken,
      regenerateToken: mocks.regenerateToken,
      update: mocks.update,
    },
    uploads: { url: (p: string) => p },
  },
}));
vi.mock('../../../i18n/errors', () => ({ describeError: (e: unknown) => (e instanceof Error ? e.message : 'error') }));
vi.mock('../../../i18n/formatters', () => ({
  useFormatters: () => ({ formatMediumDate: () => 'DATE', formatRelativeTime: () => 'AGO' }),
}));
vi.mock('../../ui/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../ui/ImageCropModal', () => ({ ImageCropModal: () => null }));
vi.mock('../../../stores/transferStore', () => ({ useTransferStore: () => undefined }));
vi.mock('../../../utils/waitForTransfer', () => ({ waitForTransferAttachment: vi.fn() }));

import { BotsPanel } from './BotsPanel';

const bot: BotSummary = {
  id: 'b1',
  username: 'echo_bot',
  displayName: 'Echo_bot',
  avatar: null,
  avatarColor: '#123456',
  bio: null,
  activity: null,
  requestedPermissions: '0',
  createdAt: 1_700_000_000_000,
};

const openTokens = async () => {
  render(<BotsPanel />);
  fireEvent.click(await screen.findByText('settings:bots.actions.tokens'));
};

describe('BotsPanel tokens', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.list.mockResolvedValue({ bots: [bot] });
  });
  afterEach(() => cleanup());

  it('lists tokens with their label and last use, never a secret', async () => {
    mocks.listTokens.mockResolvedValue({
      tokens: [
        { id: 't1', name: 'ci', createdAt: 1, lastUsedAt: 2 },
        { id: 't2', name: null, createdAt: 3, lastUsedAt: null },
      ],
      legacy: false,
    });
    await openTokens();
    expect(await screen.findByText('ci')).toBeTruthy();
    expect(screen.getByText('settings:bots.tokens.unnamed')).toBeTruthy();
    expect(screen.getByText(/settings:bots.tokens.lastUsed/)).toBeTruthy();
    expect(screen.getByText(/settings:bots.tokens.neverUsed/)).toBeTruthy();
    expect(mocks.listTokens).toHaveBeenCalledWith('b1');
  });

  it('tells the owner a bot still runs on the old token', async () => {
    mocks.listTokens.mockResolvedValue({ tokens: [], legacy: true });
    await openTokens();
    expect(await screen.findByText('settings:bots.tokens.legacy')).toBeTruthy();
    expect(screen.queryByText('settings:bots.tokens.empty')).toBeNull();
  });

  it('creates a labelled token, shows its secret once and drops the legacy hint', async () => {
    mocks.listTokens.mockResolvedValue({ tokens: [], legacy: true });
    mocks.createToken.mockResolvedValue({ id: 't9', name: 'prod', createdAt: 5, lastUsedAt: null, token: 'bsb_secret' });
    await openTokens();
    fireEvent.change(await screen.findByLabelText('settings:bots.tokens.nameLabel'), { target: { value: ' prod ' } });
    fireEvent.click(screen.getByText('settings:bots.tokens.create'));

    expect(await screen.findByText('bsb_secret')).toBeTruthy();
    expect(mocks.createToken).toHaveBeenCalledWith('b1', { name: 'prod' });
    expect(screen.getByText('prod')).toBeTruthy();
    expect(screen.queryByText('settings:bots.tokens.legacy')).toBeNull();
  });

  it('revokes one token after a confirmation', async () => {
    mocks.listTokens.mockResolvedValue({ tokens: [{ id: 't1', name: 'ci', createdAt: 1, lastUsedAt: null }], legacy: false });
    mocks.revokeToken.mockResolvedValue({ success: true });
    await openTokens();
    fireEvent.click(await screen.findByText('settings:bots.tokens.revoke'));
    expect(mocks.revokeToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('settings:bots.tokens.confirmRevoke'));

    await waitFor(() => expect(mocks.revokeToken).toHaveBeenCalledWith('b1', 't1'));
    await waitFor(() => expect(screen.queryByText('ci')).toBeNull());
  });

  it('stops offering new tokens at the limit', async () => {
    mocks.listTokens.mockResolvedValue({
      tokens: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, name: `n${i}`, createdAt: 1, lastUsedAt: null })),
      legacy: false,
    });
    await openTokens();
    const create = await screen.findByText('settings:bots.tokens.create');
    expect(create).toBeDisabled();
  });
});

describe('BotsPanel layout', () => {
  const other: BotSummary = { ...bot, id: 'b2', username: 'radio_bot', displayName: 'Radio_bot' };

  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.list.mockResolvedValue({ bots: [bot, other] });
  });
  afterEach(() => cleanup());

  it('gives every bot its own card holding all of its actions', async () => {
    render(<BotsPanel />);
    const card = await screen.findByRole('listitem', { name: 'Echo_bot' });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    for (const key of ['edit', 'addToServer', 'tokens', 'regenerate', 'delete']) {
      expect(within(card).getByText(`settings:bots.actions.${key}`)).toBeTruthy();
    }
  });

  it('opens the tokens of one bot inside that bot\'s card and marks the button', async () => {
    mocks.listTokens.mockResolvedValue({ tokens: [], legacy: false });
    render(<BotsPanel />);
    const card = await screen.findByRole('listitem', { name: 'Radio_bot' });
    const toggle = within(card).getByText('settings:bots.actions.tokens');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(await within(card).findByText('settings:bots.tokens.title')).toBeTruthy();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const firstCard = screen.getByRole('listitem', { name: 'Echo_bot' });
    expect(within(firstCard).queryByText('settings:bots.tokens.title')).toBeNull();
  });

  it('asks before deleting, inside the same card', async () => {
    render(<BotsPanel />);
    const card = await screen.findByRole('listitem', { name: 'Echo_bot' });
    fireEvent.click(within(card).getByText('settings:bots.actions.delete'));
    expect(within(card).getByText('settings:bots.actions.confirmDelete')).toBeTruthy();
    expect(within(card).queryByText('settings:bots.actions.delete')).toBeNull();
  });
});

describe('BotsPanel about and status', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.list.mockResolvedValue({ bots: [bot] });
  });
  afterEach(() => cleanup());

  const openEditor = async () => {
    render(<BotsPanel />);
    const card = await screen.findByRole('listitem', { name: 'Echo_bot' });
    fireEvent.click(within(card).getByText('settings:bots.actions.edit'));
    return card;
  };

  it('saves the about text and a status with the name', async () => {
    const saved = { ...bot, bio: 'Echoes what you say', activity: { type: 'listening' as const, name: 'you' } };
    mocks.update.mockResolvedValue({ bot: saved });
    const card = await openEditor();

    fireEvent.change(within(card).getByLabelText('settings:bots.edit.bioLabel'), { target: { value: '  Echoes what you say ' } });
    fireEvent.change(within(card).getByLabelText('settings:bots.status.label'), { target: { value: 'listening' } });
    fireEvent.change(within(card).getByLabelText('settings:bots.status.textLabel'), { target: { value: ' you ' } });
    fireEvent.click(within(card).getByText('settings:bots.actions.save'));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('b1', {
      displayName: 'Echo_bot',
      bio: 'Echoes what you say',
      activity: { type: 'listening', name: 'you' },
      requestedPermissions: '0',
    }));
    expect(await within(card).findByText('settings:bots.status.display.listening')).toBeTruthy();
  });

  it('does not save a status type without its text', async () => {
    const card = await openEditor();
    fireEvent.change(within(card).getByLabelText('settings:bots.status.label'), { target: { value: 'playing' } });
    expect(within(card).getByText('settings:bots.actions.save')).toBeDisabled();
    fireEvent.keyDown(within(card).getByLabelText('settings:bots.edit.nameLabel'), { key: 'Enter' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('clears the status when "No status" is chosen', async () => {
    mocks.list.mockResolvedValue({ bots: [{ ...bot, activity: { type: 'playing', name: 'chess' } }] });
    mocks.update.mockResolvedValue({ bot });
    const card = await openEditor();
    expect((within(card).getByLabelText('settings:bots.status.textLabel') as HTMLInputElement).value).toBe('chess');

    fireEvent.change(within(card).getByLabelText('settings:bots.status.label'), { target: { value: 'none' } });
    fireEvent.click(within(card).getByText('settings:bots.actions.save'));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('b1', expect.objectContaining({ activity: null, bio: null })));
  });
});

describe('BotsPanel requested permissions', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.list.mockResolvedValue({ bots: [{ ...bot, requestedPermissions: String(1n << 10n) }] });
    mocks.update.mockResolvedValue({ bot });
  });
  afterEach(() => cleanup());

  it('shows what the bot asks for ticked and saves the changed set', async () => {
    render(<BotsPanel />);
    const card = await screen.findByRole('listitem', { name: 'Echo_bot' });
    fireEvent.click(within(card).getByText('settings:bots.actions.edit'));

    const send = within(card).getByLabelText('spaces:permissions.names.sendMessages') as HTMLInputElement;
    expect(send.checked).toBe(true);
    fireEvent.click(within(card).getByLabelText('spaces:permissions.names.kickMembers'));
    fireEvent.click(within(card).getByText('settings:bots.actions.save'));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('b1', expect.objectContaining({
      requestedPermissions: String((1n << 10n) | (1n << 6n)),
    })));
  });
});
