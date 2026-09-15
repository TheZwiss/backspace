import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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

beforeEach(() => {
  detect.mockReset();
});

afterEach(cleanup);

describe('DesktopDownloadPanel', () => {
  it('offers the combined installer on Windows', async () => {
    platformIs({ os: 'windows', arch: null, archGuessed: false });
    render(<DesktopDownloadPanel version="1.2.3" />);

    const primary = await screen.findByRole('link', { name: 'Download for Windows' });
    expect(primary).toHaveAttribute(
      'href',
      `${RELEASES_URL}/download/v1.2.3/Backspace-1.2.3.exe`,
    );
  });

  it('says the architecture was assumed and keeps the other build reachable', async () => {
    platformIs({ os: 'mac', arch: 'arm64', archGuessed: true });
    render(<DesktopDownloadPanel version="1.2.3" />);

    expect(
      await screen.findByRole('link', { name: 'Download for macOS (Apple Silicon)' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/did not report/i)).toHaveTextContent('macOS disk image (Intel)');
    expect(
      screen.getByRole('link', { name: 'macOS disk image (Intel)' }),
    ).toHaveAttribute('href', `${RELEASES_URL}/download/v1.2.3/Backspace-1.2.3-x64.dmg`);
  });

  it('lists every build without a primary one on an unsupported platform', async () => {
    platformIs({ os: 'other', arch: null, archGuessed: false });
    render(<DesktopDownloadPanel version="1.2.3" />);

    expect(
      await screen.findByText('The desktop app runs on Windows, macOS and Linux.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Download for/ })).not.toBeInTheDocument();
    // The seven release builds plus the link to the releases page.
    expect(screen.getAllByRole('link')).toHaveLength(8);
  });

  it('points every link at the releases page while the version is unknown', async () => {
    platformIs({ os: 'linux', arch: 'x64', archGuessed: false });
    render(<DesktopDownloadPanel version={null} />);

    await screen.findByRole('link', { name: 'Download for Linux (AppImage, x64)' });
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('href', RELEASES_URL);
    }
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

  it('shows only the releases link until detection resolves', () => {
    detect.mockReturnValue(new Promise(() => undefined));
    render(<DesktopDownloadPanel version="1.2.3" />);

    expect(screen.getByRole('heading', { name: 'Desktop' })).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', RELEASES_URL);
  });
});
