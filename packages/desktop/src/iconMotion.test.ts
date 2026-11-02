import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { getIconMotionScript } from './iconMotion';
describe('native icon feedback resource', () => {
  it('loads the packaged shared engine as an executable browser script', () => {
    const script = getIconMotionScript();
    expect(() => new Script(script)).not.toThrow();
    expect(script).toContain('installIconMotion(document,');
    expect(script).not.toContain('export function');
    expect(getIconMotionScript()).toBe(script);
  });
});
