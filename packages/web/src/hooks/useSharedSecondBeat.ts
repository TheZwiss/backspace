import { useSyncExternalStore } from 'react';

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: number | null = null;
let snapshot = Date.now();

function publish(): void {
  snapshot = Date.now();
  for (const listener of listeners) listener();
}

function stop(): void {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

function start(): void {
  if (timer !== null || listeners.size === 0 || document.visibilityState === 'hidden') return;
  snapshot = Date.now();
  timer = window.setInterval(publish, 1_000);
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    stop();
    return;
  }
  publish();
  start();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    start();
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  };
}

function getSnapshot(): number {
  return snapshot;
}

/** A single visibility-aware 1 Hz clock shared by every mounted subscriber. */
export function useSharedSecondBeat(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
