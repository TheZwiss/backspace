import { afterEach, describe, it, expect, vi } from 'vitest';
import bcrypt from 'bcryptjs';

/**
 * #326: the bcrypt cost comes from `config.passwordHashCost`, which is 12 in
 * a deployment and bcrypt's minimum under the test suite, so hashing cases do
 * not time out under load.
 */
describe('password hash cost', () => {
  const nodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = nodeEnv;
    vi.resetModules();
  });

  it('hashes at cost 4 under the test suite, and the hash verifies', async () => {
    const { hashPassword, verifyPassword } = await import('./auth.js');
    const hash = await hashPassword('correct horse');
    expect(bcrypt.getRounds(hash)).toBe(4);
    await expect(verifyPassword('correct horse', hash)).resolves.toBe(true);
  });

  it('is 12 outside the test suite', async () => {
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    const { config } = await import('../config.js');
    expect(config.passwordHashCost).toBe(12);
  });

  it('verifies a hash made at the production cost', async () => {
    const { verifyPassword } = await import('./auth.js');
    const hash = await bcrypt.hash('correct horse', 12);
    await expect(verifyPassword('correct horse', hash)).resolves.toBe(true);
  });
});
