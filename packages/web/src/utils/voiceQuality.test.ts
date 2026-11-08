import { describe, expect, it, vi } from 'vitest';
import type { Room } from 'livekit-client';
import { applyMicBitrate, audioPresetForKbps } from './voiceQuality';

describe('audioPresetForKbps', () => {
  it.each([[64, 64_000], [128, 128_000], [256, 256_000]])('turns the %i kbps preset into %i bps', (kbps, bps) => {
    expect(audioPresetForKbps(kbps)).toEqual({ maxBitrate: bps });
  });

  it.each([[undefined], [null], [0], [96], [512]])('gives no preset for %s, so LiveKit keeps its default', (value) => {
    expect(audioPresetForKbps(value)).toBeUndefined();
  });
});

function fakeRoom(sender: unknown) {
  const room = {
    options: { publishDefaults: { videoCodec: 'h264' } as Record<string, unknown> },
    localParticipant: {
      getTrackPublication: vi.fn(() => (sender === undefined ? undefined : { track: { sender } })),
    },
  };
  return room as unknown as Room & typeof room;
}

describe('applyMicBitrate', () => {
  it('sets the default for later publishes and the live encoder', async () => {
    const setParameters = vi.fn(async () => {});
    const sender = { getParameters: () => ({ encodings: [{ maxBitrate: 48_000 }] }), setParameters };
    const room = fakeRoom(sender);

    await applyMicBitrate(room, 256);

    expect(room.options.publishDefaults).toEqual({ videoCodec: 'h264', audioPreset: { maxBitrate: 256_000 } });
    expect(setParameters).toHaveBeenCalledWith({ encodings: [{ maxBitrate: 256_000 }] });
  });

  it('still updates the default when nothing is publishing yet', async () => {
    const room = fakeRoom(undefined);
    await applyMicBitrate(room, 128);
    expect(room.options.publishDefaults.audioPreset).toEqual({ maxBitrate: 128_000 });
  });

  it('leaves the room alone for a value that is not a preset', async () => {
    const setParameters = vi.fn(async () => {});
    const room = fakeRoom({ getParameters: () => ({ encodings: [{}] }), setParameters });
    await applyMicBitrate(room, 96);
    expect(room.options.publishDefaults).toEqual({ videoCodec: 'h264' });
    expect(setParameters).not.toHaveBeenCalled();
  });

  it('does not throw when the browser refuses the new parameters', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sender = { getParameters: () => ({ encodings: [{}] }), setParameters: vi.fn(async () => { throw new Error('InvalidModificationError'); }) };
    await expect(applyMicBitrate(fakeRoom(sender), 128)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
