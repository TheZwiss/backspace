import { it, expect } from 'vitest';
import pkg from '../package.json';

it('declares no runtime dependencies', () => {
  expect((pkg as { dependencies?: unknown }).dependencies).toBeUndefined();
});
