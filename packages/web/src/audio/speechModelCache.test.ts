// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./speechModels.json', () => ({ default: [
  { id: 'base', repo: 'test/base', revision: 'pinned-a', assets: [{ path: 'config.json', bytes: 3, hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }] },
  { id: 'large-v3', repo: 'test/large-v3', revision: 'pinned-b', assets: [{ path: 'config.json', bytes: 3, hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }] },
] }));
import { installedSpeechModels, installSpeechModel, removeSpeechModel, speechModelCacheName } from './speechModelCache';
let buckets: Map<string, Map<string, Response>>;
const download = vi.fn();
beforeEach(() => {
  buckets = new Map();
  vi.stubGlobal('fetch', download); download.mockReset(); download.mockImplementation(async () => new Response('abc'));
  vi.stubGlobal('caches', {
    keys: async () => [...buckets.keys()],
    delete: async (name: string) => buckets.delete(name),
    open: async (name: string) => {
      if (!buckets.has(name)) buckets.set(name, new Map()); const bucket = buckets.get(name)!;
      return { match: async (url: string) => bucket.get(url)?.clone(), delete: async (url: string) => bucket.delete(url), put: async (url: string, response: Response) => { const data = await response.arrayBuffer(); bucket.set(url, new Response(data)); } };
    },
  });
});
it('downloads a pinned file, checks its SHA256, and persists the completion marker', async () => {
  const progress = vi.fn(); await installSpeechModel('base', new AbortController().signal, progress);
  expect(download.mock.calls[0]![0]).toBe('https://huggingface.co/test/base/resolve/pinned-a/config.json');
  expect(await installedSpeechModels()).toEqual(['base']); expect(progress).toHaveBeenLastCalledWith(100);
  await installSpeechModel('base', new AbortController().signal, progress); expect(download).toHaveBeenCalledOnce();
});
it('never marks corrupt or incomplete bytes as an installed model', async () => {
  download.mockResolvedValueOnce(new Response('bad'));
  await expect(installSpeechModel('base', new AbortController().signal, vi.fn())).rejects.toThrow('download-integrity');
  expect(await installedSpeechModels()).toEqual([]);
  expect(buckets.get(speechModelCacheName('base'))!.size).toBe(0);
});
it('deletes only the chosen app-owned model cache and rejects arbitrary identifiers', async () => {
  await installSpeechModel('base', new AbortController().signal, vi.fn());
  await installSpeechModel('large-v3', new AbortController().signal, vi.fn());
  buckets.set('unrelated-user-models', new Map());
  await expect(removeSpeechModel('../unrelated-user-models')).rejects.toThrow('invalid-model');
  await removeSpeechModel('base');
  expect(await installedSpeechModels()).toEqual(['large-v3']); expect(buckets.has('unrelated-user-models')).toBe(true);
});
it('cancelled download never fetches or creates an installed model', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(installSpeechModel('base', controller.signal, vi.fn())).rejects.toThrow();
  expect(download).not.toHaveBeenCalled(); expect(await installedSpeechModels()).toEqual([]);
});
