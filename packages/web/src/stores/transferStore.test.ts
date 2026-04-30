import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { useTransferStore } from './transferStore';

describe('transferStore basics', () => {
  beforeEach(() => {
    useTransferStore.setState({ transfers: new Map() });
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('creates a transfer with queued state and unique id', () => {
    const id = useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a.png', size: 100, mimetype: 'image/png' },
      tray: true,
    });
    const t = useTransferStore.getState().get(id);
    expect(t).toBeDefined();
    expect(t!.state).toBe('queued');
    expect(t!.progress).toEqual({ loaded: 0, total: 100 });
  });

  it('createTransfer assigns unique ids across repeated calls', () => {
    const a = useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a', size: 1, mimetype: 'image/png' },
      tray: true,
    });
    const b = useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'b', size: 1, mimetype: 'image/png' },
      tray: true,
    });
    expect(a).not.toBe(b);
  });

  it('updateProgress mutates only the loaded count', () => {
    const id = useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a.png', size: 1000, mimetype: 'image/png' },
      tray: true,
    });
    useTransferStore.getState().updateProgress(id, 250);
    const t = useTransferStore.getState().get(id)!;
    expect(t.progress.loaded).toBe(250);
    expect(t.progress.total).toBe(1000);
  });

  it('updateProgress on a missing id is a no-op', () => {
    useTransferStore.getState().updateProgress('not-real', 100);
    expect(useTransferStore.getState().get('not-real')).toBeUndefined();
  });

  it('setState_ moves through the state machine', () => {
    const id = useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a.png', size: 100, mimetype: 'image/png' },
      tray: true,
    });
    const s = useTransferStore.getState();
    s.setState_(id, 'active');
    s.setState_(id, 'paused');
    s.setState_(id, 'completed');
    expect(useTransferStore.getState().get(id)!.state).toBe('completed');
  });

  it('setError marks the transfer failed and stores the error payload', () => {
    const id = useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a.png', size: 100, mimetype: 'image/png' },
      tray: true,
    });
    useTransferStore.getState().setError(id, { message: 'boom', permanent: true });
    const t = useTransferStore.getState().get(id)!;
    expect(t.state).toBe('failed');
    expect(t.error).toEqual({ message: 'boom', permanent: true });
  });

  it('setTusUrl + setAttachmentId stores the metadata', () => {
    const id = useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a', size: 1, mimetype: 'image/png' },
      tray: true,
    });
    useTransferStore.getState().setTusUrl(id, '/api/files/abc', 5_000);
    useTransferStore.getState().setAttachmentId(id, 'att-9');
    const t = useTransferStore.getState().get(id)!;
    expect(t.tusUploadUrl).toBe('/api/files/abc');
    expect(t.tusExpiresAt).toBe(5_000);
    expect(t.attachmentId).toBe('att-9');
  });

  it('remove drops a transfer; idempotent on missing id', () => {
    const id = useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a', size: 1, mimetype: 'image/png' },
      tray: true,
    });
    useTransferStore.getState().remove(id);
    expect(useTransferStore.getState().get(id)).toBeUndefined();
    // Idempotent
    expect(() => useTransferStore.getState().remove(id)).not.toThrow();
    expect(() => useTransferStore.getState().remove('not-real')).not.toThrow();
  });

  it('listVisible omits tray:false transfers', () => {
    useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'visible.png', size: 100, mimetype: 'image/png' },
      tray: true,
    });
    useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'hidden.png', size: 100, mimetype: 'image/png' },
      tray: false,
    });
    expect(useTransferStore.getState().listVisible().length).toBe(1);
    expect(useTransferStore.getState().listVisible()[0]!.file.name).toBe('visible.png');
  });

  it('listForChannel filters by channelId', () => {
    useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a', size: 1, mimetype: 'image/png' },
      tray: true,
      channelId: 'ch-1',
    });
    useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'b', size: 1, mimetype: 'image/png' },
      tray: true,
      channelId: 'ch-2',
    });
    expect(useTransferStore.getState().listForChannel('ch-1').length).toBe(1);
    expect(useTransferStore.getState().listForChannel('ch-2').length).toBe(1);
    expect(useTransferStore.getState().listForChannel('ch-missing').length).toBe(0);
  });
});

describe('transferStore persistence (localStorage)', () => {
  beforeEach(() => {
    useTransferStore.setState({ transfers: new Map() });
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('persists a transfer that has a tusUploadUrl across explicit rehydrate', async () => {
    const id = useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a.png', size: 100, mimetype: 'image/png' },
      tray: true,
    });
    useTransferStore.getState().setTusUrl(id, '/api/files/abc', Date.now() + 60_000);

    // Force flush — zustand persist writes synchronously to localStorage on update.
    // Read back from localStorage and confirm the transfer is in the serialized payload.
    const raw = localStorage.getItem('transferStore@v1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.transfers.length).toBe(1);
    expect(parsed.state.transfers[0][1].tusUploadUrl).toBe('/api/files/abc');
  });

  it('does NOT persist queued transfers without a tusUploadUrl or attachmentId', () => {
    useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a.png', size: 100, mimetype: 'image/png' },
      tray: true,
    });
    const raw = localStorage.getItem('transferStore@v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      expect(parsed.state.transfers.length).toBe(0);
    }
    // If raw is null, that also means "did not persist" — pass.
  });

  it('does persist failed transfers (user can retry)', () => {
    const id = useTransferStore.getState().createTransfer({
      type: 'upload',
      file: { name: 'a.png', size: 100, mimetype: 'image/png' },
      tray: true,
    });
    useTransferStore.getState().setError(id, { message: 'oops', permanent: false });
    const raw = localStorage.getItem('transferStore@v1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.transfers.length).toBe(1);
    expect(parsed.state.transfers[0][1].state).toBe('failed');
  });
});
