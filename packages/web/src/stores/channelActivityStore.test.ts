import { describe, expect, it } from 'vitest';
import { useChannelActivityStore } from './channelActivityStore';
describe('channel activity snapshots', () => {
  it('replaces one origin on reconnect without deleting another origin', () => {
    const store = useChannelActivityStore.getState();
    store.reset();
    store.hydrate('', { counts: { a: 3 }, supportsPoke: true });
    store.hydrate('remote', { counts: { b: 5 }, supportsPoke: true });
    store.updateCounts('', { a: 0 });
    expect(useChannelActivityStore.getState().counts).toEqual({ '': { a: 0 }, remote: { b: 5 } });
    store.hydrate('remote', {});
    expect(useChannelActivityStore.getState().counts.remote).toEqual({});
    expect(useChannelActivityStore.getState().pokeOrigins.remote).toBe(false);
    store.reset();
    expect(useChannelActivityStore.getState().counts).toEqual({});
  });
});
