import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationSetting, UpdateNotificationSettingRequest } from '@backspace/shared';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { notificationSettingKey, useNotificationSettingsStore } from '../../stores/notificationSettingsStore';
import { setLanguage } from '../../i18n';
import { ChannelNotificationButton } from './ChannelNotificationButton';
import { ChannelMutedIndicator } from './ChannelMutedIndicator';
import { NotificationSettingsControls } from './NotificationSettingsControls';
import { NotificationSettingsModal } from './NotificationSettingsModal';

const REMOTE = 'https://remote.example';
const SPACE = 'space-1';
const CHANNEL = 'general';
const HOUR = 60 * 60 * 1000;

const updateSpace = vi.fn<(spaceId: string, data: UpdateNotificationSettingRequest) => Promise<NotificationSetting>>();
const updateChannel = vi.fn<(channelId: string, data: UpdateNotificationSettingRequest) => Promise<NotificationSetting>>();
const clientOrigins: string[] = [];

vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));

vi.mock('../../utils/crossStoreResolvers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/crossStoreResolvers')>();
  return {
    ...actual,
    getApiForOrigin: (origin: string) => {
      clientOrigins.push(origin);
      return { notificationSettings: { list: vi.fn(), updateSpace, updateChannel } };
    },
  };
});

function setting(over: Partial<NotificationSetting>): NotificationSetting {
  return { spaceId: SPACE, channelId: null, level: null, muted: false, mutedUntil: null, updatedAt: 1, ...over };
}

function seed(entries: NotificationSetting[]): void {
  useNotificationSettingsStore.setState({
    settings: new Map(entries.map((s) => [notificationSettingKey(REMOTE, { spaceId: s.spaceId, channelId: s.channelId }), s])),
  });
}

/** The server's answer: what the request asked for, a tick later. */
function answer(channelId: string | null, data: UpdateNotificationSettingRequest, updatedAt: number): NotificationSetting {
  return setting({
    channelId,
    suppressEveryone: data.suppressEveryone ?? false,
    suppressRoles: data.suppressRoles ?? false,
    level: data.level ?? null,
    muted: data.mute !== undefined && data.mute !== null,
    mutedUntil: data.mute && data.mute !== 'indefinite' ? Date.now() + (data.mute === '1h' ? HOUR : data.mute === '8h' ? 8 * HOUR : 24 * HOUR) : null,
    updatedAt,
  });
}

beforeEach(async () => {
  await setLanguage('en');
  clientOrigins.length = 0;
  updateSpace.mockReset();
  updateChannel.mockReset();
  updateChannel.mockImplementation(async (channelId, data) => answer(channelId, data, 10));
  updateSpace.mockImplementation(async (_spaceId, data) => answer(null, data, 10));
  useNotificationSettingsStore.getState().reset();
  useSpaceStore.setState({
    channelToSpaceMap: new Map([[CHANNEL, SPACE]]),
    channelOriginMap: new Map([[CHANNEL, REMOTE]]),
  });
  useUIStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  useNotificationSettingsStore.getState().reset();
});

function openPopover() {
  render(<ChannelNotificationButton channelId={CHANNEL} channelName="general" />);
  fireEvent.click(screen.getByTitle(/^Notification Settings/));
  return screen.getByRole('dialog', { name: 'Notifications for #general' });
}

describe('ChannelNotificationPopover', () => {
  it('opens from the bell as a glass popover with the four level choices', () => {
    const dialog = openPopover();
    expect(dialog).toHaveClass('glass');
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual([
      'Space default (Only @mentions)', 'All messages', 'Only @mentions', 'Nothing',
    ]);
    expect(screen.getByRole('radio', { name: 'Space default (Only @mentions)' })).toHaveAttribute('aria-checked', 'true');
  });

  it('names the inherited level of the space on the default row', () => {
    seed([setting({ level: 'nothing' })]);
    openPopover();
    expect(screen.getByRole('radio', { name: 'Space default (Nothing)' })).toHaveAttribute('aria-checked', 'true');
  });

  it('writes a level to the instance that hosts the space and shows the answer', async () => {
    openPopover();
    fireEvent.click(screen.getByRole('radio', { name: 'All messages' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'All messages' })).toHaveAttribute('aria-checked', 'true'));
    expect(updateChannel).toHaveBeenCalledWith(CHANNEL, { level: 'all' });
    expect(clientOrigins).toContain(REMOTE);
  });

  it('clears the channel level with the space default row', async () => {
    seed([setting({ channelId: CHANNEL, level: 'all' })]);
    openPopover();
    fireEvent.click(screen.getByRole('radio', { name: 'Space default (Only @mentions)' }));
    await waitFor(() => expect(updateChannel).toHaveBeenCalledWith(CHANNEL, { level: null }));
  });

  it('does not write when the selected level is chosen again', () => {
    openPopover();
    fireEvent.click(screen.getByRole('radio', { name: 'Space default (Only @mentions)' }));
    expect(updateChannel).not.toHaveBeenCalled();
  });

  it('mutes for a duration, then shows the end and an Unmute button', async () => {
    openPopover();
    fireEvent.click(screen.getByRole('button', { name: 'For 8 hours' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unmute' })).toBeInTheDocument());
    expect(updateChannel).toHaveBeenCalledWith(CHANNEL, { mute: '8h' });
    expect(screen.getByText(/^Muted until /)).toBeInTheDocument();
    // The bell turns into the muted bell.
    expect(screen.getByTitle('Notification Settings (Muted)')).toBeInTheDocument();
  });

  it('shows an indefinite mute and lifts it with Unmute', async () => {
    seed([setting({ channelId: CHANNEL, muted: true, mutedUntil: null })]);
    openPopover();
    expect(screen.getByText('Muted until you unmute')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'For 1 hour' })).toBeInTheDocument());
    expect(updateChannel).toHaveBeenCalledWith(CHANNEL, { mute: null });
  });

  it('says so when the whole space is muted', () => {
    seed([setting({ muted: true, mutedUntil: null })]);
    openPopover();
    expect(screen.getByText('This space is muted, so its channels are too.')).toBeInTheDocument();
  });

  it('shows a toast and keeps the old choice when the write fails', async () => {
    updateChannel.mockRejectedValue(new Error('offline'));
    openPopover();
    fireEvent.click(screen.getByRole('radio', { name: 'Nothing' }));
    await waitFor(() => expect(useUIStore.getState().toasts.map((t) => t.message)).toContain('Could not save notification settings'));
    expect(screen.getByRole('radio', { name: 'Space default (Only @mentions)' })).toHaveAttribute('aria-checked', 'true');
  });

  it('moves the choice with the arrow keys', async () => {
    openPopover();
    const selected = screen.getByRole('radio', { name: 'Space default (Only @mentions)' });
    fireEvent.keyDown(selected, { key: 'ArrowDown' });
    await waitFor(() => expect(updateChannel).toHaveBeenCalledWith(CHANNEL, { level: 'all' }));
  });

  it('closes on Escape and on a click outside', () => {
    openPopover();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Notification Settings'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not open for a channel no listing has named yet', () => {
    useSpaceStore.setState({ channelToSpaceMap: new Map(), channelOriginMap: new Map() });
    render(<ChannelNotificationButton channelId="unknown" channelName="unknown" />);
    fireEvent.click(screen.getByTitle('Notification Settings'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('ChannelMutedIndicator', () => {
  it('shows for a muted channel and for a channel of a muted space', () => {
    seed([setting({ channelId: CHANNEL, muted: true, mutedUntil: null })]);
    const { rerender } = render(<ChannelMutedIndicator channelId={CHANNEL} />);
    expect(screen.getByRole('img', { name: 'Muted' })).toBeInTheDocument();
    act(() => seed([setting({ muted: true, mutedUntil: null })]));
    rerender(<ChannelMutedIndicator channelId={CHANNEL} />);
    expect(screen.getByRole('img', { name: 'Muted' })).toBeInTheDocument();
  });

  it('is absent for an unmuted channel', () => {
    seed([setting({ channelId: CHANNEL, level: 'nothing' })]);
    render(<ChannelMutedIndicator channelId={CHANNEL} />);
    expect(screen.queryByRole('img', { name: 'Muted' })).not.toBeInTheDocument();
  });

  it('goes away by itself when a timed mute ends', () => {
    vi.useFakeTimers();
    try {
      act(() => useNotificationSettingsStore.getState().apply(REMOTE, setting({ channelId: CHANNEL, muted: true, mutedUntil: Date.now() + HOUR })));
      render(<ChannelMutedIndicator channelId={CHANNEL} />);
      expect(screen.getByRole('img', { name: 'Muted' })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(HOUR + 10));
      expect(screen.queryByRole('img', { name: 'Muted' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('NotificationSettingsModal for a space', () => {
  it('offers the three levels without a default row and writes through the space route', async () => {
    render(
      <NotificationSettingsModal
        target={{ kind: 'space', origin: REMOTE, spaceId: SPACE, spaceName: 'Space One' }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Notifications for Space One')).toBeInTheDocument();
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['All messages', 'Only @mentions', 'Nothing']);
    expect(screen.getByRole('radio', { name: 'Only @mentions' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Until I unmute' }));
    await waitFor(() => expect(updateSpace).toHaveBeenCalledWith(SPACE, { mute: 'indefinite' }));
    expect(updateChannel).not.toHaveBeenCalled();
  });
});


describe('mass mention settings controls', () => {
  it('writes a space suppression preference to its hosting origin', async () => {
    render(<NotificationSettingsControls origin={REMOTE} spaceId={SPACE} channelId={null} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Suppress @everyone and @here' });
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(updateSpace).toHaveBeenCalledWith(SPACE, { suppressEveryone: true });
    expect(clientOrigins).toContain(REMOTE);
    expect(updateChannel).not.toHaveBeenCalled();
  });
  it('keeps suppression controls out of channel overrides', () => {
    openPopover();
    expect(screen.queryByRole('checkbox', { name: 'Suppress role mentions' })).not.toBeInTheDocument();
  });
  it('reports a failed save without silently changing the preference', async () => {
    updateSpace.mockRejectedValue(new Error('offline'));
    render(<NotificationSettingsControls origin={REMOTE} spaceId={SPACE} channelId={null} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Suppress role mentions' });
    fireEvent.click(checkbox);
    await waitFor(() => expect(useUIStore.getState().toasts).toHaveLength(1));
    expect(checkbox).not.toBeChecked();
  });
});
