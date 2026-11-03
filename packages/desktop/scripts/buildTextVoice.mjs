import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
// Sandboxed preloads may require Electron, but cannot require our local modules.
await build({ entryPoints: [path.join(root, 'src/preload.ts')], outfile: path.join(root, 'dist/preload.js'),
  bundle: true, external: ['electron'], format: 'cjs', platform: 'browser', target: 'chrome150' });
const out = path.join(root, 'dist', 'text-voice');
await mkdir(out, { recursive: true });
await build({ entryPoints: [path.join(root, 'engine/textVoiceEngine.ts')], outfile: path.join(out, 'engine.mjs'), bundle: true,
  external: ['module'], format: 'esm', platform: 'browser', target: 'chrome136', legalComments: 'eof' });
const ort = path.dirname(require.resolve('onnxruntime-web'));
for (const name of ['.asyncify'].flatMap((variant) => ['mjs', 'wasm'].map((ext) => `ort-wasm-simd-threaded${variant}.${ext}`))) await copyFile(path.join(ort, name), path.join(out, name));
await writeFile(path.join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="./engine.mjs"></script></body></html>');

await copyFile(path.join(path.dirname(require.resolve('@echogarden/espeak-ng-emscripten')), 'espeak-ng.data'), path.join(out, 'espeak-ng.data'));
await copyFile(path.join(path.dirname(require.resolve('@echogarden/espeak-ng-emscripten')), 'COPYING'), path.join(out, 'espeak-COPYING'));

await copyFile(path.join(ort, 'ort.webgpu.min.mjs'), path.join(out, 'ort.webgpu.min.mjs'));
