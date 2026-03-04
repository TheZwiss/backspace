import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseWasmSimdPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

export class AudioManager {
  private static instance: AudioManager | null = null;
  private ctx: AudioContext | null = null;
  private inputGain: GainNode | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputDestination: MediaStreamAudioDestinationNode | null = null;
  private silentGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private masterCompressor: DynamicsCompressorNode | null = null;
  
  private currentInputDeviceId: string = 'default';
  private desiredOutputDeviceId: string = 'default';
  private currentStream: MediaStream | null = null;
  private isInitialized = false;
  
  private listeners: Set<() => void> = new Set();
  private soundBuffers: Map<string, AudioBuffer> = new Map();
  private voiceEchoCancellation = true;
  private voiceNoiseSuppression = true;
  private voiceAutoGainControl = true;
  private streamGeneration = 0;
  private inputSwitchChain: Promise<MediaStream | null> = Promise.resolve(null);
  private rnnoiseNode: AudioWorkletNode | null = null;
  private stereoMerger: ChannelMergerNode | null = null;
  private rnnoiseEnabled = false;
  private rnnoiseReady = false;
  private keepAliveOscillator: OscillatorNode | null = null;

  private constructor() {}

  static getInstance(): AudioManager {
    if (!AudioManager.instance) {
      AudioManager.instance = new AudioManager();
    }
    return AudioManager.instance;
  }

  private initContext() {
    if (this.ctx) return;
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioContextClass({ sampleRate: 48000 });
    
    this.inputGain = this.ctx.createGain();
    this.inputDestination = this.ctx.createMediaStreamDestination();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    
    this.silentGain = this.ctx.createGain();
    this.silentGain.gain.value = 0;

    // Master compressor/limiter — prevents clipping when multiple
    // audio sources (voice + stream) sum at the output.
    this.masterCompressor = this.ctx.createDynamicsCompressor();
    this.masterCompressor.threshold.value = -1;    // only engage near digital clipping
    this.masterCompressor.knee.value = 0.5;        // hard knee — transparent below threshold
    this.masterCompressor.ratio.value = 4;         // gentle limiting, no ducking
    this.masterCompressor.attack.value = 0.0005;   // 0.5ms — catch transient peaks
    this.masterCompressor.release.value = 0.01;    // 10ms — recover quickly
    this.masterCompressor.connect(this.ctx.destination);

    this.inputGain.connect(this.inputDestination);
    this.inputGain.connect(this.analyser);
    this.inputGain.connect(this.silentGain);
    this.silentGain.connect(this.ctx.destination);

    this.inputGain.gain.setValueAtTime(1, this.ctx.currentTime);

    // Safari suspends the AudioContext when it detects no audible output,
    // even while WebRTC audio is flowing through the pipeline. A sub-bass
    // oscillator at near-zero gain keeps the rendering thread alive without
    // producing audible sound.
    this.keepAliveOscillator = this.ctx.createOscillator();
    this.keepAliveOscillator.frequency.value = 20;
    const keepAliveGain = this.ctx.createGain();
    keepAliveGain.gain.value = 0.00001;
    this.keepAliveOscillator.connect(keepAliveGain);
    keepAliveGain.connect(this.ctx.destination);
    this.keepAliveOscillator.start();

    this.ctx.onstatechange = () => {
      console.log(`[AudioManager] Context state: ${this.ctx?.state}`);
      if (this.ctx?.state === 'running') {
        this.notifyResumed();
      }
    };

    this.isInitialized = true;

    // Apply pending output device selection (user preference loaded before context creation)
    this.applyOutputDevice();
  }

  /**
   * Routes all Web Audio output to the specified device via AudioContext.setSinkId().
   * This is the ONLY correct way to switch output devices when using a custom Web Audio
   * pipeline — LiveKit's switchActiveDevice('audiooutput') targets <audio> elements
   * which we deliberately kill via MutationObserver.
   */
  async setOutputDevice(deviceId: string): Promise<void> {
    this.desiredOutputDeviceId = deviceId;
    await this.applyOutputDevice();
  }

  private async applyOutputDevice(): Promise<void> {
    if (!this.ctx || !('setSinkId' in this.ctx)) return;
    try {
      const sinkId = this.desiredOutputDeviceId === 'default' ? '' : this.desiredOutputDeviceId;
      await (this.ctx as any).setSinkId(sinkId);
      console.log(`[AudioManager] Output device set to: ${this.desiredOutputDeviceId}`);
    } catch (err) {
      console.error('[AudioManager] Failed to set output device:', err);
    }
  }

  onResumed(cb: () => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notifyResumed() {
    this.listeners.forEach(cb => cb());
  }

  async resumeContext() {
    if (!this.ctx) this.initContext();
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
        console.log('[AudioManager] AudioContext resumed.');
      } catch (err) {
        console.error('[AudioManager] Failed to resume context:', err);
      }
    }
  }

  async loadSound(name: string): Promise<AudioBuffer | null> {
    if (this.soundBuffers.has(name)) {
      return this.soundBuffers.get(name)!;
    }

    if (!this.ctx) this.initContext();
    
    try {
      const response = await fetch(`/sounds/${name}.mp3`);
      if (!response.ok) throw new Error(`Failed to load sound: ${name}`);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.ctx!.decodeAudioData(arrayBuffer);
      this.soundBuffers.set(name, audioBuffer);
      return audioBuffer;
    } catch (err) {
      console.error(`[AudioManager] Error loading sound ${name}:`, err);
      return null;
    }
  }

  async playSound(name: string, options: { loop?: boolean; volume?: number } = {}): Promise<AudioBufferSourceNode | null> {
    await this.resumeContext();
    const buffer = await this.loadSound(name);
    if (!buffer || !this.ctx) return null;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = options.loop || false;

    const gainNode = this.ctx.createGain();
    gainNode.gain.value = options.volume ?? 0.5;

    source.connect(gainNode);
    gainNode.connect(this.masterCompressor!);

    source.start(0);
    return source;
  }

  /**
   * Serialized input device switch.
   * Multiple callers (store, syncMic, UI) may trigger this concurrently.
   * Chaining ensures only one getUserMedia runs at a time, and the second
   * call short-circuits if the first already set the same device.
   */
  async setInputDevice(deviceId: string): Promise<MediaStream | null> {
    const job = this.inputSwitchChain.then(() => this._setInputDeviceImpl(deviceId));
    this.inputSwitchChain = job.catch(() => null);
    return job;
  }

  private async _setInputDeviceImpl(deviceId: string): Promise<MediaStream | null> {
    if (!this.isInitialized) this.initContext();

    // Skip if already set and stream is active
    if (this.currentInputDeviceId === deviceId && this.currentStream?.active) {
      return this.currentStream;
    }

    try {
      if (this.currentStream) {
        this.currentStream.getTracks().forEach(t => t.stop());
      }

      // Chrome AEC stays on during screen share — headphone users unaffected,
      // speaker users get proper echo cancellation.

      // When RNNoise is active, force browser NS off — running both degrades quality.
      // The user's noiseSuppression preference is preserved in the store for when RNNoise is disabled.
      const effectiveNoiseSuppression = this.rnnoiseEnabled ? false : this.voiceNoiseSuppression;

      const constraints = {
        audio: {
          deviceId: deviceId === 'default' ? undefined : { exact: deviceId },
          echoCancellation: this.voiceEchoCancellation,
          noiseSuppression: effectiveNoiseSuppression,
          autoGainControl: this.voiceAutoGainControl,
          // Chromium-specific constraints — belt-and-suspenders to ensure
          // Chrome's internal audio engine respects the standard constraints.
          googEchoCancellation: this.voiceEchoCancellation,
          googAutoGainControl: this.voiceAutoGainControl,
          googNoiseSuppression: effectiveNoiseSuppression,
          googHighpassFilter: false,
          googTypingNoiseDetection: false,
        } as any
      };

      this.currentStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.currentInputDeviceId = deviceId;
      this.streamGeneration++;

      if (this.ctx && this.inputGain) {
        if (this.inputSource) {
          this.inputSource.disconnect();
        }
        this.inputSource = this.ctx.createMediaStreamSource(this.currentStream);
        this.inputSource.connect(this.getInputTarget());
      }

      return this.currentStream;
    } catch (err) {
      console.error('[AudioManager] Failed to set input device:', err);
      throw err;
    }
  }

  private getInputTarget(): AudioNode {
    return (this.rnnoiseEnabled && this.rnnoiseNode) ? this.rnnoiseNode : this.inputGain!;
  }

  async setRnnoiseEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.rnnoiseEnabled && this.rnnoiseReady) return;
    if (!this.isInitialized) this.initContext();

    if (enabled && !this.rnnoiseReady) {
      try {
        console.log('[AudioManager] Loading RNNoise worklet...');
        await this.ctx!.audioWorklet.addModule(rnnoiseWorkletPath);

        // loadRnnoise handles SIMD feature detection and returns the right binary
        const wasmBinary = await loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseWasmSimdPath });

        this.rnnoiseNode = new RnnoiseWorkletNode(this.ctx!, {
          wasmBinary,
          maxChannels: 1,
        });

        // Explicit mono→stereo: RNNoise outputs 1 channel, so duplicate it
        // to both L and R via a ChannelMergerNode. This is spec-guaranteed
        // stereo, unlike relying on automatic up-mixing which fails in some
        // browsers when the source is an AudioWorkletNode.
        this.stereoMerger = this.ctx!.createChannelMerger(2);
        this.rnnoiseNode.connect(this.stereoMerger, 0, 0); // mono → left
        this.rnnoiseNode.connect(this.stereoMerger, 0, 1); // mono → right
        this.stereoMerger.connect(this.inputGain!);

        this.rnnoiseReady = true;
        console.log('[AudioManager] RNNoise worklet loaded and connected (mono→stereo via ChannelMerger)');
      } catch (err) {
        console.error('[AudioManager] Failed to load RNNoise worklet:', err);
        this.rnnoiseReady = false;
        this.rnnoiseEnabled = false;
        // Fall back to direct wiring
        if (this.inputSource && this.inputGain) {
          this.inputSource.disconnect();
          this.inputSource.connect(this.inputGain);
        }
        return;
      }
    }

    this.rnnoiseEnabled = enabled;

    // Rewire the graph
    if (this.inputSource) {
      this.inputSource.disconnect();
      this.inputSource.connect(this.getInputTarget());
      console.log(`[AudioManager] RNNoise ${enabled ? 'enabled' : 'bypassed'} — inputSource → ${enabled ? 'rnnoiseNode' : 'inputGain'}`);
    }

    // Force track re-publish so LiveKit picks up the new pipeline
    this.streamGeneration++;
    if (this.currentStream) {
      this.currentStream.getTracks().forEach(t => t.stop());
      this.currentStream = null;
    }
  }

  isRnnoiseEnabled(): boolean {
    return this.rnnoiseEnabled;
  }

  setInputVolume(volume: number) {
    if (!this.isInitialized) this.initContext();
    if (this.inputGain && this.ctx) {
      const gainValue = volume / 100;
      this.inputGain.gain.setTargetAtTime(gainValue, this.ctx.currentTime, 0.1);
    }
  }

  setVoiceProcessing(opts: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean }) {
    let changed = false;
    if (opts.echoCancellation !== undefined && opts.echoCancellation !== this.voiceEchoCancellation) {
      this.voiceEchoCancellation = opts.echoCancellation;
      changed = true;
    }
    if (opts.noiseSuppression !== undefined && opts.noiseSuppression !== this.voiceNoiseSuppression) {
      this.voiceNoiseSuppression = opts.noiseSuppression;
      changed = true;
    }
    if (opts.autoGainControl !== undefined && opts.autoGainControl !== this.voiceAutoGainControl) {
      this.voiceAutoGainControl = opts.autoGainControl;
      changed = true;
    }
    if (changed && this.currentStream) {
      this.currentStream.getTracks().forEach(t => t.stop());
      this.currentStream = null;
    }
  }

  getStreamGeneration(): number {
    return this.streamGeneration;
  }

  /**
   * CRITICAL: Always returns a CLONE of the destination track.
   * This prevents LiveKit's cleanup from killing the main singleton track
   * when switching rooms.
   */
  getFreshTrack(): MediaStreamTrack | null {
    if (!this.isInitialized) this.initContext();
    const track = this.inputDestination!.stream.getAudioTracks()[0];
    if (!track) return null;
    return track.clone();
  }

  getAnalyserNode(): AnalyserNode {
    if (!this.isInitialized) this.initContext();
    return this.analyser!;
  }

  /**
   * Ensures the AudioContext exists and returns it.
   * Unlike getContext(), this will never return null — it lazily
   * creates the context if it hasn't been initialised yet.
   * The context may be in 'suspended' state but Web Audio nodes
   * can be created and connected regardless; audio will flow
   * once the context resumes.
   */
  ensureContext(): AudioContext {
    if (!this.ctx) this.initContext();
    return this.ctx!;
  }

  /**
   * Returns the master output bus (DynamicsCompressorNode → ctx.destination).
   * All audio (remote voice, streams, effects) routes through this node.
   * The compressor prevents clipping when multiple sources sum together.
   * Output device is controlled via setSinkId on the underlying AudioContext.
   */
  getMasterOutput(): AudioNode {
    if (!this.ctx) this.initContext();
    return this.masterCompressor!;
  }

  getContext(): AudioContext | null {
    return this.ctx;
  }
}
