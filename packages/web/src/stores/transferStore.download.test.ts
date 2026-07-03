import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('./authStore', () => ({
  useAuthStore: {
    getState: () => ({ token: 'test-token', user: { id: 'u-9' } }),
  },
}));

// Stub tus-js-client so importing transferStore doesn't fail
vi.mock('tus-js-client', () => ({
  Upload: vi.fn(),
}));

import { useTransferStore } from './transferStore';

describe('transferStore.startDownload (blob fallback)', () => {
  beforeEach(() => {
    useTransferStore.setState({ transfers: new Map() });
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('downloads via in-memory blob and triggers an anchor click', async () => {
    const data = new Uint8Array([1, 2, 3]);
    (globalThis.fetch as unknown) = vi.fn().mockResolvedValue(new Response(data, {
      status: 200,
      headers: { 'Content-Length': '3' },
    }));
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:fake');
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();

    const clicked = vi.fn();
    const orig = document.createElement.bind(document);
    document.createElement = ((tag: string) => {
      const el = orig(tag) as HTMLElement & { click?: () => void };
      if (tag === 'a') (el as unknown as { click: () => void }).click = clicked;
      return el;
    }) as typeof document.createElement;

    const id = await useTransferStore.getState().startDownload('https://e.x/file.bin', {
      filename: 'file.bin', size: 3, mimetype: 'application/octet-stream', tray: true,
    });
    expect(useTransferStore.getState().get(id)!.state).toBe('completed');
    expect(clicked).toHaveBeenCalled();

    document.createElement = orig as typeof document.createElement;
  });

  it('marks transfer failed on non-2xx response', async () => {
    (globalThis.fetch as unknown) = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));

    const id = await useTransferStore.getState().startDownload('https://e.x/missing', {
      filename: 'missing.bin', tray: true,
    });
    const t = useTransferStore.getState().get(id)!;
    expect(t.state).toBe('failed');
    expect(t.error?.permanent).toBe(true);   // 4xx is permanent
  });

  it('updates progress as bytes arrive', async () => {
    const big = new Uint8Array(1024);
    (globalThis.fetch as unknown) = vi.fn().mockResolvedValue(new Response(big, {
      status: 200,
      headers: { 'Content-Length': '1024' },
    }));
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:fake');
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();

    const id = await useTransferStore.getState().startDownload('https://e.x/big', {
      filename: 'big.bin', size: 1024, tray: true,
    });
    const t = useTransferStore.getState().get(id)!;
    expect(t.progress.loaded).toBe(1024);
  });
});

describe('transferStore.abortDownload + pauseDownload', () => {
  beforeEach(() => {
    useTransferStore.setState({ transfers: new Map() });
  });

  it('abortDownload sets state aborted', () => {
    const id = useTransferStore.getState().createTransfer({
      type: 'download',
      file: { name: 'a.bin', size: 100, mimetype: 'application/octet-stream' },
      tray: true,
      sourceUrl: 'https://e.x/a',
    });
    useTransferStore.getState().abortDownload(id);
    expect(useTransferStore.getState().get(id)!.state).toBe('aborted');
  });

  it('pauseDownload sets state paused', () => {
    const id = useTransferStore.getState().createTransfer({
      type: 'download',
      file: { name: 'a.bin', size: 100, mimetype: 'application/octet-stream' },
      tray: true,
      sourceUrl: 'https://e.x/a',
    });
    useTransferStore.getState().pauseDownload(id);
    expect(useTransferStore.getState().get(id)!.state).toBe('paused');
  });
});

describe('transferStore.resumeDownload', () => {
  beforeEach(() => {
    useTransferStore.setState({ transfers: new Map() });
  });

  it('marks failed when no destFileHandleId stored', async () => {
    const id = useTransferStore.getState().createTransfer({
      type: 'download',
      file: { name: 'a.bin', size: 100, mimetype: 'application/octet-stream' },
      tray: true,
      sourceUrl: 'https://e.x/a',
    });
    useTransferStore.getState().setState_(id, 'paused');
    await useTransferStore.getState().resumeDownload(id);
    expect(useTransferStore.getState().get(id)!.state).toBe('failed');
    expect(useTransferStore.getState().get(id)!.error?.message).toMatch(/no destination handle/i);
  });
});
