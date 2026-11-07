import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { countChangeClass, useChangeSignal } from './useChangeSignal';

describe('useChangeSignal', () => {
  it('reports nothing for the value it mounted with', () => {
    const { result, rerender } = renderHook(({ value }) => useChangeSignal(value), { initialProps: { value: 3 } });
    expect(result.current).toEqual({ generation: 0, direction: null });
    rerender({ value: 3 });
    expect(result.current).toEqual({ generation: 0, direction: null });
  });

  it('counts each live change and says which way it went', () => {
    const { result, rerender } = renderHook(({ value }) => useChangeSignal(value), { initialProps: { value: 3 } });
    rerender({ value: 5 });
    expect(result.current).toEqual({ generation: 1, direction: 'up' });
    rerender({ value: 5 });
    expect(result.current).toEqual({ generation: 1, direction: 'up' });
    rerender({ value: 1 });
    expect(result.current).toEqual({ generation: 2, direction: 'down' });
  });
});

describe('countChangeClass', () => {
  it('rolls the number the way it moved, and not at all before a change', () => {
    expect(countChangeClass({ generation: 0, direction: null })).toBe('');
    expect(countChangeClass({ generation: 1, direction: 'up' })).toBe('motion-count-up');
    expect(countChangeClass({ generation: 2, direction: 'down' })).toBe('motion-count-down');
  });
});
