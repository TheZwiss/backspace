import { describe, expect, it, vi } from 'vitest';
import { installDownloadedUpdate, updaterInstallOptions } from './updateInstall';

describe('updaterInstallOptions', () => {
  it('installs silently and reopens the app on Windows', () => {
    expect(updaterInstallOptions('win32')).toEqual({ isSilent: true, isForceRunAfter: true });
  });

  it('keeps the updater defaults on macOS and Linux', () => {
    expect(updaterInstallOptions('darwin')).toEqual({ isSilent: false, isForceRunAfter: false });
    expect(updaterInstallOptions('linux')).toEqual({ isSilent: false, isForceRunAfter: false });
  });
});

describe('installDownloadedUpdate', () => {
  it('asks the updater for a silent install with a relaunch on Windows', () => {
    const updater = { quitAndInstall: vi.fn() };
    installDownloadedUpdate(updater, 'win32');
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('does not ask for it on other platforms', () => {
    const updater = { quitAndInstall: vi.fn() };
    installDownloadedUpdate(updater, 'linux');
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, false);
    installDownloadedUpdate(updater, 'darwin');
    expect(updater.quitAndInstall).toHaveBeenLastCalledWith(false, false);
  });
});
