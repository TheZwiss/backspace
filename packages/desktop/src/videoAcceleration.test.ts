import { describe, expect, it } from 'vitest';
import { LINUX_VIDEO_ACCELERATION_FEATURES, linuxVideoAccelerationFeatures, readGpuVendors } from './videoAcceleration';

const ALL = [...LINUX_VIDEO_ACCELERATION_FEATURES];

describe('linuxVideoAccelerationFeatures', () => {
  it('liga as features em Intel e AMD', () => {
    expect(linuxVideoAccelerationFeatures('linux', ['0x8086'])).toEqual(ALL);
    expect(linuxVideoAccelerationFeatures('linux', ['0x1002'])).toEqual(ALL);
    expect(linuxVideoAccelerationFeatures('linux', ['0x8086', '0x1002'])).toEqual(ALL);
  });

  it('mantém software quando há NVIDIA, inclusive em notebook híbrido', () => {
    expect(linuxVideoAccelerationFeatures('linux', ['0x10de'])).toEqual([]);
    expect(linuxVideoAccelerationFeatures('linux', ['0x8086', '0x10de'])).toEqual([]);
  });

  it('não liga fora do Linux nem sem GPU identificada', () => {
    expect(linuxVideoAccelerationFeatures('win32', ['0x8086'])).toEqual([]);
    expect(linuxVideoAccelerationFeatures('linux', [])).toEqual([]);
    expect(linuxVideoAccelerationFeatures('linux', ['0x1234'])).toEqual([]);
  });
});

describe('readGpuVendors', () => {
  it('lê só os cardN e normaliza o vendor', () => {
    const files: Record<string, string> = { card0: '0x8086\n', card1: '0x10DE\n' };
    expect(readGpuVendors(() => ['card0', 'card0-DP-1', 'renderD128', 'card1', 'version'], (c) => files[c] ?? "")).toEqual(['0x8086', '0x10de']);
  });

  it('ignora cartão ilegível e devolve vazio sem sysfs', () => {
    expect(readGpuVendors(() => ['card0', 'card1'], (c) => { if (c === 'card0') throw new Error('enoent'); return '0x1002'; })).toEqual(['0x1002']);
    expect(readGpuVendors(() => { throw new Error('enoent'); })).toEqual([]);
  });
});
