import '@testing-library/jest-dom/vitest';

// Node 20+ ships a built-in `localStorage`/`sessionStorage` stub on globalThis
// that has no methods unless `--localstorage-file=PATH` is provided. Vitest's
// jsdom env only overwrites globals it knows about, and neither storage is in
// that list — so Node's broken stub shadows jsdom's working implementation,
// breaking anything that persists via zustand's `persist` middleware.
// Replace both with an in-memory Storage-compatible polyfill.
class InMemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, {
    value: new InMemoryStorage(),
    configurable: true,
    writable: true,
  });
}

// Polyfill ClipboardItem for jsdom (not included in jsdom)
if (typeof ClipboardItem === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ClipboardItem = class ClipboardItem {
    private items: Record<string, Blob | Promise<Blob>>;
    constructor(items: Record<string, Blob | Promise<Blob>>) {
      this.items = items;
    }
    getType(type: string): Promise<Blob> {
      const item = this.items[type];
      return Promise.resolve(item as Blob);
    }
    get types(): string[] {
      return Object.keys(this.items);
    }
  };
}

// Patch globalThis.Response to preserve Blob content-type in jsdom.
// jsdom's fetch Response.blob() drops the Blob's MIME type; this shim
// restores it so tests that construct `new Response(blob)` behave correctly.
const OriginalResponse = globalThis.Response;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).Response = class PatchedResponse extends OriginalResponse {
  private _sourceBlob: Blob | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init);
    this._sourceBlob = body instanceof Blob ? body : null;
  }
  async blob(): Promise<Blob> {
    const b = await super.blob();
    if (this._sourceBlob && this._sourceBlob.type && !b.type) {
      return new Blob([b], { type: this._sourceBlob.type });
    }
    if (this._sourceBlob && this._sourceBlob.type && b.type !== this._sourceBlob.type) {
      return new Blob([b], { type: this._sourceBlob.type });
    }
    return b;
  }
};
