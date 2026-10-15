import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { TranslationVault as SettingsVault, TranslationError } from '@backspace/translation';

export interface VaultEncryption {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

/** Desktop settings stay local; selecting the HTTP backend never migrates these secrets. */
export class TranslationVault extends SettingsVault {
  constructor(directory: string, encryption: VaultEncryption) {
    const file = (scope: string) => path.join(directory, createHash('sha256').update(scope).digest('hex') + '.bin');
    super({
      read(scope) {
        try {
          return encryption.decrypt(fs.readFileSync(file(scope)));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          if (error instanceof TranslationError && error.code === 'secure-storage') throw error;
          throw new TranslationError('storage');
        }
      },
      write(scope, plaintext) {
        const encrypted = encryption.encrypt(plaintext);
        try {
          fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
          fs.writeFileSync(file(scope) + '.tmp', encrypted, { mode: 0o600 });
          fs.renameSync(file(scope) + '.tmp', file(scope));
        } catch {
          throw new TranslationError('storage');
        }
      },
    });
  }
}
