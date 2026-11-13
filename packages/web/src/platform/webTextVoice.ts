type Device = 'auto' | 'cpu' | 'gpu';
const revision = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
const root = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${revision}/`;
const assets: Record<string, { path: string; hash: string; bytes: number }> = {
  cpu: { path: 'onnx/model_quantized.onnx', hash: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478', bytes: 92361116 },
  gpu: { path: 'onnx/model.onnx', hash: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb', bytes: 325532232 },
  pf_dora: { path: 'voices/pf_dora.bin', hash: '3da7b5b2d91847ebf5646f57631af6ececae3c29a89cd300f06edf9aa6cfe9ee', bytes: 522240 },
  pm_alex: { path: 'voices/pm_alex.bin', hash: '0175c753f59c54e7fd5a995bedef0c5ff2fb67e0043dd3dcb2ae74ec2acbeb2a', bytes: 522240 },
  pm_santa: { path: 'voices/pm_santa.bin', hash: '8b012db3185778afe2e45a62cbad69db73021774fe68dda634bcc748a982eede', bytes: 522240 },
};

type TextVoiceSpeech = { audio: ArrayBuffer; generationMs: number; audioSeconds: number; backend: string };

/** Browser-only worker: models come straight from the public repository, never Backspace's CPU. */
class WebTextVoice {
  private worker: Worker | null = null;
  private id = 0;
  private jobs = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private status: LocalTextVoiceStatus = { phase: 'idle' };
  private listeners = new Set<(status: LocalTextVoiceStatus) => void>();
  private preparing: Promise<LocalTextVoiceStatus> | null = null;
  private busy = false;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private downloads = new AbortController();

  getTextVoiceStatus = async () => this.status;
  onTextVoiceStatus = (callback: (status: LocalTextVoiceStatus) => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  private update(value: LocalTextVoiceStatus) { this.status = value; for (const callback of this.listeners) callback(value); }
  private armIdle() { if (this.idle) clearTimeout(this.idle); this.idle = setTimeout(() => { if (!this.busy && !this.preparing) this.releaseTextVoice(); }, 60_000); }
  private open() {
    if (this.worker) return;
    this.worker = new Worker(new URL('../audio/textVoice.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const job = this.jobs.get(data.id); if (!job) return;
      clearTimeout(job.timer); this.jobs.delete(data.id);
      if (data.ok) job.resolve(data.result); else job.reject(new Error(data.error));
    };
    this.worker.onerror = () => { this.releaseTextVoice(); this.update({ phase: 'error', error: 'engine-failed' }); };
  }
  private request<T = unknown>(operation: string, data: unknown, transfer: Transferable[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.jobs.delete(id); reject(new Error('engine-timeout')); }, 90_000);
      this.jobs.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ id, operation, data }, transfer);
    });
  }
  private async asset(id: string): Promise<ArrayBuffer> {
    const asset = assets[id]!; const url = root + asset.path;
    let cache: Cache | null = null;
    try { cache = await caches.open('backspace-local-text-voice-v1'); } catch { /* Private browsing can deny persistent storage. */ }
    const cached = await cache?.match(url);
    const valid = async (bytes: ArrayBuffer) => bytes.byteLength === asset.bytes && [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((n) => n.toString(16).padStart(2, '0')).join('') === asset.hash;
    if (cached) { const data = await cached.arrayBuffer(); if (await valid(data)) return data; }
    const response = await fetch(url, { signal: AbortSignal.any([this.downloads.signal, AbortSignal.timeout(300_000)]) });
    if (!response.ok || !response.body) throw new Error('download-failed');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = [];
    let bytes = 0; let lastUpdate = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > asset.bytes) { await reader.cancel(); throw new Error('download-too-large'); }
      chunks.push(value);
      if (Date.now() - lastUpdate > 200) { lastUpdate = Date.now(); this.update({ phase: 'downloading', device: this.status.device, progress: Math.floor(bytes / asset.bytes * 100) }); }
    }
    const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    if (!await valid(data.buffer)) throw new Error('download-integrity');
    try { await cache?.put(url, new Response(data.buffer, { headers: { 'Content-Type': 'application/octet-stream' } })); } catch { /* Still usable without a cache. */ }
    return data.buffer;
  }
  prepareTextVoice = async (device: Device): Promise<LocalTextVoiceStatus> => {
    if (this.status.phase === 'ready' && this.status.device === device) { this.armIdle(); return this.status; }
    if (this.preparing) return this.preparing;
    if (this.busy) throw new Error('speech-busy');
    this.downloads = new AbortController();
    this.preparing = this.initialize(device).finally(() => { this.preparing = null; this.armIdle(); });
    return this.preparing;
  };
  private async initialize(device: Device): Promise<LocalTextVoiceStatus> {
    try {
      this.open(); this.update({ phase: 'loading', device });
      const probe = await this.request<{ adapter?: unknown }>('probe', {});
      const gpu = device !== 'cpu' && !!probe.adapter;
      if (device === 'gpu' && !gpu) throw new Error('gpu-unavailable');
      const load = async (useGpu: boolean) => {
        const [model, ...data] = await Promise.all([this.asset(useGpu ? 'gpu' : 'cpu'), ...['pf_dora', 'pm_alex', 'pm_santa'].map((id) => this.asset(id))]);
        if (this.downloads.signal.aborted) throw new Error('engine-released');
        this.update({ phase: 'loading', device });
        const voices = Object.fromEntries(['pf_dora', 'pm_alex', 'pm_santa'].map((id, i) => [id, data[i]!]));
        const loaded = await this.request<Partial<LocalTextVoiceStatus>>('load', { device: useGpu ? 'gpu' : 'cpu', model, voices, assetBase: new URL('/local-text-voice/', location.href).href }, [model!, ...data]);
        await this.request('synthesize', { text: 'Olá.', voice: 'pf_dora', speed: 1 });
        return loaded;
      };
      let loaded;
      try { loaded = await load(gpu); }
      catch (error) { if (device !== 'auto' || !gpu || this.downloads.signal.aborted) throw error; loaded = await load(false); }
      this.update({ phase: 'ready', device, ...loaded }); return this.status;
    } catch (error) {
      await this.releaseTextVoice();
      this.update({ phase: 'error', device, error: error instanceof Error && error.message === 'gpu-unavailable' ? 'gpu-unavailable' : 'engine-failed' });
      throw error;
    }
  }
  synthesizeTextVoice = async (text: string, voice: string, speed: number): Promise<TextVoiceSpeech> => {
    if (!text.trim() || text.length > 400 || !['pf_dora', 'pm_alex', 'pm_santa'].includes(voice) || !Number.isFinite(speed) || speed < 0.8 || speed > 1.3) throw new Error('invalid-speech-request');
    if (this.busy || this.preparing || this.status.phase !== 'ready') throw new Error('speech-not-ready');
    this.busy = true;
    try {
      try { return await this.request<TextVoiceSpeech>('synthesize', { text, voice, speed }); }
      catch (error) {
        if (this.status.device !== 'auto' || this.status.backend !== 'webgpu' || this.downloads.signal.aborted) throw error;
        const loaded = await this.initialize('cpu');
        this.update({ ...loaded, device: 'auto' });
        return await this.request<TextVoiceSpeech>('synthesize', { text, voice, speed });
      }
    }
    finally { this.busy = false; this.armIdle(); }
  };
  releaseTextVoice = async () => {
    if (this.idle) clearTimeout(this.idle);
    this.downloads.abort(); this.worker?.terminate(); this.worker = null;
    for (const job of this.jobs.values()) { clearTimeout(job.timer); job.reject(new Error('engine-released')); }
    this.jobs.clear(); this.update({ phase: 'idle' });
  };
}
export const webTextVoice = new WebTextVoice();
