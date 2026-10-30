import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isGifAvatar, useStaticAvatar } from './staticAvatar';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('static GIF avatars', () => {
  it('recognizes local and federated GIF URLs with query strings', () => {
    expect(isGifAvatar('/api/uploads/face.GIF?v=2')).toBe(true);
    expect(isGifAvatar('https://peer.example/face.gif?token=test')).toBe(true);
    expect(isGifAvatar('/api/uploads/face.webp')).toBe(false);
  });

  it('shares a still and switches to the original only while animation is allowed', async () => {
    const images: Array<{ onload: (() => void) | null }> = [];
    class FakeImage {
      crossOrigin = '';
      naturalWidth = 320;
      naturalHeight = 160;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { images.push(this); }
    }
    vi.stubGlobal('Image', FakeImage);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,still');
    const url = '/api/uploads/static-avatar-test.gif';
    const one = renderHook(({ animate }) => useStaticAvatar(url, animate), { initialProps: { animate: false } });
    const two = renderHook(() => useStaticAvatar(url, false));
    expect(images).toHaveLength(1);
    expect(one.result.current).toBeNull();
    act(() => images[0].onload?.());
    await waitFor(() => expect(one.result.current).toBe('data:image/png;base64,still'));
    expect(two.result.current).toBe('data:image/png;base64,still');
    expect(drawImage).toHaveBeenCalledTimes(1);
    one.rerender({ animate: true });
    expect(one.result.current).toBe(url);
    expect(two.result.current).toBe('data:image/png;base64,still');
    one.rerender({ animate: false });
    expect(one.result.current).toBe('data:image/png;base64,still');
  });
});
