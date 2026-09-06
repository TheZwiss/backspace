import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TelemetryPayload } from '@backspace/shared';
import { HelloModal } from './HelloModal';
import { FAREWELL_WAVE_MS } from './scene/useSceneAnimation';

vi.mock('./scene/HelloScene', () => ({
  HelloScene: ({ mood }: { mood: string }) => <div data-testid="scene" data-mood={mood} />,
}));

const preview: TelemetryPayload = {
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

/** The class list without the colour utilities, so the two buttons can be compared on size and weight. */
function shape(button: HTMLElement): string {
  return button.className
    .split(' ')
    .filter((cls) => !cls.startsWith('bg-') && !cls.startsWith('hover:') && cls !== 'text-white' && !cls.startsWith('text-txt-'))
    .join(' ');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HelloModal', () => {
  it('shows the ask with two equal buttons and the preview', async () => {
    render(<HelloModal open onAnswer={vi.fn().mockResolvedValue(undefined)} onDismiss={vi.fn()} preview={preview} />);

    expect(screen.getByText("Hi. It's Jannis. I built this.")).toBeInTheDocument();
    const yes = screen.getByRole('button', { name: 'Say hi' });
    const no = screen.getByRole('button', { name: 'No thanks' });
    expect(shape(yes)).toBe(shape(no));
    expect(yes.className).not.toBe(no.className);

    await userEvent.click(screen.getByRole('button', { name: 'Show the message' }));
    expect(screen.getByText(/"instance": "preview"/)).toBeInTheDocument();
    expect(screen.getByTestId('scene')).toHaveAttribute('data-mood', 'idle');
  });

  it('saves before switching to the happy state', async () => {
    let resolve!: () => void;
    const onAnswer = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<HelloModal open onAnswer={onAnswer} onDismiss={vi.fn()} preview={preview} />);

    await userEvent.click(screen.getByRole('button', { name: 'Say hi' }));
    expect(onAnswer).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('scene')).toHaveAttribute('data-mood', 'idle');

    resolve();
    expect(await screen.findByText('Signal acquired.')).toBeInTheDocument();
    expect(screen.getByTestId('scene')).toHaveAttribute('data-mood', 'happy');
  });

  it('shows the farewell after no, with a close button', async () => {
    render(<HelloModal open onAnswer={vi.fn().mockResolvedValue(undefined)} onDismiss={vi.fn()} preview={preview} />);

    await userEvent.click(screen.getByRole('button', { name: 'No thanks' }));
    expect(await screen.findByText('Understood.')).toBeInTheDocument();
    expect(screen.getByTestId('scene')).toHaveAttribute('data-mood', 'farewell');
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
  });

  it('closes the farewell once the wave has finished', async () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<HelloModal open onAnswer={vi.fn().mockResolvedValue(undefined)} onDismiss={onDismiss} preview={preview} />);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'No thanks' })); });
    expect(screen.getByText('Understood.')).toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(FAREWELL_WAVE_MS); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('closes the farewell on a click anywhere in it', async () => {
    const onDismiss = vi.fn();
    render(<HelloModal open onAnswer={vi.fn().mockResolvedValue(undefined)} onDismiss={onDismiss} preview={preview} />);

    await userEvent.click(screen.getByRole('button', { name: 'No thanks' }));
    await userEvent.click(await screen.findByText('Understood.'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('shows an error and stays on the ask when saving fails', async () => {
    render(<HelloModal open onAnswer={vi.fn().mockRejectedValue(new Error('x'))} onDismiss={vi.fn()} preview={preview} />);

    await userEvent.click(screen.getByRole('button', { name: 'Say hi' }));
    expect(await screen.findByText(/could not be saved/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Say hi' })).toBeEnabled();
    expect(screen.getByTestId('scene')).toHaveAttribute('data-mood', 'idle');
  });

  it('ignores a dismissal while the answer is being saved', async () => {
    let resolve!: () => void;
    const onAnswer = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const onDismiss = vi.fn();
    render(<HelloModal open onAnswer={onAnswer} onDismiss={onDismiss} preview={preview} />);

    await userEvent.click(screen.getByRole('button', { name: 'Say hi' }));
    await userEvent.keyboard('{Escape}');
    expect(onDismiss).not.toHaveBeenCalled();

    resolve();
    expect(await screen.findByText('Signal acquired.')).toBeInTheDocument();
  });

  it('calls onDismiss for the later link and for Escape', async () => {
    const onDismiss = vi.fn();
    render(<HelloModal open onAnswer={vi.fn().mockResolvedValue(undefined)} onDismiss={onDismiss} preview={preview} />);

    await userEvent.click(screen.getByRole('button', { name: 'Decide later' }));
    await userEvent.keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('waits for the preview instead of showing an empty message', async () => {
    render(<HelloModal open onAnswer={vi.fn().mockResolvedValue(undefined)} onDismiss={vi.fn()} preview={null} />);

    await userEvent.click(screen.getByRole('button', { name: 'Show the message' }));
    expect(screen.getByText('Putting the message together')).toBeInTheDocument();
  });
});
