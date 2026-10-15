import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;

/** An operator-owned key, kept outside the database and unrelated to JWT signing. */
export class TranslationEncryption {
  private readonly key: Buffer;
  constructor(keyHex: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(keyHex)) {
      throw new Error('AI_TRANSLATION_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters (32 random bytes).');
    }
    this.key = Buffer.from(keyHex, 'hex');
  }
  encrypt(plaintext: string, context: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    // Binding ciphertext to its owner and purpose prevents row-swapping across accounts.
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([FORMAT_VERSION]), nonce, cipher.getAuthTag(), encrypted]);
  }
  decrypt(encrypted: Buffer, context: string): string {
    const headerBytes = 1 + NONCE_BYTES + TAG_BYTES;
    if (encrypted.length < headerBytes || encrypted[0] !== FORMAT_VERSION) throw new Error('Invalid encrypted translation record');
    const decipher = createDecipheriv('aes-256-gcm', this.key, encrypted.subarray(1, 1 + NONCE_BYTES));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(encrypted.subarray(1 + NONCE_BYTES, headerBytes));
    return Buffer.concat([decipher.update(encrypted.subarray(headerBytes)), decipher.final()]).toString('utf8');
  }
}
