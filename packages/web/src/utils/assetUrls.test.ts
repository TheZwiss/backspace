import { describe, expect, it, vi } from 'vitest';

vi.mock('../stores/spaceStore', () => ({
  getApiForOrigin: (origin: string) => ({
    uploads: { url: (filename: string) => `${origin || 'home'}/api/uploads/${filename}` },
  }),
}));

import { uploadUrlOn } from './assetUrls';

describe('uploadUrlOn', () => {
  it('resolves a bare filename against the instance it lives on', () => {
    expect(uploadUrlOn('bot.webp', '')).toBe('home/api/uploads/bot.webp');
    expect(uploadUrlOn('bot.webp', 'https://other.example')).toBe('https://other.example/api/uploads/bot.webp');
  });

  it('strips an /api/uploads/ prefix and leaves absolute URLs alone', () => {
    expect(uploadUrlOn('/api/uploads/bot.webp', 'https://other.example')).toBe('https://other.example/api/uploads/bot.webp');
    expect(uploadUrlOn('https://cdn.example/bot.webp', 'https://other.example')).toBe('https://cdn.example/bot.webp');
  });

  it('is null without a file', () => {
    expect(uploadUrlOn(null, '')).toBeNull();
    expect(uploadUrlOn(undefined, 'https://other.example')).toBeNull();
    expect(uploadUrlOn('', '')).toBeNull();
  });
});
