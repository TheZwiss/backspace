import { describe, it, expect } from 'vitest';
import { pickAutoStageSource } from './screenShareSources';

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
