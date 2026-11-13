/** Canonical PCM keeps decoding/validation dependency-free on Termux and Debian. */
export function validateSoundboardWav(bytes: Buffer): number | null {
  if (bytes.length < 46 || bytes.length > 499244) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) !== bytes.length - 8 ||
      bytes.toString('ascii', 8, 16) !== 'WAVEfmt ' || bytes.readUInt32LE(16) !== 16 ||
      bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 48000 ||
      bytes.readUInt32LE(28) !== 96000 || bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16 ||
      bytes.toString('ascii', 36, 40) !== 'data' || bytes.readUInt32LE(40) !== bytes.length - 44 || (bytes.length - 44) % 2) return null;
  return Math.ceil((bytes.length - 44) / 96);
}
