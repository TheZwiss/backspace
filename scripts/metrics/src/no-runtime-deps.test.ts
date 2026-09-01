import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

/**
 * Strips block comments and whole-line `//` comments before scanning.
 *
 * The scanners below are regexes, not a parser, so without this they read
 * JSDoc prose as if it were code: a doc comment that happens to contain a
 * quoted phrase near the word `from` matches IMPORT_RE and fails the build
 * for a dependency that does not exist. That cost a real implementer real
 * time on this package, and every module here is heavily documented.
 *
 * Only two forms are stripped, both deliberately conservative. A real
 * `import` statement can never begin with `//`, and the imports in these
 * files all precede any code that could contain a stray `/*` inside a string
 * literal — so stripping cannot hide an import from the scanners, which is
 * the only direction that would turn a spurious failure into a missed
 * defect. `stripComments keeps a real import that follows a comment` below
 * pins that.
 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Matches the module specifier of any static import or re-export. */
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;

/** Matches a bare side-effect import: `import 'x'` with no `from` clause. */
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

/**
 * Extract all import specifiers from a file, from both `from` imports and
 * side-effect imports. Used by both constraint tests.
 */
function allSpecifiersInFile(source: string): Array<{ spec: string; statement: string }> {
  const text = stripComments(source);
  const specifiers: Array<{ spec: string; statement: string }> = [];

  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (spec !== undefined) {
      specifiers.push({ spec, statement: match[0] });
    }
  }

  for (const match of text.matchAll(SIDE_EFFECT_RE)) {
    const spec = match[1];
    if (spec !== undefined) {
      specifiers.push({ spec, statement: match[0] });
    }
  }

  return specifiers;
}

describe('collector source constraints', () => {
  it('has source files to check', () => {
    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  it('imports nothing outside node: builtins and relative paths', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(path.join(srcDir, file), 'utf8');
      for (const { spec } of allSpecifiersInFile(text)) {
        const ok = spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../');
        if (!ok) offenders.push(`${file} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses the .ts extension on every relative import', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(path.join(srcDir, file), 'utf8');
      for (const { spec } of allSpecifiersInFile(text)) {
        if ((spec.startsWith('./') || spec.startsWith('../')) && !spec.endsWith('.ts')) {
          offenders.push(`${file} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // Known limitation: the `import type` check below matches only the
  // statement-level form. `import { type Foo } from './types.ts'` — the inline
  // modifier, which Node erases correctly and is therefore safe — would be
  // flagged. Use the statement-level form in this package and the guard stays
  // quiet. A precise check needs an AST parser, which is not worth a dependency
  // in a package whose whole point is having none.
  it('imports types with the type keyword so Node can erase them', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(path.join(srcDir, file), 'utf8');
      for (const { spec, statement } of allSpecifiersInFile(text)) {
        if (!spec.endsWith('types.ts')) continue;
        if (!/import\s+type\b/.test(statement)) {
          offenders.push(`${file} -> ${spec} (missing import type)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ignores import-like prose inside comments', () => {
    const source = [
      '/**',
      ' * Reads a value from \'somewhere\' and returns it.',
      ' */',
      "// import lodash from 'lodash';",
      "import { parseCsv } from './series.ts';",
    ].join('\n');
    expect(allSpecifiersInFile(source).map((s) => s.spec)).toEqual(['./series.ts']);
  });

  it('stripComments keeps a real import that follows a comment', () => {
    const source = ["/* a block comment */", "import { x } from 'node:fs';"].join('\n');
    expect(stripComments(source)).toContain("import { x } from 'node:fs';");
  });
});
