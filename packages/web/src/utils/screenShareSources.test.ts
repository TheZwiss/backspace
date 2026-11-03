import { describe, it, expect } from 'vitest';
import { mergeScreenSources, pickAutoStageSource, sameScreenSources } from './screenShareSources';

const screenA: ElectronScreenSource = { id: 'screen:0:0', name: 'Built-in Display', thumbnailDataUrl: '', appIconDataUrl: null, isScreen: true };
const screenB: ElectronScreenSource = { id: 'screen:1:0', name: 'DELL U2720Q', thumbnailDataUrl: '', appIconDataUrl: null, isScreen: true };
const windowA: ElectronScreenSource = { id: 'window:4711:0', name: 'Firefox', thumbnailDataUrl: '', appIconDataUrl: null, isScreen: false };

describe('pickAutoStageSource', () => {
  it('stages the source shared last time', () => {
    expect(pickAutoStageSource([screenA, screenB, windowA], 'screen:1:0', 'screens')).toBe(screenB);
  });

  it('stages a remembered window whichever tab is showing', () => {
    expect(pickAutoStageSource([screenA, windowA], 'window:4711:0', 'screens')).toBe(windowA);
  });

  it('ignores a remembered id that is gone, as window ids are after a restart', () => {
    expect(pickAutoStageSource([screenA, screenB], 'window:4711:0', 'screens')).toBeNull();
  });

  it('falls back to the only screen', () => {
    expect(pickAutoStageSource([screenA, windowA], null, 'screens')).toBe(screenA);
  });

  it('picks nothing when there is a choice of screens to make', () => {
    expect(pickAutoStageSource([screenA, screenB], null, 'screens')).toBeNull();
  });

  it('does not stage the lone screen from the Windows tab', () => {
    expect(pickAutoStageSource([screenA, windowA], null, 'windows')).toBeNull();
  });

  it('picks nothing before the enumeration has arrived', () => {
    expect(pickAutoStageSource([], 'screen:0:0', 'screens')).toBeNull();
  });
});
describe('mergeScreenSources', () => {
  const thumb = 'data:image/png;base64,AAAA';
  const windowWithThumb: ElectronScreenSource = { ...windowA, thumbnailDataUrl: thumb };

  it('adds a window that appeared while the screen was open, in front', () => {
    const late: ElectronScreenSource = { id: 'window:9000:0', name: 'Brave', thumbnailDataUrl: '', appIconDataUrl: null, isScreen: false };
    const merged = mergeScreenSources([screenA, windowA], [screenA, windowA, late]);
    expect(merged.map((s) => s.id)).toEqual(['window:9000:0', 'screen:0:0', 'window:4711:0']);
  });

  it('drops a window that closed', () => {
    const merged = mergeScreenSources([screenA, windowA], [screenA]);
    expect(merged.map((s) => s.id)).toEqual(['screen:0:0']);
  });

  it('keeps the decoded thumbnail when a cheap poll sends none', () => {
    const merged = mergeScreenSources([windowWithThumb], [{ ...windowA, thumbnailDataUrl: '' }]);
    expect(merged[0]!.thumbnailDataUrl).toBe(thumb);
  });

  it('keeps a tile in its slot when the enumerator reorders the list', () => {
    const merged = mergeScreenSources([screenA, screenB, windowA], [windowA, screenB, screenA]);
    expect(merged.map((s) => s.id)).toEqual(['screen:0:0', 'screen:1:0', 'window:4711:0']);
  });

  it('takes a new name for a known id', () => {
    const merged = mergeScreenSources([windowA], [{ ...windowA, name: 'Firefox — Private' }]);
    expect(merged[0]!.name).toBe('Firefox — Private');
  });

  it('survives an empty previous list', () => {
    expect(mergeScreenSources([], [screenA]).map((s) => s.id)).toEqual(['screen:0:0']);
  });

  it('reports whether the grid would change', () => {
    expect(sameScreenSources([screenA], [screenA])).toBe(true);
    expect(sameScreenSources([screenA], [screenB])).toBe(false);
    expect(sameScreenSources([screenA], [screenA, windowA])).toBe(false);
  });
});
