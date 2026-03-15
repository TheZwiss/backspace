export function isElectron(): boolean {
  return typeof window !== 'undefined' && typeof window.backspace !== 'undefined';
}

export function getElectronAPI(): BackspaceElectronAPI | null {
  return window.backspace ?? null;
}
