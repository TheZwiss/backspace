import { describe, it, expect } from 'vitest';
import { ownAudioInSystemAudio } from './systemAudioCapability';

/**
 * Chromium leaves the app's own playback out of a system-audio capture only
 * where `media::IsRestrictOwnAudioSupported()` holds: Windows 11 (build 22000)
 * and macOS 14.2 (CoreAudio Tap). Elsewhere the constraint is dropped and the
 * whole mix, this call included, is captured.
 */
describe('ownAudioInSystemAudio', () => {
  it('leaves Backspace out on Windows 11', () => {
    expect(ownAudioInSystemAudio('win32', '10.0.22000')).toBe('excluded');
    expect(ownAudioInSystemAudio('win32', '10.0.26100')).toBe('excluded');
  });

  it('captures Backspace too on Windows 10, 22H2 included, and on Server 2022', () => {
    expect(ownAudioInSystemAudio('win32', '10.0.19045')).toBe('included');
    expect(ownAudioInSystemAudio('win32', '10.0.17763')).toBe('included');
    expect(ownAudioInSystemAudio('win32', '10.0.20348')).toBe('included');
  });

  it('leaves Backspace out on macOS 14.2 and later', () => {
    expect(ownAudioInSystemAudio('darwin', '14.2')).toBe('excluded');
    expect(ownAudioInSystemAudio('darwin', '14.2.1')).toBe('excluded');
    expect(ownAudioInSystemAudio('darwin', '15.0')).toBe('excluded');
    expect(ownAudioInSystemAudio('darwin', '26.1')).toBe('excluded');
  });

  it('captures Backspace too on macOS 13.0 to 14.1', () => {
    expect(ownAudioInSystemAudio('darwin', '13.0')).toBe('included');
    expect(ownAudioInSystemAudio('darwin', '13.6.4')).toBe('included');
    expect(ownAudioInSystemAudio('darwin', '14.1.2')).toBe('included');
  });

  it('has no system audio before macOS 13', () => {
    expect(ownAudioInSystemAudio('darwin', '12.7.6')).toBe('unavailable');
  });

  it('captures Backspace too on Linux', () => {
    expect(ownAudioInSystemAudio('linux', '6.8.0-45-generic')).toBe('included');
  });

  it('answers unknown for a version it cannot read', () => {
    expect(ownAudioInSystemAudio('win32', '')).toBe('unknown');
    expect(ownAudioInSystemAudio('win32', 'Windows')).toBe('unknown');
    expect(ownAudioInSystemAudio('darwin', 'garbage')).toBe('unknown');
    expect(ownAudioInSystemAudio('freebsd', '14.0')).toBe('unknown');
  });
});
