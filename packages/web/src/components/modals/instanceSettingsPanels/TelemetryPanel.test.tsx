import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TelemetryPanel } from './TelemetryPanel';
import { useSettingsStore } from '../../../stores/settingsStore';
import { api } from '../../../api/client';

const off = { enabled: false, id: null, lastDay: null, lastError: null };
const on = { enabled: true, id: '3f6c9e2a-1b2c-4d5e-8f90-1234567890ab', lastDay: '2026-09-06', lastError: null };
const never = { enabled: null, id: null, lastDay: null, lastError: null };

/** The mood the scene stands in, which is this panel's state as a picture. */
function moodOf(container: HTMLElement): string | null {
  return container.querySelector('svg[data-mood]')?.getAttribute('data-mood') ?? null;
}

beforeEach(() => {
  useSettingsStore.setState({ telemetry: null, telemetryPreview: null });
  vi.spyOn(api.admin.telemetry, 'preview').mockResolvedValue({ schema: 1, instance: 'preview' } as never);
});

describe('TelemetryPanel', () => {
  it('shows the state, the masked id and the last day when on', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(on);
    render(<TelemetryPanel />);
    expect(await screen.findByText('On')).toBeInTheDocument();
    expect(screen.getByText(/3f6c9e2a/)).toBeInTheDocument();
    expect(screen.queryByText(/1234567890ab/)).not.toBeInTheDocument();
    expect(screen.getByText(/Last hello sent on/)).toBeInTheDocument();
  });

  it('toggles through the API', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(off);
    const set = vi.spyOn(api.admin.telemetry, 'set').mockResolvedValue(on);
    render(<TelemetryPanel />);
    await screen.findByText('Off');
    await userEvent.click(screen.getByRole('switch'));
    expect(set).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.getByText('On')).toBeInTheDocument());
  });

  it('shows the last error', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue({ ...on, lastError: { day: '2026-09-07', status: 503 } });
    render(<TelemetryPanel />);
    expect(await screen.findByText(/status 503/)).toBeInTheDocument();
  });

  it('renders the preview JSON', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(off);
    render(<TelemetryPanel />);
    expect(await screen.findByText(/"instance": "preview"/)).toBeInTheDocument();
  });

  it('says nothing was asked yet before an answer', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue({ enabled: null, id: null, lastDay: null, lastError: null });
    render(<TelemetryPanel />);
    expect(await screen.findByText('Never asked')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps the toggle on the server state when saving fails', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(off);
    vi.spyOn(api.admin.telemetry, 'set').mockRejectedValue(new Error('Nope'));
    const { container } = render(<TelemetryPanel />);
    await screen.findByText('Off');
    await userEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(moodOf(container), 'the scene lit up for a save the server refused').toBe('farewell');
  });

  it('refetches the preview on demand', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(off);
    const preview = vi.mocked(api.admin.telemetry.preview);
    render(<TelemetryPanel />);
    await screen.findByText('Off');
    await waitFor(() => expect(preview.mock.calls.length).toBeGreaterThan(0));
    const onMount = preview.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(preview.mock.calls.length).toBe(onMount + 1));
  });

  it('says the state twice, once in words and once in the scene', async () => {
    const get = vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(on);

    const lit = render(<TelemetryPanel />);
    await screen.findByText('On');
    expect(moodOf(lit.container)).toBe('happy');
    lit.unmount();

    useSettingsStore.setState({ telemetry: null, telemetryPreview: null });
    get.mockResolvedValue(off);
    const dark = render(<TelemetryPanel />);
    await screen.findByText('Off');
    expect(moodOf(dark.container)).toBe('farewell');
    dark.unmount();

    useSettingsStore.setState({ telemetry: null, telemetryPreview: null });
    get.mockResolvedValue(never);
    const waiting = render(<TelemetryPanel />);
    await screen.findByText('Never asked');
    expect(moodOf(waiting.container)).toBe('idle');
  });

  it('lights the beam when the switch goes on', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(off);
    vi.spyOn(api.admin.telemetry, 'set').mockResolvedValue(on);
    const { container } = render(<TelemetryPanel />);
    await screen.findByText('Off');
    expect(moodOf(container)).toBe('farewell');

    await userEvent.click(screen.getByRole('switch'));

    await waitFor(() => expect(screen.getByText('On')).toBeInTheDocument());
    expect(moodOf(container)).toBe('happy');
  });

  it('links to the document that says what is sent', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(off);
    render(<TelemetryPanel />);
    const link = await screen.findByRole('link', { name: 'What is sent and why' });
    expect(link).toHaveAttribute('href', 'https://github.com/TheZwiss/backspace/blob/main/docs/systems/telemetry.md');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});
