import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('loads the shared engine through the production tsx/esm entry, without starting a server', () => {
  // Vitest transpilation can hide CJS/ESM interop errors that break the Docker entrypoint.
  const output = execFileSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e',
    "import { TranslationService, TranslationError } from '@backspace/translation'; console.log(typeof TranslationService, typeof TranslationError);",
  ], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' });
  expect(output.trim()).toBe('function function');
});
