import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NotificationsPanel } from './NotificationsPanel';
import { useVoiceStore } from '../../../stores/voiceStore';
import { useNudgePreferences } from '../../../stores/nudgePreferences';
vi.mock('../../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
const voice = useVoiceStore.getState();
const nudge = useNudgePreferences.getState();
afterEach(() => { cleanup(); useVoiceStore.setState({ soundEffectVolume: voice.soundEffectVolume, messageSoundAllChannels: voice.messageSoundAllChannels }); useNudgePreferences.setState(nudge); });
describe('notifications settings panel', () => {
  it('groups general sounds, message notices and attention preferences', () => {
    render(<NotificationsPanel />);
    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'App sounds' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Message notices' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Attention calls' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Game mode' })).toBeTruthy();
  });
  it('changes general and attention volumes independently', () => {
    render(<NotificationsPanel />);
    fireEvent.change(screen.getByLabelText('Sound Effects Volume'), { target: { value: '80' } });
    expect(useVoiceStore.getState().soundEffectVolume).toBe(80);
    fireEvent.change(screen.getByLabelText('Attention call volume'), { target: { value: '30' } });
    expect(useNudgePreferences.getState().volume).toBe(30);
    expect(useVoiceStore.getState().soundEffectVolume).toBe(80);
  });
});
