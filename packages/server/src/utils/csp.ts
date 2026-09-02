/**
 * Content Security Policy construction.
 *
 * The policy is built at runtime rather than written as a constant string
 * because one directive depends on operator configuration: the LiveKit
 * signalling origin. `connect-src` lists the `wss:` scheme, which covers a
 * TLS-terminated LiveKit, but an operator running LiveKit unencrypted on a LAN
 * needs their exact `ws://host:port` listed, and no build-time string can know
 * it.
 *
 * What this policy is and is not for. Backspace renders arbitrary user content
 * and federates with instances discovered at runtime, so `img-src`, `media-src`
 * and `connect-src` cannot be meaningfully constrained: a link embed pulls its
 * preview image from any site on the web, and a peer's API origin is not
 * knowable in advance. The directives that carry the weight here are the ones
 * that stop script injection and clickjacking: `script-src`, `object-src`,
 * `base-uri`, `form-action` and `frame-ancestors`. The permissive content
 * directives are a deliberate, documented trade, not an oversight.
 *
 * See docs/systems/web-security.md.
 */

export interface CspInput {
  /** `config.livekit.url`. Absent, empty or unparseable means voice is off. */
  livekitUrl?: string | null;
}

/**
 * The exact origins `utils/embedClassifier.ts` produces `embedUrl` values for.
 * `frame-src` defaults to `default-src`, so without these three the YouTube,
 * Vimeo and Spotify embeds render as blank boxes.
 */
export const EMBED_FRAME_ORIGINS: readonly string[] = [
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
  'https://open.spotify.com',
];

/** Path of the in-app violation sink. Must match routes/cspReport.ts. */
export const CSP_REPORT_PATH = '/api/csp-report';

/** Name of the Reporting-Endpoints group used by `report-to`. */
export const CSP_REPORT_GROUP = 'csp';

function livekitOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:' &&
        url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    // `origin` drops any path, query and trailing slash, which is what a CSP
    // source expression wants. A URL like wss://host/livekit/ would otherwise
    // be emitted verbatim and match nothing.
    return url.origin;
  } catch {
    return null;
  }
}

export function buildCspDirectives(input: CspInput): Record<string, string[]> {
  const livekit = livekitOrigin(input.livekitUrl);

  // Peers are discovered at runtime and are not enumerable, so the schemes are
  // listed rather than the hosts. `http:` is present alongside `https:` because
  // self-hosters do run instances on a plain-HTTP LAN; on an HTTPS page the
  // browser blocks mixed content regardless, so listing it costs nothing there.
  const connectSrc = ["'self'", 'https:', 'http:', 'wss:', 'ws:', 'blob:', 'data:'];
  if (livekit && !connectSrc.includes(livekit)) {
    connectSrc.push(livekit);
  }

  return {
    'default-src': ["'self'"],
    // 'wasm-unsafe-eval' is required by the rnnoise WebAssembly module the
    // noise suppressor instantiates (web/src/audio/AudioManager.ts). It permits
    // WebAssembly compilation only and does not re-enable eval() or
    // new Function(), which is why it exists as a separate source expression.
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    // React writes element styles through the CSSOM rather than as inline style
    // attributes, so `style={{...}}` is unaffected by CSP. 'unsafe-inline' is
    // here for injected <style> blocks from the bundler and from third-party
    // components, and carries far less risk than its script-src namesake.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
    'media-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': connectSrc,
    // The 15-second WebSocket keepalive runs in a Worker created from a blob
    // URL (web/src/hooks/useWebSocket.ts). worker-src falls back to script-src,
    // so omitting blob: here kills every connection's heartbeat silently.
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
    'frame-src': [...EMBED_FRAME_ORIGINS],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    // The app is never framed. The desktop client loads instances with a
    // top-level BrowserWindow.loadURL (desktop/src/main.ts:380), not a webview
    // or an iframe, so denying all ancestors does not affect it.
    'frame-ancestors': ["'none'"],
    'report-uri': [CSP_REPORT_PATH],
    'report-to': [CSP_REPORT_GROUP],
  };
}

export function buildCspHeaderValue(input: CspInput): string {
  return Object.entries(buildCspDirectives(input))
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}
