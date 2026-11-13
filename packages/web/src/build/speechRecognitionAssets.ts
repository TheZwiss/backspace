import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

/** Bundle the browser runtime with its own matching ORT; never mix it with Kokoro's WASM. */
export function speechRecognitionAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const transformers = require.resolve('@huggingface/transformers');
  const packageRequire = createRequire(transformers);
  const ort = path.dirname(packageRequire.resolve('onnxruntime-web'));
  let files: Record<string, Uint8Array> = {};
  return {
    name: 'local-speech-recognition-assets',
    async buildStart() {
      const bundle = await build({ entryPoints: [path.join(path.dirname(transformers), 'transformers.web.min.js')], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'chrome136', minify: true });
      files = { 'transformers.mjs': bundle.outputFiles[0]!.contents };
      for (const ext of ['mjs', 'wasm']) files[`ort-wasm-simd-threaded.asyncify.${ext}`] = await readFile(path.join(ort, `ort-wasm-simd-threaded.asyncify.${ext}`));
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = new URL(request.url ?? '/', 'http://vite').pathname.replace(/^\/local-speech-recognition\//, '');
        const data = files[name]; if (!data) return next();
        response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        response.end(data);
      });
    },
    generateBundle() { for (const [name, source] of Object.entries(files)) this.emitFile({ type: 'asset', fileName: `local-speech-recognition/${name}`, source }); },
  };
}
