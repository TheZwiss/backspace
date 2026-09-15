import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesktopDownloadPanel } from './DesktopDownloadPanel';
import {
  detectDesktopPlatform,
  RELEASES_URL,
  type DetectedPlatform,
} from '../../../platform/desktopDownload';

// Only the detection is mocked: the link builder is the real one, so the hrefs
// these tests assert on are the URLs a visitor would actually get.
vi.mock('../../../platform/desktopDownload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/desktopDownload')>();
  return { ...actual, detectDesktopPlatform: vi.fn() };
});

const detect = vi.mocked(detectDesktopPlatform);

function platformIs(detected: DetectedPlatform) {
  detect.mockResolvedValue(detected);
}

const asset = (file: string) => `${RELEASES_URL}/download/v1.2.3/${file}`;

/** The tile for one platform, found by the heading that names it. */
function tile(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

beforeEach(() => {
  detect.mockReset();
});

afterEach(cleanup);

describe('DesktopDownloadPanel', () => {
  it('puts the combined Windows installer in the hero and drops the Windows tile', async () => {
    platformIs({ os: 'windows', arch: null, archGuessed: false });
    render(<DesktopDownloadPanel version="1.2.3" />);

    const hero = await screen.findByRole('region', { name: 'Windows' });
    expect(hero).toHaveAttribute('data-tile', 'hero');
    expect(within(hero).getByText('This PC')).toBeInTheDocument();
    // The one installer covers both architectures, so the hero offers no choice.
    expect(within(hero).queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(within(hero).getByRole('link', { name: 'Download for Windows' })).toHaveAttribute(
      'href',
      asset('Backspace-1.2.3.exe'),
    );
    expect(within(hero).getByText('Version 1.2.3')).toBeInTheDocument();

    // Windows is the hero, so it must not also appear as a quiet tile.
    expect(screen.getAllByRole('link', { name: 'Download for Windows' })).toHaveLength(1);
    expect(tile('macOS')).toHaveAttribute('data-tile', 'quiet');
    expect(tile('Linux')).toHaveAttribute('data-tile', 'quiet');
  });

  it('preselects Apple Silicon on a guessed Mac and follows the picker', async () => {
    const user = userEvent.setup();
    platformIs({ os: 'mac', arch: 'arm64', archGuessed: true });
    render(<DesktopDownloadPanel version="1.2.3" />);

    const hero = await screen.findByRole('region', { name: 'macOS' });
    expect(within(hero).getByText('This Mac')).toBeInTheDocument();
    expect(within(hero).getByRole('radio', { name: 'Apple Silicon' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(
      screen.getByText('Your browser did not say which chip this Mac has, so Apple Silicon is preselected.'),
    ).toBeInTheDocument();

    const download = within(hero).getByRole('link', { name: 'Download for macOS' });
    expect(download).toHaveAttribute('href', asset('Backspace-1.2.3-arm64.dmg'));

    await user.click(within(hero).getByRole('radio', { name: 'Intel' }));

    expect(within(hero).getByRole('radio', { name: 'Intel' })).toHaveAttribute('aria-checked', 'true');
    expect(within(hero).getByRole('radio', { name: 'Apple Silicon' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(within(hero).getByRole('link', { name: 'Download for macOS' })).toHaveAttribute(
      'href',
      asset('Backspace-1.2.3-x64.dmg'),
    );
    // The rest of the hero is untouched by the choice.
    expect(within(hero).getByText('This Mac')).toBeInTheDocument();
    expect(within(hero).getByText('Version 1.2.3')).toBeInTheDocument();
  });

  it('omits the guessed note when the browser named the architecture', async () => {
    platformIs({ os: 'mac', arch: 'arm64', archGuessed: false });
    render(<DesktopDownloadPanel version="1.2.3" />);

    await screen.findByRole('region', { name: 'macOS' });
    expect(screen.queryByText(/preselected/)).not.toBeInTheDocument();
  });

  it('carries a format picker and an architecture picker on Linux', async () => {
    const user = userEvent.setup();
    platformIs({ os: 'linux', arch: 'x64', archGuessed: false });
    render(<DesktopDownloadPanel version="1.2.3" />);

    const hero = await screen.findByRole('region', { name: 'Linux' });
    expect(within(hero).getAllByRole('radiogroup')).toHaveLength(2);
    expect(within(hero).getByRole('link', { name: 'Download for Linux' })).toHaveAttribute(
      'href',
      asset('Backspace-1.2.3-x86_64.AppImage'),
    );

    await user.click(within(hero).getByRole('radio', { name: 'deb' }));
    expect(within(hero).getByRole('link', { name: 'Download for Linux' })).toHaveAttribute(
      'href',
      asset('Backspace-1.2.3-amd64.deb'),
    );

    await user.click(within(hero).getByRole('radio', { name: 'arm64' }));
    expect(within(hero).getByRole('link', { name: 'Download for Linux' })).toHaveAttribute(
      'href',
      asset('Backspace-1.2.3-arm64.deb'),
    );
  });

  it('moves the checked segment with the arrow keys', async () => {
    const user = userEvent.setup();
    platformIs({ os: 'mac', arch: 'arm64', archGuessed: false });
    render(<DesktopDownloadPanel version="1.2.3" />);

    const hero = await screen.findByRole('region', { name: 'macOS' });
    const appleSilicon = within(hero).getByRole('radio', { name: 'Apple Silicon' });
    appleSilicon.focus();
    await user.keyboard('{ArrowRight}');

    const intel = within(hero).getByRole('radio', { name: 'Intel' });
    expect(intel).toHaveAttribute('aria-checked', 'true');
    expect(intel).toHaveFocus();
    expect(within(hero).getByRole('link', { name: 'Download for macOS' })).toHaveAttribute(
      'href',
      asset('Backspace-1.2.3-x64.dmg'),
    );

    // The group wraps, so the same key brings the first segment back.
    await user.keyboard('{ArrowRight}');
    expect(within(hero).getByRole('radio', { name: 'Apple Silicon' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('offers three quiet tiles and no hero on an unsupported platform', async () => {
    platformIs({ os: 'other', arch: null, archGuessed: false });
    render(<DesktopDownloadPanel version="1.2.3" />);

    expect(
      await screen.findByText('The desktop app runs on Windows, macOS and Linux.'),
    ).toBeInTheDocument();

    const tiles = screen.getAllByRole('region');
    expect(tiles).toHaveLength(3);
    for (const region of tiles) expect(region).toHaveAttribute('data-tile', 'quiet');

    expect(within(tile('Windows')).getByRole('link', { name: 'Download for Windows' })).toHaveAttribute(
      'href',
      asset('Backspace-1.2.3.exe'),
    );
    expect(within(tile('macOS')).getByRole('link', { name: 'Download for macOS' })).toHaveAttribute(
      'href',
      asset('Backspace-1.2.3-arm64.dmg'),
    );
    expect(within(tile('Linux')).getByRole('link', { name: 'Download for Linux' })).toHaveAttribute(
      'href',
      asset('Backspace-1.2.3-x86_64.AppImage'),
    );
    // Three downloads plus the releases listing.
    expect(screen.getAllByRole('link')).toHaveLength(4);
  });

  it('points every link at the releases page while the version is unknown', async () => {
    platformIs({ os: 'linux', arch: 'x64', archGuessed: false });
    render(<DesktopDownloadPanel version={null} />);

    await screen.findByRole('link', { name: 'Download for Linux' });
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('href', RELEASES_URL);
    }
    expect(screen.queryByText(/Version/)).not.toBeInTheDocument();
  });

  it('opens every link in a new tab without leaking the opener', async () => {
    platformIs({ os: 'windows', arch: null, archGuessed: false });
    render(<DesktopDownloadPanel version="1.2.3" />);

    await screen.findByRole('link', { name: 'Download for Windows' });
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('shows only the footer until detection resolves', () => {
    detect.mockReturnValue(new Promise(() => undefined));
    render(<DesktopDownloadPanel version="1.2.3" />);

    expect(screen.getByRole('heading', { name: 'Desktop' })).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', RELEASES_URL);
  });
});
