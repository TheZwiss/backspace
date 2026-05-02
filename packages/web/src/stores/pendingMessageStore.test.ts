import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

// Break the import chain before transferStore pulls voiceStore → AudioManager →
// @sapphi-red/web-noise-suppressor (jsdom can't provide AudioWorkletNode).
vi.mock('./authStore', () => ({
  useAuthStore: {
    getState: () => ({ token: 'test-token', user: { id: 'u-9', username: 'tester' } }),
  },
}));

import { usePendingMessageStore, type PendingBubble } from './pendingMessageStore';
import { useTransferStore, type Transfer } from './transferStore';

function bubble(over: Partial<PendingBubble> = {}): PendingBubble {
  return {
    clientId: over.clientId ?? 'c-1',
    channelId: 'ch-1',
    content: '',
    replyToId: null,
    transferIds: ['t-1'],
    createdAtLocal: 1000,
    state: 'sending',
    tusExpiresAt: Date.now() + 60_000,
    retryCount: 0,
    ...over,
  };
}

function makeTransfer(over: Partial<Transfer> & Pick<Transfer, 'id'>): Transfer {
  return {
    type: 'upload',
    state: 'queued',
    file: { name: 'a', size: 1, mimetype: 'image/png' },
    progress: { loaded: 0, total: 1 },
    tray: true,
    ...over,
  };
}

describe('pendingMessageStore', () => {
  beforeEach(() => {
    usePendingMessageStore.setState({ bubbles: new Map() });
    useTransferStore.setState({ transfers: new Map() });
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('appends a bubble in sending state', () => {
    usePendingMessageStore.getState().append(bubble());
    expect(usePendingMessageStore.getState().listForChannel('ch-1').length).toBe(1);
  });

  it('matchAndRemove dedups by content + sortedAttachmentIds, oldest first', () => {
    useTransferStore.setState({
      transfers: new Map<string, Transfer>([
        ['t-A', makeTransfer({ id: 't-A', state: 'completed', attachmentId: 'att-1', progress: { loaded: 1, total: 1 } })],
        ['t-B', makeTransfer({ id: 't-B', state: 'completed', attachmentId: 'att-2', progress: { loaded: 1, total: 1 } })],
      ]),
    });
    usePendingMessageStore.getState().append(bubble({ clientId: 'b1', createdAtLocal: 1000, content: 'x', transferIds: ['t-A', 't-B'] }));
    usePendingMessageStore.getState().append(bubble({ clientId: 'b2', createdAtLocal: 2000, content: 'x', transferIds: ['t-A', 't-B'] }));
    const removed = usePendingMessageStore.getState().matchAndRemove('ch-1', 'x', ['att-2', 'att-1']);
    expect(removed?.clientId).toBe('b1');
    expect(usePendingMessageStore.getState().listForChannel('ch-1').map((b) => b.clientId)).toEqual(['b2']);
  });

  it('discardExpired drops bubbles past tusExpiresAt', () => {
    usePendingMessageStore.getState().append(bubble({ clientId: 'old', tusExpiresAt: 1 }));
    usePendingMessageStore.getState().append(bubble({ clientId: 'new', tusExpiresAt: Date.now() + 60_000 }));
    const dropped = usePendingMessageStore.getState().discardExpired(Date.now());
    expect(dropped.map((b) => b.clientId)).toEqual(['old']);
    expect(usePendingMessageStore.getState().listForChannel('ch-1').map((b) => b.clientId)).toEqual(['new']);
  });

  it('listReadyForDeferredSend returns bubbles whose all transfers have attachmentIds', () => {
    useTransferStore.setState({
      transfers: new Map<string, Transfer>([
        ['t-1', makeTransfer({ id: 't-1', state: 'completed', attachmentId: 'att-9', progress: { loaded: 1, total: 1 } })],
      ]),
    });
    usePendingMessageStore.getState().append(bubble({ clientId: 'r1', transferIds: ['t-1'] }));
    expect(usePendingMessageStore.getState().listReadyForDeferredSend().map((b) => b.clientId)).toEqual(['r1']);
  });

  it('matchAndRemove returns null when only some referenced transfers have completed', () => {
    useTransferStore.setState({
      transfers: new Map([
        ['t-1', makeTransfer({ id: 't-1', state: 'completed', attachmentId: 'att-1' })],
        ['t-2', makeTransfer({ id: 't-2', state: 'active' })], // no attachmentId yet
      ]),
    });
    usePendingMessageStore.getState().append(bubble({ clientId: 'b1', transferIds: ['t-1', 't-2'] }));
    const result = usePendingMessageStore.getState().matchAndRemove('ch-1', '', ['att-1', 'att-2']);
    expect(result).toBeNull();
    expect(usePendingMessageStore.getState().listForChannel('ch-1').length).toBe(1); // bubble still there
  });

  it('markFailed on a missing clientId is a no-op (does not throw)', () => {
    expect(() => usePendingMessageStore.getState().markFailed('does-not-exist')).not.toThrow();
  });

  it('discardExpired with no expired bubbles does not mutate state', () => {
    usePendingMessageStore.getState().append(bubble({ clientId: 'live', tusExpiresAt: Date.now() + 60_000 }));
    const before = usePendingMessageStore.getState().bubbles;
    const dropped = usePendingMessageStore.getState().discardExpired(Date.now());
    const after = usePendingMessageStore.getState().bubbles;
    expect(dropped).toEqual([]);
    expect(after).toBe(before); // same Map reference
  });

  it('listFailedRetryable returns failed bubbles with retryCount=0 and all transfers complete', () => {
    useTransferStore.setState({
      transfers: new Map([
        ['t-1', makeTransfer({ id: 't-1', state: 'completed', attachmentId: 'att-1' })],
      ]),
    });
    usePendingMessageStore.getState().append(bubble({ clientId: 'fail-ready', transferIds: ['t-1'] }));
    usePendingMessageStore.getState().markFailed('fail-ready');
    expect(usePendingMessageStore.getState().listFailedRetryable().map((b) => b.clientId)).toEqual(['fail-ready']);
  });

  it('listFailedRetryable excludes bubbles already retried', () => {
    useTransferStore.setState({
      transfers: new Map([['t-1', makeTransfer({ id: 't-1', state: 'completed', attachmentId: 'att-1' })]]),
    });
    usePendingMessageStore.getState().append(bubble({ clientId: 'retried', transferIds: ['t-1'], retryCount: 1 }));
    usePendingMessageStore.getState().markFailed('retried');
    expect(usePendingMessageStore.getState().listFailedRetryable()).toEqual([]);
  });

  it('listFailedRetryable excludes bubbles whose transfers are not all complete', () => {
    useTransferStore.setState({
      transfers: new Map([
        ['t-1', makeTransfer({ id: 't-1', state: 'completed', attachmentId: 'att-1' })],
        ['t-2', makeTransfer({ id: 't-2', state: 'paused' })], // no attachmentId
      ]),
    });
    usePendingMessageStore.getState().append(bubble({ clientId: 'partial', transferIds: ['t-1', 't-2'] }));
    usePendingMessageStore.getState().markFailed('partial');
    expect(usePendingMessageStore.getState().listFailedRetryable()).toEqual([]);
  });
});
