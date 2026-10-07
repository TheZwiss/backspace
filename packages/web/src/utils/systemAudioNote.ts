import { useEffect, useState } from 'react';
import { getElectronAPI } from '../platform/platform';

/**
 * The note under the System Audio switch: what a system-audio share on this
 * machine carries to viewers. Whether it carries Backspace's own playback
 * (the voice chat, so viewers hear themselves) depends on the OS build, and
 * only the desktop app's main process can tell (`getSystemAudioCapability`,
 * packages/desktop/src/systemAudioCapability.ts).
 *
 * - A warning (`included`, `unavailable`) shows whether the switch is on or
 *   off, so it is read before System Audio is turned on.
 * - `excluded` shows once it is on.
 * - An older desktop app that cannot answer, a version it cannot read, and a
 *   browser keep the notes they had before, shown once the switch is on.
 */
export type SystemAudioNoteKey =
  | 'excluded'
  | 'excludedMac'
  | 'includedWindows'
  | 'includedMac'
  | 'includedLinux'
  | 'unavailableMac'
  | 'legacyWindows'
  | 'legacyMac'
  | 'legacyLinux'
  | 'browser';

export interface SystemAudioNote {
  key: SystemAudioNoteKey;
  tone: 'warning' | 'info';
}

/** The `voice` catalog key of each note. */
export const SYSTEM_AUDIO_NOTE_I18N_KEYS = {
  excluded: 'voice:streamSettings.systemAudioNote.excluded',
  excludedMac: 'voice:streamSettings.systemAudioNote.excludedMac',
  includedWindows: 'voice:streamSettings.systemAudioNote.includedWindows',
  includedMac: 'voice:streamSettings.systemAudioNote.includedMac',
  includedLinux: 'voice:streamSettings.systemAudioNote.includedLinux',
  unavailableMac: 'voice:streamSettings.systemAudioNote.unavailableMac',
  legacyWindows: 'voice:streamSettings.electronWindowsAudioNote',
  legacyMac: 'voice:streamSettings.electronMacAudioNote',
  legacyLinux: 'voice:streamSettings.electronLinuxAudioNote',
  browser: 'voice:streamSettings.chromeEchoNote',
} as const satisfies Record<SystemAudioNoteKey, string>;

function legacyNote(platform: string, checked: boolean): SystemAudioNote | null {
  if (!checked) return null;
  if (platform === 'win32') return { key: 'legacyWindows', tone: 'warning' };
  if (platform === 'darwin') return { key: 'legacyMac', tone: 'warning' };
  if (platform === 'linux') return { key: 'legacyLinux', tone: 'warning' };
  return { key: 'browser', tone: 'warning' };
}

/**
 * @param electronPlatform `window.backspace.platform` in the desktop app, null in a browser
 * @param capability the desktop app's answer, null while unknown or unavailable
 * @param checked whether the System Audio switch is on
 */
export function systemAudioNote(
  electronPlatform: string | null,
  capability: OwnAudioInSystemAudio | null,
  checked: boolean,
): SystemAudioNote | null {
  if (electronPlatform === null) return checked ? { key: 'browser', tone: 'warning' } : null;
  switch (capability) {
    case 'excluded':
      if (!checked) return null;
      return { key: electronPlatform === 'darwin' ? 'excludedMac' : 'excluded', tone: 'info' };
    case 'included':
      if (electronPlatform === 'win32') return { key: 'includedWindows', tone: 'warning' };
      if (electronPlatform === 'darwin') return { key: 'includedMac', tone: 'warning' };
      if (electronPlatform === 'linux') return { key: 'includedLinux', tone: 'warning' };
      return legacyNote(electronPlatform, checked);
    case 'unavailable':
      return { key: 'unavailableMac', tone: 'warning' };
    case 'unknown':
    case null:
      return legacyNote(electronPlatform, checked);
  }
}

const CAPABILITIES: readonly OwnAudioInSystemAudio[] = ['excluded', 'included', 'unavailable', 'unknown'];

function asCapability(value: unknown): OwnAudioInSystemAudio | null {
  return CAPABILITIES.find((c) => c === value) ?? null;
}

/** Asked once per app run: the OS build does not change under it. */
let capabilityRequest: Promise<OwnAudioInSystemAudio | null> | null = null;

function requestCapability(): Promise<OwnAudioInSystemAudio | null> {
  if (!capabilityRequest) {
    const ask = getElectronAPI()?.getSystemAudioCapability;
    // A desktop app older than the method keeps the notes it had before.
    capabilityRequest = typeof ask === 'function'
      ? ask().then(asCapability, () => null)
      : Promise.resolve(null);
  }
  return capabilityRequest;
}

/** Test seam: forget the cached answer. */
export function resetSystemAudioCapabilityForTests(): void {
  capabilityRequest = null;
}

/** The desktop app's answer for this machine; null in a browser, an older app, or until it arrives. */
export function useOwnAudioInSystemAudio(): OwnAudioInSystemAudio | null {
  const [capability, setCapability] = useState<OwnAudioInSystemAudio | null>(null);
  useEffect(() => {
    if (!getElectronAPI()) return;
    let active = true;
    void requestCapability().then((answer) => { if (active) setCapability(answer); });
    return () => { active = false; };
  }, []);
  return capability;
}
