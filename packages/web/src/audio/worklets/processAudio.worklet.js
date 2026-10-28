// Bounded stereo PCM queue: a stalled renderer must never grow latency indefinitely.
class ProcessAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(48000);
    this.right = new Float32Array(48000);
    this.read = 0; this.write = 0; this.count = 0;
    this.port.onmessage = ({ data }) => {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let offset = 0; offset + 3 < data.byteLength; offset += 4) {
        if (this.count >= 24000) { this.read = (this.read + 1) % 48000; this.count--; }
        this.left[this.write] = view.getInt16(offset, true) / 32768;
        this.right[this.write] = view.getInt16(offset + 2, true) / 32768;
        this.write = (this.write + 1) % 48000; this.count++;
      }
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output?.[0] || !output[1]) return true;
    for (let index = 0; index < output[0].length; index++) {
      output[0][index] = this.count ? this.left[this.read] : 0;
      output[1][index] = this.count ? this.right[this.read] : 0;
      if (this.count) { this.read = (this.read + 1) % 48000; this.count--; }
    }
    return true;
  }
}
registerProcessor('backspace-process-audio', ProcessAudio);
