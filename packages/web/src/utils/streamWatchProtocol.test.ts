import { describe, it, expect } from 'vitest';
import {
  encodeStreamWatch,
  parseStreamWatch,
  isStreamWatchPayload,
  encodeStreamRepublish,
  isStreamRepublish,
} from './streamWatchProtocol';

describe('streamWatchProtocol', () => {
  it('round-trips an encoded payload', () => {
    const payload = { type: 'stream_watch' as const, target: 'user-1', watching: true };
    const encoded = encodeStreamWatch(payload);
    // Realm-safe Uint8Array check — TextEncoder returns a Uint8Array from Node's
    // realm, which `toBeInstanceOf(Uint8Array)` rejects under vitest+jsdom.
    expect(Object.prototype.toString.call(encoded)).toBe('[object Uint8Array]');
    const parsed = parseStreamWatch(encoded);
    expect(parsed).toEqual(payload);
  });

  it('parseStreamWatch returns null on invalid JSON', () => {
    const bad = new TextEncoder().encode('not json');
    expect(parseStreamWatch(bad)).toBeNull();
  });

  it('parseStreamWatch returns null on wrong message type', () => {
    const other = new TextEncoder().encode(JSON.stringify({ type: 'deafen', deafened: true }));
    expect(parseStreamWatch(other)).toBeNull();
  });

  it('isStreamWatchPayload validates shape', () => {
    expect(isStreamWatchPayload({ type: 'stream_watch', target: 'u', watching: true })).toBe(true);
    expect(isStreamWatchPayload({ type: 'stream_watch', target: 'u', watching: 'yes' })).toBe(false);
    expect(isStreamWatchPayload({ type: 'stream_watch', watching: true })).toBe(false);
    expect(isStreamWatchPayload({ type: 'other', target: 'u', watching: true })).toBe(false);
    expect(isStreamWatchPayload(null)).toBe(false);
    expect(isStreamWatchPayload('string')).toBe(false);
  });
});

describe('stream_republish', () => {
  it('encodes the wire format the viewer checks', () => {
    const encoded = encodeStreamRepublish();
    expect(Object.prototype.toString.call(encoded)).toBe('[object Uint8Array]');
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual({ type: 'stream_republish' });
    expect(isStreamRepublish(encoded)).toBe(true);
  });

  it('is ignored by the receivers older clients run', () => {
    // An older viewer tries stream_watch, then looks for `deafen`; neither may match.
    const encoded = encodeStreamRepublish();
    expect(parseStreamWatch(encoded)).toBeNull();
    const msg = JSON.parse(new TextDecoder().decode(encoded)) as { type: string };
    expect(msg.type).not.toBe('deafen');
  });

  it('rejects other payloads', () => {
    expect(isStreamRepublish(encodeStreamWatch({ type: 'stream_watch', target: 'u', watching: true }))).toBe(false);
    expect(isStreamRepublish(new TextEncoder().encode('not json'))).toBe(false);
    expect(isStreamRepublish(new TextEncoder().encode('null'))).toBe(false);
  });
});
