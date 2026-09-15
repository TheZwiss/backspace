/**
 * Detects the visitor's desktop platform and builds the GitHub release download links
 * for it. Pure and dependency-free: the navigator arrives as an argument so the module
 * runs the same in a test as it does in the browser.
 */

export type DesktopOs = 'windows' | 'mac' | 'linux' | 'other';
export type DesktopArch = 'x64' | 'arm64';

export interface DetectedPlatform {
  os: DesktopOs;
  /** null when unknown or irrelevant (windows, other). */
  arch: DesktopArch | null;
  /** true when the architecture came from the platform default, not from the browser. */
  archGuessed: boolean;
}

export interface DesktopDownload {
  os: Exclude<DesktopOs, 'other'>;
  /** null for the combined Windows installer, which picks the architecture at install time. */
  arch: DesktopArch | null;
  kind: 'exe' | 'dmg' | 'appimage' | 'deb';
  filename: string;
  url: string;
}

export interface DesktopDownloadLinks {
  primary: DesktopDownload | null;
  /** Every remaining build, ordered windows, mac, linux; within a platform the detected arch first. */
  others: DesktopDownload[];
  allReleasesUrl: string;
}

/**
 * The shape this module needs from a navigator. `window.navigator` satisfies it, and so
 * does a plain object in a test. In jsdom both optional members are absent.
 */
export interface NavigatorLike {
  userAgent: string;
  maxTouchPoints?: number;
  userAgentData?: {
    platform?: string;
    mobile?: boolean;
    getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
  };
}

/** The release listing, not `releases/latest`: filenames carry the version, so there is no fixed-name asset. */
export const RELEASES_URL = 'https://github.com/TheZwiss/backspace/releases';

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

interface BuildSpec {
  os: Exclude<DesktopOs, 'other'>;
  arch: DesktopArch | null;
  kind: DesktopDownload['kind'];
  /** The part of the filename between the version and the extension, empty for the combined installer. */
  fileArch: string;
  ext: string;
}

/** Exactly what electron-builder emits for a release, in the canonical windows, mac, linux order. */
const BUILDS: readonly BuildSpec[] = [
  { os: 'windows', arch: null, kind: 'exe', fileArch: '', ext: 'exe' },
  { os: 'mac', arch: 'arm64', kind: 'dmg', fileArch: '-arm64', ext: 'dmg' },
  { os: 'mac', arch: 'x64', kind: 'dmg', fileArch: '-x64', ext: 'dmg' },
  { os: 'linux', arch: 'x64', kind: 'appimage', fileArch: '-x86_64', ext: 'AppImage' },
  { os: 'linux', arch: 'arm64', kind: 'appimage', fileArch: '-arm64', ext: 'AppImage' },
  { os: 'linux', arch: 'x64', kind: 'deb', fileArch: '-amd64', ext: 'deb' },
  { os: 'linux', arch: 'arm64', kind: 'deb', fileArch: '-arm64', ext: 'deb' },
];

/** The build offered when the browser will not say which architecture it runs on. */
const DEFAULT_ARCH: Record<'mac' | 'linux', DesktopArch> = { mac: 'arm64', linux: 'x64' };

function osFromHintPlatform(platform: string): DesktopOs {
  switch (platform) {
    case 'Windows':
      return 'windows';
    case 'macOS':
      return 'mac';
    case 'Linux':
      return 'linux';
    default:
      // Chrome OS, Android, iOS and anything else this module has no build for.
      return 'other';
  }
}

function osFromUserAgent(userAgent: string): DesktopOs {
  if (/Mobile|iPhone|iPad|Android|CrOS/.test(userAgent)) return 'other';
  if (userAgent.includes('Windows')) return 'windows';
  if (userAgent.includes('Mac')) return 'mac';
  if (userAgent.includes('Linux') || userAgent.includes('X11')) return 'linux';
  return 'other';
}

function detectOs(nav: NavigatorLike): DesktopOs {
  const uaData = nav.userAgentData;
  if (uaData?.mobile === true) return 'other';
  // A client hint platform decides the OS even when the user agent string disagrees.
  const os = uaData?.platform ? osFromHintPlatform(uaData.platform) : osFromUserAgent(nav.userAgent);
  // Safari on iPadOS sends a Mac user agent, and a Mac has no touch screen.
  if (os === 'mac' && (nav.maxTouchPoints ?? 0) > 1) return 'other';
  return os;
}

async function archFromClientHints(nav: NavigatorLike): Promise<DesktopArch | null> {
  const uaData = nav.userAgentData;
  if (!uaData?.getHighEntropyValues) return null;
  try {
    const values = await uaData.getHighEntropyValues(['architecture', 'bitness']);
    // Chromium reports 64-bit ARM as architecture 'arm' with bitness '64'.
    if (values.architecture === 'arm') return 'arm64';
    if (values.architecture === 'x86' && values.bitness === '64') return 'x64';
    return null;
  } catch {
    // The call can be missing, throw synchronously, or reject; all three fall through.
    return null;
  }
}

function archFromUserAgent(userAgent: string): DesktopArch | null {
  const ua = userAgent.toLowerCase();
  if (ua.includes('aarch64') || ua.includes('arm64')) return 'arm64';
  if (ua.includes('x86_64') || ua.includes('x64') || ua.includes('win64') || ua.includes('wow64')) return 'x64';
  // armv7l and armv8l are 32-bit, and there is no 32-bit build, so they fall through.
  return null;
}

/** Reads the OS and, where it matters, the CPU architecture off a navigator. Never rejects. */
export async function detectDesktopPlatform(nav: NavigatorLike): Promise<DetectedPlatform> {
  const os = detectOs(nav);
  // The Windows installer covers both architectures, and `other` has no build at all.
  if (os === 'windows' || os === 'other') return { os, arch: null, archGuessed: false };

  const hinted = await archFromClientHints(nav);
  if (hinted) return { os, arch: hinted, archGuessed: false };

  const fromUserAgent = archFromUserAgent(nav.userAgent);
  if (fromUserAgent) return { os, arch: fromUserAgent, archGuessed: false };

  return { os, arch: DEFAULT_ARCH[os], archGuessed: true };
}

function otherArch(arch: DesktopArch): DesktopArch {
  return arch === 'x64' ? 'arm64' : 'x64';
}

function buildsFor(os: BuildSpec['os'], arch: DesktopArch): BuildSpec[] {
  // BUILDS lists the AppImage before the deb, so filtering keeps that order within an arch.
  return BUILDS.filter((build) => build.os === os && build.arch === arch);
}

/** Windows first, then mac and linux with the architecture the visitor is most likely to want. */
function orderedBuilds(detectedArch: DesktopArch | null): BuildSpec[] {
  const macArch = detectedArch ?? DEFAULT_ARCH.mac;
  const linuxArch = detectedArch ?? DEFAULT_ARCH.linux;
  return [
    ...BUILDS.filter((build) => build.os === 'windows'),
    ...buildsFor('mac', macArch),
    ...buildsFor('mac', otherArch(macArch)),
    ...buildsFor('linux', linuxArch),
    ...buildsFor('linux', otherArch(linuxArch)),
  ];
}

function primaryBuild(detected: DetectedPlatform): BuildSpec | null {
  if (detected.os === 'other') return null;
  if (detected.os === 'windows') return BUILDS.find((build) => build.os === 'windows') ?? null;
  const arch = detected.arch ?? DEFAULT_ARCH[detected.os];
  if (detected.os === 'mac') return BUILDS.find((build) => build.os === 'mac' && build.arch === arch) ?? null;
  return BUILDS.find((build) => build.os === 'linux' && build.kind === 'appimage' && build.arch === arch) ?? null;
}

function toDownload(build: BuildSpec, version: string, versionIsReleasable: boolean): DesktopDownload {
  const filename = `Backspace-${version}${build.fileArch}.${build.ext}`;
  return {
    os: build.os,
    arch: build.arch,
    kind: build.kind,
    filename,
    // A development version has no tag to download from, so every link goes to the listing.
    url: versionIsReleasable ? `${RELEASES_URL}/download/v${version}/${filename}` : RELEASES_URL,
  };
}

/** Turns an instance version and a detected platform into the offer the Desktop tab renders. */
export function buildDesktopDownloads(version: string, detected: DetectedPlatform): DesktopDownloadLinks {
  const versionIsReleasable = VERSION_PATTERN.test(version);
  const primarySpec = primaryBuild(detected);
  const others = orderedBuilds(detected.arch)
    .filter((build) => build !== primarySpec)
    .map((build) => toDownload(build, version, versionIsReleasable));
  return {
    primary: primarySpec ? toDownload(primarySpec, version, versionIsReleasable) : null,
    others,
    allReleasesUrl: RELEASES_URL,
  };
}
