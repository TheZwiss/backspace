import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The startup load of the shortcode names can fail or stall (#330 review).
// The app then renders with shortcodes as typed; whenever emoji-mart's data
// arrives later, from any caller (a retry, the picker), the names fill in and
// text already drawn is drawn again converted.

afterEach(() => {
  cleanup();
  vi.doUnmock('@emoji-mart/data');
  vi.resetModules();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shortcode names that arrive after the first render', () => {
  it('converts text already on screen once the picker loads the data after a failed startup load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempts = 0;
    vi.doMock('@emoji-mart/data', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('the chunk failed to load');
      return vi.importActual('@emoji-mart/data');
    });
    vi.resetModules();
    const shortcodes = await import('./emojiShortcodes');
    const emojiData = await import('./emojiData');
    const { ProfileBio } = await import('../components/ui/ProfileBio');
    const { ActivityCard } = await import('../components/ui/ActivityCard');

    await shortcodes.loadEmojiShortcodeNames();
    render(
      <>
        <ProfileBio bio="tide :ocean:" />
        <ActivityCard activities={[]} fallbackCustomStatus="out :crab:" />
      </>,
    );
    expect(screen.getByText('tide :ocean:')).toBeInTheDocument();
    expect(screen.getByText('out :crab:')).toBeInTheDocument();

    // The emoji picker opens and loads the same data.
    await act(async () => { await emojiData.loadEmojiData(); });

    expect(screen.getByText('tide 🌊')).toBeInTheDocument();
    expect(screen.getByText('out 🦀')).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('gives up waiting after the time limit when the data chunk stalls, and converts when it arrives', async () => {
    let arrive: () => void = () => {};
    const arrived = new Promise<void>((resolve) => { arrive = resolve; });
    vi.doMock('@emoji-mart/data', async () => {
      await arrived;
      return vi.importActual('@emoji-mart/data');
    });
    vi.resetModules();
    vi.useFakeTimers();
    const shortcodes = await import('./emojiShortcodes');
    const { ProfileBio } = await import('../components/ui/ProfileBio');

    let ready = false;
    void shortcodes.waitForEmojiShortcodeNames(1000).then(() => { ready = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ready).toBe(true);

    vi.useRealTimers();
    render(<ProfileBio bio="tide :ocean:" />);
    expect(screen.getByText('tide :ocean:')).toBeInTheDocument();

    await act(async () => {
      arrive();
      await shortcodes.loadEmojiShortcodeNames();
    });
    expect(screen.getByText('tide 🌊')).toBeInTheDocument();
  });
});
