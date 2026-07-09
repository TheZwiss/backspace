import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup-env.ts'],
    // Vitest 4's default `exclude` is only node_modules/.git — it no longer
    // ignores dist/. Once `pnpm build` (tsc) has emitted the compiled test files
    // into dist/, vitest would otherwise run those stale .js copies alongside the
    // real src/*.test.ts — and they fail, because compiled vi.mock() paths
    // resolve differently than the source. Never run build output as tests.
    exclude: [...configDefaults.exclude, 'dist/**'],
  },
});
