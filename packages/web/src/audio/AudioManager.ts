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
  private currentStream: MediaStream | null = null;
  private isInitialized = false;
  
  private listeners: Set<() => void> = new Set();
  private soundBuffers: Map<string, AudioBuffer> = new Map();

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
    this.ctx = new AudioContextClass();
    
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
    
    this.ctx.onstatechange = () => {
      console.log(`[AudioManager] Context state: ${this.ctx?.state}`);
      if (this.ctx?.state === 'running') {
        this.notifyResumed();
      }
    };

    this.isInitialized = true;
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

  async setInputDevice(deviceId: string) {
    if (!this.isInitialized) this.initContext();
    
    // Skip if already set and stream is active
    if (this.currentInputDeviceId === deviceId && this.currentStream?.active) {
      return this.currentStream;
    }

    try {
      if (this.currentStream) {
        this.currentStream.getTracks().forEach(t => t.stop());
      }

      const constraints = {
        audio: {
          deviceId: deviceId === 'default' ? undefined : { exact: deviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      };

      this.currentStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.currentInputDeviceId = deviceId;

      if (this.ctx && this.inputGain) {
        if (this.inputSource) {
          this.inputSource.disconnect();
        }
        this.inputSource = this.ctx.createMediaStreamSource(this.currentStream);
        this.inputSource.connect(this.inputGain);
      }
      
      return this.currentStream;
    } catch (err) {
      console.error('[AudioManager] Failed to set input device:', err);
      throw err;
    }
  }

  setInputVolume(volume: number) {
    if (!this.isInitialized) this.initContext();
    if (this.inputGain && this.ctx) {
      const gainValue = volume / 100;
      this.inputGain.gain.setTargetAtTime(gainValue, this.ctx.currentTime, 0.1);
    }
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
   * Returns the master output bus (DynamicsCompressorNode).
   * All remote audio (voice, stream) should connect their GainNodes
   * to this node instead of directly to ctx.destination. The compressor
   * prevents clipping when multiple sources sum together.
   */
  getMasterOutput(): AudioNode {
    if (!this.ctx) this.initContext();
    return this.masterCompressor!;
  }

  getContext(): AudioContext | null {
    return this.ctx;
  }
}
