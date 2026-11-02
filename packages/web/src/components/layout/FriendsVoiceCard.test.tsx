import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FriendsVoiceCard } from './FriendsVoiceCard';
import { useSpaceStore } from '../../stores/spaceStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { joinVoiceChannel } from '../../utils/voice';
import type { groupFriendsInVoice } from '../../utils/friendsInVoice';
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('../../utils/voice', () => ({ joinVoiceChannel: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: vi.fn() } }));
const group = { channelId: 'voice', channelName: 'Lounge', space: { id: 'server', name: 'Friends server', icon: null, _instanceOrigin: '' }, friends: [] } as unknown as ReturnType<typeof groupFriendsInVoice>[number];
beforeEach(() => { vi.clearAllMocks(); });
describe('friends voice card', () => {
 it('opens the server without joining voice', () => {
  render(<FriendsVoiceCard group={group}><span>avatars</span></FriendsVoiceCard>);
  fireEvent.click(screen.getByTitle('Go to server'));
  expect(navigate).toHaveBeenCalledWith('/channels/server');
  expect(useSpaceStore.getState().currentSpaceId).toBe('server');
  expect(joinVoiceChannel).not.toHaveBeenCalled();
 });
 it('offers separate navigation and join actions for the channel', () => {
  const open = vi.spyOn(useContextMenuStore.getState(), 'open');
  const connect = vi.fn().mockResolvedValue(undefined); useVoiceStore.setState({ connectFn: connect });
  render(<FriendsVoiceCard group={group}>avatars</FriendsVoiceCard>);
  fireEvent.click(screen.getByText('avatars'));
  expect(screen.getByRole('button', { name: 'Options for Lounge' }).contains(screen.getByText('avatars'))).toBe(true);
  const items = open.mock.calls[0]?.[1];
  expect(items?.map(x => x.key)).toEqual(['open-space', 'join-channel']);
  const join = items?.find(x => x.key === 'join-channel');
  if (join?.type !== 'action') throw new Error('Missing join action');
  join.onClick();
  expect(navigate).toHaveBeenCalledWith('/channels/server/voice');
  expect(joinVoiceChannel).toHaveBeenCalledWith('voice', connect);
 });
});
