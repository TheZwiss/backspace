import { createRequire } from 'node:module';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

/** Static inference resources only: never execute synthesis in the web server. */
export function textVoiceAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const ort = path.dirname(require.resolve('onnxruntime-web'));
  const espeak = path.dirname(require.resolve('@echogarden/espeak-ng-emscripten'));
  const files: Record<string, string> = {
    'ort.webgpu.min.mjs': path.join(ort, 'ort.webgpu.min.mjs'),
    'ort-wasm-simd-threaded.asyncify.mjs': path.join(ort, 'ort-wasm-simd-threaded.asyncify.mjs'),
    'ort-wasm-simd-threaded.asyncify.wasm': path.join(ort, 'ort-wasm-simd-threaded.asyncify.wasm'),
    'espeak-ng.data': path.join(espeak, 'espeak-ng.data'),
    'espeak-COPYING': path.join(espeak, 'COPYING'),
  };
  return {
    name: 'local-text-voice-static-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://vite');
        if (!url.pathname.startsWith('/local-text-voice/')) return next();
        const name = url.pathname.slice('/local-text-voice/'.length);
        const filename = files[name]; if (!filename) return next();
        response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream');
        createReadStream(filename).on('error', next).pipe(response);
      });
    },
    async generateBundle() {
      for (const [name, filename] of Object.entries(files)) this.emitFile({ type: 'asset', fileName: `local-text-voice/${name}`, source: await readFile(filename) });
    },
  };
}
