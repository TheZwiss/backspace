import { describe, expect, it } from 'vitest';
import { systemAudioNote } from './systemAudioNote';

describe('systemAudioNote', () => {
  it('warns before System Audio is on where the OS captures Backspace too', () => {
    for (const checked of [false, true]) {
      expect(systemAudioNote('win32', 'included', checked)).toEqual({ key: 'includedWindows', tone: 'warning' });
      expect(systemAudioNote('darwin', 'included', checked)).toEqual({ key: 'includedMac', tone: 'warning' });
      expect(systemAudioNote('linux', 'included', checked)).toEqual({ key: 'includedLinux', tone: 'warning' });
      expect(systemAudioNote('darwin', 'unavailable', checked)).toEqual({ key: 'unavailableMac', tone: 'warning' });
    }
  });

  it('says Backspace is left out once System Audio is on where the OS can', () => {
    expect(systemAudioNote('win32', 'excluded', true)).toEqual({ key: 'excluded', tone: 'info' });
    expect(systemAudioNote('darwin', 'excluded', true)).toEqual({ key: 'excludedMac', tone: 'info' });
    expect(systemAudioNote('win32', 'excluded', false)).toBeNull();
  });

  it('keeps the older per-platform note when the desktop app cannot tell (older app, unreadable version)', () => {
    expect(systemAudioNote('win32', null, true)).toEqual({ key: 'legacyWindows', tone: 'warning' });
    expect(systemAudioNote('darwin', 'unknown', true)).toEqual({ key: 'legacyMac', tone: 'warning' });
    expect(systemAudioNote('linux', null, true)).toEqual({ key: 'legacyLinux', tone: 'warning' });
    expect(systemAudioNote('win32', null, false)).toBeNull();
  });

  it('keeps the browser note in a browser', () => {
    expect(systemAudioNote(null, null, true)).toEqual({ key: 'browser', tone: 'warning' });
    expect(systemAudioNote(null, null, false)).toBeNull();
  });
});
