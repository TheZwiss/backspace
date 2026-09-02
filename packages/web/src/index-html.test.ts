import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');

describe('index.html meta policy', () => {
  const meta = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/i,
  );

  it('declares a meta policy', () => {
    expect(meta).not.toBeNull();
  });

  it('constrains scripts, objects and base', () => {
    const content = meta?.[1] ?? '';
    expect(content).toContain("object-src 'none'");
    expect(content).toContain("base-uri 'self'");
    expect(content).toContain("script-src 'self' 'wasm-unsafe-eval'");
  });

  it('allows the blob worker the WebSocket keepalive runs in', () => {
    // worker-src falls back to script-src when it is absent, and script-src here
    // does not list blob:. Without this directive the meta policy blocks the
    // Worker created in src/hooks/useWebSocket.ts and every connection loses its
    // heartbeat, with nothing but a console entry to show for it. Verified in a
    // headless browser against the built bundle on 2026-09-02.
    const content = meta?.[1] ?? '';
    expect(content).toContain("worker-src 'self' blob:");
  });

  it('carries no directive the server owns dynamically', () => {
    // connect-src, img-src and frame-src depend on operator config and on peers
    // discovered at runtime. A meta tag cannot know them, and a meta policy
    // INTERSECTS with the header rather than replacing it, so a stale copy here
    // would silently block things the server policy allows.
    const content = meta?.[1] ?? '';
    for (const directive of ['connect-src', 'img-src', 'media-src', 'frame-src']) {
      expect(content).not.toContain(directive);
    }
  });

  it('carries no directive a meta tag cannot express', () => {
    // frame-ancestors, report-uri and sandbox are ignored in a meta policy.
    // Putting them here would read as protection that is not there.
    const content = meta?.[1] ?? '';
    for (const directive of ['frame-ancestors', 'report-uri', 'sandbox']) {
      expect(content).not.toContain(directive);
    }
  });
});
