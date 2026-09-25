import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Channel, ChannelCategory } from '@backspace/shared';

vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

const origins: string[] = [];
const mockChannelUpdate = vi.fn();
const mockCategoryUpdate = vi.fn();
vi.mock('../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/crossStoreResolvers')>()),
  getApiForOrigin: (origin: string) => {
    origins.push(origin);
    return {
      channels: { update: (...args: unknown[]) => mockChannelUpdate(...args) },
      categories: { update: (...args: unknown[]) => mockCategoryUpdate(...args) },
    };
  },
}));

import { useSpaceStore, type TaggedSpace } from './spaceStore';

const REMOTE = 'https://orbit.example';

const space: TaggedSpace = {
  id: 'space-1',
  name: 'Remote',
  icon: null,
  banner: null,
  avatarColor: 'lavender',
  ownerId: 'owner',
  inviteCode: null,
  visibility: 'public',
  directoryListed: false,
  description: '',
  createdAt: 1,
  _instanceOrigin: REMOTE,
};

const channel: Channel = {
  id: 'channel-1', spaceId: 'space-1', name: 'general', type: 'text',
  topic: null, position: 0, categoryId: null, createdAt: 1,
};

const category: ChannelCategory = { id: 'cat-1', spaceId: 'space-1', name: 'Text', position: 0, createdAt: 1 };

beforeEach(() => {
  origins.length = 0;
  mockChannelUpdate.mockReset();
  mockCategoryUpdate.mockReset();
  useSpaceStore.setState({
    spaces: [space],
    currentSpaceId: 'space-1',
    channels: [channel],
    categories: [category],
    channelOriginMap: new Map([['channel-1', REMOTE]]),
  });
});

describe('rename actions', () => {
  it('updateChannel asks the space\'s own instance and applies the stored row', async () => {
    mockChannelUpdate.mockResolvedValue({ ...channel, name: 'game-night' });
    const saved = await useSpaceStore.getState().updateChannel('channel-1', { name: 'Game Night' });
    expect(origins).toEqual([REMOTE]);
    expect(mockChannelUpdate).toHaveBeenCalledWith('channel-1', { name: 'Game Night' });
    expect(saved.name).toBe('game-night');
    expect(useSpaceStore.getState().channels[0].name).toBe('game-night');
  });

  it('updateCategory asks the space\'s own instance and applies the stored row', async () => {
    mockCategoryUpdate.mockResolvedValue({ ...category, name: 'Voice Rooms' });
    const saved = await useSpaceStore.getState().updateCategory('cat-1', { name: 'Voice Rooms' });
    expect(origins).toEqual([REMOTE]);
    expect(saved.name).toBe('Voice Rooms');
    expect(useSpaceStore.getState().categories[0].name).toBe('Voice Rooms');
  });

  it('leaves the store untouched when the server refuses', async () => {
    mockChannelUpdate.mockRejectedValue(new Error('refused'));
    await expect(useSpaceStore.getState().updateChannel('channel-1', { name: 'x' })).rejects.toThrow('refused');
    expect(useSpaceStore.getState().channels[0].name).toBe('general');
  });
});
