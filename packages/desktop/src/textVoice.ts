import { BrowserWindow, ipcMain, net, protocol } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type TextVoiceDevice = 'auto' | 'cpu' | 'gpu';
export interface TextVoiceStatus {
  phase: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
  device?: TextVoiceDevice;
  backend?: 'cpu' | 'webgpu';
  progress?: number;
  adapter?: { vendor: string; architecture: string; description: string } | null;
  error?: string;
}
const revision = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const TEXT_VOICE_ASSETS: Record<string, { url: string; hash: string; bytes: number }> = {
  'model-int8.onnx': { url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx', hash: '6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb', bytes: 92361271 },
  'model-fp32.onnx': { url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx', hash: '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5', bytes: 325532387 },
  'pf_dora.bin': { url: `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${revision}/voices/pf_dora.bin`, hash: '3da7b5b2d91847ebf5646f57631af6ececae3c29a89cd300f06edf9aa6cfe9ee', bytes: 522240 },
  'pm_alex.bin': { url: `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${revision}/voices/pm_alex.bin`, hash: '0175c753f59c54e7fd5a995bedef0c5ff2fb67e0043dd3dcb2ae74ec2acbeb2a', bytes: 522240 },
  'pm_santa.bin': { url: `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${revision}/voices/pm_santa.bin`, hash: '8b012db3185778afe2e45a62cbad69db73021774fe68dda634bcc748a982eede', bytes: 522240 },
};
protocol.registerSchemesAsPrivileged([{ scheme: 'backspace-tts', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

export function validTextVoiceRequest(value: unknown): value is { text: string; voice: string; speed: number } {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return typeof data.text === 'string' && !!data.text.trim() && data.text.length <= 400 &&
    ['pf_dora', 'pm_alex', 'pm_santa'].includes(String(data.voice)) &&
    typeof data.speed === 'number' && Number.isFinite(data.speed) && data.speed >= 0.8 && data.speed <= 1.3;
}

export class LocalTextVoice {
  private window: BrowserWindow | null = null;
  private status: TextVoiceStatus = { phase: 'idle' };
  private preparing: Promise<TextVoiceStatus> | null = null;
  private busy = false;
  private nextId = 0;
  private verified = new Set<string>();
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private downloads = new AbortController();

  constructor(private readonly models: string, private readonly changed: (status: TextVoiceStatus) => void = () => {}) {
    ipcMain.on('local-tts-result', (event, id: number, response: { ok: boolean; result?: unknown; error?: string }) => {
      if (event.sender !== this.window?.webContents) return;
      const job = this.pending.get(id); if (!job) return;
      clearTimeout(job.timer); this.pending.delete(id);
      if (response.ok) job.resolve(response.result); else job.reject(new Error(response.error ?? 'engine-failed'));
    });
  }

  registerProtocol(): void {
    protocol.handle('backspace-tts', async (request) => {
      const url = new URL(request.url);
      const name = url.pathname.slice(1);
      const engineFiles = ['index.html', 'engine.mjs', 'espeak-ng.data', 'ort.webgpu.min.mjs', ...['', '.jsep', '.asyncify', '.jspi'].flatMap((variant) => ['mjs', 'wasm'].map((ext) => `ort-wasm-simd-threaded${variant}.${ext}`))];
      const filename = url.hostname === 'engine' && engineFiles.includes(name) ? path.join(__dirname, 'text-voice', name)
        : url.hostname === 'engine' && name.startsWith('models/') && Object.hasOwn(TEXT_VOICE_ASSETS, name.slice(7)) ? path.join(this.models, name.slice(7)) : null;
      if (!filename) return new Response(null, { status: 404 });
      const response = await net.fetch(pathToFileURL(filename).href);
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self' blob:");
      return new Response(response.body, { status: response.status, headers });
    });
  }

  getStatus(): TextVoiceStatus { return this.status; }
  private update(status: TextVoiceStatus): void { this.status = status; this.changed(status); }
  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.status.phase !== 'ready') { this.idleTimer = null; return; }
    this.idleTimer = setTimeout(() => { if (!this.busy && !this.preparing) this.release(); }, 60_000);
    this.idleTimer.unref();
  }
  private async asset(name: string): Promise<void> {
    if (this.verified.has(name)) return;
    const asset = TEXT_VOICE_ASSETS[name]!; const filename = path.join(this.models, name);
    await mkdir(this.models, { recursive: true });
    const hashFile = async (file: string) => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
    if (await stat(filename).catch(() => null)) {
      if (await hashFile(filename) === asset.hash) { this.verified.add(name); return; }
      // Preserve a corrupt/partial previous download instead of destroying it.
      await rename(filename, `${filename}.invalid-${Date.now()}`);
    }
    const temporary = `${filename}.${randomUUID()}.partial`;
    const response = await net.fetch(asset.url, { signal: AbortSignal.any([this.downloads.signal, AbortSignal.timeout(300_000)]) });
    if (!response.ok || !response.body) throw new Error('download-failed');
    const hash = createHash('sha256'); let bytes = 0; let lastUpdate = 0;
    const meter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
      hash.update(chunk); bytes += chunk.length;
      if (bytes > asset.bytes + 1024) return callback(new Error('download-too-large'));
      if (Date.now() - lastUpdate > 200) { lastUpdate = Date.now(); this.update({ phase: 'downloading', device: this.status.device, progress: Math.min(99, Math.floor(bytes / asset.bytes * 100)) }); }
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(temporary, { flags: 'wx' }));
    if (hash.digest('hex') !== asset.hash) throw new Error('download-integrity');
    await rename(temporary, filename); this.verified.add(name);
  }

  private async open(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) return;
    const engine = new BrowserWindow({ show: false, webPreferences: {
      preload: path.join(__dirname, 'textVoiceEnginePreload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    this.window = engine;
    engine.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    engine.webContents.on('will-navigate', (event) => event.preventDefault());
    engine.on('closed', () => { if (this.window === engine) { this.window = null; this.rejectAll(); this.update({ phase: 'idle' }); } });
    let cleanupReady = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { ipcMain.removeListener('local-tts-ready', listener); reject(new Error('engine-timeout')); }, 30_000);
      const listener = (event: Electron.IpcMainEvent) => { if (event.sender === engine.webContents) { clearTimeout(timeout); ipcMain.removeListener('local-tts-ready', listener); resolve(); } };
      cleanupReady = () => { clearTimeout(timeout); ipcMain.removeListener('local-tts-ready', listener); };
      ipcMain.on('local-tts-ready', listener);
    });
    try { await Promise.all([engine.loadURL('backspace-tts://engine/index.html'), ready]); }
    finally { cleanupReady(); }
  }

  private request(operation: string, data: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('engine-timeout')); }, 90_000);
      this.pending.set(id, { resolve, reject, timer });
      this.window!.webContents.send('local-tts-request', id, operation, data);
    });
  }
  async prepare(device: TextVoiceDevice = 'auto'): Promise<TextVoiceStatus> {
    if (!['auto', 'cpu', 'gpu'].includes(device)) throw new Error('invalid-device');
    if (this.status.phase === 'ready' && this.status.device === device) { this.armIdle(); return this.status; }
    if (this.preparing) return this.preparing;
    if (this.busy) throw new Error('speech-busy');
    this.downloads = new AbortController();
    this.preparing = this.initialize(device).finally(() => { this.preparing = null; this.armIdle(); });
    return this.preparing;
  }
  private async initialize(device: TextVoiceDevice): Promise<TextVoiceStatus> {
    try {
      this.update({ phase: 'loading', device }); await this.open();
      const probe = await this.request('probe', {});
      const gpu = device !== 'cpu' && !!probe.adapter;
      if (device === 'gpu' && !gpu) throw new Error('gpu-unavailable');
      await Promise.all(['pf_dora.bin', 'pm_alex.bin', 'pm_santa.bin'].map((name) => this.asset(name)));
      await this.asset(gpu ? 'model-fp32.onnx' : 'model-int8.onnx');
      this.downloads.signal.throwIfAborted();
      this.update({ phase: 'loading', device });
      let loaded;
      try {
        loaded = await this.request('load', { device: gpu ? 'gpu' : 'cpu' });
        await this.request('synthesize', { text: 'Olá.', voice: 'pf_dora', speed: 1 });
      } catch (error) {
        if (device !== 'auto' || !gpu) throw error;
        await this.asset('model-int8.onnx'); this.update({ phase: 'loading', device });
        loaded = await this.request('load', { device: 'cpu' });
        await this.request('synthesize', { text: 'Olá.', voice: 'pf_dora', speed: 1 });
      }
      this.update({ phase: 'ready', device, ...loaded }); return this.status;
    } catch (error) {
      this.release();
      this.update({ phase: 'error', device, error: error instanceof Error && error.message === 'gpu-unavailable' ? 'gpu-unavailable' : 'engine-failed' });
      throw error;
    }
  }
  async speech(value: unknown): Promise<{ audio: ArrayBuffer; generationMs: number; audioSeconds: number; backend: string }> {
    if (!validTextVoiceRequest(value)) throw new Error('invalid-speech-request');
    if (this.busy || this.preparing || this.status.phase !== 'ready') throw new Error('speech-not-ready');
    this.busy = true;
    try {
      try { return await this.request('synthesize', value); }
      catch (error) {
        if (this.status.device !== 'auto' || this.status.backend !== 'webgpu' || this.downloads.signal.aborted) throw error;
        const loaded = await this.initialize('cpu');
        this.update({ ...loaded, device: 'auto' });
        return await this.request('synthesize', value);
      }
    }
    finally { this.busy = false; this.armIdle(); }
  }
  private rejectAll(): void { for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error('engine-released')); } this.pending.clear(); }
  release(): void {
    this.downloads.abort();
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.rejectAll(); this.window?.destroy(); this.window = null; this.update({ phase: 'idle' });
  }
}
