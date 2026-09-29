import { describe, it, expect, vi } from 'vitest';
import type { Channel, DmChannel } from '@backspace/shared';

vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

const dmSend = vi.fn();
const channelSend = vi.fn();
vi.mock('../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/crossStoreResolvers')>()),
  getApiForOrigin: () => ({
    dm: { sendMessage: (...args: unknown[]) => dmSend(...args) },
    channels: { sendMessage: (...args: unknown[]) => channelSend(...args) },
  }),
}));

import { startPendingMessageOrchestrator } from './pendingMessageRehydrate';
import { usePendingMessageStore, type PendingBubble } from './pendingMessageStore';
import { useSpaceStore } from './spaceStore';

// A bubble restored at boot can belong to a channel the client does not know
// yet: no ready has listed it. Which endpoint and which instance it goes to
// depend on what the channel is, so it waits until a listing or event names it.

function bubble(clientId: string, channelId: string): PendingBubble {
  return {
    clientId, channelId, content: clientId, replyToId: null, transferIds: [],
    createdAtLocal: Date.now(), state: 'sending', tusExpiresAt: Date.now() + 60_000, retryCount: 0,
  };
}

const DM: DmChannel = { id: 'dm-1', federatedId: null, createdAt: 1, members: [] };
const C1: Channel = { id: 'c1', spaceId: 's1', name: 'c1', type: 'text', topic: null, position: 0, categoryId: null, createdAt: 1, myPermissions: '1' };

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('deferred sends wait until the channel is known', () => {
  it('sends a restored DM bubble through the DM endpoint once the listing names it, and a space bubble once its channel arrives', async () => {
    dmSend.mockResolvedValue({});
    channelSend.mockResolvedValue({});
    useSpaceStore.getState().reset();
    usePendingMessageStore.getState().append(bubble('b-dm', DM.id));

    startPendingMessageOrchestrator();
    await settle();
    expect(dmSend).not.toHaveBeenCalled();
    expect(channelSend).not.toHaveBeenCalled();

    useSpaceStore.getState().populateFromReady('', [], [], [DM]);
    await settle();
    expect(dmSend).toHaveBeenCalledTimes(1);
    expect(dmSend.mock.calls[0]?.[0]).toBe(DM.id);
    expect(channelSend).not.toHaveBeenCalled();

    usePendingMessageStore.getState().append(bubble('b-space', C1.id));
    await settle();
    expect(channelSend).not.toHaveBeenCalled();

    useSpaceStore.getState().upsertChannel(C1, 's1', '');
    await settle();
    expect(channelSend).toHaveBeenCalledTimes(1);
    expect(channelSend.mock.calls[0]?.[0]).toBe(C1.id);
    expect(dmSend).toHaveBeenCalledTimes(1);
  });
});
