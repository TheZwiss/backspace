import { describe, it, expect, vi } from 'vitest';
import type { EnsurePeeredResult } from './federationPeering.js';
import { racePeering } from './federationPeering.js';

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

describe('racePeering', () => {
  it('returns the ensurePeered result when it resolves before the timeout', async () => {
    const stub = vi.fn(async (): Promise<EnsurePeeredResult> => ({
      status: 'active',
      peerId: 'peer-1',
    }));
    const result = await racePeering('https://example.com', 1_000, stub);
    expect(result).toEqual({ status: 'active', peerId: 'peer-1' });
    expect(stub).toHaveBeenCalledWith('https://example.com');
  });

  it('returns timeout when ensurePeered takes longer than the deadline', async () => {
    vi.useFakeTimers();
    const stub = vi.fn((): Promise<EnsurePeeredResult> => new Promise(() => {
      // Never resolves — simulates a slow handshake.
    }));
    const racePromise = racePeering('https://example.com', 50, stub);
    await vi.advanceTimersByTimeAsync(50);
    const result = await racePromise;
    expect(result).toEqual({ status: 'timeout' });
    vi.useRealTimers();
  });

  it('returns rejected result verbatim when ensurePeered resolves with rejection', async () => {
    const stub = vi.fn(async (): Promise<EnsurePeeredResult> => ({
      status: 'rejected',
      error: 'peer denied',
    }));
    const result = await racePeering('https://example.com', 1_000, stub);
    expect(result).toEqual({ status: 'rejected', error: 'peer denied' });
  });

  it('attaches a warn-logged catch to the background handshake when the timeout wins', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub = vi.fn(() => new Promise<EnsurePeeredResult>((_, reject) => {
      setTimeout(() => reject(new Error('late failure')), 30);
    }));
    const racePromise = racePeering('https://example.com', 10, stub);
    await vi.advanceTimersByTimeAsync(10);
    const result = await racePromise;
    expect(result).toEqual({ status: 'timeout' });
    await vi.advanceTimersByTimeAsync(30);
    // Let microtasks flush so the .catch handler runs.
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('background handshake'),
      'https://example.com',
      expect.any(Error),
    );
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it('normalizes a thrown handshake error into { status: failed } without emitting the background warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub = vi.fn(async (): Promise<EnsurePeeredResult> => {
      throw new Error('immediate handshake failure');
    });
    const result = await racePeering('https://example.com', 1_000, stub);
    expect(result).toEqual({ status: 'failed', error: 'immediate handshake failure' });
    // The handshake rejection was the race winner — no background warn should fire.
    await Promise.resolve();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
