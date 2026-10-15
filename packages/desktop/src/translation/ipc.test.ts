import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';
const electron = vi.hoisted(() => ({
  app: { getPath: vi.fn() },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(),
    getSelectedStorageBackend: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));
vi.mock('electron', () => electron);
import { registerTranslationIpc, trustedTranslationOrigin } from './ipc';
const trusted = {
  senderIsMain: true,
  frameIsMain: true,
  frameUrl: 'https://chat.example/channels/1',
  configuredUrl: 'https://chat.example',
};

describe('translation IPC origin boundary', () => {
  it('accepts only the configured main frame', () => {
    expect(trustedTranslationOrigin(trusted)).toBe('https://chat.example');
  });
  it.each([
    { senderIsMain: false },
    { frameIsMain: false },
    { configuredUrl: null },
    { frameUrl: 'https://attacker.example' },
    { frameUrl: 'file:///tmp/index.html' },
    { frameUrl: 'https://chat.example.attacker.example' },
  ])('rejects an untrusted context %#', (change) => {
    expect(() => trustedTranslationOrigin({ ...trusted, ...change })).toThrow('untrusted-sender');
  });
});

describe('OS encryption fail-closed wiring', () => {
  let directory: string;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => {
    vi.clearAllMocks();
    directory = mkdtempSync(path.join(tmpdir(), 'backspace-ipc-'));
    electron.app.getPath.mockReturnValue(directory);
    electron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    rmSync(directory, { recursive: true, force: true });
  });
  it.each(['unavailable', 'basic_text'])('refuses to persist secrets with %s storage', async (mode) => {
    if (mode === 'basic_text') {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
      electron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
      electron.safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');
    }
    const frame = { url: trusted.frameUrl };
    const sender = { mainFrame: frame };
    registerTranslationIpc({
      getWindow: () => ({ webContents: sender }) as unknown as BrowserWindow,
      getInstanceUrl: () => trusted.configuredUrl,
    });
    const handler = electron.ipcMain.handle.mock.calls[0]![1];
    const result = await handler(
      { sender, senderFrame: frame },
      {
        action: 'saveConnection',
        accountId: 'alice',
        connection: {
          name: 'test',
          protocol: 'openai-chat',
          baseUrl: 'https://api.example',
          model: 'test',
          apiKey: 'secret',
        },
      },
    );
    expect(result).toEqual({ ok: false, code: 'secure-storage' });
    expect(electron.safeStorage.encryptString).not.toHaveBeenCalled();
  });
});
