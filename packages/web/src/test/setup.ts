import '@testing-library/jest-dom/vitest';

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
