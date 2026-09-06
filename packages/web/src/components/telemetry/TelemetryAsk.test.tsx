import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TelemetryPayload, TelemetryStatus, User } from '@backspace/shared';
import { TelemetryAsk } from './TelemetryAsk';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../api/client';
import { ASK_MAX_DISMISSALS, ASK_STORAGE_KEY, recordDismissal } from '../../utils/telemetryAsk';

vi.mock('./scene/HelloScene', () => ({ HelloScene: () => <div data-testid="scene" /> }));

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom; authStore reaches it through the voice store.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

const neverAsked: TelemetryStatus = { enabled: null, id: null, lastDay: null, lastError: null };

const previewPayload: TelemetryPayload = {
  schema: 1,
  instance: 'preview',
  day: '2026-09-06',
  build: { version: '1.1.0', commit: null, modified: false },
  users: { registered: 12, active1d: 4, active7d: 8, active30d: 12 },
  clients: { web: 8, desktop: 4, mobile: 0 },
  content: { spaces: 2, channels: 8, messages: 1200, messages7d: 90, storageMiB: 24 },
  features: { voice: true, federation: false, peers: 0, registrationOpen: true },
  runtime: { install: 'prebuilt', os: 'linux', arch: 'x64', node: 20 },
  installedAt: '2026-08-01',
};

function admin(isAdmin: boolean): User {
  return {
    id: 'u1',
    username: 'admin',
    displayName: null,
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin,
    createdAt: 0,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
  };
}

beforeEach(() => {
  localStorage.removeItem(ASK_STORAGE_KEY);
  useAuthStore.setState({ user: admin(true) });
  useSettingsStore.setState({ telemetry: null, telemetryPreview: null });
  vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(neverAsked);
  vi.spyOn(api.admin.telemetry, 'preview').mockResolvedValue(previewPayload);
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null });
});

describe('TelemetryAsk', () => {
  it('asks an admin of a never-asked instance', async () => {
    render(<TelemetryAsk />);
    expect(await screen.findByText("Hi. It's Jannis. I built this.")).toBeInTheDocument();
    await waitFor(() => expect(api.admin.telemetry.preview).toHaveBeenCalled());
  });

  it('never asks a non-admin and never fetches for them', async () => {
    useAuthStore.setState({ user: admin(false) });
    render(<TelemetryAsk />);
    await waitFor(() => expect(api.admin.telemetry.get).not.toHaveBeenCalled());
    expect(screen.queryByText(/Jannis/)).not.toBeInTheDocument();
  });

  it('never asks before anyone is signed in', async () => {
    useAuthStore.setState({ user: null });
    render(<TelemetryAsk />);
    await waitFor(() => expect(api.admin.telemetry.get).not.toHaveBeenCalled());
    expect(screen.queryByText(/Jannis/)).not.toBeInTheDocument();
  });

  it('does not ask once answered', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue({ ...neverAsked, enabled: false });
    render(<TelemetryAsk />);
    await waitFor(() => expect(api.admin.telemetry.get).toHaveBeenCalled());
    expect(screen.queryByText(/Jannis/)).not.toBeInTheDocument();
  });

  it('does not fetch the status once this browser has spent its dismissals', () => {
    for (let i = 0; i < ASK_MAX_DISMISSALS; i += 1) recordDismissal(localStorage, Date.now());

    render(<TelemetryAsk />);

    expect(api.admin.telemetry.get).not.toHaveBeenCalled();
    expect(screen.queryByText(/Jannis/)).not.toBeInTheDocument();
  });

  it('says so when the preview could not be fetched', async () => {
    vi.spyOn(api.admin.telemetry, 'preview').mockRejectedValue(new Error('offline'));

    render(<TelemetryAsk />);
    await userEvent.click(await screen.findByRole('button', { name: 'Show the message' }));

    expect(await screen.findByText(/could not be put together/i)).toBeInTheDocument();
    expect(screen.queryByText(/putting the message together/i)).not.toBeInTheDocument();
  });

  it('does not ask while snoozed', async () => {
    localStorage.setItem(ASK_STORAGE_KEY, JSON.stringify({ dismissals: 1, snoozedUntil: Date.now() + 1_000_000 }));
    render(<TelemetryAsk />);
    await waitFor(() => expect(api.admin.telemetry.get).toHaveBeenCalled());
    expect(screen.queryByText(/Jannis/)).not.toBeInTheDocument();
  });

  it('stays away for the rest of the session when the dismissal cannot be stored', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage full'); });
    render(<TelemetryAsk />);
    expect(await screen.findByText("Hi. It's Jannis. I built this.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Decide later' }));
    expect(screen.queryByText(/Jannis/)).not.toBeInTheDocument();

    act(() => { useSettingsStore.setState({ telemetry: { ...neverAsked } }); });
    expect(screen.queryByText(/Jannis/)).not.toBeInTheDocument();
  });

  it('saves the answer and does not record a dismissal when the modal then closes', async () => {
    const set = vi.spyOn(api.admin.telemetry, 'set').mockResolvedValue({ ...neverAsked, enabled: true, id: 'abc' });
    render(<TelemetryAsk />);
    expect(await screen.findByText("Hi. It's Jannis. I built this.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Say hi' }));
    expect(set).toHaveBeenCalledWith(true);
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));

    expect(screen.queryByText(/Jannis/)).not.toBeInTheDocument();
    expect(localStorage.getItem(ASK_STORAGE_KEY)).toBeNull();
  });
});
