import { describe, it, expect } from 'vitest';
import {
  parseUploadMetadata,
  extractExtension,
  buildTusMetadata,
  isOwnerOfUpload,
} from './tusHooks.js';

describe('parseUploadMetadata', () => {
  it('parses base64-encoded metadata pairs', () => {
    const filename = Buffer.from('photo.png').toString('base64');
    const meta = parseUploadMetadata(`filename ${filename},foo bar`);
    expect(meta.filename).toBe('photo.png');
    expect(meta.foo).toBeUndefined();          // 'bar' is not valid base64 padding here
  });

  it('returns empty object on null input', () => {
    expect(parseUploadMetadata(null)).toEqual({});
  });
});

describe('extractExtension', () => {
  it('lowercases the extension', () => {
    expect(extractExtension('Photo.PNG')).toBe('.png');
  });
  it('returns empty string when no extension', () => {
    expect(extractExtension('Makefile')).toBe('');
  });
  it('strips path components', () => {
    expect(extractExtension('../../../etc/passwd.txt')).toBe('.txt');
  });
});

describe('buildTusMetadata', () => {
  it('includes snowflakeId, userId, originalName', () => {
    const meta = buildTusMetadata({
      snowflakeId: '1234',
      userId: 'u-9',
      originalName: 'photo.png',
    });
    expect(meta).toMatchObject({
      snowflakeId: '1234',
      userId: 'u-9',
      originalName: 'photo.png',
    });
  });
});

describe('isOwnerOfUpload', () => {
  it('returns true on matching userId', () => {
    expect(isOwnerOfUpload({ userId: 'u-9' }, 'u-9')).toBe(true);
  });
  it('returns false on mismatch', () => {
    expect(isOwnerOfUpload({ userId: 'u-9' }, 'u-10')).toBe(false);
  });
  it('returns false on missing metadata', () => {
    expect(isOwnerOfUpload({}, 'u-9')).toBe(false);
  });
  it('returns false when metadata.userId is an empty string', () => {
    expect(isOwnerOfUpload({ userId: '' }, 'u-9')).toBe(false);
  });
});
