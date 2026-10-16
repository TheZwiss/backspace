import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminUser } from '@backspace/shared';

// Reached transitively via authStore -> ... -> voiceStore; jsdom has no AudioWorkletNode.
vi.mock('../../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { UsersPanel } from './UsersPanel';
import { api } from '../../../api/client';

/** Delete with "block" for a bot of another instance, and the list of blocked bots. */

const user = (over: Partial<AdminUser>): AdminUser => ({
  id: 'u', username: 'u', displayName: null, avatar: null, avatarColor: null, status: 'offline',
  isAdmin: false, isBot: false, isDeleted: false, homeInstance: null, createdAt: 1, ...over,
});

const remoteBot = user({ id: 'rb', username: 'radio_bot@a.example', isBot: true, homeInstance: 'a.example' });
const localBot = user({ id: 'lb', username: 'local_bot', isBot: true });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api.admin, 'listInstances').mockResolvedValue({ instances: [] });
  vi.spyOn(api.admin, 'listUsers').mockResolvedValue({ users: [remoteBot, localBot], total: 2, page: 1, pageSize: 50 });
});

async function openDelete(username: string): Promise<void> {
  const row = (await screen.findByText(username)).closest('div.flex.items-center.gap-3') as HTMLElement;
  await userEvent.click(row.querySelector('button[title="Delete user"]') as HTMLElement);
}

describe('UsersPanel: blocking a bot of another instance', () => {
  it('offers the block only for a bot with a home instance and sends it when ticked', async () => {
    vi.spyOn(api.admin, 'listBlockedBots').mockResolvedValue({ bots: [] });
    const del = vi.spyOn(api.admin, 'deleteUser').mockResolvedValue({ success: true });
    render(<UsersPanel />);

    await openDelete('local_bot');
    expect(screen.queryByText('Do not let this bot register again')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await openDelete('radio_bot@a.example');
    await userEvent.click(screen.getByRole('checkbox', { name: /Do not let this bot register again/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete User' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('rb', { blockBot: true }));
  });

  it('a delete without the tick sends no block', async () => {
    vi.spyOn(api.admin, 'listBlockedBots').mockResolvedValue({ bots: [] });
    const del = vi.spyOn(api.admin, 'deleteUser').mockResolvedValue({ success: true });
    render(<UsersPanel />);
    await openDelete('radio_bot@a.example');
    await userEvent.click(screen.getByRole('button', { name: 'Delete User' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('rb', undefined));
  });

  it('lists the blocked bots and unblocks one', async () => {
    const list = vi.spyOn(api.admin, 'listBlockedBots')
      .mockResolvedValueOnce({ bots: [{ homeInstance: 'b.example', homeUserId: 'h1', username: 'spam_bot@b.example', blockedBy: 'admin', createdAt: 1 }] })
      .mockResolvedValue({ bots: [] });
    const unblock = vi.spyOn(api.admin, 'unblockBot').mockResolvedValue({ success: true });
    render(<UsersPanel />);
    expect(await screen.findByText('spam_bot@b.example')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Unblock' }));
    expect(unblock).toHaveBeenCalledWith('b.example', 'h1');
    await waitFor(() => expect(screen.queryByText('spam_bot@b.example')).not.toBeInTheDocument());
    expect(list).toHaveBeenCalledTimes(2);
  });
});
