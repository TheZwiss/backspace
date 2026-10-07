import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readPrecacheManifest,
  collectPrecacheCandidates,
  evaluatePrecacheBudget,
} from '../../../../scripts/precache/check.mjs';
import { PRECACHE_FILE_EXTENSIONS, PRECACHE_GLOB_PATTERNS } from './precache';

const EXTENSIONS = PRECACHE_FILE_EXTENSIONS;

// The shape workbox's generateSW writes: one precacheAndRoute call whose
// entries carry a url and a revision (null for hashed file names).
function swSource(urls: string[]): string {
  const entries = urls.map((url, i) => `{url:"${url}",revision:${i % 2 === 0 ? 'null' : `"r${i}"`}}`).join(',');
  return `if(!self.define){}define(["./workbox-abc"],function(s){"use strict";importScripts("sw-rollover.js"),`
    + `s.clientsClaim(),s.precacheAndRoute([${entries}],{}),s.cleanupOutdatedCaches()});`;
}

function makeDist(files: Record<string, number>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'precache-check-'));
  for (const [rel, bytes] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, Buffer.alloc(bytes, 97));
  }
  return dir;
}

describe('readPrecacheManifest', () => {
  it('returns every precached url in the order the worker lists them', () => {
    expect(readPrecacheManifest(swSource(['index.html', 'assets/index-a1.js', 'icons/icon-192.png'])))
      .toEqual(['index.html', 'assets/index-a1.js', 'icons/icon-192.png']);
  });

  it('throws when the worker has no precache manifest, rather than passing an empty list', () => {
    expect(() => readPrecacheManifest('self.addEventListener("fetch",()=>{});')).toThrow(/precacheAndRoute/);
  });
});

describe('collectPrecacheCandidates', () => {
  it('marks manifest entries as precached and sizes them from disk', () => {
    const dist = makeDist({ 'index.html': 10, 'assets/index-a1.js': 300 });
    const files = collectPrecacheCandidates(dist, ['index.html', 'assets/index-a1.js'], EXTENSIONS);
    expect(files).toEqual(expect.arrayContaining([
      { path: 'index.html', bytes: 10, precached: true },
      { path: 'assets/index-a1.js', bytes: 300, precached: true },
    ]));
    expect(files).toHaveLength(2);
  });

  it('includes build assets missing from the manifest, which is where workbox leaves a file over its limit', () => {
    const dist = makeDist({ 'index.html': 10, 'assets/index-a1.js': 300, 'assets/huge-b2.js': 5000 });
    const files = collectPrecacheCandidates(dist, ['index.html', 'assets/index-a1.js'], EXTENSIONS);
    expect(files).toContainEqual({ path: 'assets/huge-b2.js', bytes: 5000, precached: false });
  });

  it('leaves out an asset of a type the worker never precaches, however large (#330)', () => {
    // Only a file the glob would have precached can have been dropped for
    // size; a large font or image was never a candidate.
    const dist = makeDist({ 'assets/index-a1.js': 300, 'assets/DMSans-x1.woff2': 5000, 'assets/banner-y2.png': 9000 });
    const files = collectPrecacheCandidates(dist, ['assets/index-a1.js'], EXTENSIONS);
    expect(files.map((f) => f.path)).toEqual(['assets/index-a1.js']);
  });

  it('builds the worker glob from the same list of file types', () => {
    expect(PRECACHE_GLOB_PATTERNS).toEqual([`**/*.{${EXTENSIONS.join(',')}}`]);
    expect([...EXTENSIONS].sort()).toEqual(['css', 'html', 'js', 'wasm']);
  });

  it('leaves source maps out, which are never precached', () => {
    const dist = makeDist({ 'assets/index-a1.js': 300, 'assets/index-a1.js.map': 9000 });
    const files = collectPrecacheCandidates(dist, ['assets/index-a1.js'], EXTENSIONS);
    expect(files.map((f) => f.path)).toEqual(['assets/index-a1.js']);
  });

  it('throws when a manifest entry has no file behind it', () => {
    const dist = makeDist({ 'index.html': 10 });
    expect(() => collectPrecacheCandidates(dist, ['index.html', 'assets/gone-c3.js'], EXTENSIONS)).toThrow(/assets\/gone-c3\.js/);
  });
});

describe('evaluatePrecacheBudget', () => {
  const limitBytes = 1000;

  it('passes files at or under the budget share of the limit', () => {
    const result = evaluatePrecacheBudget(limitBytes, [
      { path: 'a.js', bytes: 900, precached: true },
      { path: 'b.js', bytes: 10, precached: true },
    ]);
    expect(result.budgetBytes).toBe(900);
    expect(result.overBudget).toEqual([]);
    expect(result.largest).toEqual({ path: 'a.js', bytes: 900, precached: true });
  });

  it('fails a precached file one byte over the budget', () => {
    const result = evaluatePrecacheBudget(limitBytes, [{ path: 'a.js', bytes: 901, precached: true }]);
    expect(result.overBudget).toEqual([{ path: 'a.js', bytes: 901, precached: true }]);
  });

  it('fails a file that is already past the limit and so was dropped from the manifest', () => {
    const result = evaluatePrecacheBudget(limitBytes, [
      { path: 'small.js', bytes: 5, precached: true },
      { path: 'dropped.js', bytes: 1200, precached: false },
    ]);
    expect(result.overBudget.map((f) => f.path)).toEqual(['dropped.js']);
  });

  it('rejects a limit that is not a positive number', () => {
    expect(() => evaluatePrecacheBudget(0, [])).toThrow();
    expect(() => evaluatePrecacheBudget(Number.NaN, [])).toThrow();
  });
});
