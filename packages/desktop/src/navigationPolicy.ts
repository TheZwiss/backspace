// Pure decision logic for the `will-navigate` deny handler wired up in
// main.ts's createWindow(). Extracted so it can be unit-tested without
// booting Electron; main.ts owns the wiring (webContents.on('will-navigate',
// ...) + event.preventDefault()), this module owns the policy (which
// top-level navigations are allowed).
//
// `will-navigate` fires only for page/user-initiated top-level navigation
// (a clicked link, `window.location` assignment, a meta-refresh) — never for
// main-process `webContents.loadURL()`/`loadFile()` calls. That means the
// app's own initial instance load, the file:// picker load, and
// cross-instance switching (all done via loadURL/loadFile in main.ts) never
// reach this policy. It still explicitly allows same-origin navigation, the
// bundled picker, and known federation-peer origins — defense-in-depth
// against a compromised or malicious renderer trying to hijack the
// top-level frame — rather than denying unconditionally.

export interface NavigationPolicyInput {
  /** The navigation target, exactly as received from the `will-navigate` event. */
  targetUrl: string;
  /** The window's current top-level URL (webContents.getURL()), or null if unavailable/unparseable. */
  currentUrl: string | null;
  /** file:// URL of the bundled instance picker (pathToFileURL(getPickerPath()).href). */
  pickerFileUrl: string;
  /** Federation peer + own-instance origins the renderer has reported as connected (main.ts's knownInstanceOrigins). */
  knownInstanceOrigins: ReadonlySet<string>;
}

export function isNavigationAllowed(input: NavigationPolicyInput): boolean {
  const { targetUrl, currentUrl, pickerFileUrl, knownInstanceOrigins } = input;

  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }

  if (target.protocol === 'file:') {
    return target.href === pickerFileUrl;
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return false;
  }

  let currentOrigin: string | null = null;
  if (currentUrl !== null) {
    try {
      currentOrigin = new URL(currentUrl).origin;
    } catch {
      currentOrigin = null;
    }
  }

  return target.origin === currentOrigin || knownInstanceOrigins.has(target.origin);
}
