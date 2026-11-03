import { describe, expect, it } from 'vitest';
import { shouldRenderLocalScreenPreview } from './localScreenPreview';
describe('local preview focus policy', () => {
  it.each(['monitor', 'window', 'browser'])('resumes %s captures only in focus', displaySurface => {
    const track = { readyState: 'live', getSettings: () => ({ displaySurface }) } as MediaStreamTrack;
    expect(shouldRenderLocalScreenPreview(track, true)).toBe(true);
    expect(shouldRenderLocalScreenPreview(track, false)).toBe(false);
  });
  it('does not render absent or ended tracks', () => {
    expect(shouldRenderLocalScreenPreview(null, true)).toBe(false);
    expect(shouldRenderLocalScreenPreview({ readyState: 'ended' } as MediaStreamTrack, true)).toBe(false);
  });
});
