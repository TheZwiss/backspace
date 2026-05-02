import { describe, it, expect, beforeEach } from 'vitest';
import { useComposerStore } from './composerStore';

describe('composerStore', () => {
  beforeEach(() => useComposerStore.setState({ states: new Map() }));

  it('starts empty for unseen channels', () => {
    expect(useComposerStore.getState().get('ch-1')).toEqual({ draftText: '', replyTo: null, stagedTransferIds: [] });
  });

  it('attaches a transferId to the per-channel staged list', () => {
    useComposerStore.getState().attach('ch-1', 't-1');
    expect(useComposerStore.getState().get('ch-1').stagedTransferIds).toEqual(['t-1']);
  });

  it('removes a staged transferId', () => {
    useComposerStore.getState().attach('ch-1', 't-1');
    useComposerStore.getState().attach('ch-1', 't-2');
    useComposerStore.getState().removeStaged('ch-1', 't-1');
    expect(useComposerStore.getState().get('ch-1').stagedTransferIds).toEqual(['t-2']);
  });

  it('clear empties draft + replyTo + staged', () => {
    useComposerStore.getState().attach('ch-1', 't-1');
    useComposerStore.getState().setDraft('ch-1', 'hi');
    useComposerStore.getState().setReplyTo('ch-1', { id: 'm', userId: 'u', content: 'x' });
    useComposerStore.getState().clear('ch-1');
    expect(useComposerStore.getState().get('ch-1')).toEqual({ draftText: '', replyTo: null, stagedTransferIds: [] });
  });

  it('attach is idempotent for the same transferId', () => {
    useComposerStore.getState().attach('ch-1', 't-1');
    useComposerStore.getState().attach('ch-1', 't-1');
    expect(useComposerStore.getState().get('ch-1').stagedTransferIds).toEqual(['t-1']);
  });
});
