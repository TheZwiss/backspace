// ESLint flat config for every workspace package. `pnpm lint` runs it over the
// whole repository; CI runs the same command in its own job.
//
// Two mechanisms keep the run green without hollowing the rule set out:
//   - Rules that encode a decision the project has not taken (React Compiler
//     readiness, CommonJS in build scripts) are switched off below, each with
//     the condition that would bring it back.
//   - Violations that predate the lint step stay recorded in
//     eslint-suppressions.json. The rule keeps firing on new code; only the
//     counted, already-present occurrences are ignored. Regenerate with
//     `pnpm lint:suppress`, prune with `pnpm lint:prune`.
//
// tsc already reports undefined identifiers in TypeScript, so `no-undef` is on
// only for the plain JavaScript files no tsconfig covers.

const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');

// ESLint's built-in environments do not exist in flat config, and the `globals`
// package is not worth a dependency for the handful of plain JS files here.
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  AbortController: 'readonly',
  fetch: 'readonly',
  crypto: 'readonly',
  WebSocket: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
};

const commonjsGlobals = {
  ...nodeGlobals,
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  matchMedia: 'readonly',
  IntersectionObserver: 'readonly',
  MutationObserver: 'readonly',
  ResizeObserver: 'readonly',
  getComputedStyle: 'readonly',
  CustomEvent: 'readonly',
  Image: 'readonly',
};

module.exports = tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-electron/**',
      '**/build/**',
      '**/installers/**',
      '**/coverage/**',
      // Runtime data, not source: the SQLite database, uploads and backups.
      'data/**',
      // Vendored third-party bundle (uPlot) and the dashboard payloads the
      // metrics bundler writes at deploy time. See docs/systems/metrics.md.
      'site/insights/vendor/**',
      'site/insights/data/**',
      'site/insights/data.json',
      // Vite PWA output.
      'packages/web/dev-dist/**',
      // Local scratch: agent worktrees are full second checkouts of this repo,
      // and the harness directories hold generated fixtures.
      '.claude/**',
      '.worktrees/**',
      '.metrics-data/**',
      '.metrics-init/**',
      'tests/.tmp/**',
    ],
  },

  tseslint.configs.recommended,

  {
    linterOptions: {
      // Off because the codebase carries eslint-disable comments for rules this
      // config does not enable (no-control-regex from eslint's own recommended
      // set, @typescript-eslint/consistent-type-assertions from the stylistic
      // set), which the check reports as unused. Turn back on once those rule
      // sets are enabled or the eight stale comments are deleted.
      reportUnusedDisableDirectives: 'off',
    },
  },

  {
    // Plain JavaScript that no tsconfig covers: build scripts, release tooling
    // and the two web config files. CommonJS by design, so the ES-module import
    // rule does not apply to them.
    files: ['**/*.js', '**/*.cjs'],
    ignores: ['site/assets/**'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: commonjsGlobals,
    },
    rules: {
      'no-undef': 'error',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    // ES-module Node scripts: version bump, icon generation, the i18n check,
    // the Flatpak manifest tooling and the insights fixtures.
    files: ['**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      'no-undef': 'error',
    },
  },

  {
    // The landing page's only script. Runs in the browser, no bundler.
    files: ['site/assets/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: browserGlobals,
    },
    rules: {
      'no-undef': 'error',
    },
  },

  {
    // React code. packages/desktop holds only main-process and preload code
    // today; the glob is here so renderer code added later is covered.
    files: ['packages/web/**/*.{ts,tsx}', 'packages/desktop/**/*.tsx'],
    ...reactHooks.configs.flat['recommended-latest'],
    rules: {
      ...reactHooks.configs.flat['recommended-latest'].rules,
      // The five rules below come from the React Compiler rule set that
      // eslint-plugin-react-hooks 7 folds into its recommended config. They
      // flag patterns that are legal in the React this app runs and would
      // block ordinary new components, so they stay off until the project
      // adopts the compiler. Counts at the time of writing:
      // set-state-in-effect 89 sites, refs 42, preserve-manual-memoization 6,
      // purity 5, immutability 2.
      // Raised from the plugin's default of 'warn' so the 13 sites that
      // already miss a dependency can be recorded in the suppressions file and
      // a new one fails the run instead of printing a line nobody reads.
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/immutability': 'off',
    },
  },
);
