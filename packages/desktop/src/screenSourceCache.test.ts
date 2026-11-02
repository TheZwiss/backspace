import { describe, expect, it, vi } from 'vitest';
import { ScreenSourceCache } from './screenSourceCache';

interface Source {
  id: string;
  name: string;
  thumbnailDataUrl: string;
}

const source = (id: string, name: string, thumbnailDataUrl = ''): Source => ({
  id,
  name,
  thumbnailDataUrl,
});

describe('ScreenSourceCache', () => {
  it('preserves pixels across metadata scans for the same source identity', async () => {
    const cache = new ScreenSourceCache<Source>();
    await cache.refresh(async () => [source('window:1', 'Editor', 'data:image/png;base64,pixels')]);

    const updated = await cache.refresh(async () => [source('window:1', 'Editor')]);

    expect(updated).toEqual([source('window:1', 'Editor', 'data:image/png;base64,pixels')]);
  });

  it('does not carry pixels across renamed or removed sources', async () => {
    const cache = new ScreenSourceCache<Source>();
    await cache.refresh(async () => [source('window:1', 'Old name', 'old-pixels'), source('window:2', 'Gone', 'gone-pixels')]);

    const updated = await cache.refresh(async () => [source('window:1', 'New name')]);

    expect(updated).toEqual([source('window:1', 'New name')]);
    expect(cache.read()).toEqual(updated);
  });

  it('shares an in-flight scan between simultaneous callers', async () => {
    const cache = new ScreenSourceCache<Source>();
    let finish!: (sources: Source[]) => void;
    const capture = vi.fn(() => new Promise<Source[]>(resolve => { finish = resolve; }));

    const first = cache.refresh(capture);
    const second = cache.refresh(capture);
    expect(capture).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(capture).toHaveBeenCalledTimes(1);

    finish([source('screen:0', 'Display', 'pixels')]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      [source('screen:0', 'Display', 'pixels')],
      [source('screen:0', 'Display', 'pixels')],
    ]);
  });

  it('keeps cached pixels when a full request joins an in-flight metadata scan', async () => {
    const cache = new ScreenSourceCache<Source>();
    await cache.refresh(async () => [source('window:1', 'Editor', 'previous-pixels')]);
    let finishMetadata!: (sources: Source[]) => void;
    const metadataScan = cache.refresh(() => new Promise<Source[]>(resolve => { finishMetadata = resolve; }));
    await Promise.resolve();
    const fullScan = cache.refresh(vi.fn(async () => [source('window:1', 'Editor', 'fresh-pixels')]));

    finishMetadata([source('window:1', 'Editor')]);

    const [metadataResult, fullResult] = await Promise.all([metadataScan, fullScan]);
    expect(metadataResult).toEqual([source('window:1', 'Editor', 'previous-pixels')]);
    expect(fullResult).toEqual(metadataResult);
    expect(cache.read()).toEqual(metadataResult);
  });

  it('returns no pixels to a full request joining metadata when none were cached, so the caller must retry', async () => {
    const cache = new ScreenSourceCache<Source>();
    let finishMetadata!: (sources: Source[]) => void;
    const metadataScan = cache.refresh(() => new Promise<Source[]>(resolve => { finishMetadata = resolve; }));
    await Promise.resolve();
    const fullScan = cache.refresh(vi.fn(async () => [source('window:1', 'Editor', 'fresh-pixels')]));

    finishMetadata([source('window:1', 'Editor')]);

    const [metadataResult, fullResult] = await Promise.all([metadataScan, fullScan]);
    expect(metadataResult).toEqual([source('window:1', 'Editor')]);
    expect(fullResult).toEqual(metadataResult);

    // The renderer schedules another thumbnails:true request after an
    // all-empty response; once this shared scan settles, that retry can capture pixels.
    await expect(cache.refresh(async () => [source('window:1', 'Editor', 'fresh-pixels')]))
      .resolves.toEqual([source('window:1', 'Editor', 'fresh-pixels')]);
  });

  it('keeps the previous cache on failure and allows a later retry', async () => {
    const cache = new ScreenSourceCache<Source>();
    const original = [source('screen:0', 'Display', 'pixels')];
    await cache.refresh(async () => original);

    await expect(cache.refresh(async () => { throw new Error('capture failed'); })).rejects.toThrow('capture failed');
    expect(cache.read()).toEqual(original);

    await expect(cache.refresh(async () => [source('screen:0', 'Display', 'new-pixels')]))
      .resolves.toEqual([source('screen:0', 'Display', 'new-pixels')]);
  });

  it('does not restore pixels when an in-flight scan finishes after clear', async () => {
    const cache = new ScreenSourceCache<Source>();
    let finish!: (sources: Source[]) => void;
    const scan = cache.refresh(() => new Promise<Source[]>(resolve => { finish = resolve; }));
    await Promise.resolve();

    cache.clear();
    finish([source('screen:0', 'Display', 'pixels')]);

    await expect(scan).resolves.toEqual([]);
    expect(cache.read()).toEqual([]);
    await expect(cache.refresh(async () => [source('screen:0', 'Display', 'fresh')]))
      .resolves.toEqual([source('screen:0', 'Display', 'fresh')]);
  });

  it('prevents an old scan from restoring enumeration globals or a cache timestamp after clear', async () => {
    const cache = new ScreenSourceCache<Source>();
    let lastScreenSources = ['before-clear'];
    let lastEnumeratedAt: number | null = 100;
    const generation = cache.generationToken;
    let finish!: (sources: Source[]) => void;
    const scan = cache.refresh(() => new Promise<Source[]>(resolve => { finish = resolve; }).then(sources => {
      cache.commitIfCurrent(generation, () => { lastScreenSources = ['late-scan']; });
      cache.commitIfCurrent(generation, () => { lastEnumeratedAt = 200; });
      return sources;
    }));
    await Promise.resolve();

    lastScreenSources = [];
    lastEnumeratedAt = null;
    cache.clear();
    finish([source('screen:0', 'Display', 'pixels')]);

    await expect(scan).resolves.toEqual([]);
    expect(lastScreenSources).toEqual([]);
    expect(lastEnumeratedAt).toBeNull();
    expect(cache.read()).toEqual([]);
  });
});
