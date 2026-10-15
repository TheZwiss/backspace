import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { RESULT_CACHE_LIMIT, RESULT_CACHE_BYTES, MAX_RESULT_LENGTH, TranslationError } from '@backspace/translation';
import type { VaultEncryption } from './vault';

/** Local, OS-encrypted results only: no source text, keys or provider metadata on disk. */
export class TranslationResultCache {
  constructor(
    private readonly directory: string,
    private readonly encryption: VaultEncryption,
  ) {}
  private scopeDirectory(scope: string): string {
    return path.join(this.directory, createHash('sha256').update(scope).digest('hex'));
  }
  get(scope: string, key: string): string | null {
    const file = path.join(this.scopeDirectory(scope), key + '.bin');
    try {
      const value: unknown = JSON.parse(this.encryption.decrypt(fs.readFileSync(file)));
      if (typeof value !== 'string' || !value.trim() || value.length > MAX_RESULT_LENGTH)
        throw new Error('schema');
      const now = new Date();
      fs.utimesSync(file, now, now);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof TranslationError && error.code === 'secure-storage') throw error;
      // Corruption/permission errors are not cache misses that silently incur another paid request.
      throw new TranslationError('cache-storage');
    }
  }
  set(scope: string, key: string, text: string): void {
    const directory = this.scopeDirectory(scope);
    const file = path.join(directory, key + '.bin');
    try {
      const encrypted = this.encryption.encrypt(JSON.stringify(text));
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file + '.tmp', encrypted, { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
      this.prune(directory);
    } catch (error) {
      if (error instanceof TranslationError && error.code === 'secure-storage') throw error;
      throw new TranslationError('cache-storage');
    }
  }
  private prune(directory: string): void {
    const files = fs
      .readdirSync(directory)
      .filter((name) => /^[a-f0-9]{64}\.bin$/.test(name))
      .map((name) => {
        const file = path.join(directory, name);
        const stat = fs.statSync(file);
        return { file, size: stat.size, used: stat.mtimeMs };
      })
      .sort((a, b) => a.used - b.used);
    let bytes = files.reduce((sum, file) => sum + file.size, 0);
    let count = files.length;
    for (const file of files) {
      if (count <= RESULT_CACHE_LIMIT && bytes <= RESULT_CACHE_BYTES) break;
      fs.unlinkSync(file.file);
      bytes -= file.size;
      count -= 1;
    }
  }
}
