import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { MemoryRouter } from 'react-router-dom';
import { SpaceSettingsModal } from './SpaceSettings';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { api } from '../../api/client';
import { getSpaceGradient } from '../../utils/gradients';

const base: TaggedSpace = {
  id: 'workbench-space-7',
  name: 'Tidepool',
  icon: null,
  banner: null,
  avatarColor: 'rose',
  ownerId: 'user-1',
  inviteCode: null,
  visibility: 'public',
  directoryListed: false,
  description: '',
  createdAt: 1,
  _instanceOrigin: '',
};

function asRendered(gradient: string): string {
  const probe = document.createElement('div');
  probe.style.background = gradient;
  return probe.style.background;
}

async function openOn(space: TaggedSpace): Promise<HTMLElement> {
  useSpaceStore.setState({ spaces: [space], currentSpaceId: space.id, spacePermissions: new Map() });
  const view = render(<MemoryRouter><SpaceSettingsModal /></MemoryRouter>);
  act(() => { useUIStore.getState().openModal('spaceSettings'); });
  await act(async () => {});
  return view.baseElement;
}

beforeEach(() => {
  vi.spyOn(api.explore, 'getJoinRequests').mockResolvedValue([]);
  useUIStore.setState({ activeModal: null, modalData: {}, isMobile: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SpaceSettingsModal header avatar (#328)', () => {
  it('paints the space in the colour its sidebar icon has', async () => {
    const root = await openOn(base);
    const fallback = root.querySelector<HTMLElement>('[data-avatar] .avatar-fallback')!;
    expect(fallback.style.background).toBe(asRendered(getSpaceGradient(base.id, base.name, 'rose').gradient));
  });

  it('hashes a space with no stored colour the way the sidebar does', async () => {
    const root = await openOn({ ...base, avatarColor: null });
    const fallback = root.querySelector<HTMLElement>('[data-avatar] .avatar-fallback')!;
    expect(fallback.style.background).toBe(asRendered(getSpaceGradient(base.id, base.name, null).gradient));
  });
});
