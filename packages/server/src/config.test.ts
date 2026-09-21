import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// config.ts reads process.env at module load, so each case sets the variable
// and re-imports a fresh copy of the module.
async function loadConfig(): Promise<typeof import('./config.js')['config']> {
  vi.resetModules();
  const mod = await import('./config.js');
  return mod.config;
}

const saved = process.env.DIRECTORY_ENDPOINT;

beforeEach(() => {
  delete process.env.DIRECTORY_ENDPOINT;
});

afterEach(() => {
  if (saved === undefined) delete process.env.DIRECTORY_ENDPOINT;
  else process.env.DIRECTORY_ENDPOINT = saved;
});

describe('config.directory.endpoint', () => {
  it('defaults to the project hub when DIRECTORY_ENDPOINT is unset', async () => {
    const config = await loadConfig();
    expect(config.directory.endpoint).toBe('https://explore.backspacechat.com');
  });

  it('an empty DIRECTORY_ENDPOINT stays empty, which means disabled', async () => {
    process.env.DIRECTORY_ENDPOINT = '';
    const config = await loadConfig();
    expect(config.directory.endpoint).toBe('');
  });

  it('drops trailing slashes from a custom hub', async () => {
    process.env.DIRECTORY_ENDPOINT = 'https://x.test/';
    const config = await loadConfig();
    expect(config.directory.endpoint).toBe('https://x.test');
  });
});
