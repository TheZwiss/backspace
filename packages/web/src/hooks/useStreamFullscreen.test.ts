import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useStreamFullscreen } from './useStreamFullscreen';
function setup() {
 const container = document.createElement('div');
 const video = document.createElement('video'); container.append(video);
 const hook = renderHook(() => useStreamFullscreen({ current: video }));
 return { container, video, ...hook };
}
describe('stream fullscreen', () => {
 it('requests native fullscreen immediately from the gesture', async () => {
  const s = setup(); const request = vi.fn().mockResolvedValue(undefined); s.container.requestFullscreen = request;
  await act(async () => { s.result.current.toggle(); expect(request).toHaveBeenCalledOnce(); });
  expect(s.result.current.active).toBe(true);
 });
 it('uses the iPhone video API when container fullscreen is unavailable', () => {
  const s = setup(); const enter = vi.fn(); Object.assign(s.video, { webkitEnterFullscreen: enter });
  act(() => s.result.current.toggle()); expect(enter).toHaveBeenCalledOnce();
  act(() => s.video.dispatchEvent(new Event('webkitendfullscreen')));
  expect(s.result.current.active).toBe(false);
 });
 it('expands inside the page after refusal and lets the user exit', async () => {
  const s = setup(); s.container.requestFullscreen = vi.fn().mockRejectedValue(new Error('Denied'));
  await act(async () => s.result.current.toggle()); expect(s.result.current.expanded).toBe(true);
  act(() => s.result.current.toggle()); expect(s.result.current.expanded).toBe(false);
 });
});
