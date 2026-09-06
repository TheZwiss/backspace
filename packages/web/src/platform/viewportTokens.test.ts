// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}

it('uses scale-adjusted tokens instead of raw viewport units and env in production styles', () => {
  const violations: string[] = [];
  for (const file of files(root)) {
    if (!/\.(tsx?|css)$/.test(file) || /\.test\./.test(file)) continue;
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, '');
    source.split('\n').forEach((line, index) => {
      if (file.endsWith(join('styles', 'globals.css'))
        && /^\s*--(?:app-vh|app-vw|app-dvh|safe-bottom|safe-top|keyboard-inset):/.test(line)) return;
      if (/(?:\d+(?:\.\d+)?(?:d?vh|vw)\b|\benv\s*\()/i.test(line)) {
        violations.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  expect(violations).toEqual([]);
});
