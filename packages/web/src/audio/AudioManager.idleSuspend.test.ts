import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@sapphi-red/web-noise-suppressor', () => ({
  RnnoiseWorkletNode: class {},
  loadRnnoise: vi.fn(),
}));
import { AudioManager } from './AudioManager';

interface MockOscillator {
  frequency: { value: number };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

interface MockBufferSource {
  buffer: AudioBuffer | null;
  loop: boolean;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

interface MockAudioContext {
  state: AudioContextState;
  currentTime: number;
  destination: object;
  onstatechange: (() => void) | null;
  resume: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
  createMediaStreamDestination: ReturnType<typeof vi.fn>;
  createAnalyser: ReturnType<typeof vi.fn>;
  createDynamicsCompressor: ReturnType<typeof vi.fn>;
  createOscillator: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
  decodeAudioData: ReturnType<typeof vi.fn>;
  oscillators: MockOscillator[];
  bufferSources: MockBufferSource[];
  inputGainNode: { gain: { value: number; setValueAtTime: ReturnType<typeof vi.fn>; setTargetAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } | null;
}

function createMockAudioContext(): MockAudioContext {
  const oscillators: MockOscillator[] = [];
  const bufferSources: MockBufferSource[] = [];
  let gainCount = 0;

  const ctx: MockAudioContext = {
    state: 'running',
    currentTime: 0,
    destination: {},
    onstatechange: null,
    oscillators,
    bufferSources,
    inputGainNode: null,
    resume: vi.fn(async () => {
      ctx.state = 'running';
      ctx.onstatechange?.();
    }),
    suspend: vi.fn(async () => {
      ctx.state = 'suspended';
      ctx.onstatechange?.();
    }),
    createGain: vi.fn(() => {
      const node = {
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          setTargetAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      if (gainCount === 0) {
        ctx.inputGainNode = node;
      }
      gainCount++;
      return node;
    }),
    createMediaStreamDestination: vi.fn(() => ({
      stream: { getAudioTracks: () => [] },
    })),
    createAnalyser: vi.fn(() => ({ fftSize: 256 })),
    createDynamicsCompressor: vi.fn(() => ({
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      connect: vi.fn(),
    })),
    createOscillator: vi.fn(() => {
      const osc: MockOscillator = {
        frequency: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      oscillators.push(osc);
      return osc;
    }),
    createBufferSource: vi.fn(() => {
      const src: MockBufferSource = {
        buffer: null,
        loop: false,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(() => {
          src.onended?.();
        }),
        onended: null,
      };
      bufferSources.push(src);
      return src;
    }),
    decodeAudioData: vi.fn(async () => ({ duration: 0.5 }) as unknown as AudioBuffer),
  };
  return ctx;
}

describe('AudioManager idle suspension and keep-alive lifecycle', () => {
  let mockCtx: MockAudioContext;
  let audioCtxCtorCalls: number;
  let am: AudioManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockCtx = createMockAudioContext();
    audioCtxCtorCalls = 0;

    // Reset singleton cleanly for isolated lifecycle assertions.
    (AudioManager as unknown as { instance: AudioManager | null }).instance = null;
    am = AudioManager.getInstance();

    const MockAudioContextClass = function MockAudioContextCtor() {
      audioCtxCtorCalls++;
      return mockCtx;
    };
    vi.stubGlobal('AudioContext', MockAudioContextClass);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })));
  });

  afterEach(() => {
    am.releaseInputStream();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not create an AudioContext when setInputVolume is called while idle, and applies it on init', () => {
    am.setInputVolume(75);
    expect(audioCtxCtorCalls).toBe(0);
    expect(am.getContext()).toBeNull();

    am.ensureContext();
    expect(audioCtxCtorCalls).toBe(1);
    expect(mockCtx.inputGainNode?.gain.setValueAtTime).toHaveBeenCalledWith(0.75, 0);
  });

  it('does not start the keep-alive oscillator on init when no audio session is held', () => {
    am.ensureContext();
    expect(mockCtx.oscillators).toHaveLength(0);
  });

  it('holds AudioContext + keep-alive oscillator during an audio session and suspends after release', async () => {
    const release = am.acquireAudioSession();
    await am.resumeContext();

    expect(mockCtx.oscillators).toHaveLength(1);
    expect(mockCtx.oscillators[0].start).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(mockCtx.suspend).not.toHaveBeenCalled();

    release();
    // Idempotent second call must not break state
    release();
    expect(mockCtx.oscillators[0].stop).toHaveBeenCalledTimes(1);
    expect(mockCtx.oscillators[0].disconnect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1499);
    expect(mockCtx.suspend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockCtx.suspend).toHaveBeenCalledTimes(1);
    expect(mockCtx.state).toBe('suspended');
  });

  it('keeps AudioContext active until all overlapping audio sessions are released', async () => {
    const releaseA = am.acquireAudioSession();
    const releaseB = am.acquireAudioSession();
    await am.resumeContext();

    releaseA();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockCtx.suspend).not.toHaveBeenCalled();
    expect(mockCtx.oscillators[0].stop).not.toHaveBeenCalled();

    releaseB();
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockCtx.oscillators[0].stop).toHaveBeenCalledTimes(1);
    expect(mockCtx.suspend).toHaveBeenCalledTimes(1);
  });

  it('suspends after a one-shot sound finishes playing, and resumes on the next sound', async () => {
    const src1 = await am.playSound('message');
    expect(src1).not.toBeNull();

    // Still playing — must not suspend
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockCtx.suspend).not.toHaveBeenCalled();

    // Sound finishes
    mockCtx.bufferSources[0].onended?.();
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockCtx.suspend).toHaveBeenCalledTimes(1);
    expect(mockCtx.state).toBe('suspended');

    // Next sound resumes the suspended context
    const src2 = await am.playSound('message');
    expect(src2).not.toBeNull();
    expect(mockCtx.resume).toHaveBeenCalledTimes(1);
    expect(mockCtx.state).toBe('running');

    mockCtx.bufferSources[1].onended?.();
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockCtx.suspend).toHaveBeenCalledTimes(2);
  });

  it('keeps AudioContext running while a looping sound plays and suspends once stopped', async () => {
    const loopSrc = await am.playSound('call_ringing', { loop: true });
    expect(loopSrc).not.toBeNull();

    await vi.advanceTimersByTimeAsync(10000);
    expect(mockCtx.suspend).not.toHaveBeenCalled();

    loopSrc!.stop();
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockCtx.suspend).toHaveBeenCalledTimes(1);
  });

  it('suspends after playTestTone finishes', async () => {
    await am.playTestTone();
    expect(mockCtx.oscillators).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(mockCtx.suspend).not.toHaveBeenCalled();

    mockCtx.oscillators[0].onended?.();
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockCtx.suspend).toHaveBeenCalledTimes(1);
  });

  it('suspends after releaseInputStream when no other audio consumer is active', async () => {
    const track = { stop: vi.fn(), onended: null as (() => void) | null };
    const stream = { active: true, getTracks: () => [track] } as unknown as MediaStream;
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    });
    (mockCtx as unknown as { createMediaStreamSource: ReturnType<typeof vi.fn> }).createMediaStreamSource = vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));

    await am.setInputDevice('mic-1');
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockCtx.suspend).not.toHaveBeenCalled();

    am.releaseInputStream();
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockCtx.suspend).toHaveBeenCalledTimes(1);
  });

  it('resumes an iOS interrupted AudioContext on resumeContext()', async () => {
    am.ensureContext();
    (mockCtx as unknown as { state: string }).state = 'interrupted';
    expect(am.isContextRunning()).toBe(false);

    await am.resumeContext();

    expect(mockCtx.resume).toHaveBeenCalledTimes(1);
    expect(mockCtx.state).toBe('running');
    expect(am.isContextRunning()).toBe(true);
  });

  it('schedules idle suspend when AudioContext transitions to interrupted while unused', async () => {
    am.ensureContext();
    (mockCtx as unknown as { state: string }).state = 'interrupted';
    mockCtx.onstatechange?.();

    await vi.advanceTimersByTimeAsync(1500);
    expect(mockCtx.suspend).toHaveBeenCalledTimes(1);
    expect(mockCtx.state).toBe('suspended');
  });

  it('does not hang resumeContext() when browser/iOS leaves ctx.resume() pending', async () => {
    am.ensureContext();
    (mockCtx as unknown as { state: string }).state = 'interrupted';
    mockCtx.resume.mockReturnValueOnce(new Promise(() => {}));

    let settled = false;
    const p = am.resumeContext().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBe(true);
  });

  it('auto-resumes an interrupted AudioContext on visibilitychange when an audio session is active', async () => {
    const release = am.acquireAudioSession();
    am.ensureContext();
    (mockCtx as unknown as { state: string }).state = 'interrupted';

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();

    expect(mockCtx.resume).toHaveBeenCalledTimes(1);
    expect(mockCtx.state).toBe('running');
    release();
  });
});
