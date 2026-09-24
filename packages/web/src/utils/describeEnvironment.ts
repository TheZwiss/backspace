/**
 * A short description of the browser and OS, written into a bug report's
 * `environment` field, e.g. "Firefox 131 on macOS".
 *
 * English on purpose: it lands in a GitHub issue, not in the UI.
 *
 * Callers pass `navigator.userAgent` and `isElectron()`. Parsed from the
 * user-agent string alone, with no dependency, because a major version and an
 * OS family are all a triager needs and the UA carries both on every browser
 * the client supports.
 */

/**
 * Checked in this order because Edge and Opera also carry "Chrome/", and
 * Chrome also carries "Safari/". Safari's own major is in "Version/".
 */
const BROWSERS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'Edge', pattern: /\bEdg\/(\d+)/ },
  { name: 'Opera', pattern: /\bOPR\/(\d+)/ },
  { name: 'Firefox', pattern: /\bFirefox\/(\d+)/ },
  { name: 'Chrome', pattern: /\bChrome\/(\d+)/ },
  { name: 'Safari', pattern: /\bVersion\/(\d+)\b.*\bSafari\// },
];

/**
 * Checked in this order because iOS carries "like Mac OS X", and Android and
 * ChromeOS both carry "Linux" or "X11".
 */
const SYSTEMS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'Windows', pattern: /\bWindows\b/ },
  { name: 'iOS', pattern: /\b(?:iPhone|iPad|iPod)\b/ },
  { name: 'macOS', pattern: /\bMacintosh\b|\bMac OS X\b/ },
  { name: 'Android', pattern: /\bAndroid\b/ },
  { name: 'ChromeOS', pattern: /\bCrOS\b/ },
  { name: 'Linux', pattern: /\bLinux\b|\bX11\b/ },
];

const CHROME_MAJOR = /\bChrome\/(\d+)/;

function operatingSystem(userAgent: string): string | null {
  return SYSTEMS.find(({ pattern }) => pattern.test(userAgent))?.name ?? null;
}

function browser(userAgent: string): string {
  for (const { name, pattern } of BROWSERS) {
    const major = pattern.exec(userAgent)?.[1];
    if (major !== undefined) return `${name} ${major}`;
  }
  return 'Unknown browser';
}

/** The desktop app is named as such; its engine is the Chrome that Electron bundles. */
function desktopApp(userAgent: string): string {
  const major = CHROME_MAJOR.exec(userAgent)?.[1];
  return major === undefined ? 'Desktop app' : `Desktop app (Chrome ${major})`;
}

export function describeEnvironment(userAgent: string, isDesktopApp: boolean): string {
  const client = isDesktopApp ? desktopApp(userAgent) : browser(userAgent);
  const os = operatingSystem(userAgent);
  return os === null ? client : `${client} on ${os}`;
}
