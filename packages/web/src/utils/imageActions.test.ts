import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../stores/uiStore', () => ({
  useUIStore: {
    getState: vi.fn(() => ({
      addToast: vi.fn(),
    })),
  },
}));

import { saveImage, copyImageToClipboard } from './imageActions';
import { useUIStore } from '../stores/uiStore';

describe('saveImage', () => {
  let createElementSpy: ReturnType<typeof vi.spyOn>;
  let mockAnchor: { href: string; download: string; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockAnchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(mockAnchor as any);
    vi.spyOn(document.body, 'appendChild').mockImplementation((node) => node);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches image as blob and triggers download for same-origin URLs', async () => {
    const mockBlob = new Blob(['img'], { type: 'image/png' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(mockBlob));

    await saveImage('/api/uploads/abc123_photo.png');

    expect(fetch).toHaveBeenCalledWith('/api/uploads/abc123_photo.png');
    expect(URL.createObjectURL).toHaveBeenCalledWith(mockBlob);
    expect(mockAnchor.download).toBe('abc123_photo.png');
    expect(mockAnchor.click).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('uses provided filename when given', async () => {
    const mockBlob = new Blob(['img'], { type: 'image/png' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(mockBlob));

    await saveImage('/api/uploads/abc123.png', 'my-photo.png');

    expect(mockAnchor.download).toBe('my-photo.png');
  });

  it('falls back to window.open on CORS/fetch error and shows toast', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const mockAddToast = vi.fn();
    vi.mocked(useUIStore.getState).mockReturnValue({ addToast: mockAddToast } as any);

    await saveImage('https://media.tenor.com/abc/tenor.gif');

    expect(openSpy).toHaveBeenCalledWith('https://media.tenor.com/abc/tenor.gif', '_blank', 'noopener');
    expect(mockAddToast).toHaveBeenCalledWith('Opened in new tab', 'info', 3000);
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

  it('falls back to copying URL as text on failure and shows toast', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('CORS'));
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { write: vi.fn(), writeText: mockWriteText },
    });
    const mockAddToast = vi.fn();
    vi.mocked(useUIStore.getState).mockReturnValue({ addToast: mockAddToast } as any);

    await copyImageToClipboard('https://external.com/image.jpg');

    expect(mockWriteText).toHaveBeenCalledWith('https://external.com/image.jpg');
    expect(mockAddToast).toHaveBeenCalledWith('Copied image link', 'info', 3000);
  });
});
