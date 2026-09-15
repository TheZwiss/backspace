/**
 * Detects the visitor's desktop platform and builds the GitHub release download links
 * for it. Pure and dependency-free: the navigator arrives as an argument so the module
 * runs the same in a test as it does in the browser.
 *
 * The offer is one primary build for the detected platform plus every other build of
 * the release. The secondary list leads with the rest of the detected platform's own
 * builds and then runs windows, linux, mac over what is left, the same order the
 * README table and the Downloads table in the release notes use.
 */

export type DesktopOs = 'windows' | 'mac' | 'linux' | 'other';
export type DesktopArch = 'x64' | 'arm64';

export interface DetectedPlatform {
  os: DesktopOs;
  /** null only for `other`, which has no build. */
  arch: DesktopArch | null;
  /** true when the architecture came from the platform default, not from the browser. */
  archGuessed: boolean;
}

export interface DesktopDownload {
  os: Exclude<DesktopOs, 'other'>;
  arch: DesktopArch;
  kind: 'exe' | 'dmg' | 'appimage' | 'deb';
  filename: string;
  url: string;
}

export interface DesktopDownloadLinks {
  primary: DesktopDownload | null;
  /**
   * Every remaining build: the detected platform's own builds first, then the
   * other platforms in windows, linux, mac order. Within a platform the
   * detected architecture comes before the other one.
   */
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
  arch: DesktopArch;
  kind: DesktopDownload['kind'];
  /**
   * The part of the filename between the version and the extension: the platform token
   * and the architecture as electron-builder spells it for that format (`x86_64` for an
   * AppImage, `amd64` for a deb, `x64` everywhere else). Kept in step with
   * `artifactName` in packages/desktop/electron-builder.yml and the Downloads table
   * that .github/workflows/release.yml writes into the release notes.
   */
  fileSuffix: string;
  ext: string;
}

/** Exactly what electron-builder emits for a release, in the canonical windows, linux, mac order. */
const BUILDS: readonly BuildSpec[] = [
  { os: 'windows', arch: 'x64', kind: 'exe', fileSuffix: '-win-x64', ext: 'exe' },
  { os: 'windows', arch: 'arm64', kind: 'exe', fileSuffix: '-win-arm64', ext: 'exe' },
  { os: 'linux', arch: 'x64', kind: 'appimage', fileSuffix: '-linux-x86_64', ext: 'AppImage' },
  { os: 'linux', arch: 'arm64', kind: 'appimage', fileSuffix: '-linux-arm64', ext: 'AppImage' },
  { os: 'linux', arch: 'x64', kind: 'deb', fileSuffix: '-linux-amd64', ext: 'deb' },
  { os: 'linux', arch: 'arm64', kind: 'deb', fileSuffix: '-linux-arm64', ext: 'deb' },
  { os: 'mac', arch: 'arm64', kind: 'dmg', fileSuffix: '-mac-arm64', ext: 'dmg' },
  { os: 'mac', arch: 'x64', kind: 'dmg', fileSuffix: '-mac-x64', ext: 'dmg' },
];

/**
 * The build offered when the browser will not say which architecture it runs on.
 * The Windows default is load-bearing rather than merely likely: the x64 installer
 * runs under emulation on Windows on ARM, while the arm64 installer on an x64
 * machine finds no package to extract. A wrong guess must land on x64.
 */
const DEFAULT_ARCH: Record<Exclude<DesktopOs, 'other'>, DesktopArch> = { windows: 'x64', mac: 'arm64', linux: 'x64' };

/** null when the hint names no platform this module recognises, which the caller reads as "ask the user agent". */
function osFromHintPlatform(platform: string): DesktopOs | null {
  switch (platform) {
    case 'Windows':
      return 'windows';
    case 'macOS':
      return 'mac';
    case 'Linux':
      return 'linux';
    case 'Chrome OS':
    case 'Android':
    case 'iOS':
      // Recognised, and this module has no build for any of them.
      return 'other';
    default:
      // Chromium sends 'Unknown' when it cannot name the platform, and the
      // list above is not closed. A value we do not know says nothing, so it
      // must not outrank the user agent string.
      return null;
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
  // A recognised client hint platform decides the OS even when the user agent
  // string disagrees. An absent or unrecognised one leaves the decision to it.
  const hinted = uaData?.platform ? osFromHintPlatform(uaData.platform) : null;
  const os = hinted ?? osFromUserAgent(nav.userAgent);
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

/** Reads the OS and the CPU architecture off a navigator. Never rejects. */
export async function detectDesktopPlatform(nav: NavigatorLike): Promise<DetectedPlatform> {
  const os = detectOs(nav);
  if (os === 'other') return { os, arch: null, archGuessed: false };

  const hinted = await archFromClientHints(nav);
  if (hinted) return { os, arch: hinted, archGuessed: false };

  // Every browser on Windows on ARM freezes its user agent at "Win64; x64", so
  // the token says nothing there. Only a client hint counts as a detection on
  // Windows; anything else is the default, and the panel says it is a guess.
  if (os !== 'windows') {
    const fromUserAgent = archFromUserAgent(nav.userAgent);
    if (fromUserAgent) return { os, arch: fromUserAgent, archGuessed: false };
  }

  return { os, arch: DEFAULT_ARCH[os], archGuessed: true };
}

function otherArch(arch: DesktopArch): DesktopArch {
  return arch === 'x64' ? 'arm64' : 'x64';
}

function buildsFor(os: BuildSpec['os'], arch: DesktopArch): BuildSpec[] {
  // BUILDS lists the AppImage before the deb, so filtering keeps that order within an arch.
  return BUILDS.filter((build) => build.os === os && build.arch === arch);
}

/** The canonical platform order, used for every platform the visitor is not on. */
const PLATFORM_ORDER: readonly Exclude<DesktopOs, 'other'>[] = ['windows', 'linux', 'mac'];

/** One platform's builds, the architecture the visitor is most likely to want first. */
function platformBuilds(os: BuildSpec['os'], detectedArch: DesktopArch | null): BuildSpec[] {
  const arch = detectedArch ?? DEFAULT_ARCH[os];
  return [...buildsFor(os, arch), ...buildsFor(os, otherArch(arch))];
}

/**
 * The visitor's own platform first, so the builds most likely to be wanted next
 * (the other architecture, the other package format) sit closest to the primary
 * offer. The platforms that are left follow in windows, linux, mac order.
 */
function orderedBuilds(detected: DetectedPlatform): BuildSpec[] {
  const order =
    detected.os === 'other'
      ? PLATFORM_ORDER
      : [detected.os, ...PLATFORM_ORDER.filter((os) => os !== detected.os)];
  return order.flatMap((os) => platformBuilds(os, detected.arch));
}

function primaryBuild(detected: DetectedPlatform): BuildSpec | null {
  if (detected.os === 'other') return null;
  const arch = detected.arch ?? DEFAULT_ARCH[detected.os];
  // BUILDS lists the AppImage before the deb, so the first Linux match is the AppImage.
  return BUILDS.find((build) => build.os === detected.os && build.arch === arch) ?? null;
}

function toDownload(build: BuildSpec, version: string, versionIsReleasable: boolean): DesktopDownload {
  const filename = `Backspace-${version}${build.fileSuffix}.${build.ext}`;
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
  const others = orderedBuilds(detected)
    .filter((build) => build !== primarySpec)
    .map((build) => toDownload(build, version, versionIsReleasable));
  return {
    primary: primarySpec ? toDownload(primarySpec, version, versionIsReleasable) : null,
    others,
    allReleasesUrl: RELEASES_URL,
  };
}
