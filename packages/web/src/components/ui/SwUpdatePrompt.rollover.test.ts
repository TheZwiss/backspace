import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// public/sw-rollover.js runs inside the generated service worker. It is plain
// script, so the test evaluates the real file against a fake worker scope.

const SOURCE = readFileSync(path.resolve(import.meta.dirname, '../../../public/sw-rollover.js'), 'utf8');

type LifecycleHandler = (event: { waitUntil: (promise: Promise<unknown>) => void }) => void;

class FakeCache {
  readonly entries = new Map<string, { contentType: string }>();

  keys(): Promise<{ url: string }[]> {
    return Promise.resolve([...this.entries.keys()].map((url) => ({ url })));
  }

  match(request: { url: string }): Promise<{ headers: { get: (name: string) => string | null } } | undefined> {
    const entry = this.entries.get(request.url);
    return Promise.resolve(entry && { headers: { get: () => entry.contentType } });
  }
}

class FakeCacheStorage {
  names = new Set<string>();
  stores = new Map<string, FakeCache>();
  failWith: Error | null = null;

  keys(): Promise<string[]> {
    return Promise.resolve([...this.names]);
  }

  delete(name: string): Promise<boolean> {
    this.stores.delete(name);
    return Promise.resolve(this.names.delete(name));
  }

  has(name: string): Promise<boolean> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.names.has(name));
  }

  open(name: string): Promise<FakeCache> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.names.add(name);
    const store = this.stores.get(name) ?? new FakeCache();
    this.stores.set(name, store);
    return Promise.resolve(store);
  }
}

/** One installed copy of sw-rollover.js: a worker scope with its own handlers. */
class FakeWorkerScope {
  private handlers = new Map<string, LifecycleHandler[]>();
  readonly skipWaiting = vi.fn(() => Promise.resolve());

  constructor(
    readonly caches: FakeCacheStorage,
    readonly registration: { active: object | null },
  ) {
    new Function('self', SOURCE)(this);
  }

  addEventListener(type: string, handler: LifecycleHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  /** Dispatches a lifecycle event and resolves once every waitUntil settles. */
  async dispatch(type: 'install' | 'activate'): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const handler of this.handlers.get(type) ?? []) {
      handler({ waitUntil: (promise) => { pending.push(promise); } });
    }
    await Promise.all(pending);
  }
}

let caches: FakeCacheStorage;

beforeEach(() => {
  caches = new FakeCacheStorage();
});

describe('sw-rollover', () => {
  it('skips waiting when it replaces a worker from before the prompt flow', async () => {
    const scope = new FakeWorkerScope(caches, { active: {} });
    await scope.dispatch('install');
    expect(scope.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('waits for SKIP_WAITING when the active worker already runs the prompt flow', async () => {
    const first = new FakeWorkerScope(caches, { active: {} });
    await first.dispatch('install');
    await first.dispatch('activate');

    const next = new FakeWorkerScope(caches, { active: {} });
    await next.dispatch('install');
    expect(next.skipWaiting).not.toHaveBeenCalled();
  });

  it('does not skip waiting on a first install', async () => {
    const scope = new FakeWorkerScope(caches, { active: null });
    await scope.dispatch('install');
    expect(scope.skipWaiting).not.toHaveBeenCalled();
  });

  it('does not skip waiting on a first install after the desktop app cleared its workers', async () => {
    // The desktop app clears service workers on launch but not Cache Storage,
    // so the marker can outlive the worker that wrote it.
    const earlier = new FakeWorkerScope(caches, { active: null });
    await earlier.dispatch('install');
    await earlier.dispatch('activate');

    const relaunch = new FakeWorkerScope(caches, { active: null });
    await relaunch.dispatch('install');
    expect(relaunch.skipWaiting).not.toHaveBeenCalled();
  });

  it('writes a marker cache that workbox precache cleanup does not delete', async () => {
    const scope = new FakeWorkerScope(caches, { active: null });
    await scope.dispatch('activate');
    expect(caches.names.size).toBe(1);
    const [marker] = [...caches.names];
    expect(marker).not.toContain('-precache-');
  });

  it('does not fail the install when Cache Storage throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    caches.failWith = new Error('quota');
    const scope = new FakeWorkerScope(caches, { active: {} });
    await expect(scope.dispatch('install')).resolves.toBeUndefined();
    await expect(scope.dispatch('activate')).resolves.toBeUndefined();
    expect(scope.skipWaiting).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  describe('poisoned precache', () => {
    const URL_JS = 'https://host.example/assets/index-abc.js';

    async function seed(contentType: string): Promise<void> {
      const store = await caches.open('backspace-precache-v2-https://host.example/');
      store.entries.set(URL_JS, { contentType });
    }

    it('skips waiting when the active worker cached HTML under a script URL', async () => {
      const first = new FakeWorkerScope(caches, { active: {} });
      await first.dispatch('activate');
      await seed('text/html; charset=UTF-8');

      const next = new FakeWorkerScope(caches, { active: {} });
      await next.dispatch('install');
      expect(next.skipWaiting).toHaveBeenCalledTimes(1);
    });

    it('deletes the poisoned cache when it activates and keeps the marker', async () => {
      const first = new FakeWorkerScope(caches, { active: {} });
      await first.dispatch('activate');
      await seed('text/html; charset=UTF-8');

      const next = new FakeWorkerScope(caches, { active: {} });
      await next.dispatch('activate');
      expect([...caches.names]).toEqual(['backspace-sw-protocol-prompt-v1']);
    });

    it('leaves a healthy precache alone', async () => {
      const first = new FakeWorkerScope(caches, { active: {} });
      await first.dispatch('activate');
      await seed('text/javascript');

      const next = new FakeWorkerScope(caches, { active: {} });
      await next.dispatch('install');
      await next.dispatch('activate');
      expect(next.skipWaiting).not.toHaveBeenCalled();
      expect(caches.names.size).toBe(2);
    });
  });
});
