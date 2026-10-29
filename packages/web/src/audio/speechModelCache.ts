import { sha256 } from '@noble/hashes/sha2.js';
import models from './speechModels.json';
export const SPEECH_MODELS = models;
export type SpeechModelId = 'base' | 'large-v3' | 'large-v3-turbo';
export function speechModel(id: string) { const model = models.find((item) => item.id === id); if (!model) throw new Error('invalid-model'); return model; }
export function speechModelCacheName(id: string) { const model = speechModel(id); return `backspace-speech-${model.id}-${model.revision}-${model.dtype ?? 'q8'}-v1`; }
export function speechModelUrl(id: string, filename: string) { const model = speechModel(id); return `https://huggingface.co/${model.repo}/resolve/${model.revision}/${filename}`; }
const marker = (id: string) => speechModelUrl(id, '__backspace_complete__');
export async function installedSpeechModels(): Promise<string[]> {
  const names = await caches.keys(); const installed: string[] = [];
  for (const model of models) {
    if (!names.includes(speechModelCacheName(model.id))) continue;
    const cache = await caches.open(speechModelCacheName(model.id));
    if (await cache.match(marker(model.id)) && (await Promise.all(model.assets.map((asset) => cache.match(speechModelUrl(model.id, asset.path))))).every(Boolean)) installed.push(model.id);
  }
  return installed;
}
/** Only fixed, app-owned caches. No filesystem paths or arbitrary cache names accepted. */
export async function removeSpeechModel(id: string): Promise<void> { await caches.delete(speechModelCacheName(id)); }
export async function installSpeechModel(id: string, signal: AbortSignal, progress: (value: number) => void): Promise<void> {
  const model = speechModel(id); const cache = await caches.open(speechModelCacheName(id));
  const total = model.assets.reduce((sum, asset) => sum + asset.bytes, 0); let complete = 0;
  await cache.delete(marker(id));
  for (const asset of model.assets) {
    signal.throwIfAborted(); const url = speechModelUrl(id, asset.path);
    if (await cache.match(url)) { complete += asset.bytes; progress(complete / total * 100); continue; }
    const response = await fetch(url, { signal, credentials: 'omit' });
    if (!response.ok || !response.body) throw new Error('download-failed');
    const hash = sha256.create(); let bytes = 0; let last = 0;
    // Hash before each chunk reaches CacheStorage; no multi-GB JS assembly buffer.
    const reader = response.body.getReader(); let failure: unknown;
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
      try {
        signal.throwIfAborted(); const { done, value } = await reader.read();
        if (done) {
          const digest = [...hash.digest()].map((n) => n.toString(16).padStart(2, '0')).join('');
          if (bytes !== asset.bytes || digest !== asset.hash) throw new Error(`download-integrity (${bytes}/${asset.bytes}, ${digest})`);
          controller.close(); return;
        }
        bytes += value.byteLength; if (bytes > asset.bytes) throw new Error('download-too-large');
        hash.update(value); controller.enqueue(value);
        if (Date.now() - last > 150) { last = Date.now(); progress((complete + bytes) / total * 100); }
      } catch (error) { failure = error; controller.error(error); await reader.cancel().catch(() => {}); }
    }, cancel() { return reader.cancel(); } });
    try { await cache.put(url, new Response(stream, { headers: { 'Content-Type': asset.path.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'Content-Length': String(asset.bytes) } })); }
    catch (error) { await cache.delete(url); throw failure ?? error; }
    complete += asset.bytes;
  }
  signal.throwIfAborted(); await cache.put(marker(id), new Response('verified')); progress(100);
}
