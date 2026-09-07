import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawViewport = /(?:\d+(?:\.\d+)?d?v[hw]\b|\benv\s*\()/i;
const rawBreakpoint = /(?<![\w-])(?:sm|md|lg|xl|2xl):/;
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}

it.each(['100vh', '100vw', '100dvh', '100dvw', 'env(safe-area-inset-bottom)'])(
  'detects raw viewport length %s', value => expect(rawViewport.test(value)).toBe(true),
);
it.each(['sm:block', 'md:flex', 'lg:grid', 'xl:grid-cols-3', '2xl:block', 'hover:md:block'])(
  'detects raw responsive class %s', value => expect(rawBreakpoint.test(value)).toBe(true),
);

it('uses scaled tokens and a shared breakpoint in production styles', () => {
  const violations: string[] = [];
  for (const file of files(root)) {
    if (!/\.(tsx?|css)$/.test(file) || /\.test\./.test(file)) continue;
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, '');
    source.split('\n').forEach((line, index) => {
      if (file.endsWith(join('styles', 'globals.css'))
        && /^\s*--(?:app-vh|app-vw|app-dvh|safe-bottom|safe-top|keyboard-inset):/.test(line)) return;
      const isAuth = relative(root, file).startsWith(join('components', 'auth') + sep);
      if (rawViewport.test(line) || (!isAuth && rawBreakpoint.test(line))) {
        violations.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  expect(violations).toEqual([]);
});
