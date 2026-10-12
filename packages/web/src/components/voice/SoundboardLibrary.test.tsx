import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SOUNDBOARD_SETTINGS } from '@backspace/shared/src/soundboard';
import { PermissionBits, permissionsToString } from '@backspace/shared/src/permissions';
import { SoundboardLibrary } from './SoundboardLibrary';
import { useSpaceStore } from '../../stores/spaceStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { soundboardKey, useSoundboardPreferences, useSoundboardStore } from '../../stores/soundboardStore';
import { useKeybindStore } from '../../stores/keybindStore';

const api = vi.hoisted(() => ({ list: vi.fn(), play: vi.fn(), remove: vi.fn() }));
vi.mock('../../utils/crossStoreResolvers', async importOriginal => ({
  ...await importOriginal<typeof import('../../utils/crossStoreResolvers')>(), getApiForOrigin: () => ({ soundboard: api }),
}));
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('../../audio/soundboardPlayback', () => ({ receiveSoundboardPlay: vi.fn(), stopSoundboardPlayback: vi.fn() }));
const clip = { id: '1', spaceId: 'space', uploaderId: 'remote-me', name: 'Victory', emoji: '🔊', filename: '1.wav', durationSeconds: 1, createdAt: 1 };

beforeEach(() => {
  vi.clearAllMocks(); useSoundboardStore.getState().reset();
  useAuthStore.setState({ user: null, myRowIds: new Map([['https://remote.test', 'remote-me']]) });
  useSpaceStore.setState({ spacePermissions: new Map([['space', permissionsToString(PermissionBits.ATTACH_FILES)]]), channelPermissions: new Map([['voice', permissionsToString(PermissionBits.SPEAK)]]) });
  useVoiceStore.setState({ isDeafened: false, spaceMutedUserIds: new Set(), spaceDeafenedUserIds: new Set() });
  useSoundboardPreferences.setState({ shortcuts: {} }); useKeybindStore.setState({ keybinds: [] });
  api.list.mockResolvedValue({ settings: DEFAULT_SOUNDBOARD_SETTINGS, sounds: [clip] });
  api.play.mockResolvedValue({ success: true }); api.remove.mockResolvedValue({ success: true });
});

const renderLibrary = () => render(<SoundboardLibrary origin="https://remote.test" spaceId="space" channelId="voice" />);
describe('soundboard library UX and gating', () => {
  it('routes play to the space host and searches without mutating the catalog', async () => {
    renderLibrary(); fireEvent.click(await screen.findByRole('button', { name: 'Play Victory' }));
    await waitFor(() => expect(api.play).toHaveBeenCalledWith('space', '1', 'voice'));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
    expect(screen.getByText('No sounds match your search.')).toBeInTheDocument();
  });
  it('blocks playback for server mute and clips exceeding a lowered cap', async () => {
    useVoiceStore.setState({ spaceMutedUserIds: new Set(['space:remote-me']) });
    api.list.mockResolvedValue({ settings: { ...DEFAULT_SOUNDBOARD_SETTINGS, maxDurationSeconds: 0.5 }, sounds: [clip] });
    renderLibrary(); expect(await screen.findByRole('button', { name: 'Play Victory' })).toBeDisabled();
    expect(screen.getByText('Exceeds the current duration limit')).toBeInTheDocument();
  });
  it('does not expose uploads when member uploads are disabled', async () => {
    api.list.mockResolvedValue({ settings: { ...DEFAULT_SOUNDBOARD_SETTINGS, allowMemberUploads: false }, sounds: [clip] });
    renderLibrary(); await screen.findByRole('button', { name: 'Play Victory' });
    expect(screen.queryByRole('button', { name: 'Add sound' })).not.toBeInTheDocument();
  });
  it('allows the uploader identified by their remote row to confirm deletion', async () => {
    renderLibrary(); fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!);
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('space', '1'));
  });
  it('captures and clears an individual personal shortcut', async () => {
    renderLibrary(); const input = await screen.findByRole('textbox', { name: 'Shortcut for Victory' });
    fireEvent.focus(input); fireEvent.keyDown(input, { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(useSoundboardPreferences.getState().shortcuts[`${soundboardKey('https://remote.test', 'space')}:1`]?.label).toBe('Ctrl + K');
    fireEvent.click(screen.getByRole('button', { name: 'Clear shortcut' }));
    expect(useSoundboardPreferences.getState().shortcuts).toEqual({});
  });
  it('allows reusing a shortcut after another client deletes its sound', async () => {
    const removed = { ...clip, id: '2', name: 'Removed' };
    const prefix = `${soundboardKey('https://remote.test', 'space')}:`;
    const shortcut = { code: 'F13', ctrl: false, alt: false, shift: false, meta: false, label: 'F13' };
    useSoundboardPreferences.getState().setShortcut(prefix + removed.id, shortcut);
    api.list.mockResolvedValue({ settings: DEFAULT_SOUNDBOARD_SETTINGS, sounds: [clip, removed] });
    renderLibrary();
    const input = await screen.findByRole('textbox', { name: 'Shortcut for Victory' });
    fireEvent.focus(input); fireEvent.keyDown(input, { key: 'F13', code: 'F13' });
    expect(useSoundboardPreferences.getState().shortcuts[prefix + clip.id]).toBeUndefined();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // The websocket refresh updates the catalog, but does not remove this device's preferences.
    api.list.mockResolvedValue({ settings: DEFAULT_SOUNDBOARD_SETTINGS, sounds: [clip] });
    await act(async () => { await useSoundboardStore.getState().load('https://remote.test', 'space'); });
    expect(screen.queryByRole('textbox', { name: 'Shortcut for Removed' })).not.toBeInTheDocument();
    expect(useSoundboardPreferences.getState().shortcuts[prefix + removed.id]).toEqual(shortcut);
    fireEvent.focus(input); fireEvent.keyDown(input, { key: 'F13', code: 'F13' });
    expect(useSoundboardPreferences.getState().shortcuts[prefix + clip.id]).toEqual(shortcut);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
