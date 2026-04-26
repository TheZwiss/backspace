import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    const result = await racePeering('https://example.com', 1_000, { kind: 'system' }, stub);
    expect(result).toEqual({ status: 'active', peerId: 'peer-1' });
    expect(stub).toHaveBeenCalledWith('https://example.com', { kind: 'system' });
  });

  it('returns timeout when ensurePeered takes longer than the deadline', async () => {
    vi.useFakeTimers();
    const stub = vi.fn((): Promise<EnsurePeeredResult> => new Promise(() => {
      // Never resolves — simulates a slow handshake.
    }));
    const racePromise = racePeering('https://example.com', 50, { kind: 'system' }, stub);
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
    const result = await racePeering('https://example.com', 1_000, { kind: 'system' }, stub);
    expect(result).toEqual({ status: 'rejected', error: 'peer denied' });
  });

  it('attaches a warn-logged catch to the background handshake when the timeout wins', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub = vi.fn(() => new Promise<EnsurePeeredResult>((_, reject) => {
      setTimeout(() => reject(new Error('late failure')), 30);
    }));
    const racePromise = racePeering('https://example.com', 10, { kind: 'system' }, stub);
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
    const result = await racePeering('https://example.com', 1_000, { kind: 'system' }, stub);
    expect(result).toEqual({ status: 'failed', error: 'immediate handshake failure' });
    // The handshake rejection was the race winner — no background warn should fire.
    await Promise.resolve();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('ensurePeered needs_attention handling', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns rejected without calling performHandshake when peer is in needs_attention', async () => {
    const fakeDbGet = vi.fn().mockReturnValue({
      id: 'peer-na',
      origin: 'https://remote.example',
      status: 'needs_attention',
      hmacSecret: 'secret',
      createdAt: Date.now(),
      lastSyncedAt: 0,
    });

    vi.doMock('../db/index.js', () => ({
      getDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              get: fakeDbGet,
            }),
          }),
        }),
      }),
    }));

    vi.doMock('../utils/federationAuth.js', () => ({
      getOurOrigin: () => 'https://local.example',
      generateHmacSecret: () => 'new-secret',
    }));

    vi.doMock('../routes/federation.js', () => ({
      validateOrigin: (o: string) => o,
    }));

    vi.doMock('../utils/federationPeerActivation.js', () => ({
      onPeerActivated: vi.fn(),
    }));

    const { ensurePeered } = await import('./federationPeering.js');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await ensurePeered('https://remote.example', { kind: 'system' });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.error).toContain('needs_attention');
    }
    // performHandshake must not have fired — no POST to /peer/accept
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});
