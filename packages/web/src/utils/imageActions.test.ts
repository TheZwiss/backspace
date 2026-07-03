import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../stores/uiStore', () => ({
  useUIStore: {
    getState: vi.fn(() => ({
      addToast: vi.fn(),
    })),
  },
}));

const mockStartDownload = vi.fn();
const mockGet = vi.fn();

vi.mock('../stores/transferStore', () => ({
  useTransferStore: {
    getState: vi.fn(() => ({
      startDownload: mockStartDownload,
      get: mockGet,
    })),
  },
}));

import { saveImage, copyImageToClipboard } from './imageActions';
import { useUIStore } from '../stores/uiStore';

describe('saveImage', () => {
  beforeEach(() => {
    mockStartDownload.mockReset();
    mockGet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes downloads through transferStore.startDownload with derived filename', async () => {
    mockStartDownload.mockResolvedValue('transfer-id-1');
    mockGet.mockReturnValue({ id: 'transfer-id-1', state: 'completed' });

    await saveImage('/api/uploads/abc123_photo.png');

    expect(mockStartDownload).toHaveBeenCalledWith('/api/uploads/abc123_photo.png', {
      filename: 'abc123_photo.png',
      mimetype: 'image/*',
      tray: true,
    });
  });

  it('uses provided filename when given', async () => {
    mockStartDownload.mockResolvedValue('transfer-id-2');
    mockGet.mockReturnValue({ id: 'transfer-id-2', state: 'completed' });

    await saveImage('/api/uploads/abc123.png', 'my-photo.png');

    expect(mockStartDownload).toHaveBeenCalledWith('/api/uploads/abc123.png', {
      filename: 'my-photo.png',
      mimetype: 'image/*',
      tray: true,
    });
  });

  it('falls back to window.open and toast when startDownload throws', async () => {
    mockStartDownload.mockRejectedValue(new TypeError('Failed to fetch'));
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const mockAddToast = vi.fn();
    vi.mocked(useUIStore.getState).mockReturnValue({ addToast: mockAddToast } as ReturnType<typeof useUIStore.getState>);

    await saveImage('https://media.tenor.com/abc/tenor.gif');

    expect(openSpy).toHaveBeenCalledWith('https://media.tenor.com/abc/tenor.gif', '_blank', 'noopener');
    expect(mockAddToast).toHaveBeenCalledWith('Opened in new tab', 'info', 3000);
  });

  it('falls back to window.open when transfer ends in failed state', async () => {
    mockStartDownload.mockResolvedValue('transfer-id-3');
    mockGet.mockReturnValue({
      id: 'transfer-id-3',
      state: 'failed',
      error: { message: 'HTTP 404', permanent: true },
    });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const mockAddToast = vi.fn();
    vi.mocked(useUIStore.getState).mockReturnValue({ addToast: mockAddToast } as ReturnType<typeof useUIStore.getState>);

    await saveImage('https://external.com/img.png');

    expect(openSpy).toHaveBeenCalledWith('https://external.com/img.png', '_blank', 'noopener');
    expect(mockAddToast).toHaveBeenCalledWith('Opened in new tab', 'info', 3000);
  });

  it('stays silent when user cancels (state aborted)', async () => {
    mockStartDownload.mockResolvedValue('transfer-id-4');
    mockGet.mockReturnValue({ id: 'transfer-id-4', state: 'aborted' });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    await saveImage('/api/uploads/cancelled.png');

    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('copyImageToClipboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches image and writes PNG blob to clipboard', async () => {
    const pngBlob = new Blob(['img'], { type: 'image/png' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(pngBlob));

    const mockWrite = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { write: mockWrite, writeText: vi.fn() },
    });

    await copyImageToClipboard('/api/uploads/photo.png');

    expect(mockWrite).toHaveBeenCalledTimes(1);
    const clipboardItem = mockWrite.mock.calls[0][0][0];
    expect(clipboardItem).toBeInstanceOf(ClipboardItem);
  });

  it('copies GIF URLs as text to preserve animation', async () => {
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { write: vi.fn(), writeText: mockWriteText },
    });
    const mockAddToast = vi.fn();
    vi.mocked(useUIStore.getState).mockReturnValue({ addToast: mockAddToast } as ReturnType<typeof useUIStore.getState>);

    await copyImageToClipboard('https://media.tenor.com/abc/tenor.gif');

    expect(mockWriteText).toHaveBeenCalledWith('https://media.tenor.com/abc/tenor.gif');
    expect(mockAddToast).toHaveBeenCalledWith('Copied GIF link', 'success', 3000);
  });

  it('falls back to copying URL as text on failure and shows toast', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('CORS'));
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { write: vi.fn(), writeText: mockWriteText },
    });
    const mockAddToast = vi.fn();
    vi.mocked(useUIStore.getState).mockReturnValue({ addToast: mockAddToast } as ReturnType<typeof useUIStore.getState>);

    await copyImageToClipboard('https://external.com/image.jpg');

    expect(mockWriteText).toHaveBeenCalledWith('https://external.com/image.jpg');
    expect(mockAddToast).toHaveBeenCalledWith('Copied image link', 'info', 3000);
  });
});
