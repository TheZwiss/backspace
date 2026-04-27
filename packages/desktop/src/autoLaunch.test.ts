import { describe, it, expect } from 'vitest';
import {
  deriveStartMinimizedFromArgs,
  parseExecPathFromDesktopFile,
  shouldReapplyAppImage,
} from './autoLaunch';

describe('deriveStartMinimizedFromArgs', () => {
  it('returns true when --hidden is present', () => {
    expect(deriveStartMinimizedFromArgs(['--hidden'])).toBe(true);
    expect(deriveStartMinimizedFromArgs(['--foo', '--hidden', '--bar'])).toBe(true);
  });
  it('returns false when --hidden is absent', () => {
    expect(deriveStartMinimizedFromArgs([])).toBe(false);
    expect(deriveStartMinimizedFromArgs(['--other'])).toBe(false);
  });
  it('handles undefined safely', () => {
    expect(deriveStartMinimizedFromArgs(undefined)).toBe(false);
  });
});

describe('parseExecPathFromDesktopFile', () => {
  it('extracts an unquoted path', () => {
    const content = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Backspace',
      'Exec=/opt/Backspace/backspace --hidden',
      'X-GNOME-Autostart-enabled=true',
    ].join('\n');
    expect(parseExecPathFromDesktopFile(content)).toBe('/opt/Backspace/backspace');
  });

  it('extracts a double-quoted path (handles spaces in path)', () => {
    const content = 'Exec="/home/user/Apps/Backspace 1.0.AppImage" --hidden\n';
    expect(parseExecPathFromDesktopFile(content)).toBe('/home/user/Apps/Backspace 1.0.AppImage');
  });

  it('returns null when no Exec= line is present', () => {
    expect(parseExecPathFromDesktopFile('[Desktop Entry]\nName=X\n')).toBeNull();
  });

  it('ignores commented Exec lines', () => {
    expect(parseExecPathFromDesktopFile('#Exec=/wrong\nExec=/right\n')).toBe('/right');
  });

  it('returns null on empty input', () => {
    expect(parseExecPathFromDesktopFile('')).toBeNull();
  });
});

describe('shouldReapplyAppImage', () => {
  it('returns true when AppImage path differs from recorded path', () => {
    expect(shouldReapplyAppImage('/home/u/Backspace-2.0.AppImage', '/home/u/Backspace-1.0.AppImage')).toBe(true);
  });
  it('returns false when paths match', () => {
    expect(shouldReapplyAppImage('/home/u/Backspace-2.0.AppImage', '/home/u/Backspace-2.0.AppImage')).toBe(false);
  });
  it('returns false when no recorded path exists — treat missing autostart entry as user-disabled', () => {
    // A missing .desktop file is a user signal (they disabled via their DE's startup manager
    // or removed it manually), not a stale-path-needs-refresh signal. The OS-authoritative
    // architecture must treat this as "OS state changed, do not override".
    expect(shouldReapplyAppImage('/home/u/Backspace.AppImage', null)).toBe(false);
  });
  it('returns false when there is no current AppImage env (not in AppImage runtime)', () => {
    expect(shouldReapplyAppImage(null, '/anything')).toBe(false);
    expect(shouldReapplyAppImage(null, null)).toBe(false);
  });
});
