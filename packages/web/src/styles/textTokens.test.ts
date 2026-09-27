import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import tailwindConfig from '../../tailwind.config.js';

// Tailwind emits no rule for a colour class whose token is not in the config,
// and says nothing about it: the element silently takes its parent's colour.
// `text-txt-muted` rendered white that way in thirteen places (#312). This
// check fails on any `*-txt-<name>` class whose <name> is not a `colors.txt`
// token.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const txtClass = /(?<![\w-])(?:text|bg|border|ring|fill|stroke|from|via|to|placeholder|divide|outline|decoration|caret|accent)-txt-([a-z]+(?:-[a-z]+)*)/g;

interface ColorConfig { theme: { extend: { colors: { txt: Record<string, string> } } } }
const tokens = new Set(Object.keys((tailwindConfig as ColorConfig).theme.extend.colors.txt));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}

it('detects an unknown txt token in a class list', () => {
  const found = Array.from('px-2 text-txt-muted hover:text-txt-tertiary'.matchAll(txtClass), m => m[1]);
  expect(found).toEqual(['muted', 'tertiary']);
  expect(tokens.has('muted')).toBe(false);
  expect(tokens.has('tertiary')).toBe(true);
});

it('uses only text colour tokens that tailwind.config.js defines', () => {
  const violations: string[] = [];
  for (const file of files(root)) {
    if (!/\.(tsx?|css)$/.test(file) || /\.test\./.test(file)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      for (const match of line.matchAll(txtClass)) {
        if (!tokens.has(match[1]!)) violations.push(`${relative(root, file)}:${index + 1}: ${match[0]}`);
      }
    });
  }
  expect(violations).toEqual([]);
});
