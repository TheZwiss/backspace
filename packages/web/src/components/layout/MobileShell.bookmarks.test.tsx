import { describe, expect, it, vi } from 'vitest';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));
vi.mock('../bookmarks/MobileBookmarksScreen', () => ({ MobileBookmarksScreen: () => null }));

describe('mobileScreenMap', () => {
  it('has a bookmarks screen for the You screen to push', async () => {
    const { mobileScreenMap } = await import('./MobileShell');
    expect(mobileScreenMap['bookmarks']).toBeTypeOf('function');
  });
});
