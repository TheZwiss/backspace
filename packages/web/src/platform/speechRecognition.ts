import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SpeechModelId } from '../audio/speechModelCache';
export { SPEECH_MODELS } from '../audio/speechModelCache';
export const useDictationStore = create<{
  model: SpeechModelId; device: 'auto' | 'cpu' | 'gpu'; installed: string[];
  phase: 'idle' | 'downloading' | 'loading' | 'ready' | 'transcribing';
  progress: number; recording: boolean; error: string; backend: string;
  setModel(model: SpeechModelId): void; setDevice(device: 'auto' | 'cpu' | 'gpu'): void;
}>()(persist((set) => ({
  model: 'base', device: 'auto', installed: [], phase: 'idle', progress: 0, recording: false, error: '', backend: '',
  setModel: (model) => set({ model, backend: '' }), setDevice: (device) => set({ device, backend: '' }),
}), { name: 'backspace-dictation', partialize: (state) => ({ model: state.model, device: state.device }) }));

class SpeechRecognition {
  private worker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private idle: ReturnType<typeof setTimeout> | null = null;
  private open() {
    if (this.worker) return;
    this.worker = new Worker(new URL('../audio/speechRecognition.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (typeof data.progress === 'number') { useDictationStore.setState({ progress: data.progress }); return; }
      const job = this.pending.get(data.id); if (!job) return;
      this.pending.delete(data.id); clearTimeout(job.timer);
      if (data.ok) job.resolve(data.result); else job.reject(new Error(data.error));
      if (!this.pending.size) { if (this.idle) clearTimeout(this.idle); this.idle = setTimeout(() => this.release(), 60_000); }
    };
    this.worker.onerror = () => { this.release(); useDictationStore.setState({ error: 'recognition-failed' }); };
  }
  private request(operation: string, data: unknown = {}, transfer: Transferable[] = []): Promise<any> {
    this.open(); if (this.idle) clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.release(); reject(new Error('recognition-timeout')); }, 20 * 60_000);
      this.pending.set(id, { resolve, reject, timer }); this.worker!.postMessage({ id, operation, data }, transfer);
    });
  }
  async refresh() { const installed: string[] = await this.request('list'); useDictationStore.setState({ installed }); return installed; }
  async install() {
    const state = useDictationStore.getState(); if (!['idle', 'ready'].includes(state.phase)) return;
    useDictationStore.setState({ phase: 'downloading', progress: 0, error: '' });
    try { await this.request('install', { model: state.model }); await this.refresh(); useDictationStore.setState({ phase: 'idle' }); }
    catch (error) { useDictationStore.setState({ phase: 'idle', error: error instanceof DOMException && error.name === 'AbortError' ? '' : 'download-failed' }); throw error; }
  }
  async remove(model: SpeechModelId) {
    this.release(); await this.request('remove', { model }); await this.refresh();
  }
  async prepare() {
    const state = useDictationStore.getState();
    if (!state.installed.includes(state.model)) throw new Error('model-not-installed');
    useDictationStore.setState({ phase: 'loading', error: '' });
    try { const result = await this.request('load', { model: state.model, device: state.device }); useDictationStore.setState({ phase: 'ready', ...(result ?? {}) }); }
    catch (error) { useDictationStore.setState({ phase: 'idle' }); throw error; }
  }
  async transcribe(audio: Float32Array) {
    const { model, device } = useDictationStore.getState();
    useDictationStore.setState({ phase: 'transcribing', error: '' });
    try { const result = await this.request('transcribe', { model, device, audio }, [audio.buffer]); useDictationStore.setState({ backend: result.backend ?? '' }); return result; }
    finally { useDictationStore.setState({ phase: this.worker ? 'ready' : 'idle' }); }
  }
  release() {
    if (this.idle) clearTimeout(this.idle); this.idle = null;
    this.worker?.terminate(); this.worker = null;
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new DOMException('Cancelled', 'AbortError')); }
    this.pending.clear(); useDictationStore.setState({ phase: 'idle', backend: '' });
  }
}
export const speechRecognition = new SpeechRecognition();
