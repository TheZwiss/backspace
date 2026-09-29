// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import tailwindConfig from '../../tailwind.config.js';

// Tailwind emits no rule for a class whose token is not in the config, and
// says nothing about it: the element silently keeps its parent's text colour,
// no background, or preflight's default border colour (gray-200, a bright
// line on this dark UI). `text-txt-muted` rendered white that way in thirteen
// places (#312), `border-border-subtle` drew light-grey dashed rings (#328).
//
// This check asks Tailwind itself. Every colour-utility class written in the
// source (any string literal that reads as a class list, and the class
// attributes of index.html) is compiled with the real config and the app's
// stylesheet; a class that produces no rule fails. So the set of valid
// classes is whatever tailwind.config.js and globals.css define, every colour
// family at once, with no list to keep in step.
//
// Out of reach: arbitrary values (`bg-[#111]`, always generated), and classes
// assembled at run time (`bg-${tone}-500`), which Tailwind cannot see either.

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcRoot = join(webRoot, 'src');

/** Utilities that take a colour. A class starting with one of these is checked. */
const COLOR_UTILITY = /^-?(?:text|bg|border(?:-[xytrblse])?|ring(?:-offset)?|fill|stroke|from|via|to|placeholder|divide|outline|decoration|caret|accent|shadow)-[a-z]/;

interface Candidate {
  /** The utility without variants or `!`, e.g. `bg-surface-input/50`. */
  utility: string;
  /** `file:line` and the class as written, for the failure message. */
  where: string;
}

/** The utility a class applies, without its variants and `!`: `hover:!bg-x/10` gives `bg-x/10`. */
function utilityOf(className: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < className.length; i += 1) {
    const char = className[i];
    if (char === '[') depth += 1;
    else if (char === ']') depth -= 1;
    else if (char === ':' && depth === 0) start = i + 1;
  }
  return className.slice(start).replace(/^!/, '');
}

/**
 * The classes in one piece of literal text. Text holding `{`, `}` or `;` is
 * CSS or code, not a class list. Where a template literal breaks the text
 * (`bg-${x}`), the class cut by the break is incomplete and skipped.
 */
function classesIn(text: string, cutAtStart: boolean, cutAtEnd: boolean): string[] {
  if (/[{};]/.test(text)) return [];
  const words = text.split(/\s+/);
  if (cutAtStart && !/^\s/.test(text)) words.shift();
  if (cutAtEnd && !/\s$/.test(text)) words.pop();
  return words.filter((word) => word.length > 0);
}

function colorCandidates(text: string, where: (index: number) => string, cutAtStart = false, cutAtEnd = false): Candidate[] {
  const found: Candidate[] = [];
  for (const className of classesIn(text, cutAtStart, cutAtEnd)) {
    const utility = utilityOf(className);
    if (utility.includes('[') || !COLOR_UTILITY.test(utility)) continue;
    found.push({ utility: utility.replace(/^-/, ''), where: `${where(text.indexOf(className))}: ${className}` });
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  });
}

function candidatesInScript(file: string): Candidate[] {
  const text = readFileSync(file, 'utf8');
  const kind = /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const rel = relative(webRoot, file);
  const found: Candidate[] = [];
  const visit = (node: ts.Node): void => {
    let cutAtStart = false;
    let cutAtEnd = false;
    if (ts.isTemplateHead(node)) cutAtEnd = true;
    else if (ts.isTemplateMiddle(node)) { cutAtStart = true; cutAtEnd = true; }
    else if (ts.isTemplateTail(node)) cutAtStart = true;
    else if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const literal = node as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateLiteralLikeNode;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.push(...colorCandidates(literal.text, () => `${rel}:${line}`, cutAtStart, cutAtEnd));
  };
  visit(source);
  return found;
}

function candidatesInHtml(file: string): Candidate[] {
  const text = readFileSync(file, 'utf8');
  const rel = relative(webRoot, file);
  const found: Candidate[] = [];
  for (const match of text.matchAll(/\bclass="([^"]*)"/g)) {
    const line = text.slice(0, match.index).split('\n').length;
    found.push(...colorCandidates(match[1] ?? '', () => `${rel}:${line}`));
  }
  return found;
}

/** Every class selector in the CSS Tailwind generates for these candidates, unescaped. */
async function generatedClasses(utilities: readonly string[]): Promise<Set<string>> {
  const stylesheet = readFileSync(join(srcRoot, 'styles', 'globals.css'), 'utf8');
  const result = await postcss([
    tailwindcss({ ...tailwindConfig, content: [{ raw: utilities.join(' '), extension: 'html' }] }),
  ]).process(stylesheet, { from: join(srcRoot, 'styles', 'globals.css') });
  const classes = new Set<string>();
  result.root.walkRules((rule) => {
    for (const match of rule.selector.matchAll(/\.((?:\\.|[\w-])+)/g)) {
      classes.add((match[1] ?? '').replace(/\\(.)/g, '$1'));
    }
  });
  return classes;
}

async function unknownColorClasses(candidates: readonly Candidate[]): Promise<string[]> {
  const generated = await generatedClasses([...new Set(candidates.map((c) => c.utility))]);
  return candidates.filter((c) => !generated.has(c.utility)).map((c) => c.where);
}

describe('colour token classes', () => {
  it('reads the utility out of a class list, variants and all', () => {
    const found = colorCandidates(
      'px-2 hover:border-border-subtle desktop:!bg-surface-input/50 text-sm bg-[#111] -text-txt-primary',
      () => 'x',
    ).map((c) => c.utility);
    expect(found).toEqual(['border-border-subtle', 'bg-surface-input/50', 'text-sm', 'text-txt-primary']);
  });

  it('skips code, CSS and the class a template literal cuts', () => {
    expect(colorCandidates('.a{transform-box:fill-box}', () => 'x')).toEqual([]);
    expect(colorCandidates('text-txt-primary bg-', () => 'x', false, true).map((c) => c.utility)).toEqual(['text-txt-primary']);
    expect(colorCandidates('-500 text-txt-primary', () => 'x', true).map((c) => c.utility)).toEqual(['text-txt-primary']);
  });

  it('fails a class whose token the config does not define, in any colour family', async () => {
    const sample = [
      'border-border-subtle', 'bg-surface-primary', 'text-txt-muted', 'ring-accent-teal',
      'border-border-soft', 'bg-surface-input/50', 'text-txt-primary', 'bg-accent-rose/10', 'text-sm', 'border-2', 'bg-white/5',
    ].map((utility) => ({ utility, where: utility }));
    expect(await unknownColorClasses(sample)).toEqual([
      'border-border-subtle', 'bg-surface-primary', 'text-txt-muted', 'ring-accent-teal',
    ]);
  });

  it('uses only colour classes that tailwind.config.js and globals.css generate', async () => {
    const candidates = [
      ...sourceFiles(srcRoot).flatMap(candidatesInScript),
      ...candidatesInHtml(join(webRoot, 'index.html')),
    ];
    expect(candidates.length).toBeGreaterThan(500);
    expect(await unknownColorClasses(candidates)).toEqual([]);
  }, 30_000);
});
