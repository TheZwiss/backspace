import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { soundboardWavDuration } from '@backspace/shared/src/soundboard';
import { SoundboardUpload } from './SoundboardUpload';

const mocks = vi.hoisted(() => ({ decode: vi.fn(), upload: vi.fn(), start: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({
  ensureContext: () => ({ decodeAudioData: mocks.decode, createBufferSource: () => ({ connect: vi.fn(), disconnect: vi.fn(), stop: vi.fn(), start: mocks.start }) }),
  resumeContext: async () => {}, getMasterOutput: () => ({}),
}) } }));
vi.mock('../../utils/crossStoreResolvers', () => ({ getApiForOrigin: () => ({ soundboard: { upload: mocks.upload } }) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decode.mockResolvedValue({ duration: 20, length: 960000, numberOfChannels: 1, getChannelData: () => new Float32Array(960000) });
  mocks.upload.mockResolvedValue({});
  vi.stubGlobal('OfflineAudioContext', class {
    destination = {};
    constructor(readonly channels: number, readonly length: number, readonly sampleRate: number) {}
    createBufferSource() { return { connect: vi.fn(), start: vi.fn() }; }
    async startRendering() { return { getChannelData: () => new Float32Array(this.length) }; }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('soundboard crop boundary UX', () => {
  it.each([[6.01, 16.01, 10], [0.5, 0.6, 0.1]])('previews and uploads selection %s → %s', async (start, end, duration) => {
    const done = vi.fn();
    render(<SoundboardUpload origin="https://remote.test" spaceId="space" maxDuration={10} onDone={done} onCancel={vi.fn()} />);
    const file = new File(['source'], 'Victory.wav', { type: 'audio/wav' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(0) });
    fireEvent.change(screen.getByLabelText('Choose audio'), { target: { files: [file] } });
    await screen.findByRole('spinbutton', { name: 'Start (seconds)' });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Start (seconds)' }), { target: { value: String(start) } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'End (seconds)' }), { target: { value: String(end) } });
    const preview = screen.getByRole('button', { name: 'Preview' });
    const add = screen.getByRole('button', { name: 'Add sound' });
    expect(preview).toBeEnabled(); expect(add).toBeEnabled();
    fireEvent.click(preview);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(0, start, duration));
    fireEvent.click(add);
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    const [space, payload] = mocks.upload.mock.calls[0]!;
    expect(space).toBe('space');
    const bytes = Uint8Array.from(atob(payload.audio), c => c.charCodeAt(0));
    expect(soundboardWavDuration(bytes)).toBe(duration);
  });
});
