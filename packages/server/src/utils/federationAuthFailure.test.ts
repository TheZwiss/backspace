import { describe, it, expect } from 'vitest';
import { evaluateAuthFailure, AUTH_FAILURE_THRESHOLD } from './federationAuthFailure.js';

describe('evaluateAuthFailure', () => {
  it('returns backoff with incremented count for a first failure', () => {
    const result = evaluateAuthFailure(0);
    expect(result).toEqual({ kind: 'backoff', newAuthFailures: 1 });
  });

  it('returns backoff below the threshold', () => {
    for (let prev = 0; prev < AUTH_FAILURE_THRESHOLD - 1; prev++) {
      const result = evaluateAuthFailure(prev);
      expect(result.kind).toBe('backoff');
      expect(result.newAuthFailures).toBe(prev + 1);
    }
  });

  it('returns transition at the threshold', () => {
    const result = evaluateAuthFailure(AUTH_FAILURE_THRESHOLD - 1);
    expect(result).toEqual({
      kind: 'transition_to_needs_attention',
      newAuthFailures: AUTH_FAILURE_THRESHOLD,
    });
  });

  it('returns transition beyond the threshold', () => {
    const result = evaluateAuthFailure(AUTH_FAILURE_THRESHOLD + 5);
    expect(result.kind).toBe('transition_to_needs_attention');
    expect(result.newAuthFailures).toBe(AUTH_FAILURE_THRESHOLD + 6);
  });

  it('AUTH_FAILURE_THRESHOLD is 5', () => {
    expect(AUTH_FAILURE_THRESHOLD).toBe(5);
  });
});
