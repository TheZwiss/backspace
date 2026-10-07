/**
 * Whether a system-audio screen share on this machine carries Backspace's own
 * playback (the voice chat, its sounds, in-app embeds) to the viewers. The
 * per-OS-build rule and the Chromium code it follows are stated in
 * docs/systems/voice.md ("System Audio Loopback"); this is that table as code.
 *
 * `unknown` is for a version string this cannot read; the renderer then shows
 * its generic per-platform note.
 */
export type OwnAudioInSystemAudio = 'excluded' | 'included' | 'unavailable' | 'unknown';

/** First Windows build where Chromium honours `restrictOwnAudio` (Windows 11). */
export const WINDOWS_OWN_AUDIO_EXCLUSION_BUILD = 22000;

function parseVersion(version: string): number[] | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function atLeast(version: number[], major: number, minor: number): boolean {
  const [vMajor = 0, vMinor = 0] = version;
  return vMajor > major || (vMajor === major && vMinor >= minor);
}

/**
 * @param platform `process.platform`
 * @param systemVersion `process.getSystemVersion()`: `10.0.<build>` on Windows,
 *   the macOS version on macOS, the kernel release on Linux.
 */
export function ownAudioInSystemAudio(platform: NodeJS.Platform, systemVersion: string): OwnAudioInSystemAudio {
  if (platform === 'linux') return 'included';
  const version = parseVersion(systemVersion);
  if (!version) return 'unknown';
  if (platform === 'win32') {
    const build = version[2];
    if (!build) return 'unknown';
    return build >= WINDOWS_OWN_AUDIO_EXCLUSION_BUILD ? 'excluded' : 'included';
  }
  if (platform === 'darwin') {
    if (atLeast(version, 14, 2)) return 'excluded';
    if (atLeast(version, 13, 0)) return 'included';
    return 'unavailable';
  }
  return 'unknown';
}
