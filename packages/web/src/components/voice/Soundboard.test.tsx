import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { api, voice, space } = vi.hoisted(() => {
  const sound = (id: string, spaceId: string, name: string) => ({ id, spaceId, name, assetId: id, creatorId: 'u', durationMs: 1000, volume: 1 });
  return {
    api: { soundboard: { list: vi.fn().mockResolvedValue([{ spaceId: 'empty', name: 'Empty', sounds: [] }, { spaceId: 'other', name: 'Other', sounds: [sound('b', 'other', 'Bell')] }, { spaceId: 'current', name: 'Current', sounds: [sound('a', 'current', 'Airhorn')] }]), play: vi.fn(), audio: vi.fn() }, uploads: { url: vi.fn() } },
    voice: { livekitHostOrigin: '', soundboardVolume: 80, isLiveKitConnected: true, isMuted: false, isDeafened: false, currentVoiceChannelId: 'channel' },
    space: { spaces: [{ id: 'current', icon: 'cat.gif', _instanceOrigin: '' }], channelToSpaceMap: new Map([['channel', 'current']]) },
  };
});
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../i18n/formatters', () => ({ useFormatters: () => ({ formatPercent: (n: number) => `${n}%`, formatDuration: String }) }));
vi.mock('../../stores/voiceStore', () => ({ useVoiceStore: Object.assign((fn: (state: typeof voice) => unknown) => fn(voice), { getState: () => ({ setSoundboardVolume: vi.fn() }) }) }));
vi.mock('../../stores/spaceStore', () => ({ useSpaceStore: (fn: (state: typeof space) => unknown) => fn(space), getApiForOrigin: () => api, getMyUserIdForOrigin: () => 'user' }));
vi.mock('../../utils/staticAvatar', () => ({ useStaticAvatar: (src: string) => src ? 'data:image/png;still' : null }));
vi.mock('../layout/SpaceSidebar', () => ({ SpaceIconImage: () => null }));
vi.mock('../../utils/soundboard', () => ({ playLocalSoundboard: vi.fn(), encodeSoundboardFile: vi.fn() }));
vi.mock('../ui/Modal', () => ({ Modal: () => null }));
import { SoundboardButton, SoundboardLibrary } from './Soundboard';
import { useSoundboardUsageStore } from '../../stores/soundboardUsageStore';

describe('soundboard player', () => {
  beforeEach(() => { useSoundboardUsageStore.setState({ counts: {} }); api.soundboard.play.mockReset(); });
  it('opens an anchored non-modal popover and closes outside or on Escape', async () => {
    render(<SoundboardButton variant="toolbar" className="h-[34px]" />);
    const button = screen.getByRole('button', { name: 'soundboard.title' });
    expect(button.className).toContain('rounded-[4px]');
    fireEvent.click(button);
    expect(await screen.findByRole('region', { name: 'soundboard.title' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('region', { name: 'soundboard.title' })).toBeNull();
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'soundboard.title' })).toBeNull();
  });
  it('orders current server first, filters sounds and opens volume', async () => {
    render(<SoundboardLibrary origin="" />);
    await screen.findByText('Airhorn');
    const nav = screen.getByRole('navigation');
    expect(within(nav).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Current', 'Other']);
    expect(within(nav).getByRole('button', { name: 'Current' }).getAttribute('aria-current')).toBe('true');
    expect(nav.parentElement?.firstElementChild).toBe(nav);
    expect(within(nav).queryByRole('button', { name: 'Empty' })).toBeNull();
    const heading = screen.getByRole('heading', { name: 'Current' });
    expect(heading.querySelector('img')?.getAttribute('src')).toBe('data:image/png;still');
    expect(screen.getByText('Airhorn').closest('.grid')?.className).toContain('grid-cols-3');
    fireEvent.click(screen.getByRole('button', { name: 'soundboard.volume' }));
    expect(screen.getByRole('slider', { name: 'soundboard.volume' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('slider')).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bell' } });
    expect(screen.queryByText('Airhorn')).toBeNull();
    expect(screen.getByText('Bell')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'missing' } });
    expect(screen.getByText('soundboard.noResults')).toBeTruthy();
  });
  it('records only a successful play', async () => {
    api.soundboard.play.mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce(undefined);
    render(<SoundboardLibrary origin="" />);
    const play = await screen.findByRole('button', { name: 'Airhorn' });
    fireEvent.click(play);
    await screen.findByRole('alert');
    expect(useSoundboardUsageStore.getState().counts).toEqual({});
    fireEvent.click(play);
    await waitFor(() => expect(useSoundboardUsageStore.getState().counts['["","user"]']).toEqual({ a: 1 }));
  });
});
