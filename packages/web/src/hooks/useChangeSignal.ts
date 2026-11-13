import { useState } from 'react';

export interface ChangeSignal {
  /** How many times the value changed since mount; 0 until the first change. */
  generation: number;
  /** Which way the latest change went, or null before any change. */
  direction: 'up' | 'down' | null;
}

const UNCHANGED: ChangeSignal = { generation: 0, direction: null };

/**
 * Counts the changes a number goes through after the first render and says
 * which way the latest one went. A component keys an element on `generation`
 * to replay a one-shot CSS animation (`motion-bump`, `motion-count-up`, ...)
 * for a live change, and never animates the value it mounted with, so opening
 * a channel or a list does not set everything in it moving.
 */
export function useChangeSignal(value: number): ChangeSignal {
  const [previous, setPrevious] = useState(value);
  const [signal, setSignal] = useState<ChangeSignal>(UNCHANGED);
  if (previous !== value) {
    // The "adjust state while rendering" pattern: React re-renders at once
    // with the new signal, before anything is committed.
    setPrevious(value);
    setSignal({ generation: signal.generation + 1, direction: value > previous ? 'up' : 'down' });
  }
  return signal;
}

/** The class that rolls a number to its new value in the direction it moved. */
export function countChangeClass(signal: ChangeSignal): string {
  if (signal.direction === 'up') return 'motion-count-up';
  if (signal.direction === 'down') return 'motion-count-down';
  return '';
}
