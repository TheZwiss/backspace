import { installSpeechModel, installedSpeechModels, removeSpeechModel, speechModel, speechModelCacheName, speechModelUrl, type SpeechModelId } from './speechModelCache';
import { gpuOf } from './webGpu';

/** What the worker uses of a loaded Transformers.js pipeline. */
interface Transcriber {
  (audio: Float32Array, options: Record<string, unknown>): Promise<{ text?: unknown }>;
  dispose(): Promise<void>;
}
/** What the worker uses of the Transformers.js module it imports from the public asset folder at runtime. */
interface TransformersRuntime {
  env: {
    allowLocalModels: boolean;
    useBrowserCache: boolean;
    useFSCache: boolean;
    useCustomCache: boolean;
    useWasmCache: boolean;
    customCache: { match(url: string): Promise<Response | undefined>; put(): Promise<void> };
    fetch: typeof fetch;
    backends: { onnx: { wasm: { numThreads: number; wasmPaths: { mjs: string; wasm: string } } } };
  };
  pipeline(task: string, model: string, options: Record<string, unknown>): Promise<Transcriber>;
}
interface WorkerRequest {
  id: number;
  operation: string;
  data: { model: SpeechModelId; device: 'auto' | 'cpu' | 'gpu'; audio?: unknown };
}
let transcriber: Transcriber | null = null;
let loaded = '';
let backend: 'webgpu' | 'cpu' = 'cpu';
let library: TransformersRuntime | undefined;
const worker = self as unknown as { postMessage(value: unknown): void };
async function runtime(): Promise<TransformersRuntime> {
  if (library) return library;
  const base = new URL('/local-speech-recognition/', self.location.href).href;
  const imported = await import(/* @vite-ignore */ `${base}transformers.mjs`) as TransformersRuntime;
  imported.env.allowLocalModels = true;
  imported.env.useBrowserCache = false;
  imported.env.useFSCache = false;
  imported.env.useCustomCache = true;
  imported.env.useWasmCache = false;
  imported.env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? 2 : 1;
  imported.env.backends.onnx.wasm.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.asyncify.mjs`, wasm: `${base}ort-wasm-simd-threaded.asyncify.wasm` };
  // Missing optional tokenizer config is a 404. Inference can never download a model implicitly.
  imported.env.fetch = async () => new Response(null, { status: 404 });
  library = imported;
  return imported;
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
  const gpuApi = gpuOf(self);
  if (device !== 'cpu' && gpuApi) {
    const adapter = await gpuApi.requestAdapter({ powerPreference: 'high-performance' });
    const info = adapter?.info;
    gpu = !!adapter && !adapter.isFallbackAdapter && !/swiftshader|llvmpipe|software/iu.test(`${info?.vendor ?? ''} ${info?.description ?? ''}`);
  }
  if (device === 'gpu' && !gpu) throw new Error('gpu-unavailable');
  try { transcriber = await create(gpu); }
  catch (error) { if (device !== 'auto' || !gpu) throw error; gpu = false; transcriber = await create(false); }
  loaded = key; backend = gpu ? 'webgpu' : 'cpu'; return { backend };
}
let chain = Promise.resolve();
self.onmessage = ({ data: { id, operation, data } }: MessageEvent<WorkerRequest>) => {
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
          const audio = data.audio;
          if (!(audio instanceof Float32Array) || audio.length < 1600 || audio.length > 16000 * 60) throw new Error('invalid-audio');
          const active = transcriber;
          if (!active) throw new Error('not-ready');
          const started = performance.now();
          const run = () => active(audio, { language: 'portuguese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, return_timestamps: false, max_new_tokens: 440, condition_on_prev_tokens: false });
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
