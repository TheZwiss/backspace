import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { integrateAppImage } from './appImageIntegration';

const dirs: string[] = [];
function temporaryDir() { const dir = mkdtempSync(join(tmpdir(), 'backspace-integration-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('AppImage desktop integration', () => {
  it('creates an entry for the exact AppImage without shell expansion', () => {
    const dir = temporaryDir();
    expect(integrateAppImage('/tmp/Backspace "test" $d 100%.AppImage', dir)).toBe(true);
    const text = readFileSync(join(dir, 'applications/io.github.TheZwiss.backspace.desktop'), 'utf8');
    expect(text).toContain('Exec="/tmp/Backspace \\"test\\" \\$d 100%%.AppImage"');
  });
  it('preserves an existing user entry', () => {
    const dir = temporaryDir();
    expect(integrateAppImage('/tmp/first.AppImage', dir)).toBe(true);
    const file = join(dir, 'applications/io.github.TheZwiss.backspace.desktop');
    writeFileSync(file, 'user-owned entry');
    expect(integrateAppImage('/tmp/second.AppImage', dir)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('user-owned entry');
  });
  it('does not write an entry outside the AppImage context', () => {
    expect(integrateAppImage(undefined, temporaryDir())).toBe(false);
    expect(integrateAppImage('relative.AppImage', temporaryDir())).toBe(false);
  });
});
