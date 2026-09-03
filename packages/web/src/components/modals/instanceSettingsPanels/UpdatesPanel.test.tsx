import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdatesPanel } from './UpdatesPanel';
import { api } from '../../../api/client';
import type { InstanceUpdateStatus } from '@backspace/shared';

function status(over: Partial<InstanceUpdateStatus> = {}): InstanceUpdateStatus {
  return {
    current: { version: '1.0.3', commit: '73cc4fd' },
    latest: null,
    state: 'up-to-date',
    checkedAt: Date.now(),
    checkEnabled: true,
    reason: null,
    channel: 'prebuilt',
    ...over,
  };
}

const AVAILABLE = status({
  latest: {
    version: '1.0.4',
    url: 'https://github.com/TheZwiss/backspace/releases/tag/v1.0.4',
    publishedAt: '2026-09-03T11:00:00Z',
  },
  state: 'update-available',
});

let updateStatus: ReturnType<typeof vi.fn>;

beforeEach(() => {
  updateStatus = vi.fn();
  vi.spyOn(api.admin, 'updateStatus').mockImplementation(updateStatus as never);
});

describe('UpdatesPanel, what is running', () => {
  it('names the version, the commit, and how the instance gets its image', async () => {
    updateStatus.mockResolvedValue(status());
    render(<UpdatesPanel />);
    expect(await screen.findByText('Backspace 1.0.3')).toBeInTheDocument();
    expect(screen.getByText(/commit 73cc4fd/)).toBeInTheDocument();
    expect(screen.getByText(/prebuilt image/)).toBeInTheDocument();
  });

  it('does not claim an install method it was never told', async () => {
    updateStatus.mockResolvedValue(status({ channel: 'unknown' }));
    render(<UpdatesPanel />);
    expect(await screen.findByText(/install method not recorded/)).toBeInTheDocument();
  });
});

describe('UpdatesPanel, an update exists', () => {
  beforeEach(() => { updateStatus.mockResolvedValue(AVAILABLE); });

  it('shows the version, the date, and a link to the notes', async () => {
    render(<UpdatesPanel />);
    expect(await screen.findByText('Backspace 1.0.4 is available')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Release notes' });
    expect(link).toHaveAttribute('href', 'https://github.com/TheZwiss/backspace/releases/tag/v1.0.4');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('hands over the exact command', async () => {
    render(<UpdatesPanel />);
    expect(await screen.findByText('./update.sh')).toBeInTheDocument();
  });

  it('says the update rolls back if it does not come up', async () => {
    render(<UpdatesPanel />);
    expect(await screen.findByText(/puts back the version you\s+are on now/)).toBeInTheDocument();
  });

  it('copies the command to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<UpdatesPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('./update.sh');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('marks the manual steps as an expandable disclosure', async () => {
    render(<UpdatesPanel />);
    const toggle = await screen.findByRole('button', { name: /I do not have update\.sh/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('offers manual steps for operators who do not have update.sh yet', async () => {
    render(<UpdatesPanel />);
    await userEvent.click(await screen.findByRole('button', { name: /I do not have update\.sh/ }));
    expect(screen.getByText(/docker compose pull backspace/)).toBeInTheDocument();
  });

  it('warns against --remove-orphans in the manual steps', async () => {
    // Compose actively suggests --remove-orphans on hosts running other
    // containers in the same project, and following it deletes them.
    render(<UpdatesPanel />);
    await userEvent.click(await screen.findByRole('button', { name: /I do not have update\.sh/ }));
    expect(screen.getByText(/it would delete them/)).toBeInTheDocument();
  });

  it('shows only the from-source commands on a from-source install', async () => {
    updateStatus.mockResolvedValue({ ...AVAILABLE, channel: 'source' });
    render(<UpdatesPanel />);
    await userEvent.click(await screen.findByRole('button', { name: /I do not have update\.sh/ }));
    expect(screen.getByText(/up -d --build backspace/)).toBeInTheDocument();
    expect(screen.queryByText(/compose pull backspace/)).not.toBeInTheDocument();
  });

  it('shows both command sets when the channel was never recorded', async () => {
    updateStatus.mockResolvedValue({ ...AVAILABLE, channel: 'unknown' });
    render(<UpdatesPanel />);
    await userEvent.click(await screen.findByRole('button', { name: /I do not have update\.sh/ }));
    expect(screen.getByText(/compose pull backspace/)).toBeInTheDocument();
    expect(screen.getByText(/up -d --build backspace/)).toBeInTheDocument();
  });
});

describe('UpdatesPanel, nothing to do', () => {
  it('says so calmly, with no call to action', async () => {
    updateStatus.mockResolvedValue(status());
    render(<UpdatesPanel />);
    expect(await screen.findByText('You are on the latest release.')).toBeInTheDocument();
    expect(screen.queryByText('./update.sh')).not.toBeInTheDocument();
  });
});

describe('UpdatesPanel, the lookup could not be made', () => {
  it('still shows the running version when GitHub is unreachable', async () => {
    updateStatus.mockResolvedValue(status({ state: 'unknown', reason: 'unreachable', latest: null }));
    render(<UpdatesPanel />);
    expect(await screen.findByText('Backspace 1.0.3')).toBeInTheDocument();
    expect(screen.getByText('Could not check for updates')).toBeInTheDocument();
    expect(screen.getByText(/says nothing about whether an/)).toBeInTheDocument();
  });

  it('names the env var when checks are turned off, and disables re-checking', async () => {
    updateStatus.mockResolvedValue(
      status({ state: 'unknown', reason: 'disabled', checkEnabled: false, checkedAt: null }),
    );
    render(<UpdatesPanel />);
    expect(await screen.findByText('Update checks are turned off')).toBeInTheDocument();
    expect(screen.getByText('BACKSPACE_UPDATE_CHECK=true')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled();
    expect(screen.getByText('No lookups are made')).toBeInTheDocument();
  });

  it('distinguishes rate limiting from being unreachable', async () => {
    updateStatus.mockResolvedValue(status({ state: 'unknown', reason: 'rate-limited', latest: null }));
    render(<UpdatesPanel />);
    expect(await screen.findByText('GitHub rate-limited the lookup')).toBeInTheDocument();
  });

  it('recovers from a failed load', async () => {
    updateStatus.mockRejectedValueOnce(new Error('Network error'));
    render(<UpdatesPanel />);
    expect(await screen.findByText('Network error')).toBeInTheDocument();

    updateStatus.mockResolvedValue(status());
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Backspace 1.0.3')).toBeInTheDocument();
  });
});

describe('UpdatesPanel, re-checking', () => {
  it('looks up on mount without forcing a refresh', async () => {
    updateStatus.mockResolvedValue(status());
    render(<UpdatesPanel />);
    await waitFor(() => expect(updateStatus).toHaveBeenCalled());
    expect(updateStatus).toHaveBeenCalledWith(false);
  });

  it('forces a fresh lookup on an explicit re-check', async () => {
    updateStatus.mockResolvedValue(status());
    render(<UpdatesPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(updateStatus).toHaveBeenLastCalledWith(true);
  });
});

describe('UpdatesPanel, no trigger', () => {
  it('offers nothing that would apply the update from the browser', async () => {
    // Doing so needs the Docker socket mounted into the container, which is
    // host root. See the comment in UpdatesPanel and adminUpdates.ts.
    updateStatus.mockResolvedValue(AVAILABLE);
    render(<UpdatesPanel />);
    await screen.findByText('Backspace 1.0.4 is available');
    const labels = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    for (const label of labels) {
      expect(label).not.toMatch(/^(Update now|Install|Apply|Restart)$/i);
    }
  });
});
