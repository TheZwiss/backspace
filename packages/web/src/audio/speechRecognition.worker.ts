import { installSpeechModel, installedSpeechModels, removeSpeechModel, speechModel, speechModelCacheName, speechModelUrl, type SpeechModelId } from './speechModelCache';
let transcriber: any = null;
let loaded = '';
let backend: 'webgpu' | 'cpu' = 'cpu';
let library: any;
const worker = self as unknown as { postMessage(value: unknown): void };
async function runtime() {
  if (library) return library;
  const base = new URL('/local-speech-recognition/', self.location.href).href;
  library = await import(/* @vite-ignore */ `${base}transformers.mjs`);
  library.env.allowLocalModels = true;
  library.env.useBrowserCache = false;
  library.env.useFSCache = false;
  library.env.useCustomCache = true;
  library.env.useWasmCache = false;
  library.env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? 2 : 1;
  library.env.backends.onnx.wasm.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.asyncify.mjs`, wasm: `${base}ort-wasm-simd-threaded.asyncify.wasm` };
  // Missing optional tokenizer config is a 404. Inference can never download a model implicitly.
  library.env.fetch = async () => new Response(null, { status: 404 });
  return library;
}
async function load(id: SpeechModelId, device: 'auto' | 'cpu' | 'gpu') {
  const key = `${id}:${device}`;
  if (loaded === key) return { backend };
  const model = speechModel(id);
  if (!(await installedSpeechModels()).includes(id)) throw new Error('model-not-installed');
  await transcriber?.dispose(); transcriber = null; loaded = '';
  const lib = await runtime(); const cache = await caches.open(speechModelCacheName(id));
  lib.env.customCache = { match: async (url: string) => {
    // Transformers' pipeline preflight requests config at main even with revision.
    // Resolve only allowlisted files into the verified pinned cache, never main/network.
    const prefixes = [`https://huggingface.co/${model.repo}/resolve/main/`, `https://huggingface.co/${model.repo}/resolve/${model.revision}/`];
    const prefix = prefixes.find((item) => String(url).startsWith(item));
    if (!prefix) return undefined;
    const file = String(url).slice(prefix.length);
    if (!model.assets.some((asset) => asset.path === file)) return undefined;
    return cache.match(speechModelUrl(id, file));
  }, put: async () => {} };
  const create = (gpu: boolean) => lib.pipeline('automatic-speech-recognition', model.repo, { revision: model.revision, local_files_only: true, dtype: model.dtype, device: gpu ? 'webgpu' : 'wasm' });
  let gpu = false;
  if (device !== 'cpu' && (self.navigator as any).gpu) {
    const adapter = await (self.navigator as any).gpu.requestAdapter({ powerPreference: 'high-performance' });
    const info = adapter?.info;
    gpu = !!adapter && !adapter.isFallbackAdapter && !/swiftshader|llvmpipe|software/iu.test(`${info?.vendor ?? ''} ${info?.description ?? ''}`);
  }
  if (device === 'gpu' && !gpu) throw new Error('gpu-unavailable');
  try { transcriber = await create(gpu); }
  catch (error) { if (device !== 'auto' || !gpu) throw error; gpu = false; transcriber = await create(false); }
  loaded = key; backend = gpu ? 'webgpu' : 'cpu'; return { backend };
}
let chain = Promise.resolve();
self.onmessage = ({ data: { id, operation, data } }) => {
  chain = chain.then(async () => {
    try {
      let result: unknown;
      switch (operation) {
        case 'install': await installSpeechModel(data.model, new AbortController().signal, (progress) => worker.postMessage({ progress })); result = await installedSpeechModels(); break;
        case 'list': result = await installedSpeechModels(); break;
        case 'remove': speechModel(data.model); if (loaded.startsWith(`${data.model}:`)) { await transcriber?.dispose(); transcriber = null; loaded = ''; } await removeSpeechModel(data.model); result = await installedSpeechModels(); break;
        case 'load': result = await load(data.model, data.device); break;
        case 'transcribe': {
          await load(data.model, data.device);
          if (!(data.audio instanceof Float32Array) || data.audio.length < 1600 || data.audio.length > 16000 * 60) throw new Error('invalid-audio');
          const started = performance.now();
          const run = () => transcriber(data.audio, { language: 'portuguese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, return_timestamps: false, max_new_tokens: 440, condition_on_prev_tokens: false });
          let output;
          try { output = await run(); }
          catch (error) {
            if (data.device !== 'auto' || backend !== 'webgpu') throw error;
            await load(data.model, 'cpu'); output = await run();
          }
          result = { text: String(output.text ?? '').trim(), elapsedMs: performance.now() - started, backend }; break;
        }
        default: throw new Error('invalid-operation');
      }
      worker.postMessage({ id, ok: true, result });
    } catch (error) { worker.postMessage({ id, ok: false, error: error instanceof Error ? error.message : 'recognition-failed' }); }
  });
};
