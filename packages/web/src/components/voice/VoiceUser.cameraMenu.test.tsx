import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { VoiceUser } from './VoiceUser';
import { useVoiceStore } from '../../stores/voiceStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import type { UserTile } from '../../hooks/useLiveKit';

const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), room: {} }));
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('../../hooks/useLiveKit', () => ({ getActiveRoom: () => mocks.room, setCameraSubscription: mocks.subscribe }));
vi.mock('../../hooks/useVoiceParticipantMeta', () => ({ useVoiceParticipantMeta: () => ({ displayName: 'Friend', avatar: null }) }));
vi.mock('../ui/ProfileAvatar', () => ({ ProfileAvatar: () => null }));
vi.mock('./voiceMenuItems', () => ({ buildVoiceModMenuItems: () => [], VolumeSliderItem: () => null }));
afterEach(() => { cleanup(); useContextMenuStore.getState().close(); });

it('lets a private-call viewer stop and resume a webcam without a server channel', () => {
  useVoiceStore.setState({ currentVoiceChannelId: null, participants: [], unwatchedCameras: new Set() });
  const tile = { participant: { userId: 'friend', identity: 'friend:Friend', isLocal: false, isCameraOn: true }, videoTrack: null, lkVideoTrack: null } as unknown as UserTile;
  const view = render(<VoiceUser tile={tile} />);
  const open = () => fireEvent.contextMenu(view.container.firstElementChild!, { clientX: 20, clientY: 30 });
  const toggle = () => {
    const item = useContextMenuStore.getState().menu?.items.find((item) => item.key === 'camera-toggle');
    if (item?.type !== 'action') throw new Error('Missing camera action');
    act(() => item.onClick());
  };
  open(); toggle();
  expect(useVoiceStore.getState().unwatchedCameras.has('friend')).toBe(true);
  expect(mocks.subscribe).toHaveBeenLastCalledWith(mocks.room, 'friend:Friend', false);
  open(); toggle();
  expect(useVoiceStore.getState().unwatchedCameras.has('friend')).toBe(false);
  expect(mocks.subscribe).toHaveBeenLastCalledWith(mocks.room, 'friend:Friend', true);
});
