import type * as Ort from 'onnxruntime-web';
let ort: typeof Ort;
import createEspeak, { type EspeakModule, type EspeakWorker } from '@echogarden/espeak-ng-emscripten';
import { gpuOf } from './webGpu';
import vocab from './kokoro-vocab.json';

type Device = 'auto' | 'cpu' | 'gpu';
let session: Ort.InferenceSession | null = null;
let backend = '';
let espeak: EspeakWorker | null = null;
let espeakModule: EspeakModule | null = null;
async function phonemizePt(text: string): Promise<string> {
  if (!espeak) {
    const response = await fetch(`${assetBase}espeak-ng.data`);
    if (!response.ok) throw new Error('phonemizer-unavailable');
    const data = await response.arrayBuffer();
    const created = await createEspeak({ getPreloadedPackage: () => data });
    const worker = new created.eSpeakNGWorker();
    worker.set_voice('pt-br');
    espeakModule = created;
    espeak = worker;
  }
  const heap = espeakModule!;
  const pointer = espeak.convert_to_phonemes(text, true).ptr;
  let end = pointer; while (heap.HEAPU8[end]) end++;
  const result = new TextDecoder().decode(heap.HEAPU8.subarray(pointer, end));
  heap._free(pointer);
  return result.replaceAll('_', '');
}
let adapterInfo: Record<string, string> | null = null;
const voices = new Map<string, Float32Array>();
let assetBase = 'backspace-tts://engine/';
function setAssetBase(base: string) {
  assetBase = base;

}
setAssetBase(assetBase);
async function runtime() {
  if (!ort) {
    ort = await import(/* @vite-ignore */ `${assetBase}ort.webgpu.min.mjs`);
    ort.env.wasm.wasmPaths = { mjs: `${assetBase}ort-wasm-simd-threaded.asyncify.mjs`, wasm: `${assetBase}ort-wasm-simd-threaded.asyncify.wasm` };
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? 2 : 1;
    ort.env.logLevel = 'error';
  }
  return ort;
}

async function gpuInfo() {
  const adapter = await gpuOf(globalThis)?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter || adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter) return null;
  const info = adapter.info;
  if (/swiftshader|llvmpipe|lavapipe|software|basic render/i.test(`${info?.vendor} ${info?.architecture} ${info?.description}`)) return null;
  return { vendor: info?.vendor ?? '', architecture: info?.architecture ?? '', description: info?.description ?? '' };
}

async function load(device: Device, data: { model?: ArrayBuffer; voices?: Record<string, ArrayBuffer>; assetBase?: string } = {}) {
  if (data.assetBase) setAssetBase(data.assetBase);
  await runtime();
  if (data.voices) for (const [id, voice] of Object.entries(data.voices)) voices.set(id, new Float32Array(voice));
  if (session) { try { await session.release(); } catch { /* A lost GPU device may already be released. */ } session = null; }
  adapterInfo = await gpuInfo().catch(() => null);
  if (device === 'gpu' && !adapterInfo) throw new Error('gpu-unavailable');
  const gpu = device !== 'cpu' && adapterInfo !== null;
  try {
    const options = { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'], graphOptimizationLevel: 'all' as const };
    session = data.model ? await ort.InferenceSession.create(new Uint8Array(data.model), options)
      : await ort.InferenceSession.create(`backspace-tts://engine/models/${gpu ? 'model-fp32.onnx' : 'model-int8.onnx'}`, options);
    backend = gpu ? 'webgpu' : 'cpu';
  } catch (error) {
    if (device !== 'auto' || !gpu) throw error;
    // Main process downloads CPU weights before requesting a retry.
    throw new Error('gpu-load-failed');
  }
  return { backend, adapter: adapterInfo, threads: ort.env.wasm.numThreads };
}

function wav(samples: Float32Array): ArrayBuffer {
  const output = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(output);
  const write = (offset: number, value: string) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, output.byteLength - 8, true); write(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), true);
  return output;
}

async function synthesize({ text, voice, speed }: { text: string; voice: string; speed: number }) {
  if (!session) throw new Error('not-ready');
  const start = performance.now();
  const phonemes = await phonemizePt(text.trim());
  const tokens = [...phonemes].flatMap((char) => { const id = (vocab as Record<string, number>)[char]; return id === undefined ? [] : [id]; });
  if (!tokens.length || tokens.length > 510) throw new Error('invalid-text');
  let data = voices.get(voice);
  if (!data) {
    const response = await fetch(`backspace-tts://engine/models/${voice}.bin`);
    if (!response.ok) throw new Error('voice-unavailable');
    data = new Float32Array(await response.arrayBuffer()); voices.set(voice, data);
  }
  const index = Math.min(tokens.length - 1, 509) * 256;
  const feeds = {
    [session.inputNames.includes('input_ids') ? 'input_ids' : 'tokens']: new ort.Tensor('int64', BigInt64Array.from([0, ...tokens, 0], BigInt), [1, tokens.length + 2]),
    style: new ort.Tensor('float32', data.slice(index, index + 256), [1, 256]),
    speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
  };
  const output = await session.run(feeds);
  const samples = output[session.outputNames[0]!]!.data as Float32Array;
  if (!samples.length || samples.length > 24000 * 40) throw new Error('invalid-audio');
  const audio = wav(samples);
  for (const value of Object.values(output)) value.dispose();
  for (const value of Object.values(feeds)) value.dispose();
  return { audio, generationMs: performance.now() - start, audioSeconds: samples.length / 24000, backend, adapter: adapterInfo };
}

type LoadRequest = NonNullable<Parameters<typeof load>[1]> & { device: Device };
type SynthesizeRequest = Parameters<typeof synthesize>[0];

/** Requests arrive over IPC and the main process validates them before forwarding, so each operation narrows `data` to its own shape. */
export async function handleTextVoiceRequest(operation: string, data: unknown): Promise<unknown> {
  if (operation === 'probe') return { adapter: await gpuInfo(), threads: globalThis.crossOriginIsolated ? 2 : 1 };
  if (operation === 'load') { const request = data as LoadRequest; return load(request.device, request); }
  if (operation === 'synthesize') return synthesize(data as SynthesizeRequest);
  throw new Error('invalid-operation');
}
