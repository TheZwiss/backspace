import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const { voice } = vi.hoisted(() => ({ voice: {
  currentVoiceChannelId: 'voice' as string | null, activeDmCall: null as object | null,
  isLiveKitConnected: true, voiceConnectionStatus: 'connected', connectionQuality: 'good',
  isCameraOn: false, isScreenSharing: false, rnnoiseEnabled: true, setRnnoiseEnabled: vi.fn(), connectionError: null,
} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../stores/voiceStore', () => ({ useVoiceStore: (selector: (state: typeof voice) => unknown) => selector(voice) }));
vi.mock('../../stores/spaceStore', () => ({ useSpaceStore: (selector: (state: unknown) => unknown) => selector({ channels: [{ id: 'voice', name: 'General' }], channelPermissions: new Map() }) }));
vi.mock('./TextVoice', () => ({ TextVoiceButton: ({ className, variant }: { className?: string; variant?: string }) => <button className={className} data-variant={variant}>Text voice</button> }));
vi.mock('./Soundboard', () => ({ SoundboardButton: ({ className }: { className?: string }) => <button className={className}>Soundboard</button> }));
vi.mock('./ScreenShareSettingsPopover', () => ({ ScreenShareSettingsPopover: () => null }));
vi.mock('./ConnectionInfoPopover', () => ({ ConnectionInfoPopover: () => null }));
vi.mock('../../utils/voiceActions', () => ({ handleCameraAction: vi.fn(), handleDisconnectAction: vi.fn(), handleScreenShareAction: vi.fn(), reconnectVoice: vi.fn() }));
import { VoiceControls } from './VoiceControls';

beforeEach(() => { voice.currentVoiceChannelId = 'voice'; voice.activeDmCall = null; });
it('places the existing text voice control directly next to soundboard in the connected toolbar', () => {
  render(<VoiceControls />);
  expect(screen.getByText('voice:status.connected')).toBeTruthy();
  const textVoice = screen.getByRole('button', { name: 'Text voice' });
  const soundboard = screen.getByRole('button', { name: 'Soundboard' });
  expect(textVoice.nextElementSibling).toBe(soundboard);
  expect(textVoice.closest('.relative.flex')).toBe(screen.getByRole('button', { name: 'voice:controls.noiseSuppressionOff' }).closest('.relative.flex'));
  expect(textVoice.className).toContain('h-[34px]');
  expect(textVoice).toHaveAttribute('data-variant', 'toolbar');
});
it('keeps connected controls hidden outside a voice channel or private call', () => {
  voice.currentVoiceChannelId = null;
  const { container } = render(<VoiceControls />);
  expect(container).toBeEmptyDOMElement();
});
