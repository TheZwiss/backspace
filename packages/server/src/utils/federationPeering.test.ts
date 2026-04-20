import { describe, it, expect } from 'vitest';
import type { EnsurePeeredResult } from './federationPeering.js';

describe('EnsurePeeredResult type', () => {
  it('active result has peerId', () => {
    const result: EnsurePeeredResult = {
      status: 'active',
      peerId: '123',
    };
    expect(result.status).toBe('active');
    if (result.status === 'active') {
      expect(result.peerId).toBe('123');
    }
  });

  it('rejected result has error', () => {
    const result: EnsurePeeredResult = {
      status: 'rejected',
      error: 'Remote instance requires manual peering approval',
    };
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.error).toContain('manual peering');
    }
  });

  it('failed result has error', () => {
    const result: EnsurePeeredResult = {
      status: 'failed',
      error: 'timeout',
    };
    expect(result.status).toBe('failed');
  });

  it('pending result has error', () => {
    const result: EnsurePeeredResult = {
      status: 'pending',
      error: 'Awaiting admin approval on remote instance',
    };
    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.error).toContain('admin approval');
    }
  });
});
