import { app, ipcMain, safeStorage, type BrowserWindow } from 'electron';
import path from 'path';
import { TranslationService } from '@backspace/translation';
import { TranslationVault, type VaultEncryption } from './vault';
import { TranslationResultCache } from './resultCache';
import { TranslationError } from '@backspace/translation';

export function trustedTranslationOrigin(input: {
  senderIsMain: boolean;
  frameIsMain: boolean;
  frameUrl: string;
  configuredUrl: string | null;
}): string {
  if (!input.senderIsMain || !input.frameIsMain || !input.configuredUrl)
    throw new TranslationError('untrusted-sender');
  try {
    const frame = new URL(input.frameUrl);
    const expected = new URL(input.configuredUrl);
    if (!['http:', 'https:'].includes(frame.protocol) || frame.origin !== expected.origin) throw new Error();
    return frame.origin;
  } catch {
    throw new TranslationError('untrusted-sender');
  }
}
function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new TranslationError('secure-storage');
  // On Linux Electron can otherwise "encrypt" using a hard-coded password.
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    throw new TranslationError('secure-storage');
}
export function registerTranslationIpc(context: {
  getWindow: () => BrowserWindow | null;
  getInstanceUrl: () => string | null;
}): void {
  const encryption: VaultEncryption = {
    encrypt: (text) => {
      requireEncryption();
      return safeStorage.encryptString(text);
    },
    decrypt: (bytes) => {
      requireEncryption();
      return safeStorage.decryptString(bytes);
    },
  };
  const directory = path.join(app.getPath('userData'), 'local-ai');
  const vault = new TranslationVault(directory, encryption);
  const cache = new TranslationResultCache(path.join(directory, 'results'), encryption);
  const service = new TranslationService(vault, fetch, cache);
  ipcMain.handle('translation:command', async (event, input: unknown) => {
    try {
      const window = context.getWindow();
      const origin = trustedTranslationOrigin({
        senderIsMain: !!window && event.sender === window.webContents,
        frameIsMain: event.senderFrame === event.sender.mainFrame,
        frameUrl: event.senderFrame?.url ?? '',
        configuredUrl: context.getInstanceUrl(),
      });
      return await service.command(origin, input);
    } catch (error) {
      return {
        ok: false,
        code: error instanceof TranslationError ? error.code : 'secure-storage',
      };
    }
  });
}
