import type { Plugin } from 'vite';

/**
 * The Content-Security-Policy in `index.html` is written for the production
 * build, where every script is an external file and `script-src 'self'` is
 * enough.
 *
 * The dev server is a different shape. `@vitejs/plugin-react` injects its React
 * Refresh preamble as an inline `<script type="module">`, and the production
 * policy has neither `'unsafe-inline'` nor a nonce, so the browser blocks it.
 * The preamble never runs, and every module the plugin transforms then throws
 * "@vitejs/plugin-react can't detect preamble" on first render, so the app does
 * not come up at all under `pnpm dev`.
 *
 * Relaxing script-src for the dev server keeps the rest of the policy active
 * locally, so a violation of object-src, base-uri or worker-src still shows up
 * before it reaches production.
 */
export function relaxScriptSrcForDev(html: string): string {
  return html.replace(
    /(<meta http-equiv="Content-Security-Policy" content="script-src 'self')/,
    "$1 'unsafe-inline'",
  );
}

/**
 * Applies {@link relaxScriptSrcForDev} to the served HTML. `apply: 'serve'`
 * keeps it out of the build entirely, so the shipped artifact carries the
 * strict policy unchanged.
 */
export function devCspPreamble(): Plugin {
  return {
    name: 'backspace:dev-csp-preamble',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler: relaxScriptSrcForDev,
    },
  };
}
