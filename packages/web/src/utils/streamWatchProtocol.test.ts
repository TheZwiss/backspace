import { describe, it, expect } from 'vitest';
import {
  encodeStreamWatch,
  parseStreamWatch,
  isStreamWatchPayload,
  encodeShareSignal,
  parseShareSignal,
  type ShareSignal,
  streamWatchFor,
  streamWatchKey,
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

describe('share signals', () => {
  const signals: ShareSignal[] = ['stream_republish', 'stream_resume', 'stream_stop'];

  it.each(signals)('encodes %s in the wire format the viewer checks', (signal) => {
    const encoded = encodeShareSignal(signal);
    expect(Object.prototype.toString.call(encoded)).toBe('[object Uint8Array]');
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual({ type: signal });
    expect(parseShareSignal(encoded)).toBe(signal);
  });

  it.each(signals)('%s is ignored by the receivers older clients run', (signal) => {
    // An older viewer tries stream_watch, then looks for `deafen`; neither may match.
    const encoded = encodeShareSignal(signal);
    expect(parseStreamWatch(encoded)).toBeNull();
    const msg = JSON.parse(new TextDecoder().decode(encoded)) as { type: string };
    expect(msg.type).not.toBe('deafen');
  });

  it('rejects other payloads', () => {
    expect(parseShareSignal(encodeStreamWatch({ type: 'stream_watch', target: 'u', watching: true }))).toBeNull();
    expect(parseShareSignal(new TextEncoder().encode(JSON.stringify({ type: 'deafen', deafened: true })))).toBeNull();
    expect(parseShareSignal(new TextEncoder().encode('not json'))).toBeNull();
    expect(parseShareSignal(new TextEncoder().encode('null'))).toBeNull();
  });
});

describe('stream_watch across instances', () => {
  // The sharer's LiveKit identity is the one string every client in the room
  // knows the sharer by. Its user id differs per instance (a remote-instance
  // space channel, a federated DM call), so the watch is keyed by identity.
  const sharer = { userId: 'b-local-alice', identity: 'alice-home:Alice' };

  it('carries the sharer\'s identity next to the user id older sharers read', () => {
    expect(streamWatchFor(sharer, true)).toEqual({
      type: 'stream_watch', target: 'b-local-alice', targetIdentity: 'alice-home:Alice', watching: true,
    });
    const parsed = parseStreamWatch(encodeStreamWatch(streamWatchFor(sharer, false)));
    expect(parsed).toEqual({
      type: 'stream_watch', target: 'b-local-alice', targetIdentity: 'alice-home:Alice', watching: false,
    });
  });

  it('rejects a targetIdentity that is not a string', () => {
    expect(isStreamWatchPayload({ type: 'stream_watch', target: 'u', targetIdentity: 7, watching: true })).toBe(false);
  });

  it('keys a ping by its targetIdentity whatever user id it names', () => {
    const participants = [{ userId: 'a-local-alice', identity: 'alice-home:Alice' }];
    expect(streamWatchKey(streamWatchFor(sharer, true), participants)).toBe('alice-home:Alice');
  });

  it('keys an older viewer\'s ping through the participant listed under its target', () => {
    const participants = [
      { userId: 'r-77', identity: 'r-77:Me' },
      { userId: 'ann', identity: 'ann:Ann' },
    ];
    expect(streamWatchKey({ type: 'stream_watch', target: 'r-77', watching: true }, participants)).toBe('r-77:Me');
  });

  it('drops an older viewer\'s ping whose target nobody is listed under', () => {
    const participants = [{ userId: 'a-local-alice', identity: 'alice-home:Alice' }];
    expect(streamWatchKey({ type: 'stream_watch', target: 'b-local-alice', watching: true }, participants)).toBeNull();
  });
});
