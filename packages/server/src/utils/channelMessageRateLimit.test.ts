import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_MESSAGE_CREATE_RATE_LIMIT,
  _resetChannelMessageCreateLimit,
  consumeChannelMessageCreate,
} from './channelMessageRateLimit.js';

beforeEach(() => {
  _resetChannelMessageCreateLimit();
  vi.unstubAllEnvs();
});

describe('channel message create rate limit', () => {
  const { max, windowMs } = CHANNEL_MESSAGE_CREATE_RATE_LIMIT;

  it('counts per account instead of sharing a budget across users', () => {
    const start = 1_000_000;
    for (let index = 0; index < max; index += 1) {
      expect(consumeChannelMessageCreate('alice', start + index)).toBe(true);
    }
    expect(consumeChannelMessageCreate('alice', start + windowMs - 1)).toBe(false);
    expect(consumeChannelMessageCreate('bob', start + windowMs - 1)).toBe(true);
  });

  it('opens a fresh window after five seconds', () => {
    const start = 2_000_000;
    for (let index = 0; index < max; index += 1) consumeChannelMessageCreate('alice', start);
    expect(consumeChannelMessageCreate('alice', start + windowMs)).toBe(true);
  });

  it('admits everything when rate limits are disabled', () => {
    vi.stubEnv('DISABLE_RATE_LIMITS', '1');
    for (let index = 0; index < max * 3; index += 1) {
      expect(consumeChannelMessageCreate('alice', 1)).toBe(true);
    }
  });
});
