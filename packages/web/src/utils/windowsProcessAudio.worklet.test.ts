import workletSource from '../audio/worklets/processAudio.worklet.js?raw';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('process audio worklet', () => {
  it('decodes signed little-endian stereo PCM and outputs silence on underrun', () => {
    interface ProcessorInstance { port: { onmessage: ((event: { data: Uint8Array }) => void) | null }; process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean; count: number }
    let Processor!: new () => ProcessorInstance;
    runInNewContext(workletSource, {
      AudioWorkletProcessor: class { port = { onmessage: null }; },
      registerProcessor: (_name: string, ctor: new () => ProcessorInstance) => { Processor = ctor; },
    });
    const processor = new Processor();
    processor.port.onmessage!({ data: new Uint8Array([0, 64, 0, 192]) });
    const left = new Float32Array(128), right = new Float32Array(128);
    processor.process([], [[left, right]]);
    expect(left[0]).toBe(0.5); expect(right[0]).toBe(-0.5);
    expect(left[1]).toBe(0); expect(right[1]).toBe(0);
    const big = new Uint8Array(48000 * 4);
    processor.port.onmessage!({ data: big });
    expect(processor.count).toBe(24000);
  });
});
