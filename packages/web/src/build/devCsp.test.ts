import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { relaxScriptSrcForDev, devCspPreamble } from './devCsp';

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(dir, '../../index.html'), 'utf8');

// index-html.test.ts owns the assertions about the production policy itself.
// This file covers only the dev-server transform applied on top of it.

describe('relaxScriptSrcForDev', () => {
  it('adds unsafe-inline to script-src and changes nothing else', () => {
    const out = relaxScriptSrcForDev(html);
    expect(out).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    expect(out.replace(" 'unsafe-inline'", '')).toBe(html);
  });

  it('leaves the directives the dev server has no reason to relax', () => {
    const out = relaxScriptSrcForDev(html);
    expect(out).toContain("object-src 'none'");
    expect(out).toContain("base-uri 'self'");
    expect(out).toContain("worker-src 'self' blob:");
  });

  it('adds it exactly once', () => {
    expect(relaxScriptSrcForDev(html).match(/unsafe-inline/g)).toHaveLength(1);
  });

  it('leaves HTML with no CSP tag untouched', () => {
    const plain = '<!doctype html><html><head></head><body></body></html>';
    expect(relaxScriptSrcForDev(plain)).toBe(plain);
  });
});

describe('devCspPreamble', () => {
  it('never runs during a build, so the shipped policy stays strict', () => {
    expect(devCspPreamble().apply).toBe('serve');
  });

  it('runs before the plugins that inject the inline preamble', () => {
    const hook = devCspPreamble().transformIndexHtml;
    expect(typeof hook).toBe('object');
    expect((hook as { order?: string }).order).toBe('pre');
  });
});
