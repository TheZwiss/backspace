import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectClientKind } from './clientKind';

afterEach(() => { vi.unstubAllGlobals(); delete (window as { backspace?: unknown }).backspace; });

describe('detectClientKind', () => {
  it('reports desktop under the Electron bridge', () => {
    (window as { backspace?: unknown }).backspace = { platform: 'darwin' };
    expect(detectClientKind()).toBe('desktop');
  });
  it('reports mobile on a small viewport and web otherwise', () => {
    vi.stubGlobal('innerWidth', 500);
    expect(detectClientKind()).toBe('mobile');
    vi.stubGlobal('innerWidth', 1200);
    expect(detectClientKind()).toBe('web');
  });
});
