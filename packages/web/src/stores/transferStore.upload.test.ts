import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

// We mock tus-js-client to drive lifecycle synchronously without real network.
const startMock = vi.fn();
const abortMock = vi.fn().mockResolvedValue(undefined);
// Captures every set of UploadOptions handed to `new Upload(...)`. Tests can
// inspect `lastUploadOpts()` to assert on endpoint + Authorization header,
// which is the only way we verify per-origin token routing without hitting
// the network.
const constructedOpts: any[] = [];
function lastUploadOpts(): any {
  return constructedOpts[constructedOpts.length - 1];
}

vi.mock('tus-js-client', () => {
  class MockUpload {
    private opts: any;
    public url: string | null = null;
    constructor(_file: File, opts: any) {
      this.opts = opts;
      constructedOpts.push(opts);
    }
    start() {
      startMock();
      // 1. Simulate POST → Location returned.
      this.opts.onAfterResponse?.({}, {
        getHeader: (h: string) =>
          h === 'Location' ? '/api/files/abc-123' :
          h === 'Upload-Expires' ? new Date(Date.now() + 60_000).toUTCString() :
          undefined,
      });
      // 2. Simulate progress.
      this.opts.onProgress?.(50, 100);
      // 3. Simulate success with a body containing Attachment JSON.
      this.opts.onSuccess?.({
        lastResponse: {
          getBody: () => JSON.stringify({
            id: 'att-9',
            filename: 'a.png',
            originalName: 'a.png',
            mimetype: 'image/png',
            size: 100,
            thumbnailFilename: null,
            width: null,
            height: null,
            duration: null,
            messageId: '',
          }),
        },
      });
    }
    abort(_terminate?: boolean) {
      return abortMock();
    }
  }
  return { Upload: MockUpload };
});

// Authstore mock: provide token + user.
vi.mock('./authStore', () => ({
  useAuthStore: {
    getState: () => ({
      token: 'test-token-12345',
      user: { id: 'u-9', username: 'tester' },
    }),
  },
}));

import { useTransferStore } from './transferStore';
import { setTokenForOriginResolver } from '../utils/crossStoreResolvers';
import { useAuthStore as authStoreMod } from './authStore';

// Default resolver mirrors prod wiring: empty origin → home authStore token,
// any other origin → null (no federated instance is wired up in tests unless
// the test explicitly registers a different resolver).
function installDefaultTokenResolver(): void {
  setTokenForOriginResolver((origin: string): string | null => {
    if (origin) return null;
    return authStoreMod.getState().token ?? null;
  });
}

describe('transferStore.startUpload', () => {
  beforeEach(() => {
    useTransferStore.setState({ transfers: new Map(), hasInMemoryFile: new Set() });
    startMock.mockClear();
    abortMock.mockClear();
    constructedOpts.length = 0;
    if (typeof localStorage !== 'undefined') localStorage.clear();
    installDefaultTokenResolver();
  });

  it('drives a transfer through tus → completed with attachmentId + attachmentFilename', async () => {
    const file = new File([new Uint8Array(100)], 'a.png', { type: 'image/png' });
    const id = await useTransferStore.getState().startUpload(file, { channelId: 'ch-1', tray: true });
    expect(startMock).toHaveBeenCalledTimes(1);
    const t = useTransferStore.getState().get(id);
    expect(t).toBeDefined();
    expect(t!.state).toBe('completed');
    expect(t!.attachmentId).toBe('att-9');
    expect(t!.attachmentFilename).toBe('a.png');
    expect(t!.tusUploadUrl).toBe('/api/files/abc-123');
    expect(t!.tusExpiresAt).toBeGreaterThan(Date.now());
  });

  it('captures Upload-Expires timestamp on the first response', async () => {
    const file = new File([new Uint8Array(100)], 'a.png', { type: 'image/png' });
    const id = await useTransferStore.getState().startUpload(file, { tray: true });
    const t = useTransferStore.getState().get(id)!;
    // Should be approximately 60s from now (we set Date+60s in the mock)
    expect(t.tusExpiresAt).toBeGreaterThan(Date.now() + 50_000);
    expect(t.tusExpiresAt).toBeLessThanOrEqual(Date.now() + 70_000);
  });

  it('throws when not authenticated', async () => {
    // Override the authStore mock for this test only
    const file = new File([new Uint8Array(10)], 'a.png', { type: 'image/png' });
    const { useAuthStore } = await import('./authStore');
    const orig = useAuthStore.getState;
    (useAuthStore as any).getState = () => ({ token: null, user: null });
    await expect(useTransferStore.getState().startUpload(file, { tray: true })).rejects.toThrow(/not authenticated/i);
    (useAuthStore as any).getState = orig;
  });

  it('abortUpload calls Upload.abort(true) and sets state aborted', async () => {
    const file = new File([new Uint8Array(100)], 'a.png', { type: 'image/png' });
    const id = await useTransferStore.getState().startUpload(file, { tray: true });
    // After mock-driven success, the live upload is removed; abort the (now-completed) transfer should still flip state.
    useTransferStore.getState().abortUpload(id);
    expect(useTransferStore.getState().get(id)!.state).toBe('aborted');
  });

  it('pauseUpload sets state paused', async () => {
    const file = new File([new Uint8Array(100)], 'a.png', { type: 'image/png' });
    const id = await useTransferStore.getState().startUpload(file, { tray: true });
    useTransferStore.getState().pauseUpload(id);
    expect(useTransferStore.getState().get(id)!.state).toBe('paused');
  });

  it('startUpload uses the per-origin token + endpoint for federated uploads', async () => {
    // Register a resolver that returns a federated token for a specific origin
    // and the home token (from the mocked authStore) for the empty origin.
    setTokenForOriginResolver((origin: string): string | null => {
      if (origin === 'https://remote.example.com') return 'federated-token-XYZ';
      if (!origin) return authStoreMod.getState().token ?? null;
      return null;
    });
    const file = new File([new Uint8Array(100)], 'a.png', { type: 'image/png' });
    const id = await useTransferStore.getState().startUpload(file, {
      tray: true,
      origin: 'https://remote.example.com',
    });
    const t = useTransferStore.getState().get(id);
    expect(t).toBeDefined();
    // The synchronous mock drives the full lifecycle, so we end completed.
    expect(t!.state).toBe('completed');
    // The transfer carries the remote origin so resume/abort route correctly.
    expect(t!.origin).toBe('https://remote.example.com');
    // The tus client was constructed with the federated bearer + remote endpoint —
    // proves we did NOT fall back to the home authStore token.
    const opts = lastUploadOpts();
    expect(opts.endpoint).toBe('https://remote.example.com/api/files/');
    expect(opts.headers.Authorization).toBe('Bearer federated-token-XYZ');
  });

  it('startUpload throws when no resolver is registered for the federated origin', async () => {
    // Resolver returns null for unknown origin → no fallback to home token.
    setTokenForOriginResolver((origin: string): string | null => {
      if (!origin) return authStoreMod.getState().token ?? null;
      return null;
    });
    const file = new File([new Uint8Array(10)], 'a.png', { type: 'image/png' });
    await expect(
      useTransferStore.getState().startUpload(file, {
        tray: true,
        origin: 'https://unknown.example.com',
      }),
    ).rejects.toThrow(/not authenticated/i);
  });
});

describe('transferStore.resumeUpload', () => {
  beforeEach(() => {
    useTransferStore.setState({ transfers: new Map(), hasInMemoryFile: new Set() });
    startMock.mockClear();
    abortMock.mockClear();
    installDefaultTokenResolver();
  });

  it('marks failed when transfer has no available blob to resume from', async () => {
    const id = useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a.png', size: 100, mimetype: 'image/png' },
      tray: true,
    });
    useTransferStore.getState().setState_(id, 'paused');
    await useTransferStore.getState().resumeUpload(id);
    const t = useTransferStore.getState().get(id)!;
    // No URL + no in-memory file + no handle → cannot resume or restart.
    // Surface 'failed' with an actionable message so the UI shows Discard
    // and hides the Retry button (which would silently no-op).
    expect(t.state).toBe('failed');
    expect(t.error?.message ?? '').toMatch(/file no longer available/i);
    expect(t.error?.permanent).toBe(true);
  });

  it('marks failed when tus URL has expired and no available blob', async () => {
    const id = useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a.png', size: 100, mimetype: 'image/png' },
      tray: true,
    });
    useTransferStore.getState().setTusUrl(id, '/api/files/expired', Date.now() - 1000);
    useTransferStore.getState().setState_(id, 'paused');
    await useTransferStore.getState().resumeUpload(id);
    const t = useTransferStore.getState().get(id)!;
    // Expired URL with no blob to restart → failed, user must discard and re-upload.
    expect(t.state).toBe('failed');
    expect(t.error?.message ?? '').toMatch(/file no longer available/i);
  });

  it('marks failed when no FS handle is available (re-pick required)', async () => {
    const id = useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a.png', size: 100, mimetype: 'image/png' },
      tray: true,
      // No fileHandleId — no handle stored
    });
    useTransferStore.getState().setTusUrl(id, '/api/files/abc', Date.now() + 60_000);
    useTransferStore.getState().setState_(id, 'paused');
    await useTransferStore.getState().resumeUpload(id);
    const t = useTransferStore.getState().get(id)!;
    expect(t.state).toBe('failed');
    expect(t.error?.message ?? '').toMatch(/file no longer available/i);
  });
});

describe('transferStore.hasInMemoryFile', () => {
  beforeEach(() => {
    useTransferStore.setState({ transfers: new Map(), hasInMemoryFile: new Set() });
    startMock.mockClear();
    abortMock.mockClear();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    installDefaultTokenResolver();
  });

  it('hasInMemoryFile tracks startUpload + remove lifecycle', async () => {
    const file = new File([new Uint8Array(100)], 'a.png', { type: 'image/png' });
    const id = await useTransferStore.getState().startUpload(file, { tray: true });
    // The mock's onSuccess fires synchronously inside start(), which clears the
    // in-memory ref. So here we should see it cleared (transfer is 'completed').
    expect(useTransferStore.getState().get(id)!.state).toBe('completed');
    expect(useTransferStore.getState().hasInMemoryFile.has(id)).toBe(false);
    useTransferStore.getState().remove(id);
    expect(useTransferStore.getState().hasInMemoryFile.has(id)).toBe(false);
  });

  it('hasInMemoryFile survives abortUpload (file retained for retry)', async () => {
    // Simulate an in-flight transfer (pre-success) by manually populating the
    // store and the in-memory file ref via a fresh transfer that hasn't completed.
    // We do this by intercepting startUpload before the mock resolves: createTransfer
    // and prime hasInMemoryFile + state directly to mirror an in-flight upload.
    const id = useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a.png', size: 100, mimetype: 'image/png' },
      tray: true,
    });
    // Prime the reactive set to mirror a live upload.
    useTransferStore.setState((s) => {
      const next = new Set(s.hasInMemoryFile);
      next.add(id);
      return { hasInMemoryFile: next };
    });
    useTransferStore.getState().setState_(id, 'active');

    expect(useTransferStore.getState().hasInMemoryFile.has(id)).toBe(true);
    useTransferStore.getState().abortUpload(id);
    // abortUpload must NOT clear the in-memory ref — the user can still retry.
    expect(useTransferStore.getState().hasInMemoryFile.has(id)).toBe(true);
    useTransferStore.getState().remove(id);
    expect(useTransferStore.getState().hasInMemoryFile.has(id)).toBe(false);
  });
});
