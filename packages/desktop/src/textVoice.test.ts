import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ listeners: new Map<string, (...args: unknown[]) => void>(), handle: vi.fn(), fetch: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: { on: (name: string, listener: (...args: unknown[]) => void) => mocks.listeners.set(name, listener) },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: mocks.handle },
  net: { fetch: mocks.fetch },
}));
import { LocalTextVoice, validTextVoiceRequest } from './textVoice';
/** The private members these tests drive directly; the engine's public surface cannot reach the IPC seams. */
interface Internals {
  open(): Promise<void>;
  asset(name: string): Promise<void>;
  request(operation: string, data: unknown): Promise<unknown>;
  window: unknown;
  status: unknown;
  pending: Map<number, unknown>;
}
let engine: LocalTextVoice;
beforeEach(() => { vi.clearAllMocks(); engine = new LocalTextVoice('/test-models'); });
afterEach(() => { engine.release(); vi.useRealTimers(); });

it('accepts only bounded Portuguese speech options, never user paths or model IDs', () => {
  expect(validTextVoiceRequest({ text: 'Olá!', voice: 'pf_dora', speed: 1 })).toBe(true);
  for (const value of [null, {}, { text: ' ', voice: 'pf_dora', speed: 1 }, { text: 'a'.repeat(401), voice: 'pf_dora', speed: 1 },
    { text: 'Olá', voice: '../../other', speed: 1 }, { text: 'Olá', voice: 'pf_dora', speed: Infinity }, { text: 'Olá', voice: 'pf_dora', speed: 0.2 }]) expect(validTextVoiceRequest(value)).toBe(false);
});

it('falls back to CPU automatically when an AMD WebGPU driver rejects a graph', async () => {
  const controller = engine as unknown as Internals;
  vi.spyOn(controller, 'open').mockResolvedValue(undefined);
  vi.spyOn(controller, 'asset').mockResolvedValue(undefined);
  const request = vi.spyOn(controller, 'request').mockImplementation(async (operation: string, data: unknown) => {
    if (operation === 'probe') return { adapter: { vendor: 'amd' } };
    if (operation === 'load') { if ((data as { device: string }).device === 'gpu') throw new Error('unsupported-operator'); return { backend: 'cpu' }; }
    return {};
  });
  expect(await engine.prepare('auto')).toMatchObject({ phase: 'ready', device: 'auto', backend: 'cpu' });
  expect(request).toHaveBeenCalledWith('load', { device: 'gpu' });
  expect(request).toHaveBeenCalledWith('load', { device: 'cpu' });
});

it('does not mislabel CPU as GPU when the explicit GPU option is unavailable', async () => {
  const controller = engine as unknown as Internals;
  vi.spyOn(controller, 'open').mockResolvedValue(undefined);
  vi.spyOn(controller, 'request').mockResolvedValue({ adapter: null });
  const download = vi.spyOn(controller, 'asset').mockResolvedValue(undefined);
  await expect(engine.prepare('gpu')).rejects.toThrow('gpu-unavailable');
  expect(engine.getStatus()).toMatchObject({ phase: 'error', error: 'gpu-unavailable' });
  expect(download).not.toHaveBeenCalled();
});

it('accepts results only from its isolated engine renderer', async () => {
  const webContents = { send: vi.fn() };
  const controller = engine as unknown as Internals;
  controller.window = { webContents, destroy: vi.fn() };
  const pending = controller.request('probe', {});
  const [, id] = webContents.send.mock.calls[0]!;
  const result = mocks.listeners.get('local-tts-result')!;
  result({ sender: {} }, id, { ok: true, result: 'spoofed' });
  expect(controller.pending.size).toBe(1);
  result({ sender: webContents }, id, { ok: true, result: 'trusted' });
  expect(await pending).toBe('trusted');
});

it('serves only known local model/runtime files, with an isolated content policy', async () => {
  mocks.fetch.mockImplementation(async () => new Response('test'));
  engine.registerProtocol();
  const handler = mocks.handle.mock.calls[0]![1];
  expect((await handler({ url: 'backspace-tts://engine/models/../../.env' })).status).toBe(404);
  expect((await handler({ url: 'backspace-tts://unknown/engine.mjs' })).status).toBe(404);
  expect(mocks.fetch).not.toHaveBeenCalled();
  const response = await handler({ url: 'backspace-tts://engine/models/pf_dora.bin' });
  expect(response.status).toBe(200);
  expect(mocks.fetch.mock.calls[0]![0]).toBe('file:///test-models/pf_dora.bin');
  expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  expect(response.headers.get('Content-Security-Policy')).not.toContain("'unsafe-eval'");
});

it('unloads the model after a minute of inactivity', async () => {
  vi.useFakeTimers();
  const controller = engine as unknown as Internals;
  const destroy = vi.fn();
  controller.window = { destroy };
  controller.status = { phase: 'ready', device: 'cpu', backend: 'cpu' };
  await engine.prepare('cpu');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(destroy).toHaveBeenCalledOnce();
  expect(engine.getStatus().phase).toBe('idle');
});
